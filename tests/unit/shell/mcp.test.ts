/**
 * MCP server: access checks (token, browser Origin, Host), the tools over a real Streamable HTTP client, project
 * lookup and the production confirmation. The execution layer is faked (McpDeps).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Connection, McpRunPolicy, McpTabInfo, McpUiRequest, RunResult } from '@shared/types'
import { McpController, claudeMcpCommand } from '../../../src/main/mcp'
import { McpHttpServer, allowedHost, authorized } from '../../../src/main/mcp/server'
import { clientName, findProject, type McpDeps } from '../../../src/main/mcp/tools'
import { McpUiBridge } from '../../../src/main/mcp/uiBridge'
import { DEFAULT_SETTINGS } from '../../../src/shared/defaults'
import { runResult } from './helpers'

const TOKEN = 'test-token-0123456789abcdef0123456789'

const projects: Connection[] = [
  { id: 'scratch', name: 'PHP', type: 'local', path: '', createdAt: 0 },
  { id: 'local-shop', name: 'shop', type: 'local', path: '/home/me/shop', createdAt: 0 },
  { id: 'ssh-prod', name: 'shop prod', type: 'ssh', host: 'prod-web', path: '/var/www/shop', createdAt: 0, production: true }
]

const tab = (extra: Partial<McpTabInfo> = {}): McpTabInfo => ({
  id: 'tab-1',
  title: 'Find users',
  projectId: 'local-shop',
  projectName: 'shop',
  projectTarget: '/home/me/shop',
  production: false,
  active: true,
  running: false,
  code: 'User::first()',
  lastRunAt: 0,
  ...extra
})

type Fake = McpDeps & { runs: Array<{ id: string; code: string; timeoutMs?: number }>; uiCalls: McpUiRequest[]; policy: McpRunPolicy }

function fakeDeps(overrides: Partial<McpDeps> = {}): Fake {
  const runs: Array<{ id: string; code: string; timeoutMs?: number }> = []
  const uiCalls: McpUiRequest[] = []
  const deps: Fake = {
    runs,
    uiCalls,
    policy: 'allow',
    projects: () => projects,
    defaultProject: () => projects[1],
    runPolicy: () => deps.policy,
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
    confirmRun: async () => false,
    ui: (async (request: McpUiRequest) => {
      uiCalls.push(request)
      switch (request.method) {
        case 'listTabs':
          return [tab()]
        case 'openTab':
          return tab({ id: 'tab-new', code: request.params.code, title: request.params.title ?? 'Untitled' })
        case 'updateTab':
          return tab({ code: request.params.code })
        case 'getTab':
          return { tab: tab(), result: null }
        case 'runTab':
          return { tab: tab(), result: runResult({ hasReturnValue: true, returnValue: { t: 'int', v: '7' } } as Partial<RunResult>), declined: false }
        case 'waitForRun':
          return { tab: tab({ code: 'User::first()?->email' }), result: runResult({ hasReturnValue: true, returnValue: { t: 'string', v: 'a@b.c', len: 5 } } as Partial<RunResult>) }
      }
    }) as McpDeps['ui'],
    ...overrides
  }
  return deps
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
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_tab',
      'list_logs',
      'list_projects',
      'list_tabs',
      'open_tab',
      'project_info',
      'read_log',
      'run_php',
      'run_tab',
      'update_tab',
      'wait_for_run'
    ])
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
      confirmRun: async (conn, code) => {
        asked.push(`${conn.id}:${code}`)
        return allow
      }
    })
    const { url } = await startServer(deps)
    const client = await connect(url)
    const declined = await client.callTool({ name: 'run_php', arguments: { code: 'User::count()', project: 'ssh-prod' } })
    expect(declined.isError).toBe(true)
    expect(textOf(declined)).toMatch(/declined to run this code on shop prod/)
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

describe('tab tools and the run policy', () => {
  it('opens a tab without running it and points the agent at wait_for_run', async () => {
    const deps = fakeDeps()
    deps.policy = 'review'
    const { url } = await startServer(deps)
    const client = await connect(url)
    const opened = await client.callTool({ name: 'open_tab', arguments: { code: 'User::first()', project: 'shop', title: 'First user' } })
    expect(textOf(opened)).toMatch(/Opened tab tab-new in Tinkerbox for shop .*review and run it in Tinkerbox, then call wait_for_run/)
    expect(deps.uiCalls[0]).toEqual({
      method: 'openTab',
      params: { code: 'User::first()', connectionId: 'local-shop', title: 'First user', client: expect.any(String) }
    })
    expect(deps.runs).toEqual([])
    await client.close()
  })

  it('refuses run_tab and run_php in review mode, and asks for each run in ask mode', async () => {
    const asked: string[] = []
    const deps = fakeDeps({
      confirmRun: async (conn) => {
        asked.push(conn.id)
        return true
      }
    })
    deps.policy = 'review'
    const { url } = await startServer(deps)
    const client = await connect(url)
    for (const name of ['run_tab', 'run_php']) {
      const r = await client.callTool({ name, arguments: name === 'run_tab' ? { tab_id: 'tab-1' } : { code: '1' } })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/Running code is left to the user/)
    }
    expect(deps.uiCalls).toEqual([])
    deps.policy = 'ask'
    const ran = await client.callTool({ name: 'run_tab', arguments: { tab_id: 'tab-1' } })
    expect(textOf(ran)).toContain('= 7')
    expect(deps.uiCalls.at(-1)).toMatchObject({ method: 'runTab', params: { tabId: 'tab-1', confirm: true } })
    await client.callTool({ name: 'run_php', arguments: { code: '1' } })
    expect(asked).toEqual(['local-shop'])
    deps.policy = 'allow'
    await client.callTool({ name: 'run_tab', arguments: { tab_id: 'tab-1' } })
    expect(deps.uiCalls.at(-1)).toMatchObject({ method: 'runTab', params: { confirm: false } })
    await client.callTool({ name: 'run_php', arguments: { code: '2' } })
    expect(asked).toEqual(['local-shop'])
    await client.close()
  })

  it('waits for the user to run a tab and returns the code they ran with the result', async () => {
    const deps = fakeDeps()
    const { url } = await startServer(deps)
    const client = await connect(url)
    const result = await client.callTool({ name: 'wait_for_run', arguments: { tab_id: 'tab-1', timeout_seconds: 30 } })
    const out = textOf(result)
    expect(out).toContain('User::first()?->email')
    expect(out).toContain('"a@b.c"')
    const call = deps.uiCalls[0] as Extract<McpUiRequest, { method: 'waitForRun' }>
    expect(call.params.timeoutMs).toBe(30_000)
    expect(Math.abs(call.params.since - Date.now())).toBeLessThan(5000)
    await client.close()
  })
})

describe('McpUiBridge', () => {
  it('matches replies to requests by id and times out', async () => {
    const sent: Array<{ id: string; focus: boolean }> = []
    const bridge = new McpUiBridge((id, _request, focus) => sent.push({ id, focus }))
    const listing = bridge.request({ method: 'listTabs' }, 1000)
    const opening = bridge.request({ method: 'openTab', params: { code: '1', connectionId: null, client: 'x' } }, 1000)
    expect(sent.map((s) => s.focus)).toEqual([false, true])
    bridge.respond(sent[1].id, { ok: false, error: 'No project nope. Call list_projects.' })
    bridge.respond(sent[0].id, { ok: true, value: [] })
    await expect(listing).resolves.toEqual([])
    await expect(opening).rejects.toThrow('No project nope')
    await expect(bridge.request({ method: 'listTabs' }, 10)).rejects.toThrow(/did not answer in time/)
  })
})

describe('clientName', () => {
  it('names Claude Code and other clients from the User-Agent', () => {
    expect(clientName('claude-code/2.1.0 (cli)')).toBe('Claude Code')
    expect(clientName('Cursor/1.2')).toBe('Cursor')
    expect(clientName('node')).toBe('A coding agent')
    expect(clientName(undefined)).toBe('A coding agent')
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
