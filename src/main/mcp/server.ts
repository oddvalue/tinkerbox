/**
 * MCP server for coding agents: Streamable HTTP (JSON responses, stateless) on 127.0.0.1 only.
 *
 * Every request must carry `Authorization: Bearer <token>`; requests from browsers (an `Origin` header) and with a
 * `Host` other than 127.0.0.1 / localhost (DNS rebinding) are refused before they reach the MCP SDK. Each request
 * gets its own McpServer + transport, so no state is kept between calls.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { clientName, registerTools, type McpDeps } from './tools'

const MAX_BODY_BYTES = 2 * 1024 * 1024

const INSTRUCTIONS = [
  'Tinkerbox is the user\'s desktop app for running PHP inside their projects (local folders, Docker containers, SSH servers) with the framework booted, like `php artisan tinker`.',
  'Use it to put code in front of the user: open_tab opens a tab with your code in a project so they can review, edit and run it; wait_for_run returns the result once they have run it, and get_tab shows the code as they left it.',
  'Results show output, dumps, SQL queries with bindings, exceptions and the value of the last expression.',
  'Whether you may run code yourself (run_tab, run_php) is the user\'s choice; list_projects reports it as runPolicy (review: the user runs it; ask: each run asks them; allow: no question, except on production projects).',
  'Code runs for real against the project\'s database and services.'
].join(' ')

export interface McpServerOptions {
  deps: McpDeps
  version: string
  /** Current bearer token ('' refuses every request). */
  token(): string
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

export interface McpServerState {
  running: boolean
  port: number
  error: string
}

/** Constant-time comparison of the Authorization header with the expected token. */
export function authorized(header: string | undefined, token: string): boolean {
  if (!token || !header) return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!match) return false
  const given = Buffer.from(match[1])
  const wanted = Buffer.from(token)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** Host header of a request to this server: 127.0.0.1, localhost or [::1], with our port. */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class McpHttpServer {
  private server: Server | null = null
  private port = 0
  private error = ''

  constructor(private readonly options: McpServerOptions) {}

  state(): McpServerState {
    return { running: this.server !== null, port: this.port, error: this.error }
  }

  /** Listen on 127.0.0.1:`port` (restarts when the port changed). Never rejects; failures end up in state().error. */
  async start(port: number): Promise<void> {
    if (this.server && this.port === port) return
    await this.stop()
    this.port = port
    this.error = ''
    const server = createServer((req, res) => void this.handle(req, res))
    // Long PHP runs keep the request open; the run's own timeout ends them.
    server.requestTimeout = 0
    server.headersTimeout = 30_000
    await new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.error =
          err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port.` : `Could not start the MCP server: ${err.message}`
        this.options.logger?.warn('MCP server:', this.error)
        resolve()
      })
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.error = ''
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? '').split('?')[0]
      if (path !== '/mcp') return sendJson(res, 404, rpcError(-32601, 'Not found: the MCP endpoint is /mcp'))
      // Browsers always send Origin on cross-site requests; MCP clients do not. Refusing them keeps web pages out.
      if (req.headers.origin) return sendJson(res, 403, rpcError(-32000, 'Requests from web pages are not allowed'))
      if (!allowedHost(req.headers.host, this.port)) return sendJson(res, 403, rpcError(-32000, 'Invalid Host header'))
      if (!authorized(req.headers.authorization, this.options.token())) {
        return sendJson(res, 401, rpcError(-32001, 'Missing or wrong bearer token (see Tinkerbox → Settings → Advanced → MCP server)'), {
          'WWW-Authenticate': 'Bearer realm="tinkerbox"'
        })
      }
      // Stateless server: no SSE stream to resume (GET) and no session to end (DELETE).
      if (req.method !== 'POST') return sendJson(res, 405, rpcError(-32000, 'Method not allowed'), { Allow: 'POST' })

      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        return sendJson(res, 400, rpcError(-32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`))
      }

      const mcp = new McpServer({ name: 'tinkerbox', title: 'Tinkerbox', version: this.options.version }, { instructions: INSTRUCTIONS })
      registerTools(mcp, this.options.deps, clientName(req.headers['user-agent']))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      this.options.logger?.error('MCP request failed:', err)
      sendJson(res, 500, rpcError(-32603, 'Internal error'))
    }
  }
}
