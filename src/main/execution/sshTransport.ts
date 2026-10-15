/**
 * SSH transport: `ssh -T -o BatchMode=yes … <host> "exec sh -c '…' tinkerbox <path> php <flags>"` with the bundle on
 * stdin. Login is the user's own ssh setup (keys, agent, ~/.ssh/config); BatchMode makes a password or host-key
 * prompt fail fast instead of hanging. Nothing is copied to the server.
 *
 * The remote command is parsed by the user's login shell (bash, zsh, fish…), so it is built from single-quoted words
 * only; the wrapper itself runs under `sh`. Like `docker exec`, killing the local client does not stop PHP on the
 * server: the wrapper reports its PID (sshd starts the command in a new session, so it is the process group) and
 * stopping a run kills that group over a second ssh call. On macOS and Linux a shared connection (ControlMaster,
 * kept 60 s) makes every run after the first start without a new SSH handshake.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connection, SshConnection } from '@shared/types'
import { findExecutable } from '../env/which'
import { phpFlags } from './argv'
import { DEFAULT_MAX_OUTPUT_BYTES, runCapture, spawnStreaming, summarizeOutput } from './process'
import { PID_MARKER, PidLineFilter, killGroupCommand, stripPidLine } from './remoteProcess'
import type { Transport, TransportRequest, TransportResult } from './transport'

/** Exit code of the wrapper when the project directory does not exist on the server. */
const NO_PROJECT_DIR = 97

/** `sh -c` script: cd into $1 (when set), report the PID, then exec the rest (php <flags>). No ' or \ inside. */
const SSH_WRAPPER = `if [ -n "$1" ]; then cd "$1" || exit ${NO_PROJECT_DIR}; fi; shift; echo "${PID_MARKER} $$" >&2; exec "$@"`

/** Single-quote a word for a POSIX shell (also understood by fish). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const SSH_MISSING = 'ssh not found. Install the OpenSSH client (or set TINKERBOX_SSH to its path) and restart Tinkerbox.'

/** The OpenSSH client: `TINKERBOX_SSH` when set, else `ssh` on PATH or in the usual folders. */
export function findSshCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const extra = process.platform === 'win32' ? ['C:\\Windows\\System32\\OpenSSH'] : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
  return findExecutable(env.TINKERBOX_SSH?.trim() || 'ssh', extra)
}

/** Options for every ssh call: no prompts, fail fast, detect dead connections, and share one connection. */
export function sshOptions(conn: SshConnection, controlDir: string | null): string[] {
  const options = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']
  // Windows' OpenSSH has no ControlMaster support.
  if (controlDir) options.push('-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${join(controlDir, '%C')}`)
  if (conn.port) options.push('-p', String(conn.port))
  return options
}

/** Arguments for the ssh call that runs PHP (with `flags`) in the project directory through the wrapper. */
export function sshRunArgs(conn: SshConnection, flags: string[], controlDir: string | null): string[] {
  const words = ['exec', 'sh', '-c', SSH_WRAPPER, 'tinkerbox', conn.path, conn.phpBinary || 'php', ...flags]
  const remote = words.map((w, i) => (i < 3 ? w : shellQuote(w))).join(' ')
  return [...sshOptions(conn, controlDir), '--', conn.host, remote]
}

/** Turn a failed ssh run into an actionable message (null when it is a PHP failure the runner reports). */
export function sshFailure(conn: SshConnection, exitCode: number | null, stderr: string, startedWrapper: boolean): string | null {
  const text = stderr.trim()
  const host = conn.host
  if (!startedWrapper) {
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
      return `The host key of ${host} has changed. If that is expected, remove the old key (ssh-keygen -R ${host}) and run \`ssh ${host}\` once in a terminal.`
    }
    if (/Host key verification failed|No .*host key is known|host key for .* is not known/i.test(text)) {
      return `The host key of ${host} is not known yet. Run \`ssh ${host}\` once in a terminal to check and accept it.`
    }
    if (/Permission denied/i.test(text)) {
      return `Permission denied by ${host}. Tinkerbox logs in with your SSH keys and agent (password logins are not supported): check that \`ssh ${host}\` works without a password.`
    }
    if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(text)) return `Unknown host: ${host}. Check the name or the Host entry in ~/.ssh/config.`
    if (/Connection refused|timed out|No route to host|Network is unreachable|Connection closed by|Connection reset/i.test(text)) {
      return `Cannot reach ${host}: ${summarizeOutput(text, 200)}`
    }
    if (exitCode === NO_PROJECT_DIR) return `Project directory not found on ${host}: ${conn.path}`
    if (exitCode === 255) return `ssh ${host} failed: ${summarizeOutput(text, 400) || 'no output'}`
    if (/sh: .*not found|command not found/i.test(text)) return `${host} has no /bin/sh, which Tinkerbox needs to run PHP.`
    return `ssh ${host} failed${exitCode !== null ? ` (exit code ${exitCode})` : ''}: ${summarizeOutput(text, 400) || 'no output'}`
  }
  if ((exitCode === 127 || exitCode === 126) && /not found|No such file|cannot execute|Permission denied/i.test(text)) {
    return `PHP binary "${conn.phpBinary || 'php'}" not found on ${host}. Set the PHP binary for this server (e.g. /usr/bin/php8.3).`
  }
  return null
}

const isSsh = (connection: Connection): connection is SshConnection => connection.type === 'ssh'

export interface SshTransportOptions {
  /** Resolve the CLI path (tests inject a wrapper). Defaults to findSshCli(). */
  findCli?(): string | null
  /** Folder for ControlMaster sockets; null disables connection sharing. Defaults to <tmp>/tinkerbox-ssh (not on Windows). */
  controlDir?: string | null
}

function defaultControlDir(): string | null {
  if (process.platform === 'win32') return null
  // Socket paths are limited to ~104 bytes: keep the folder short (%C adds a 40-character hash).
  const dir = join(tmpdir(), `tinkerbox-ssh-${process.getuid?.() ?? ''}`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  } catch {
    return null
  }
}

export function createSshTransport(options: SshTransportOptions = {}): Transport {
  const findCli = options.findCli ?? (() => findSshCli())
  let controlDir: string | null | undefined = options.controlDir
  const control = (): string | null => (controlDir === undefined ? (controlDir = defaultControlDir()) : controlDir)

  return {
    id: 'ssh',

    supports: isSsh,

    // The runner sees the server's paths and the login user's $HOME (global drivers in ~/.config/tinkerbox/drivers there).
    payloadDefaults: (connection) => ({ projectPath: connection.path, homePath: '' }),

    async run(req: TransportRequest): Promise<TransportResult> {
      if (!isSsh(req.connection)) throw new Error('The SSH transport only runs SSH connections')
      const conn = req.connection
      const ssh = findCli()
      if (!ssh) throw new Error(SSH_MISSING)
      const dir = control()

      const filter = new PidLineFilter(req.onStderr)
      const result = await spawnStreaming(
        { command: ssh, args: sshRunArgs(conn, phpFlags({ debug: Boolean(conn.debug) }), dir), env: process.env },
        {
          input: req.script,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          onStdout: req.onStdout,
          onStderr: (chunk) => filter.push(chunk),
          onTerminate: () => {
            if (filter.pid === null) return
            const remote = `exec sh -c ${shellQuote(killGroupCommand(filter.pid))}`
            void runCapture(ssh, [...sshOptions(conn, dir), '--', conn.host, remote], { timeoutMs: 20_000, allowFailure: true, label: 'ssh' }).catch(
              () => undefined
            )
          }
        }
      )
      filter.flush()
      if (result.spawnError) {
        if (result.spawnError.code === 'ENOENT') throw new Error(SSH_MISSING)
        throw new Error(`Could not start ssh (${ssh}): ${result.spawnError.message}`)
      }
      const stderr = stripPidLine(result.stderr)
      const stopped = result.timedOut || result.cancelled
      if (!stopped && result.exitCode !== 0) {
        const failure = sshFailure(conn, result.exitCode, stderr, filter.pid !== null)
        if (failure && !result.stdout.trim()) throw new Error(failure)
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

export const sshTransport = createSshTransport()
