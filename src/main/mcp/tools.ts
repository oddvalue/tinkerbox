/**
 * MCP tools: what a coding agent connected to Tinkerbox can do. They go through the same execution API as the
 * editor (local, Docker and SSH projects alike), and their results are the plain text the app copies to the
 * clipboard. Everything the tools need is injected (`McpDeps`), so they are tested without Electron or HTTP.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Connection, ConnectionTestResult, LogEntry, LogListing, RunResult } from '@shared/types'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID } from '@shared/types'
import { resultToText } from '@shared/text/dumpText'

export interface McpDeps {
  /** Saved projects plus the implicit Default (Laravel Sandbox) and PHP (plain PHP) connections. */
  projects(): Connection[]
  /** The connection the editor's "default" resolves to (Default Working Directory → Sandbox → PHP). */
  defaultProject(): Connection
  run(conn: Connection, code: string, timeoutMs: number | undefined): Promise<RunResult>
  test(conn: Connection): Promise<ConnectionTestResult>
  listLogs(conn: Connection): Promise<LogListing>
  readLog(conn: Connection, file: string, limit: number): Promise<LogEntry[]>
  /** Ask the user before running on a production connection; resolves true when they allow it. */
  confirmProduction(conn: Connection, code: string): Promise<boolean>
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
export function findProject(deps: McpDeps, ref: string | undefined): Connection {
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

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] })
const failure = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }], isError: true })

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err))
  }
}

/** Plain-text report of a run, as "Copy output" would produce it, with where it ran on top. */
export function runReport(conn: Connection, result: RunResult): string {
  const header = `Ran on ${conn.name} (${connectionTarget(conn)})${result.phpVersion ? `, PHP ${result.phpVersion}` : ''}${
    result.driver && result.driver.id !== 'none' ? `, ${result.driver.appVersion || result.driver.name}` : ''
  }`
  const body = resultToText(result, { showQueries: true, stats: true }).trim()
  return `${header}\n\n${body || '(no output)'}`
}

const projectArg = z
  .string()
  .optional()
  .describe('Project id or name from list_projects. Omit to use the default project (the one new editor tabs use).')

export function registerTools(server: McpServer, deps: McpDeps): void {
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
        return { ...text(JSON.stringify(projects, null, 2)), structuredContent: { projects } }
      })
  )

  server.registerTool(
    'run_php',
    {
      title: 'Run PHP',
      description: [
        'Run PHP code inside a project with its framework booted, like `php artisan tinker` (Laravel, Symfony, WordPress… are detected).',
        '`<?php` is optional and the value of the last expression is returned. Short class names work (`User::first()`).',
        'The result lists echo output, dump() calls, SQL queries with bindings, exceptions with a code snippet and trace, warnings, and time and memory.',
        'Each call is a fresh PHP process. The code runs for real against the project (database, cache, files), so prefer read-only code and wrap writes in a transaction you roll back unless the user asked for changes.'
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
        const conn = findProject(deps, project)
        if (conn.production && !(await deps.confirmProduction(conn, code))) {
          return failure(`The user declined to run this code on the production project ${conn.name}.`)
        }
        const result = await deps.run(conn, code, timeout_seconds ? timeout_seconds * 1000 : undefined)
        const report = runReport(conn, result)
        const failed = Boolean(result.error) || Boolean(result.exception) || result.timedOut === true
        return failed ? failure(report) : text(report)
      })
  )

  server.registerTool(
    'project_info',
    {
      title: 'Project info',
      description: 'Check that PHP runs in a project and report the PHP version and the detected framework and version.',
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
