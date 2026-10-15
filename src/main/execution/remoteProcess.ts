/**
 * PHP processes that run elsewhere (in a container, on a server) behind a local client (`docker exec`, `ssh`).
 * Killing the client does not stop the remote process, so a small `sh` wrapper reports the PID before it `exec`s
 * PHP, and the transport kills that process group remotely when a run is stopped. Both `docker exec` and sshd start
 * the command in a new session, so the PID is also the process group, which takes processes started by user code
 * (`shell_exec('sleep 100')`) down too.
 */

/** Written to stderr by the wrapper before PHP starts; stripped from the output. */
export const PID_MARKER = '__TINKERBOX_PID__'
const PID_LINE = new RegExp(`(^|\\n)${PID_MARKER} (\\d+)\\n`)

/** POSIX sh wrapper for `sh -c WRAPPER php <flags>`: report the PID, then replace the shell with PHP. */
export const WRAPPER = `printf '${PID_MARKER} %s\\n' "$$" >&2; exec "$0" "$@"`

/** Shell command that stops process group `pid` (TERM, then KILL after 2 s). */
export function killGroupCommand(pid: number): string {
  return `kill -TERM -${pid} 2>/dev/null; sleep 2; kill -KILL -${pid} 2>/dev/null; true`
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

