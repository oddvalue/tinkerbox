/**
 * McpDeps backed by the running app: saved connections, the run service (so MCP runs show up in History and the
 * stats like editor runs), the execution data modes, the renderer's tabs (through McpUiBridge) and a native
 * confirmation for runs without a tab.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog } from 'electron'
import { runOptionsFromSettings } from '@shared/defaults'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID, type Connection, type RunRequest } from '@shared/types'
import { listLogs, readLog, testConnection } from '../execution'
import type { ShellContext } from '../ipc/context'
import { connectionTarget, type McpDeps } from './tools'
import type { McpUiBridge } from './uiBridge'

/** History entries and run ids of MCP runs use this tab id. */
export const MCP_TAB_ID = 'mcp'

const CODE_PREVIEW_CHARS = 1500

async function confirmRun(conn: Connection, code: string, client: string): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (parent) {
    if (parent.isMinimized()) parent.restore()
    parent.show()
    parent.focus()
  }
  const preview = code.length > CODE_PREVIEW_CHARS ? `${code.slice(0, CODE_PREVIEW_CHARS)}\n…` : code
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Cancel', 'Run'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: conn.production ? 'Run on production?' : 'Run code from an agent?',
    message: `${client} wants to run code on ${conn.production ? 'the production project ' : ''}${conn.name}`,
    detail: `${connectionTarget(conn)}\n\n${preview}`
  }
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return response === 1
}

export function createMcpDeps(ctx: ShellContext, bridge: McpUiBridge): McpDeps {
  const ready = async <T>(fn: () => Promise<T>): Promise<T> => {
    await ctx.envReady
    return fn()
  }
  return {
    projects: () => {
      // The implicit ones first, as on the Get started tab; the stored entries of sandbox/scratch only carry settings.
      const implicit = [ctx.exec.resolveConnection(SANDBOX_CONNECTION_ID), ctx.exec.resolveConnection(SCRATCH_CONNECTION_ID)]
      const saved = ctx.connections.list().filter((c) => c.id !== SANDBOX_CONNECTION_ID && c.id !== SCRATCH_CONNECTION_ID)
      return [...implicit, ...saved]
    },
    defaultProject: () => ctx.exec.resolveConnection(null),
    runPolicy: () => ctx.settings.get().mcp.runPolicy,
    run: (conn, code, timeoutMs) => {
      const settings = ctx.settings.get()
      const options = runOptionsFromSettings(settings, true)
      if (timeoutMs) options.timeoutMs = timeoutMs
      // Unique run ids: runCode cancels a running script when a run id is reused.
      const request: RunRequest = { runId: `${MCP_TAB_ID}-${randomUUID()}`, tabId: MCP_TAB_ID, connectionId: conn.id, code, options }
      return ctx.runs.run(request)
    },
    test: (conn) => ready(() => testConnection(ctx.exec, conn)),
    listLogs: (conn) => ready(() => listLogs(ctx.exec, conn.id)),
    readLog: (conn, file, limit) => ready(() => readLog(ctx.exec, { connectionId: conn.id, file, limit })),
    confirmRun,
    ui: (request, timeoutMs) => bridge.request(request, timeoutMs)
  }
}
