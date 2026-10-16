/**
 * MCP tools: what a coding agent connected to Tinkerbox can do.
 *
 * The main use is to drive the app for a person: open a tab with prepared code in the right project, let the user
 * review, edit and run it, and read the result back (`open_tab`, `wait_for_run`, `get_tab`…). Whether agents may run
 * code themselves (`run_tab`, `run_php`) is the user's choice (`settings.mcp.runPolicy`). Results are the plain text
 * the app copies to the clipboard. Everything the tools need is injected (`McpDeps`), so they are tested without
 * Electron or HTTP.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  Connection,
  ConnectionTestResult,
  LogEntry,
  LogListing,
  McpRunPolicy,
  McpTabInfo,
  McpUiRequest,
  McpUiResponses,
  RunResult
} from '@shared/types'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID } from '@shared/types'
import { resultToText } from '@shared/text/dumpText'

type UiMethod = McpUiRequest['method']

export interface McpDeps {
  /** Saved projects plus the implicit Default (Laravel Sandbox) and PHP (plain PHP) connections. */
  projects(): Connection[]
  /** The connection the editor's "default" resolves to (Default Working Directory → Sandbox → PHP). */
  defaultProject(): Connection
  /** settings.mcp.runPolicy */
  runPolicy(): McpRunPolicy
  /** Run without a tab (run_php). */
  run(conn: Connection, code: string, timeoutMs: number | undefined): Promise<RunResult>
  test(conn: Connection): Promise<ConnectionTestResult>
  listLogs(conn: Connection): Promise<LogListing>
  readLog(conn: Connection, file: string, limit: number): Promise<LogEntry[]>
  /** Ask the user before a run_php; `production` words it for a live system. Resolves true when allowed. */
  confirmRun(conn: Connection, code: string, client: string): Promise<boolean>
  /** Act on the app's tabs (the renderer owns them). */
  ui<M extends UiMethod>(request: Extract<McpUiRequest, { method: M }>, timeoutMs: number): Promise<McpUiResponses[M]>
}

/** Where a connection runs, for humans: a folder, `container:/path` or `host:/path`. */
export function connectionTarget(conn: Connection): string {
  if (conn.type === 'docker') return conn.path ? `${conn.container}:${conn.path}` : `${conn.container} (plain PHP)`
  if (conn.type === 'ssh') return conn.path ? `${conn.host}:${conn.path}` : `${conn.host} (plain PHP)`
  if (conn.id === SCRATCH_CONNECTION_ID || !conn.path) return 'plain PHP on this machine'
  return conn.path
}

export function projectSummary(conn: Connection): Record<string, unknown> {
  return {
    id: conn.id,
    name: conn.name,
    type: conn.type,
    target: connectionTarget(conn),
    production: Boolean(conn.production)
  }
}

/**
 * Find a project by id or (case-insensitive) name; the default project when `ref` is empty. Throws a message
 * listing the projects when nothing or more than one matches.
 */
export function findProject(deps: Pick<McpDeps, 'projects' | 'defaultProject'>, ref: string | undefined): Connection {
  const wanted = (ref ?? '').trim()
  if (!wanted) return deps.defaultProject()
  const projects = deps.projects()
  const byId = projects.find((p) => p.id === wanted)
  if (byId) return byId
  const byName = projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase())
  if (byName.length === 1) return byName[0]
  const names = projects.map((p) => `${p.name} (${p.id})`).join(', ')
  if (byName.length > 1) throw new Error(`Several projects are called "${wanted}"; use the id instead: ${names}`)
  throw new Error(`No project "${wanted}". Projects: ${names || 'none'}. Call list_projects for details.`)
}

/** A friendly name for the MCP client from its User-Agent ("Claude Code", "Cursor"…). */
export function clientName(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  if (/claude-code|claude-cli|claudecode/i.test(ua)) return 'Claude Code'
  if (/claude/i.test(ua)) return 'Claude'
  const product = /^([A-Za-z][\w.-]{1,40})\//.exec(ua)?.[1]
  return product && !/^(node|undici|python|axios|curl|go-http-client|okhttp)/i.test(product) ? product : 'A coding agent'
}

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] })
const failure = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }], isError: true })

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err))
  }
}

/** Plain-text report of a run, as "Copy output" would produce it. */
export function resultText(result: RunResult): string {
  return resultToText(result, { showQueries: true, stats: true }).trim() || '(no output)'
}

/** Plain-text report of a run without a tab, with where it ran on top. */
export function runReport(conn: Connection, result: RunResult): string {
  const header = `Ran on ${conn.name} (${connectionTarget(conn)})${result.phpVersion ? `, PHP ${result.phpVersion}` : ''}${
    result.driver && result.driver.id !== 'none' ? `, ${result.driver.appVersion || result.driver.name}` : ''
  }`
  return `${header}\n\n${resultText(result)}`
}

/** A tab with its code and, when given, its last result. */
export function tabReport(tab: McpTabInfo, result: RunResult | null | undefined): string {
  const lines = [
    `Tab ${tab.id} "${tab.title}": ${tab.projectName} (${tab.projectTarget})${tab.production ? ', PRODUCTION' : ''}${tab.running ? ', running' : ''}${tab.active ? ', active' : ''}`,
    '',
    'Code:',
    tab.code.trim() ? tab.code : '(empty)'
  ]
  if (result) lines.push('', `Last run (${new Date(result.finishedAt).toISOString()}):`, resultText(result))
  else if (result === null) lines.push('', 'Not run yet.')
  return lines.join('\n')
}

const runFailed = (result: RunResult): boolean => Boolean(result.error) || Boolean(result.exception) || result.timedOut === true

/** How long UI requests may take: quick ones, and the ones that wait for a run or a person. */
const UI_TIMEOUT_MS = 15_000
const RUN_TIMEOUT_MS = 24 * 60 * 60_000

const REVIEW_ONLY =
  'Running code is left to the user in Tinkerbox (Settings → Advanced → MCP server → Agents can run code). Use open_tab to put the code in a tab, ask the user to review and run it, then call wait_for_run to get the result.'

const projectArg = z
  .string()
  .optional()
  .describe('Project id or name from list_projects. Omit to use the default project (the one new editor tabs use).')
const tabArg = z.string().min(1).max(200).describe('Tab id from open_tab or list_tabs.')

/**
 * Register the tools on a per-request McpServer. `client` is the requesting client's name, shown to the user in
 * toasts and confirmations.
 */
export function registerTools(server: McpServer, deps: McpDeps, client = 'A coding agent'): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'Projects Tinkerbox can run PHP in: local folders, Docker containers and SSH servers, plus "Default" (the Laravel Sandbox) and "PHP" (plain PHP without a framework). Projects marked production ask the user before each run.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      guarded(async () => {
        const defaultId = deps.defaultProject().id
        const projects = deps.projects().map((p) => ({ ...projectSummary(p), default: p.id === defaultId }))
        return { ...text(JSON.stringify({ runPolicy: deps.runPolicy(), projects }, null, 2)), structuredContent: { runPolicy: deps.runPolicy(), projects } }
      })
  )

  server.registerTool(
    'open_tab',
    {
      title: 'Open a tab with code',
      description: [
        'Open a new tab in the Tinkerbox app with PHP code in a project, ready for the user to review, edit and run.',
        'Nothing runs: the user presses Run (or call run_tab when the user allows agents to run code).',
        'Code runs with the framework booted, like `php artisan tinker`: `<?php` is optional, the value of the last expression is shown, and short class names work (`User::first()`).',
        'Then call wait_for_run to get the result once the user has run it, or get_tab to read the code they may have changed.'
      ].join(' '),
      inputSchema: {
        code: z.string().min(1).max(1_000_000).describe('PHP code for the tab.'),
        project: projectArg,
        title: z.string().max(80).optional().describe('Short tab title, e.g. "Find users without orders".')
      }
    },
    async ({ code, project, title }) =>
      guarded(async () => {
        const conn = project ? findProject(deps, project) : null
        const tab = await deps.ui({ method: 'openTab', params: { code, connectionId: conn?.id ?? null, title, client } }, UI_TIMEOUT_MS)
        const next =
          deps.runPolicy() === 'review'
            ? 'Ask the user to review and run it in Tinkerbox, then call wait_for_run.'
            : 'Ask the user to review it, then call run_tab (or wait_for_run if they run it themselves).'
        return { ...text(`Opened tab ${tab.id} in Tinkerbox for ${tab.projectName} (${tab.projectTarget}). ${next}`), structuredContent: { tab } }
      })
  )

  server.registerTool(
    'list_tabs',
    {
      title: 'List tabs',
      description: 'Code tabs open in Tinkerbox, with their project, current code (including the user\'s edits) and whether they ran.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      guarded(async () => {
        const tabs = await deps.ui({ method: 'listTabs' }, UI_TIMEOUT_MS)
        return { ...text(tabs.length ? tabs.map((t) => tabReport(t, undefined)).join('\n\n---\n\n') : 'No code tabs are open.'), structuredContent: { tabs } }
      })
  )

  server.registerTool(
    'get_tab',
    {
      title: 'Read a tab',
      description: "A tab's current code (the user may have edited it) and the result of its last run.",
      inputSchema: { tab_id: tabArg },
      annotations: { readOnlyHint: true }
    },
    async ({ tab_id }) =>
      guarded(async () => {
        const { tab, result } = await deps.ui({ method: 'getTab', params: { tabId: tab_id } }, UI_TIMEOUT_MS)
        return text(tabReport(tab, result))
      })
  )

  server.registerTool(
    'update_tab',
    {
      title: 'Replace the code in a tab',
      description: 'Replace the code of a tab you opened (for example after the user asked for a change). It does not run.',
      inputSchema: { tab_id: tabArg, code: z.string().min(1).max(1_000_000).describe('The new PHP code.') }
    },
    async ({ tab_id, code }) =>
      guarded(async () => {
        const tab = await deps.ui({ method: 'updateTab', params: { tabId: tab_id, code, client } }, UI_TIMEOUT_MS)
        return text(`Updated tab ${tab.id}. Ask the user to review and run it, then call wait_for_run.`)
      })
  )

  server.registerTool(
    'wait_for_run',
    {
      title: 'Wait for the user to run a tab',
      description:
        'Wait until the user runs a tab in Tinkerbox and return its result (output, dumps, SQL queries, exceptions, return value). Returns right away when the tab already finished a run after `since`.',
      inputSchema: {
        tab_id: tabArg,
        timeout_seconds: z.number().int().min(1).max(3600).optional().describe('How long to wait (default 300).'),
        since: z
          .string()
          .optional()
          .describe('ISO time; only a run that finished after it counts. Omit to count only runs that finish after this call starts.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ tab_id, timeout_seconds, since }) =>
      guarded(async () => {
        const timeoutMs = (timeout_seconds ?? 300) * 1000
        const sinceMs = since ? Date.parse(since) : Date.now()
        if (Number.isNaN(sinceMs)) return failure(`Invalid since: ${since}`)
        const { tab, result } = await deps.ui({ method: 'waitForRun', params: { tabId: tab_id, since: sinceMs, timeoutMs } }, timeoutMs + 10_000)
        if (!result) return text(`Tab ${tab.id} was not run within ${Math.round(timeoutMs / 1000)} s. Call wait_for_run again to keep waiting.`)
        const report = tabReport(tab, result)
        return runFailed(result) ? failure(report) : text(report)
      })
  )

  server.registerTool(
    'run_tab',
    {
      title: 'Run a tab',
      description:
        'Run a tab in Tinkerbox as if the user pressed Run, and return the result. Only works when the user lets agents run code (otherwise ask them to run it and call wait_for_run). Production projects always ask the user first.',
      inputSchema: { tab_id: tabArg },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ tab_id }) =>
      guarded(async () => {
        const policy = deps.runPolicy()
        if (policy === 'review') return failure(REVIEW_ONLY)
        const { tab, result, declined } = await deps.ui(
          { method: 'runTab', params: { tabId: tab_id, client, confirm: policy === 'ask' } },
          RUN_TIMEOUT_MS
        )
        if (declined || !result) return failure(`The user declined to run tab ${tab.id}. Ask what they want changed.`)
        const report = tabReport(tab, result)
        return runFailed(result) ? failure(report) : text(report)
      })
  )

  server.registerTool(
    'run_php',
    {
      title: 'Run PHP without a tab',
      description: [
        'Run PHP code in a project in the background (no tab) and return the result. Only works when the user lets agents run code; prefer open_tab so the user sees the code.',
        'Each call is a fresh PHP process with the framework booted. The code runs for real against the project (database, cache, files): prefer read-only code.'
      ].join(' '),
      inputSchema: {
        code: z.string().min(1).max(1_000_000).describe('PHP code to run.'),
        project: projectArg,
        timeout_seconds: z.number().int().min(1).max(600).optional().describe('Stop the script after this many seconds (default: the app setting).')
      },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ code, project, timeout_seconds }) =>
      guarded(async () => {
        const policy = deps.runPolicy()
        if (policy === 'review') return failure(REVIEW_ONLY)
        const conn = findProject(deps, project)
        if ((policy === 'ask' || conn.production) && !(await deps.confirmRun(conn, code, client))) {
          return failure(`The user declined to run this code on ${conn.name}.`)
        }
        const result = await deps.run(conn, code, timeout_seconds ? timeout_seconds * 1000 : undefined)
        const report = runReport(conn, result)
        return runFailed(result) ? failure(report) : text(report)
      })
  )

  server.registerTool(
    'project_info',
    {
      title: 'Project info',
      description: 'Check that PHP runs in a project and report the PHP version and the detected framework and version. Boots the project but runs no user code.',
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true }
    },
    async ({ project }) =>
      guarded(async () => {
        const conn = findProject(deps, project)
        const test = await deps.test(conn)
        const info = {
          ...projectSummary(conn),
          ok: test.ok,
          message: test.message,
          phpVersion: test.phpVersion ?? null,
          framework: test.driver && test.driver.id !== 'none' ? { id: test.driver.id, name: test.driver.name, version: test.driver.appVersion ?? null } : null
        }
        return { ...(test.ok ? text(JSON.stringify(info, null, 2)) : failure(JSON.stringify(info, null, 2))), structuredContent: info }
      })
  )

  server.registerTool(
    'list_logs',
    {
      title: 'List log files',
      description: "Log files of a project (Laravel's storage/logs and the like), with size and last change.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true }
    },
    async ({ project }) =>
      guarded(async () => {
        const conn = findProject(deps, project)
        const listing = await deps.listLogs(conn)
        const files = listing.files.map((f) => ({ path: f.path, size: f.size, modifiedAt: new Date(f.modifiedAt).toISOString() }))
        return { ...text(JSON.stringify({ root: listing.root, files }, null, 2)), structuredContent: { root: listing.root, files } }
      })
  )

  server.registerTool(
    'read_log',
    {
      title: 'Read a log file',
      description: 'Newest entries of a log file from list_logs, parsed into level, time, message, context and stack trace.',
      inputSchema: {
        project: projectArg,
        file: z.string().min(1).max(4096).describe('Path from list_logs (relative to the logs folder).'),
        limit: z.number().int().min(1).max(1000).optional().describe('Number of entries, newest first (default 50).'),
        level: z.string().optional().describe('Only entries of this level, e.g. error.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ project, file, limit, level }) =>
      guarded(async () => {
        const conn = findProject(deps, project)
        let entries = await deps.readLog(conn, file, level ? 1000 : (limit ?? 50))
        if (level) entries = entries.filter((e) => e.level.toLowerCase() === level.toLowerCase()).slice(0, limit ?? 50)
        const body = entries
          .map((e) => [`[${e.datetime}] ${e.env ? `${e.env}.` : ''}${e.level.toUpperCase()}: ${e.message}`, e.context, e.stack].filter(Boolean).join('\n'))
          .join('\n\n')
        return text(body || 'No entries.')
      })
  )
}

/** Ids of the implicit connections, exported for the server wiring. */
export const IMPLICIT_PROJECT_IDS = [SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID] as const
