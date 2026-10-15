/**
 * Compose projects for the Docker connection form: find the compose file in a project folder, list its services
 * with their containers, and start a service. `docker compose` runs in the folder, so it picks up the same files,
 * `.env` and project name as the user's own commands.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { DockerComposeProject, DockerComposeService } from '@shared/types'
import { DOCKER_MISSING, findDockerCli } from './dockerCli'
import { CommandError, runCapture, summarizeOutput } from './process'

/** The files `docker compose` looks for, in its order of preference. */
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
const OVERRIDE_FILES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml']

/** Service names as compose accepts them; also keeps the value safe as an argument. */
export const COMPOSE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/

/** `COMPOSE_FILE` from the folder's `.env` ('' when absent). */
function composeFileFromEnv(dir: string): string {
  try {
    const match = /^\s*COMPOSE_FILE\s*=\s*["']?([^"'\n#]+)/m.exec(readFileSync(join(dir, '.env'), 'utf8'))
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

/** Compose files `docker compose` will use in `dir` (absolute); [] when the folder has none. */
export function composeFilesIn(dir: string): string[] {
  const fromEnv = composeFileFromEnv(dir)
  if (fromEnv) {
    const separator = fromEnv.includes(';') ? ';' : ':'
    return fromEnv
      .split(separator)
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => (isAbsolute(f) ? f : resolve(dir, f)))
      .filter((f) => existsSync(f))
  }
  const main = COMPOSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f))
  if (!main) return []
  const override = OVERRIDE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f))
  return override ? [main, override] : [main]
}

type ConfigVolume = { type?: unknown; source?: unknown; target?: unknown }
type ConfigService = { image?: unknown; working_dir?: unknown; user?: unknown; volumes?: unknown }
type PsEntry = { Name?: unknown; Service?: unknown; State?: unknown; Labels?: unknown }

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** `docker compose ps --format json` prints one JSON object per line (v2.21+) or a JSON array (older). */
export function parsePs(output: string): PsEntry[] {
  const text = output.trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const out: PsEntry[] = []
  for (const line of text.split('\n')) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip noise lines (warnings) */
    }
  }
  return out
}

const STATE_RANK: Record<string, number> = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 }

/** Pure: `docker compose config --format json` + `ps` output → services sorted by name. */
export function parseComposeProject(dir: string, files: string[], configJson: string, psOutput: string): DockerComposeProject {
  let config: { name?: unknown; services?: Record<string, ConfigService> }
  try {
    config = JSON.parse(configJson)
  } catch {
    throw new Error('Could not read the output of docker compose config')
  }
  // The service's container: skip `docker compose run` one-offs, prefer a running one.
  const containers = new Map<string, { name: string; state: string }>()
  for (const entry of parsePs(psOutput)) {
    const service = str(entry.Service)
    const name = str(entry.Name)
    if (!service || !name || /com\.docker\.compose\.oneoff=True/.test(str(entry.Labels))) continue
    const state = str(entry.State).toLowerCase()
    const current = containers.get(service)
    if (!current || (STATE_RANK[state] ?? 9) < (STATE_RANK[current.state] ?? 9)) containers.set(service, { name, state })
  }
  const services: DockerComposeService[] = Object.entries(config.services ?? {}).map(([name, svc]) => ({
    name,
    image: str(svc?.image),
    workingDir: str(svc?.working_dir),
    user: str(svc?.user),
    mounts: (Array.isArray(svc?.volumes) ? (svc.volumes as ConfigVolume[]) : [])
      .filter((v) => v && v.type === 'bind' && str(v.source) && str(v.target))
      .map((v) => ({ source: str(v.source), destination: str(v.target) })),
    container: containers.get(name)?.name ?? '',
    state: containers.get(name)?.state ?? ''
  }))
  return {
    dir,
    files,
    project: str(config.name),
    services: services.sort((a, b) => a.name.localeCompare(b.name))
  }
}

function cli(findCli: () => string | null): string {
  const docker = findCli()
  if (!docker) throw new Error(DOCKER_MISSING)
  return docker
}

function composeError(err: unknown, action: string): Error {
  if (err instanceof CommandError && err.result) {
    const text = summarizeOutput(err.result.stderr || err.result.stdout, 500)
    if (/Cannot connect to the Docker daemon|error during connect|daemon is not running/i.test(text)) {
      return new Error('Cannot connect to the Docker daemon. Is Docker running?')
    }
    if (/is not a docker command|unknown command "compose"|unknown shorthand flag/i.test(text)) {
      return new Error('This Docker CLI has no `compose` command. Install Docker Compose v2.')
    }
    return new Error(`${action} failed: ${text || err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/** The compose project in `dir`, or null when the folder has no compose file. */
export async function readComposeProject(dir: string, findCli: () => string | null = () => findDockerCli()): Promise<DockerComposeProject | null> {
  const files = composeFilesIn(dir)
  if (files.length === 0) return null
  const docker = cli(findCli)
  try {
    const config = await runCapture(docker, ['compose', 'config', '--format', 'json'], { cwd: dir, timeoutMs: 30_000, label: 'docker compose config' })
    const ps = await runCapture(docker, ['compose', 'ps', '--all', '--format', 'json'], {
      cwd: dir,
      timeoutMs: 30_000,
      label: 'docker compose ps',
      allowFailure: true
    })
    return parseComposeProject(dir, files, config.stdout, ps.stdout)
  } catch (err) {
    throw composeError(err, 'docker compose config')
  }
}

/** `docker compose up -d <service>` in `dir`, then the refreshed project. */
export async function composeUp(dir: string, service: string, findCli: () => string | null = () => findDockerCli()): Promise<DockerComposeProject> {
  if (!COMPOSE_SERVICE.test(service)) throw new Error(`Invalid service name: ${service}`)
  if (composeFilesIn(dir).length === 0) throw new Error(`No compose file in ${dir}`)
  const docker = cli(findCli)
  try {
    // Pulling or building images can take minutes.
    await runCapture(docker, ['compose', 'up', '-d', service], { cwd: dir, timeoutMs: 15 * 60_000, label: 'docker compose up' })
  } catch (err) {
    throw composeError(err, `docker compose up ${service}`)
  }
  const project = await readComposeProject(dir, findCli)
  if (!project) throw new Error(`No compose file in ${dir}`)
  return project
}
