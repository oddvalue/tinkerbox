/**
 * Requests from the MCP server to the renderer, which owns the tabs: each request goes out as an `mcp:request`
 * event with an id, and the renderer answers through `mcp:respond` with the same id. Requests that do not get an
 * answer in time (no window, the page reloaded) reject with a message the agent can act on.
 */
import { randomUUID } from 'node:crypto'
import type { McpUiReply, McpUiRequest, McpUiResponses } from '@shared/types'

type Method = McpUiRequest['method']
type RequestOf<M extends Method> = Extract<McpUiRequest, { method: M }>

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Methods that change what the user sees bring the window to the front. */
const FOCUS: ReadonlySet<Method> = new Set<Method>(['openTab', 'updateTab', 'runTab'])

export class McpUiBridge {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly send: (id: string, request: McpUiRequest, focus: boolean) => void) {}

  request<M extends Method>(request: RequestOf<M>, timeoutMs: number): Promise<McpUiResponses[M]> {
    const id = randomUUID()
    return new Promise<McpUiResponses[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Tinkerbox did not answer in time. Is its window open? Try again.'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.send(id, request, FOCUS.has(request.method))
    })
  }

  /** An `mcp:respond` from the renderer. Unknown ids (timed out) are ignored. */
  respond(id: string, reply: McpUiReply): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (reply.ok) entry.resolve(reply.value)
    else entry.reject(new Error(reply.error))
  }

  dispose(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Tinkerbox is quitting.'))
      this.pending.delete(id)
    }
  }
}
