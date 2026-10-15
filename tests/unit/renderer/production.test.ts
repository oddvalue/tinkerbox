import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '@shared/types'
import { setBridge } from '@/api'
import { useConnectionsStore } from '@/stores/connections'
import { useSettingsStore } from '@/stores/settings'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { needsProductionConfirm, productionGuard } from '@/utils/production'
import { fakeBridge, okResult, type FakeBridge } from './helpers'

describe('production guard', () => {
  it('asks before runs the user started and blocks auto-evaluate', () => {
    const prod = { production: true }
    expect(productionGuard(prod, 'manual')).toBe('confirm')
    expect(productionGuard(prod, 'watch')).toBe('confirm')
    expect(productionGuard(prod, 'auto')).toBe('block')
    expect(needsProductionConfirm(prod, 'manual')).toBe(true)
    expect(needsProductionConfirm(prod, 'auto')).toBe(false)
  })

  it('leaves other connections alone', () => {
    for (const conn of [null, undefined, {}, { production: false }]) {
      expect(productionGuard(conn, 'manual')).toBe('run')
      expect(productionGuard(conn, 'auto')).toBe('run')
    }
  })
})

describe('production runs', () => {
  const PROD: SshConnection = { id: 'ssh-1', type: 'ssh', name: 'shop', host: 'prod-web', path: '/var/www/shop', createdAt: 1, production: true }
  let fake: FakeBridge
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
    setBridge(null)
  })

  async function setup() {
    fake = fakeBridge({ 'run:start': (request) => okResult(request), 'connections:list': () => [PROD] })
    setBridge(fake.bridge)
    setActivePinia(createPinia())
    await useSettingsStore().load()
    await useSettingsStore().update({ welcomeTab: false, prettifyOnRun: false })
    await useConnectionsStore().load()
    const tabs = useTabsStore()
    await tabs.init()
    cleanups.push(() => tabs.dispose(), () => useConnectionsStore().dispose())
    const tab = tabs.newTab({ code: 'echo 1;', connectionId: PROD.id })
    return { tabs, ui: useUiStore(), tab }
  }

  it('runs only after the user confirms', async () => {
    const { tabs, ui, tab } = await setup()
    const first = tabs.run({ tabId: tab.id })
    await vi.waitFor(() => expect(ui.modals.map((m) => m.name)).toEqual(['confirm']))
    expect(ui.modals[0].props).toMatchObject({ title: 'Run on production?', confirmLabel: 'Run', danger: true })
    expect((ui.modals[0].props as { message: string }).message).toContain('shop')
    // A second Run while the dialog is open does not stack another one.
    expect(await tabs.run({ tabId: tab.id })).toBeNull()
    ui.closeModal(undefined, false)
    expect(await first).toBeNull()
    expect(fake.callsTo('run:start')).toHaveLength(0)

    const second = tabs.run({ tabId: tab.id })
    await vi.waitFor(() => expect(ui.modals).toHaveLength(1))
    ui.closeModal(undefined, true)
    expect((await second)?.ok).toBe(true)
    expect(fake.callsTo('run:start')).toHaveLength(1)
  })

  it('never auto-evaluates and asks before re-running a watched file', async () => {
    const { tabs, ui, tab } = await setup()
    expect(await tabs.run({ tabId: tab.id, auto: true })).toBeNull()
    expect(await tabs.run({ tabId: tab.id, auto: true })).toBeNull()
    expect(ui.modals).toHaveLength(0)
    expect(ui.toasts.filter((t) => t.key === 'production-auto')).toHaveLength(1)

    const watched = tabs.run({ tabId: tab.id, auto: true, trigger: 'watch' })
    await vi.waitFor(() => expect(ui.modals).toHaveLength(1))
    ui.closeModal(undefined, true)
    await watched
    expect(fake.callsTo('run:start')).toHaveLength(1)
  })
})
