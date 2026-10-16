/**
 * The MCP server's lifecycle: follows `settings.mcp` (start, stop, restart on a port change), creates the bearer
 * token the first time it is enabled, and reports its state for Settings (`mcp:status`).
 */
import { randomBytes } from 'node:crypto'
import type { McpStatus, Settings } from '@shared/types'
import { McpHttpServer, type McpServerOptions } from './server'

export interface McpControllerOptions extends Omit<McpServerOptions, 'token'> {
  getSettings(): Settings
  /** Persist a new token (sealed by the settings store). */
  saveToken(token: string): void
}

export function newMcpToken(): string {
  return randomBytes(32).toString('base64url')
}

/** `claude mcp add` command for the connect instructions in Settings (user scope: available in every project). */
export function claudeMcpCommand(url: string, token: string): string {
  return `claude mcp add --transport http --scope user tinkerbox ${url} --header "Authorization: Bearer ${token}"`
}

export class McpController {
  private readonly server: McpHttpServer
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly options: McpControllerOptions) {
    this.server = new McpHttpServer({ ...options, token: () => this.options.getSettings().mcp.token })
  }

  /** Bring the server in line with the settings (calls are queued, so a quick on/off/on ends in the right state). */
  apply(): Promise<void> {
    this.pending = this.pending.then(() => this.applyNow()).catch(() => undefined)
    return this.pending
  }

  /** Resolves once queued apply() calls are done (before reporting the state). */
  settled(): Promise<void> {
    return this.pending
  }

  private async applyNow(): Promise<void> {
    const { enabled, port, token } = this.options.getSettings().mcp
    if (!enabled) {
      await this.server.stop()
      return
    }
    if (!token) this.options.saveToken(newMcpToken())
    await this.server.start(port)
  }

  async regenerateToken(): Promise<McpStatus> {
    this.options.saveToken(newMcpToken())
    return this.status()
  }

  status(): McpStatus {
    const { enabled, port, token } = this.options.getSettings().mcp
    const state = this.server.state()
    const url = `http://127.0.0.1:${port}/mcp`
    return {
      enabled,
      running: state.running,
      url,
      token,
      command: token ? claudeMcpCommand(url, token) : '',
      error: enabled ? state.error : ''
    }
  }

  dispose(): Promise<void> {
    return this.server.stop()
  }
}
