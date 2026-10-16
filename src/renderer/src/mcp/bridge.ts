import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { McpTabInfo, McpUiReply, McpUiRequest, McpUiResponses, RunResult, TabState } from '@shared/types'
import { api } from '../api'
import { getEditor } from '../editorBridge'
import { isImplicitConnection, useConnectionsStore } from '../stores/connections'
import { useAppStore } from '../stores/app'
import { useTabsStore } from '../stores/tabs'
import { useUiStore, type ConfirmOptions } from '../stores/ui'
import { productionGuard } from '../utils/production'
import { tildify } from '../utils/platform'

/**
 * Renderer side of the MCP server: coding agents puppet the app instead of running code headless. Main forwards
 * tool calls as `mcp:request` events; this module acts on the tabs store and answers with `mcp:respond`.
 * An agent opens or updates a tab with code, the user reviews it and runs it (or lets the agent run it, depending
 * on the run policy main enforces), and the agent reads the result back.
 */

/** Error with a message meant for the agent (sent back as `{ ok: false, error }`). */
export class McpBridgeError extends Error {}

/** A result belongs to a run that finished after `since` (ms epoch). */
export function isNewRun(result: RunResult | null | undefined, since: number): result is RunResult {
  return !!result && result.finishedAt > since
}

/**
 * The one dialog shown before an agent's run. The production guard and the run policy `ask` would each ask; this
 * merges them so the user never sees two dialogs in a row. null: no dialog.
 */
export function runConfirmation(options: { client: string; confirm: boolean; production: boolean; project: string }): ConfirmOptions | null {
  const { client, confirm, production, project } = options
  if (!confirm && !production) return null
  if (production) {
    return {
      title: confirm ? `Run code from ${client} on production?` : 'Run on production?',
      message: confirm ? project : `${client} wants to run code on ${project}.`,
      confirmLabel: 'Run',
      danger: true
    }
  }
  return { title: `Run code from ${client}?`, message: project, confirmLabel: 'Run' }
}

/** Tabs an agent filled with code, until the user edits or runs them (shown as a small badge on the tab). */
export const useAgentTabsStore = defineStore('agentTabs', () => {
  const prepared = ref<Record<string, { client: string; code: string; at: number }>>({})

  function mark(tabId: string, client: string, code: string): void {
    prepared.value = { ...prepared.value, [tabId]: { client, code, at: Date.now() } }
  }

  function clear(tabId: string): void {
    if (!prepared.value[tabId]) return
    const next = { ...prepared.value }
    delete next[tabId]
    prepared.value = next
  }

  /** Client that prepared the tab's code, while the user has neither edited nor run it; null otherwise. */
  function preparedBy(tabId: string): string | null {
    const entry = prepared.value[tabId]
    if (!entry) return null
    const tabs = useTabsStore()
    const tab = tabs.byId(tabId)
    if (!tab || tab.kind !== 'code' || tab.code !== entry.code) return null
    if (tabs.isRunning(tabId) || isNewRun(tabs.resultOf(tabId), entry.at)) return null
    return entry.client
  }

  return { prepared, mark, clear, preparedBy }
})

function codeOf(tab: TabState): string {
  return getEditor(tab.id)?.getCode() ?? tab.code
}

/** Where a tab's code runs, for the agent and the dialogs: "~/code/shop", "app:/var/www/html" or "plain PHP". */
function projectTarget(connectionId: string | null): string {
  const connections = useConnectionsStore()
  const subtitle = connections.subtitle(connections.effectiveId(connectionId))
  if (subtitle) return subtitle
  const dir = connections.path(connectionId)
  return dir ? tildify(dir, useAppStore().homeDir) : 'plain PHP'
}

export function tabInfo(tab: TabState): McpTabInfo {
  const tabs = useTabsStore()
  const connections = useConnectionsStore()
  return {
    id: tab.id,
    title: tabs.displayTitle(tab),
    projectId: tab.connectionId ?? '',
    projectName: connections.label(tab.connectionId),
    projectTarget: projectTarget(tab.connectionId),
    production: connections.isProduction(tab.connectionId),
    active: tabs.activeTabId === tab.id,
    running: tabs.isRunning(tab.id),
    code: codeOf(tab),
    lastRunAt: tabs.resultOf(tab.id)?.finishedAt ?? 0
  }
}

function codeTab(tabId: string): TabState {
  const tab = useTabsStore().byId(tabId)
  if (!tab) throw new McpBridgeError(`No tab ${tabId}. Call list_tabs.`)
  if (tab.kind !== 'code') throw new McpBridgeError(`Tab ${tabId} is not a code tab. Call list_tabs.`)
  return tab
}

function projectLine(tab: TabState): string {
  return `${useConnectionsStore().label(tab.connectionId)} (${projectTarget(tab.connectionId)})`
}

/**
 * Resolve with the tab's first result that finished after `since` (maybe one that exists already), or null after
 * `timeoutMs`. Rejects when the tab is closed meanwhile.
 */
export function waitForResult(tabId: string, since: number, timeoutMs: number): Promise<RunResult | null> {
  const tabs = useTabsStore()
  const current = tabs.resultOf(tabId)
  if (isNewRun(current, since)) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watch(
      () => [tabs.resultOf(tabId), !!tabs.byId(tabId)] as const,
      ([result, exists]) => {
        if (isNewRun(result, since)) finish(() => resolve(result))
        else if (!exists) finish(() => reject(new McpBridgeError(`Tab ${tabId} was closed.`)))
      },
      { flush: 'sync' }
    )
    function finish(settle: () => void): void {
      stop()
      if (timer) clearTimeout(timer)
      settle()
    }
    timer = setTimeout(() => finish(() => resolve(null)), Math.max(0, timeoutMs))
  })
}

/** Wait for the run in progress (started by the user or another call) instead of cancelling it. */
function waitForCurrentRun(tabId: string): Promise<RunResult | null> {
  const tabs = useTabsStore()
  const started = tabs.runStartedAt[tabId] ?? Date.now()
  // No timeout of our own: main gives up on its side and a script can legitimately run for minutes.
  return waitForResult(tabId, started - 1, 24 * 60 * 60 * 1000)
}

async function runTab(params: { tabId: string; client: string; confirm: boolean }): Promise<McpUiResponses['runTab']> {
  const tabs = useTabsStore()
  const tab = codeTab(params.tabId)
  tabs.activate(tab.id)
  if (tabs.isRunning(tab.id)) return { tab: tabInfo(tab), result: await waitForCurrentRun(tab.id), declined: false }

  const connections = useConnectionsStore()
  const production = productionGuard(connections.resolve(tab.connectionId), 'manual') === 'confirm'
  const dialog = runConfirmation({ client: params.client, confirm: params.confirm, production, project: projectLine(tab) })
  if (dialog && !(await useUiStore().confirm(dialog))) return { tab: tabInfo(codeTab(tab.id)), result: null, declined: true }

  const current = codeTab(tab.id)
  // The user may have pressed Run while the dialog was open: take that run.
  if (tabs.isRunning(current.id)) return { tab: tabInfo(current), result: await waitForCurrentRun(current.id), declined: false }
  useAgentTabsStore().clear(current.id)
  const result = await tabs.run({ tabId: current.id, trigger: 'manual', confirmed: true })
  return { tab: tabInfo(codeTab(current.id)), result, declined: false }
}

/** Act on one request. Throws McpBridgeError (or any error) for `{ ok: false }` replies. */
export async function handleMcpRequest(request: McpUiRequest): Promise<McpUiResponses[McpUiRequest['method']]> {
  const tabs = useTabsStore()
  const ui = useUiStore()
  switch (request.method) {
    case 'listTabs':
      return tabs.tabs.filter((t) => t.kind === 'code').map(tabInfo)

    case 'openTab': {
      const { code, connectionId, title, client } = request.params
      const connections = useConnectionsStore()
      if (connectionId && !isImplicitConnection(connectionId) && !connections.byId(connectionId)) {
        throw new McpBridgeError(`No project ${connectionId}. Call list_projects.`)
      }
      const tab = tabs.newTab({ code, connectionId, customTitle: title?.trim() || undefined })
      useAgentTabsStore().mark(tab.id, client, code)
      ui.toast({
        level: 'info',
        key: `mcp-open-${tab.id}`,
        timeout: 8000,
        message: `${client} opened a tab with code for ${connections.label(connectionId)}. Review it, then press Run.`
      })
      return tabInfo(tab)
    }

    case 'updateTab': {
      const { tabId, code, client } = request.params
      const tab = codeTab(tabId)
      if (tabs.isRunning(tab.id)) throw new McpBridgeError(`${tabs.displayTitle(tab)} is running. Wait for the run to finish.`)
      tabs.replaceCode(tab.id, code)
      tabs.activate(tab.id)
      useAgentTabsStore().mark(tab.id, client, code)
      ui.toast({ level: 'info', key: `mcp-update-${tab.id}`, timeout: 8000, message: `${client} updated the code in ${tabs.displayTitle(tab)}.` })
      return tabInfo(codeTab(tab.id))
    }

    case 'getTab': {
      const tab = codeTab(request.params.tabId)
      return { tab: tabInfo(tab), result: tabs.resultOf(tab.id) }
    }

    case 'runTab':
      return runTab(request.params)

    case 'waitForRun': {
      const { tabId, since, timeoutMs } = request.params
      codeTab(tabId)
      const result = await waitForResult(tabId, since, timeoutMs)
      return { tab: tabInfo(codeTab(tabId)), result }
    }

    default:
      throw new McpBridgeError(`Unknown request ${(request as { method?: string }).method ?? ''}.`)
  }
}

/** Run a request and turn its outcome into a reply (never rejects). */
export async function replyTo(request: McpUiRequest): Promise<McpUiReply> {
  try {
    return { ok: true, value: await handleMcpRequest(request) }
  } catch (err) {
    return { ok: false, error: err instanceof McpBridgeError ? err.message : api.errorText(err) }
  }
}

let uninstall: (() => void) | null = null

/** Answer `mcp:request` events. Returns the uninstall function; installing twice replaces the listener. */
export function installMcpBridge(): () => void {
  uninstall?.()
  const off = api.on('mcp:request', ({ id, request }) => {
    void replyTo(request).then((reply) => api.invoke('mcp:respond', id, reply).catch(() => undefined))
  })
  uninstall = () => {
    off()
    uninstall = null
  }
  return uninstall
}
