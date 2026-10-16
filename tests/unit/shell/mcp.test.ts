/**
 * MCP server: access checks (token, browser Origin, Host), the tools over a real Streamable HTTP client, project
 * lookup and the production confirmation. The execution layer is faked (McpDeps).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Connection, RunResult } from '@shared/types'
import { McpController, claudeMcpCommand } from '../../../src/main/mcp'
import { McpHttpServer, allowedHost, authorized } from '../../../src/main/mcp/server'
import { findProject, type McpDeps } from '../../../src/main/mcp/tools'
import { DEFAULT_SETTINGS } from '../../../src/shared/defaults'
import { runResult } from './helpers'

const TOKEN = 'test-token-0123456789abcdef0123456789'

const projects: Connection[] = [
  { id: 'scratch', name: 'PHP', type: 'local', path: '', createdAt: 0 },
  { id: 'local-shop', name: 'shop', type: 'local', path: '/home/me/shop', createdAt: 0 },
  { id: 'ssh-prod', name: 'shop prod', type: 'ssh', host: 'prod-web', path: '/var/www/shop', createdAt: 0, production: true }
]

function fakeDeps(overrides: Partial<McpDeps> = {}): McpDeps & { runs: Array<{ id: string; code: string; timeoutMs?: number }> } {
  const runs: Array<{ id: string; code: string; timeoutMs?: number }> = []
  return {
    runs,
    projects: () => projects,
    defaultProject: () => projects[1],
    run: async (conn, code, timeoutMs) => {
      runs.push({ id: conn.id, code, timeoutMs })
      return runResult({
        connectionId: conn.id,
        phpVersion: '8.4.1',
        events: [{ kind: 'echo', seq: 1, text: 'hello\n' }],
        hasReturnValue: true,
        returnValue: { t: 'int', v: '42' }
      } as Partial<RunResult>)
    },
    test: async () => ({ ok: true, message: 'PHP 8.4.1 · Laravel 12.0.0', phpVersion: '8.4.1', driver: { id: 'laravel', name: 'Laravel', appVersion: 'Laravel 12.0.0' }, durationMs: 5 }),
    listLogs: async () => ({ root: '/home/me/shop/storage/logs', files: [{ path: 'laravel.log', name: 'laravel.log', dir: '', size: 10, modifiedAt: 0 }] }),
    readLog: async () => [
      { datetime: '2026-10-16 10:00:00', env: 'local', level: 'error', message: 'Boom', stack: '#0 main' },
      { datetime: '2026-10-16 09:00:00', env: 'local', level: 'info', message: 'Hi' }
    ],
    confirmProduction: async () => false,
    ...overrides
  }
}

let servers: McpHttpServer[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
})

async function startServer(deps: McpDeps): Promise<{ url: string; port: number }> {
  const server = new McpHttpServer({ deps, version: '0.1.0', token: () => TOKEN })
  servers.push(server)
  for (let port = 47500 + Math.floor(Math.random() * 400); ; port++) {
    await server.start(port)
    if (server.state().running) return { url: `http://127.0.0.1:${port}/mcp`, port }
  }
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
  return client
}

const textOf = (result: { content?: unknown }) => (result.content as Array<{ text: string }>).map((c) => c.text).join('\n')

describe('access checks', () => {
  it('compares the bearer token exactly', () => {
    expect(authorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(authorized(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(authorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(authorized(TOKEN, TOKEN)).toBe(false)
    expect(authorized(undefined, TOKEN)).toBe(false)
    expect(authorized('Bearer ', '')).toBe(false)
  })

  it('accepts only loopback Host headers with our port', () => {
    expect(allowedHost('127.0.0.1:47474', 47474)).toBe(true)
    expect(allowedHost('localhost:47474', 47474)).toBe(true)
    expect(allowedHost('evil.example:47474', 47474)).toBe(false)
    expect(allowedHost('127.0.0.1:80', 47474)).toBe(false)
  })

  it('refuses requests without the token, from web pages, and other methods', async () => {
    const { url } = await startServer(fakeDeps())
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) })
    expect((await post({})).status).toBe(401)
    expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ Authorization: `Bearer ${TOKEN}` })).status).toBe(200)
    expect((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405)
    expect((await fetch(url.replace('/mcp', '/other'), { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404)
  })
})

describe('tools over Streamable HTTP', () => {
  it('lists the tools and the projects', async () => {
    const { url } = await startServer(fakeDeps())
    const client = await connect(url)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['list_logs', 'list_projects', 'project_info', 'read_log', 'run_php'])
    const list = await client.callTool({ name: 'list_projects', arguments: {} })
    const structured = list.structuredContent as { projects: Array<Record<string, unknown>> }
    expect(structured.projects.map((p) => [p.name, p.target, p.production, p.default])).toEqual([
      ['PHP', 'plain PHP on this machine', false, false],
      ['shop', '/home/me/shop', false, true],
      ['shop prod', 'prod-web:/var/www/shop', true, false]
    ])
    await client.close()
  })

  it('runs code in the default or a named project and returns the output as text', async () => {
    const deps = fakeDeps()
    const { url } = await startServer(deps)
    const client = await connect(url)
    const result = await client.callTool({ name: 'run_php', arguments: { code: 'echo "hello"; 42', timeout_seconds: 5 } })
    expect(result.isError).toBeFalsy()
    const out = textOf(result)
    expect(out).toContain('Ran on shop (/home/me/shop), PHP 8.4.1')
    expect(out).toContain('hello')
    expect(out).toContain('42')
    expect(deps.runs).toEqual([{ id: 'local-shop', code: 'echo "hello"; 42', timeoutMs: 5000 }])
    await client.callTool({ name: 'run_php', arguments: { code: '1', project: 'PHP' } })
    expect(deps.runs[1].id).toBe('scratch')
    const missing = await client.callTool({ name: 'run_php', arguments: { code: '1', project: 'nope' } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toMatch(/No project "nope"\. Projects: PHP \(scratch\), shop \(local-shop\)/)
    await client.close()
  })

  it('asks before running on production and reports a refusal', async () => {
    const asked: string[] = []
    let allow = false
    const deps = fakeDeps({
      confirmProduction: async (conn, code) => {
        asked.push(`${conn.id}:${code}`)
        return allow
      }
    })
    const { url } = await startServer(deps)
    const client = await connect(url)
    const declined = await client.callTool({ name: 'run_php', arguments: { code: 'User::count()', project: 'ssh-prod' } })
    expect(declined.isError).toBe(true)
    expect(textOf(declined)).toMatch(/declined to run this code on the production project shop prod/)
    expect(deps.runs).toEqual([])
    allow = true
    const ran = await client.callTool({ name: 'run_php', arguments: { code: 'User::count()', project: 'shop prod' } })
    expect(ran.isError).toBeFalsy()
    expect(asked).toEqual(['ssh-prod:User::count()', 'ssh-prod:User::count()'])
    expect(deps.runs.map((r) => r.id)).toEqual(['ssh-prod'])
    await client.close()
  })

  it('reports project info and reads logs, optionally by level', async () => {
    const { url } = await startServer(fakeDeps())
    const client = await connect(url)
    const info = await client.callTool({ name: 'project_info', arguments: {} })
    expect(info.structuredContent).toMatchObject({ name: 'shop', ok: true, phpVersion: '8.4.1', framework: { id: 'laravel' } })
    const logs = await client.callTool({ name: 'list_logs', arguments: {} })
    expect(textOf(logs)).toContain('laravel.log')
    const errors = await client.callTool({ name: 'read_log', arguments: { file: 'laravel.log', level: 'error' } })
    expect(textOf(errors)).toBe('[2026-10-16 10:00:00] local.ERROR: Boom\n#0 main')
    await client.close()
  })
})

describe('findProject', () => {
  it('matches ids, then names case-insensitively, and explains ambiguity', () => {
    const deps = fakeDeps({ projects: () => [...projects, { id: 'local-shop-2', name: 'Shop', type: 'local', path: '/srv/shop', createdAt: 0 }] })
    expect(findProject(deps, 'local-shop').id).toBe('local-shop')
    expect(findProject(deps, undefined).id).toBe('local-shop')
    expect(() => findProject(deps, 'SHOP')).toThrow(/Several projects are called "SHOP"/)
  })
})

describe('McpController', () => {
  it('creates a token when enabled, follows the settings and builds the connect command', async () => {
    let settings = { ...DEFAULT_SETTINGS, mcp: { enabled: true, port: 47900 + Math.floor(Math.random() * 90), token: '' } }
    const controller = new McpController({
      deps: fakeDeps(),
      version: '0.1.0',
      getSettings: () => settings,
      saveToken: (token) => {
        settings = { ...settings, mcp: { ...settings.mcp, token } }
      }
    })
    await controller.apply()
    const status = controller.status()
    expect(status.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(status.running || status.error !== '').toBe(true)
    expect(status.command).toBe(claudeMcpCommand(status.url, status.token))
    const before = status.token
    expect((await controller.regenerateToken()).token).not.toBe(before)
    settings = { ...settings, mcp: { ...settings.mcp, enabled: false } }
    await controller.apply()
    expect(controller.status()).toMatchObject({ enabled: false, running: false, error: '' })
    await controller.dispose()
  })
})
