/**
 * Docker transport: `docker exec -i [--user u] [--workdir path] <container> sh -c '…' php <flags>` with the bundle
 * on stdin. The project and PHP live in a running container; nothing is copied into it.
 *
 * Killing the local `docker exec` client does not stop the process inside the container (signals are not forwarded
 * without a TTY). The wrapper therefore prints its PID on stderr before it `exec`s PHP, and stopping a run (cancel,
 * timeout, output limit) also runs `kill -TERM -<pid>` in the container. `docker exec` makes PHP a process-group
 * leader, so the negative PID also stops processes started by user code.
 */
import type { Connection, DockerConnection } from '@shared/types'
import { expandHome, findExecutable } from '../env/which'
import { phpFlags } from './argv'
import { DEFAULT_MAX_OUTPUT_BYTES, runCapture, spawnStreaming, summarizeOutput } from './process'
import type { Transport, TransportRequest, TransportResult } from './transport'

/** Written to stderr by the wrapper before PHP starts; stripped from the output. */
export const PID_MARKER = '__TINKERBOX_PID__'
const PID_LINE = new RegExp(`^${PID_MARKER} (\\d+)\\n`)

/** POSIX sh wrapper: report the PID (= process group, see the header), then replace the shell with PHP. */
const WRAPPER = `printf '${PID_MARKER} %s\\n' "$$" >&2; exec "$0" "$@"`

/** Where Docker Desktop, OrbStack, Colima and Homebrew put the CLI; GUI apps often start without them on PATH. */
const DOCKER_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '~/.orbstack/bin',
  '~/.docker/bin',
  '/Applications/Docker.app/Contents/Resources/bin',
  '/Applications/OrbStack.app/Contents/MacOS/xbin'
]

/**
 * The container CLI: `TINKERBOX_DOCKER` when set (a path or a name such as `podman`), else `docker` on PATH or in
 * the usual install folders. Returns null when none is found.
 */
export function findDockerCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.TINKERBOX_DOCKER?.trim()
  if (override) return findExecutable(override, DOCKER_DIRS.map((d) => expandHome(d)))
  return findExecutable('docker', DOCKER_DIRS.map((d) => expandHome(d)))
}

const DOCKER_MISSING =
  'Docker CLI not found. Install Docker (or set TINKERBOX_DOCKER to the path of a compatible CLI such as podman) and restart Tinkerbox.'

/** Arguments for `docker exec` that run PHP (with `flags`) through the PID-reporting wrapper. */
export function dockerExecArgs(conn: DockerConnection, flags: string[]): string[] {
  const args = ['exec', '-i']
  if (conn.user) args.push('--user', conn.user)
  if (conn.path) args.push('--workdir', conn.path)
  args.push(conn.container, 'sh', '-c', WRAPPER, conn.phpBinary || 'php', ...flags)
  return args
}

/** Splits the wrapper's PID line off the front of the stderr stream; everything else passes through. */
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
    const newline = this.buffer.indexOf('\n')
    // Docker's own errors (no such container…) arrive instead of the marker: pass them on unchanged.
    if (newline === -1 && PID_MARKER.startsWith(this.buffer.slice(0, PID_MARKER.length)) && this.buffer.length < 64) return
    this.done = true
    const match = PID_LINE.exec(this.buffer)
    if (match) this.pid = Number(match[1])
    const rest = match ? this.buffer.slice(match[0].length) : this.buffer
    this.buffer = ''
    if (rest) this.forward(rest)
  }

  /** Text held back while waiting for a complete first line (the process ended mid-line). */
  flush(): void {
    if (!this.done && this.buffer) this.forward(this.buffer)
    this.done = true
    this.buffer = ''
  }
}

/** Remove the wrapper's PID line from captured stderr. */
export function stripPidLine(stderr: string): string {
  return stderr.replace(PID_LINE, '')
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
}

export function createDockerTransport(options: DockerTransportOptions = {}): Transport {
  const findCli = options.findCli ?? (() => findDockerCli())
  return {
    id: 'docker',

    supports: isDocker,

    // The runner sees the container's paths and its own $HOME (global drivers in ~/.config/tinkerbox/drivers there).
    payloadDefaults: (connection) => ({ projectPath: connection.path, homePath: '' }),

    async run(req: TransportRequest): Promise<TransportResult> {
      if (!isDocker(req.connection)) throw new Error('The Docker transport only runs Docker connections')
      const conn = req.connection
      const docker = findCli()
      if (!docker) throw new Error(DOCKER_MISSING)

      // Xdebug inside the container connects to whatever xdebug.client_host its php.ini sets.
      const flags = phpFlags({ debug: Boolean(conn.debug) })
      const stderr = new PidLineFilter(req.onStderr)
      const result = await spawnStreaming(
        { command: docker, args: dockerExecArgs(conn, flags), env: process.env },
        {
          input: req.script,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          onStdout: req.onStdout,
          onStderr: (chunk) => stderr.push(chunk),
          onTerminate: () => {
            if (stderr.pid !== null) killInContainer(docker, conn, stderr.pid)
          }
        }
      )
      stderr.flush()
      if (result.spawnError) {
        if (result.spawnError.code === 'ENOENT') throw new Error(DOCKER_MISSING)
        throw new Error(`Could not start docker (${docker}): ${result.spawnError.message}`)
      }
      const cleanStderr = stripPidLine(result.stderr)
      const stopped = result.timedOut || result.cancelled
      if (!stopped && result.exitCode !== 0) {
        const failure = dockerFailure(conn, result.exitCode, cleanStderr, stderr.pid !== null)
        if (failure && !result.stdout.trim()) throw new Error(failure)
      }
      const out: TransportResult = {
        stdout: result.stdout,
        stderr: cleanStderr,
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

export const dockerTransport = createDockerTransport()
