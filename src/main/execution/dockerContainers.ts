/**
 * Running containers for the Docker connection form: `docker ps -q` for the ids, then one `docker inspect` for the
 * details the form prefills (working directory and bind mounts → project path and host folder).
 */
import type { DockerContainer } from '@shared/types'
import { findDockerCli } from './dockerTransport'
import { CommandError, runCapture, summarizeOutput } from './process'

const MAX_CONTAINERS = 200

type Inspected = {
  Id?: unknown
  Name?: unknown
  Config?: { Image?: unknown; WorkingDir?: unknown; Labels?: Record<string, unknown> | null } | null
  Mounts?: Array<{ Type?: unknown; Source?: unknown; Destination?: unknown }> | null
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Pure: `docker inspect` JSON → DockerContainer list, sorted by name. Unusable entries are skipped. */
export function parseInspect(json: string): DockerContainer[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('Could not read the output of docker inspect')
  }
  if (!Array.isArray(raw)) return []
  const out: DockerContainer[] = []
  for (const item of raw as Inspected[]) {
    const id = str(item?.Id)
    const name = str(item?.Name).replace(/^\//, '')
    if (!id || !name) continue
    const labels = item.Config?.Labels ?? {}
    out.push({
      id: id.slice(0, 12),
      name,
      image: str(item.Config?.Image),
      workingDir: str(item.Config?.WorkingDir),
      mounts: (item.Mounts ?? [])
        .filter((m) => m && m.Type === 'bind' && str(m.Source) && str(m.Destination))
        .map((m) => ({ source: str(m.Source), destination: str(m.Destination) })),
      composeProject: str(labels['com.docker.compose.project']),
      composeService: str(labels['com.docker.compose.service'])
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Running containers; rejects with an actionable message when the CLI or the daemon is unavailable. */
export async function listDockerContainers(findCli: () => string | null = () => findDockerCli()): Promise<DockerContainer[]> {
  const docker = findCli()
  if (!docker) throw new Error('Docker CLI not found. Install Docker (or set TINKERBOX_DOCKER to a compatible CLI) and restart Tinkerbox.')
  try {
    const ps = await runCapture(docker, ['ps', '-q', '--no-trunc'], { timeoutMs: 15_000, label: 'docker ps' })
    const ids = ps.stdout.split(/\s+/).filter(Boolean).slice(0, MAX_CONTAINERS)
    if (ids.length === 0) return []
    const inspect = await runCapture(docker, ['inspect', ...ids], { timeoutMs: 15_000, label: 'docker inspect', allowFailure: true })
    // A container that stopped between the two calls makes inspect fail for that id only; the JSON still lists the rest.
    if (!inspect.stdout.trim()) throw new CommandError(`docker inspect failed: ${summarizeOutput(inspect.stderr, 300)}`, inspect)
    return parseInspect(inspect.stdout)
  } catch (err) {
    const text = err instanceof CommandError && err.result ? err.result.stderr : ''
    if (/Cannot connect to the Docker daemon|error during connect|daemon is not running/i.test(text)) {
      throw new Error('Cannot connect to the Docker daemon. Is Docker running?')
    }
    throw err
  }
}
