<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, CircleCheck, CircleX, Copy, RefreshCw } from 'lucide-vue-next'
import type { McpRunPolicy, McpStatus } from '@shared/types'
import { api } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import Button from '../../../common/Button.vue'
import Select from '../../../common/Select.vue'
import Toggle from '../../../common/Toggle.vue'
import type { SelectOption } from '../../../common/types'
import NumberField from '../NumberField.vue'
import SettingsGroup from '../SettingsGroup.vue'
import SettingsRow from '../SettingsRow.vue'

/**
 * Advanced → MCP server: turn the server on, pick the port and whether agents may run code, copy the `claude mcp add`
 * command.
 */
const settings = useSettingsStore()
const ui = useUiStore()

const status = ref<McpStatus | null>(null)
const busy = ref(false)
const copied = ref(false)

const enabled = computed({
  get: () => settings.settings.mcp.enabled,
  set: (value: boolean) => void change({ enabled: value })
})
const port = computed({
  get: () => settings.settings.mcp.port,
  set: (value: number) => void change({ port: value })
})
const runPolicy = computed({
  get: () => settings.settings.mcp.runPolicy,
  set: (value: McpRunPolicy | undefined) => {
    if (value) void change({ runPolicy: value })
  }
})

const RUN_POLICIES: SelectOption<McpRunPolicy>[] = [
  { value: 'review', label: 'No, I run it' },
  { value: 'ask', label: 'After I confirm' },
  { value: 'allow', label: 'Without asking' }
]
const RUN_POLICY_NOTES: Record<McpRunPolicy, string> = {
  review: 'Agents prepare code in tabs; you review and run it.',
  ask: 'Agents can run the code in a tab after you confirm each run.',
  allow: 'Agents run the code in a tab without asking. Production projects still ask.'
}

async function refresh(): Promise<void> {
  try {
    status.value = await api.invoke('mcp:status')
  } catch (err) {
    ui.error(err, 'Could not read the MCP server state')
  }
}

async function change(patch: { enabled?: boolean; port?: number; runPolicy?: McpRunPolicy }): Promise<void> {
  busy.value = true
  try {
    await settings.update({ mcp: patch })
    await refresh()
  } finally {
    busy.value = false
  }
}

async function copyCommand(): Promise<void> {
  if (!status.value?.command) return
  await api.copy(status.value.command)
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}

async function newToken(): Promise<void> {
  const ok = await ui.confirm({
    title: 'Create a new token?',
    message: 'Tools set up with the current token stop working until you add Tinkerbox to them again with the new command.',
    confirmLabel: 'New token'
  })
  if (!ok) return
  busy.value = true
  try {
    status.value = await api.invoke('mcp:regenerateToken')
    ui.toast({ level: 'success', key: 'mcp-token', timeout: 3000, message: 'New MCP token created. Copy the command again.' })
  } finally {
    busy.value = false
  }
}

onMounted(() => void refresh())
</script>

<template>
  <SettingsGroup title="MCP server">
    <SettingsRow
      label="MCP server"
      description="Let coding agents such as Claude Code open tabs with code for you to review and run, read the results, check your projects and read their logs. It listens on this computer only and needs a token."
    >
      <Toggle v-model="enabled" :disabled="busy" data-testid="mcp-enabled" />
    </SettingsRow>
    <SettingsRow label="Port" description="Local port the server listens on (127.0.0.1).">
      <NumberField v-model="port" :min="1024" :max="65535" integer width="96px" aria-label="MCP server port" :disabled="busy" />
    </SettingsRow>
    <SettingsRow label="Agents can run code" :description="RUN_POLICY_NOTES[runPolicy]">
      <Select v-model="runPolicy" :options="RUN_POLICIES" size="sm" aria-label="Agents can run code" :disabled="busy" data-testid="mcp-run-policy" />
    </SettingsRow>
    <SettingsRow v-if="enabled && status" label="Connect" description="Run this once in a terminal to add Tinkerbox to Claude Code. Other MCP clients take the same URL and header." stacked>
      <div
        v-if="status.error || !status.running"
        class="selectable flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-xs leading-relaxed text-fg"
        data-testid="mcp-error"
      >
        <CircleX :size="14" class="mt-px shrink-0 text-danger" />
        <p class="break-words">{{ status.error || 'The server is not running.' }}</p>
      </div>
      <template v-else>
        <div class="flex items-center gap-1.5 text-xs text-muted" data-testid="mcp-running">
          <CircleCheck :size="14" class="shrink-0 text-success" />
          Running at <span class="selectable font-mono text-fg">{{ status.url }}</span>
        </div>
        <div class="mt-2 flex items-start gap-2">
          <code
            class="selectable min-w-0 flex-1 rounded-lg border border-line bg-fg/5 px-3 py-2 font-mono text-xs leading-relaxed break-all text-fg"
            data-testid="mcp-command"
          >{{ status.command }}</code>
          <Button :icon="copied ? Check : Copy" @click="copyCommand">{{ copied ? 'Copied' : 'Copy' }}</Button>
        </div>
        <div class="mt-2 flex items-center justify-between gap-3">
          <p class="text-xs text-muted">Runs on projects marked as production ask you first.</p>
          <Button variant="ghost" size="sm" :icon="RefreshCw" :disabled="busy" @click="newToken">New token</Button>
        </div>
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
