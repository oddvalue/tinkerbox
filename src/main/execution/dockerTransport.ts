/**
 * Docker transport: `docker exec -i [--user u] [--workdir path] <container> sh -c '…' php <flags>` with the bundle
 * on stdin. The project and PHP live in a running container; nothing is copied into it.
 *
 * Killing the local `docker exec` client does not stop the process inside the container (signals are not forwarded
 * without a TTY). The wrapper therefore prints its PID on stderr before it `exec`s PHP, and stopping a run (cancel,
 * timeout, output limit) also runs `kill -TERM -<pid>` in the container. `docker exec` makes PHP a process-group
 * leader, so the negative PID also stops processes started by user code.
 */
import type { Connection, DockerConnection, DockerContainer } from '@shared/types'
import { phpFlags } from './argv'
import { DOCKER_MISSING, findDockerCli } from './dockerCli'
import { listDockerContainers } from './dockerContainers'
import { DEFAULT_MAX_OUTPUT_BYTES, runCapture, spawnStreaming, summarizeOutput, type ProcessResult } from './process'
import type { Transport, TransportRequest, TransportResult } from './transport'

/** Written to stderr by the wrapper before PHP starts; stripped from the output. */
export const PID_MARKER = '__TINKERBOX_PID__'
const PID_LINE = new RegExp(`(^|\\n)${PID_MARKER} (\\d+)\\n`)

/** POSIX sh wrapper: report the PID (= process group, see the header), then replace the shell with PHP. */
const WRAPPER = `printf '${PID_MARKER} %s\\n' "$$" >&2; exec "$0" "$@"`

/** Arguments for `docker exec` that run PHP (with `flags`) through the PID-reporting wrapper. */
export function dockerExecArgs(conn: DockerConnection, flags: string[]): string[] {
  const args = ['exec', '-i']
  if (conn.user) args.push('--user', conn.user)
  if (conn.path) args.push('--workdir', conn.path)
  args.push(conn.container, 'sh', '-c', WRAPPER, conn.phpBinary || 'php', ...flags)
  return args
}

/**
 * Takes the wrapper's PID line out of the stderr stream. Text before it (Docker's own errors and warnings) is held
 * until the line arrives or the process ends, so a failed attempt can be dropped and retried without showing it.
 */
export class PidLineFilter {
  pid: number | null = null
  private buffer = ''
  private done = false

  constructor(private readonly forward: (chunk: string) => void) {}

  push(chunk: string): void {
    if (this.done) {
      this.forward(chunk)
      return
    }
    this.buffer += chunk
    const match = PID_LINE.exec(this.buffer)
    if (!match) return
    this.pid = Number(match[2])
    this.done = true
    const rest = this.buffer.slice(0, match.index + match[1].length) + this.buffer.slice(match.index + match[0].length)
    this.buffer = ''
    if (rest) this.forward(rest)
  }

  /** The process ended: pass on what was held back (or drop it with `discard`). */
  flush(discard = false): void {
    if (!this.done && this.buffer && !discard) this.forward(this.buffer)
    this.done = true
    this.buffer = ''
  }
}

/** Remove the wrapper's PID line from captured stderr. */
export function stripPidLine(stderr: string): string {
  return stderr.replace(PID_LINE, '$1')
}

/** Turn a failed `docker exec` (the wrapper never ran, or PHP could not start) into an actionable message. */
export function dockerFailure(conn: DockerConnection, exitCode: number | null, stderr: string, startedWrapper: boolean): string | null {
  const text = stderr.trim()
  if (!startedWrapper) {
    if (/No such container/i.test(text)) return `Container "${conn.container}" not found. Start it (docker ps lists running containers) or pick another one.`
    if (/is not running|is paused|is restarting/i.test(text)) return `Container "${conn.container}" is not running. Start it and try again.`
    if (/permission denied.*docker\.sock|Got permission denied/i.test(text)) return `Permission denied talking to the Docker daemon: ${summarizeOutput(text, 300)}`
    if (/Cannot connect to the Docker daemon|error during connect|docker daemon is not running/i.test(text)) return 'Cannot connect to the Docker daemon. Is Docker running?'
    if (/unable to find user|no matching entries in passwd/i.test(text)) return `User "${conn.user}" does not exist in container "${conn.container}".`
    if (/chdir to cwd|no such file or directory/i.test(text) && conn.path) return `Project directory not found in container "${conn.container}": ${conn.path}`
    if (/executable file not found|"sh": executable/i.test(text)) return `Container "${conn.container}" has no /bin/sh, which Tinkerbox needs to run PHP.`
    return `docker exec failed${exitCode !== null ? ` (exit code ${exitCode})` : ''}: ${summarizeOutput(text, 400) || 'no output'}`
  }
  // The wrapper ran; `exec` failing leaves a shell error and exit code 126 / 127.
  if (exitCode === 127 || exitCode === 126) {
    const php = conn.phpBinary || 'php'
    if (/not found|No such file|cannot execute|Permission denied/i.test(text)) {
      return `PHP binary "${php}" not found in container "${conn.container}". Set the PHP binary for this project (e.g. /usr/local/bin/php).`
    }
  }
  return null
}

/** Best effort: stop the PHP process group inside the container. */
function killInContainer(docker: string, conn: DockerConnection, pid: number): void {
  const args = ['exec']
  if (conn.user) args.push('--user', conn.user)
  args.push(conn.container, 'sh', '-c', `kill -TERM -${pid} 2>/dev/null; sleep 2; kill -KILL -${pid} 2>/dev/null; true`)
  void runCapture(docker, args, { timeoutMs: 10_000, allowFailure: true, label: 'docker' }).catch(() => undefined)
}

const isDocker = (connection: Connection): connection is DockerConnection => connection.type === 'docker'

export interface DockerTransportOptions {
  /** Resolve the CLI path (tests inject a fake). Defaults to findDockerCli(). */
  findCli?(): string | null
  /** Running containers, to find a compose service's container and for hints. Defaults to listDockerContainers(). */
  listContainers?(): Promise<DockerContainer[]>
}

/** Hint listing a compose project's containers when `name` is a project name rather than a container. */
async function composeHint(name: string, list: () => Promise<DockerContainer[]>): Promise<string> {
  try {
    const names = (await list()).filter((c) => c.composeProject === name).map((c) => c.name)
    return names.length ? ` "${name}" is a compose project; its running containers are ${names.join(', ')}.` : ''
  } catch {
    return ''
  }
}

export function createDockerTransport(options: DockerTransportOptions = {}): Transport {
  const findCli = options.findCli ?? (() => findDockerCli())
  const list = options.listContainers ?? (() => listDockerContainers())
  return {
    id: 'docker',

    supports: isDocker,

    // The runner sees the container's paths and its own $HOME (global drivers in ~/.config/tinkerbox/drivers there).
    payloadDefaults: (connection) => ({ projectPath: connection.path, homePath: '' }),

    async run(req: TransportRequest): Promise<TransportResult> {
      if (!isDocker(req.connection)) throw new Error('The Docker transport only runs Docker connections')
      const docker = findCli()
      if (!docker) throw new Error(DOCKER_MISSING)
      let conn = req.connection
      let attempt = await execute(docker, conn, req)
      // A compose service recreated under another name (`down` + `up`, scaling…): run in its current container.
      if (attempt.missingContainer && conn.compose) {
        const current = await composeContainer(conn.compose.project, conn.compose.service, list)
        if (current && current !== conn.container) {
          conn = { ...conn, container: current }
          attempt = await execute(docker, conn, req)
        }
      }
      const { result, stderr, pidSeen } = attempt
      attempt.release()
      const stopped = result.timedOut || result.cancelled
      if (!stopped && result.exitCode !== 0) {
        const failure = dockerFailure(conn, result.exitCode, stderr, pidSeen)
        if (failure && !result.stdout.trim()) {
          if (attempt.missingContainer && !conn.compose) throw new Error(failure + (await composeHint(conn.container, list)))
          throw new Error(failure)
        }
      }
      const out: TransportResult = {
        stdout: result.stdout,
        stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        cancelled: result.cancelled
      }
      if (result.outputLimitExceeded) {
        out.error = `Output limit exceeded (${Math.round(DEFAULT_MAX_OUTPUT_BYTES / 1048576)} MB); the PHP process was stopped.`
      }
      return out
    }
  }
}

interface Attempt {
  result: ProcessResult
  /** stderr without the PID line. */
  stderr: string
  pidSeen: boolean
  /** Docker reported that the container does not exist (PHP never started). */
  missingContainer: boolean
  /** Pass on the stderr held back before PHP started (call once the attempt is kept). */
  release(): void
}

/** One `docker exec` of the bundle. Rejects only when the CLI cannot be started. */
async function execute(docker: string, conn: DockerConnection, req: TransportRequest): Promise<Attempt> {
  // Xdebug inside the container connects to whatever xdebug.client_host its php.ini sets.
  const flags = phpFlags({ debug: Boolean(conn.debug) })
  const filter = new PidLineFilter(req.onStderr)
  const result = await spawnStreaming(
    { command: docker, args: dockerExecArgs(conn, flags), env: process.env },
    {
      input: req.script,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onStdout: req.onStdout,
      onStderr: (chunk) => filter.push(chunk),
      onTerminate: () => {
        if (filter.pid !== null) killInContainer(docker, conn, filter.pid)
      }
    }
  )
  if (result.spawnError) {
    filter.flush(true)
    if (result.spawnError.code === 'ENOENT') throw new Error(DOCKER_MISSING)
    throw new Error(`Could not start docker (${docker}): ${result.spawnError.message}`)
  }
  const pidSeen = filter.pid !== null
  return {
    result,
    stderr: stripPidLine(result.stderr),
    pidSeen,
    missingContainer: !pidSeen && /No such container/i.test(result.stderr),
    release: () => filter.flush()
  }
}

/** Current container of a compose service (running ones first), or null. */
async function composeContainer(project: string, service: string, list: () => Promise<DockerContainer[]>): Promise<string | null> {
  try {
    const found = (await list()).filter((c) => c.composeProject === project && c.composeService === service)
    return found[0]?.name ?? null
  } catch {
    return null
  }
}

export const dockerTransport = createDockerTransport()
