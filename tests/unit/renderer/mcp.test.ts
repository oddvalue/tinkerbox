import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpUiRequest, McpUiResponses, RunRequest, RunResult, SshConnection } from '@shared/types'
import { setBridge } from '@/api'
import { handleMcpRequest, installMcpBridge, isNewRun, replyTo, runConfirmation, useAgentTabsStore } from '@/mcp/bridge'
import { useConnectionsStore } from '@/stores/connections'
import { useSettingsStore } from '@/stores/settings'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { deferred, fakeBridge, okResult, type FakeBridge, type Overrides } from './helpers'

const PROD: SshConnection = { id: 'ssh-1', type: 'ssh', name: 'shop', host: 'prod-web', path: '/var/www/shop', createdAt: 1, production: true }
const CLIENT = 'claude-code'

let fake: FakeBridge
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  setBridge(null)
  vi.useRealTimers()
})

async function setup(overrides: Overrides = {}) {
  fake = fakeBridge({ 'run:start': (request) => okResult(request), 'connections:list': () => [PROD], ...overrides })
  setBridge(fake.bridge)
  setActivePinia(createPinia())
  await useSettingsStore().load()
  await useSettingsStore().update({ welcomeTab: false, prettifyOnRun: false })
  await useConnectionsStore().load()
  const tabs = useTabsStore()
  await tabs.init()
  cleanups.push(
    () => tabs.dispose(),
    () => useConnectionsStore().dispose()
  )
  return { tabs, ui: useUiStore() }
}

function call<M extends McpUiRequest['method']>(request: Extract<McpUiRequest, { method: M }>): Promise<McpUiResponses[M]> {
  return handleMcpRequest(request) as Promise<McpUiResponses[M]>
}

/** Answer the top dialog once it is open. */
async function answer(ui: ReturnType<typeof useUiStore>, yes: boolean): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(ui.modals).toHaveLength(1))
  const props = ui.modals[0].props as Record<string, unknown>
  ui.closeModal(undefined, yes)
  return props
}

describe('pure helpers', () => {
  it('tells new runs from old ones', () => {
    expect(isNewRun(null, 0)).toBe(false)
    expect(isNewRun({ finishedAt: 100 } as RunResult, 99)).toBe(true)
    expect(isNewRun({ finishedAt: 100 } as RunResult, 100)).toBe(false)
  })

  it('asks at most once before an agent run', () => {
    expect(runConfirmation({ client: CLIENT, confirm: false, production: false, project: 'shop' })).toBeNull()
    expect(runConfirmation({ client: CLIENT, confirm: true, production: false, project: 'shop (~/shop)' })).toEqual({
      title: 'Run code from claude-code?',
      message: 'shop (~/shop)',
      confirmLabel: 'Run'
    })
    expect(runConfirmation({ client: CLIENT, confirm: true, production: true, project: 'shop' })).toMatchObject({
      title: 'Run code from claude-code on production?',
      danger: true
    })
    expect(runConfirmation({ client: CLIENT, confirm: false, production: true, project: 'shop' })).toMatchObject({
      title: 'Run on production?',
      message: 'claude-code wants to run code on shop.',
      danger: true
    })
  })
})

describe('tabs for agents', () => {
  it('opens a tab with prepared code without running it', async () => {
    const { tabs, ui } = await setup()
    const info = await call({ method: 'openTab', params: { code: 'echo 1;', connectionId: null, title: 'Check users', client: CLIENT } })
    expect(tabs.activeTabId).toBe(info.id)
    expect(info).toMatchObject({ title: 'Check users', code: 'echo 1;', projectId: '', active: true, running: false, lastRunAt: 0, production: false })
    expect(info.projectTarget).not.toBe('')
    expect(fake.callsTo('run:start')).toHaveLength(0)
    const toast = ui.toasts.find((t) => t.key === `mcp-open-${info.id}`)
    expect(toast?.message).toMatch(/^claude-code opened a tab with code for .+\. Review it, then press Run\.$/)
    expect(toast?.timeout).toBe(8000)

    const agentTabs = useAgentTabsStore()
    expect(agentTabs.preparedBy(info.id)).toBe(CLIENT)
    tabs.setCode(info.id, 'echo 2;')
    expect(agentTabs.preparedBy(info.id)).toBeNull()

    const listed = await call({ method: 'listTabs' })
    expect(listed.map((t) => t.id)).toContain(info.id)
    expect(listed.every((t) => tabs.byId(t.id)?.kind === 'code')).toBe(true)
  })

  it('describes production projects and refuses unknown ones', async () => {
    await setup()
    const info = await call({ method: 'openTab', params: { code: 'x();', connectionId: PROD.id, client: CLIENT } })
    expect(info).toMatchObject({ projectId: PROD.id, projectName: 'shop', projectTarget: 'prod-web:/var/www/shop', production: true })
    expect(await replyTo({ method: 'openTab', params: { code: '', connectionId: 'local-nope', client: CLIENT } })).toEqual({
      ok: false,
      error: 'No project local-nope. Call list_projects.'
    })
  })

  it('updates code, but not in a running tab', async () => {
    const run = deferred<RunResult>()
    let request: RunRequest | null = null
    const { tabs, ui } = await setup({
      'run:start': (r) => {
        request = r
        return run.promise
      }
    })
    const tab = tabs.newTab({ code: 'old();' })
    tabs.newTab()
    const info = await call({ method: 'updateTab', params: { tabId: tab.id, code: 'new();', client: CLIENT } })
    expect(info.code).toBe('new();')
    expect(tabs.activeTabId).toBe(tab.id)
    expect(ui.toasts.some((t) => t.message === `claude-code updated the code in ${tabs.displayTitle(tab.id)}.`)).toBe(true)

    const running = tabs.run({ tabId: tab.id })
    await vi.waitFor(() => expect(request).not.toBeNull())
    expect((await replyTo({ method: 'updateTab', params: { tabId: tab.id, code: 'x', client: CLIENT } })).ok).toBe(false)
    run.resolve(okResult(request!))
    await running
    expect(await replyTo({ method: 'getTab', params: { tabId: 'nope' } })).toEqual({ ok: false, error: 'No tab nope. Call list_tabs.' })
    const got = await call({ method: 'getTab', params: { tabId: tab.id } })
    expect(got.result?.ok).toBe(true)
    expect(got.tab.lastRunAt).toBe(got.result?.finishedAt)
  })
})

describe('runTab', () => {
  it('runs right away without confirm', async () => {
    const { tabs, ui } = await setup()
    const tab = tabs.newTab({ code: 'echo 1;' })
    const reply = await call({ method: 'runTab', params: { tabId: tab.id, client: CLIENT, confirm: false } })
    expect(reply.declined).toBe(false)
    expect(reply.result?.ok).toBe(true)
    expect(ui.modals).toHaveLength(0)
  })

  it('asks first with confirm, and reports a decline', async () => {
    const { tabs, ui } = await setup()
    const tab = tabs.newTab({ code: 'echo 1;' })
    const declined = call({ method: 'runTab', params: { tabId: tab.id, client: CLIENT, confirm: true } })
    expect((await answer(ui, false)).title).toBe('Run code from claude-code?')
    expect(await declined).toMatchObject({ result: null, declined: true })
    expect(fake.callsTo('run:start')).toHaveLength(0)

    const accepted = call({ method: 'runTab', params: { tabId: tab.id, client: CLIENT, confirm: true } })
    await answer(ui, true)
    expect((await accepted).result?.ok).toBe(true)
  })

  it('shows one dialog on production, with or without confirm', async () => {
    const { tabs, ui } = await setup()
    const tab = tabs.newTab({ code: 'echo 1;', connectionId: PROD.id })
    for (const confirm of [true, false]) {
      const pending = call({ method: 'runTab', params: { tabId: tab.id, client: CLIENT, confirm } })
      const props = await answer(ui, true)
      expect(props.danger).toBe(true)
      expect((await pending).result?.ok).toBe(true)
      // The store's own production dialog did not follow.
      expect(ui.modals).toHaveLength(0)
    }
    const pending = call({ method: 'runTab', params: { tabId: tab.id, client: CLIENT, confirm: false } })
    await answer(ui, false)
    expect(await pending).toMatchObject({ declined: true, result: null })
    expect(fake.callsTo('run:start')).toHaveLength(2)
  })

  it('waits for a run in progress instead of cancelling it', async () => {
    const run = deferred<RunResult>()
    let request: RunRequest | null = null
    const { tabs } = await setup({
      'run:start': (r) => {
        request = r
        return run.promise
      }
    })
    const tab = tabs.newTab({ code: 'sleep(1);' })
    const userRun = tabs.run({ tabId: tab.id })
    await vi.waitFor(() => expect(request).not.toBeNull())
    const agentRun = call({ method: 'runTab', params: { tabId: tab.id, client: CLIENT, confirm: false } })
    run.resolve(okResult(request!, { finishedAt: Date.now() + 5 }))
    await userRun
    const reply = await agentRun
    expect(reply.result?.runId).toBe(request!.runId)
    expect(fake.callsTo('run:cancel')).toHaveLength(0)
    expect(fake.callsTo('run:start')).toHaveLength(1)
  })
})

describe('waitForRun', () => {
  it('returns a run that already finished after `since`', async () => {
    const { tabs } = await setup()
    const tab = tabs.newTab({ code: 'echo 1;' })
    const before = Date.now() - 1
    await tabs.run({ tabId: tab.id })
    const reply = await call({ method: 'waitForRun', params: { tabId: tab.id, since: before, timeoutMs: 10 } })
    expect(reply.result?.ok).toBe(true)
  })

  it('waits until the user runs the tab', async () => {
    const { tabs } = await setup()
    const tab = tabs.newTab({ code: 'echo 1;' })
    await tabs.run({ tabId: tab.id })
    const since = Date.now()
    const waiting = call({ method: 'waitForRun', params: { tabId: tab.id, since, timeoutMs: 5000 } })
    let settled = false
    void waiting.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    await tabs.run({ tabId: tab.id })
    const reply = await waiting
    expect(reply.result!.finishedAt).toBeGreaterThan(since)
  })

  it('gives up after the timeout and errors when the tab closes', async () => {
    const { tabs } = await setup()
    const tab = tabs.newTab({ code: 'echo 1;' })
    vi.useFakeTimers()
    const waiting = call({ method: 'waitForRun', params: { tabId: tab.id, since: Date.now(), timeoutMs: 1000 } })
    await vi.advanceTimersByTimeAsync(1001)
    expect((await waiting).result).toBeNull()
    vi.useRealTimers()

    const closing = replyTo({ method: 'waitForRun', params: { tabId: tab.id, since: Date.now(), timeoutMs: 5000 } })
    await tabs.closeTab(tab.id, { force: true })
    expect(await closing).toEqual({ ok: false, error: `Tab ${tab.id} was closed.` })
  })
})

describe('installMcpBridge', () => {
  it('answers mcp:request events through mcp:respond', async () => {
    await setup()
    cleanups.push(installMcpBridge())
    fake.emit('mcp:request', { id: 'req-1', request: { method: 'getTab', params: { tabId: 'nope' } } })
    await vi.waitFor(() => expect(fake.callsTo('mcp:respond')).toHaveLength(1))
    expect(fake.callsTo('mcp:respond')[0]).toEqual(['req-1', { ok: false, error: 'No tab nope. Call list_tabs.' }])
  })
})
