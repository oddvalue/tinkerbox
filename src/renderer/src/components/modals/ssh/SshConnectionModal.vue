<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { Check, CircleCheck, PlugZap, RotateCw, Server, TriangleAlert } from 'lucide-vue-next'
import type { ConnectionTestResult, SshConnection, SshHost } from '@shared/types'
import { api } from '../../../api'
import { isSshConnection, useConnectionsStore } from '../../../stores/connections'
import { useEnvironmentStore } from '../../../stores/environment'
import { useTabsStore } from '../../../stores/tabs'
import { formatDuration } from '../../../utils/format'
import Button from '../../common/Button.vue'
import IconButton from '../../common/IconButton.vue'
import Modal from '../../common/Modal.vue'
import Spinner from '../../common/Spinner.vue'
import TextInput from '../../common/TextInput.vue'
import Toggle from '../../common/Toggle.vue'
import {
  applySshName,
  emptySshForm,
  findSshHost,
  sshFormFrom,
  sshHostHint,
  sshInput,
  validateSshForm,
  type SshFormErrors,
  type SshFormState
} from './sshUtils'

/**
 * SSH connection form: a host (an alias from ~/.ssh/config or user@host), optional port, the project path on the
 * server, the PHP binary there, an optional local checkout and the production flag. Login goes through the system
 * ssh client with BatchMode, so keys and the agent must work without a password prompt.
 * New connections open in a tab on Connect; `connectionId` edits a stored one.
 */
const props = defineProps<{ connectionId?: string }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const connections = useConnectionsStore()
const environment = useEnvironmentStore()
const tabs = useTabsStore()

const stored = connections.byId(props.connectionId)
const editing: SshConnection | null = isSshConnection(stored) ? stored : null

const form = ref<SshFormState>(editing ? sshFormFrom(editing) : emptySshForm())
// Edit mode keeps the saved name (null); a new connection follows host and path until the name is edited.
let suggestedName: string | null = editing ? null : ''
const errors = ref<SshFormErrors>({})
const saveError = ref<string | null>(null)
const saving = ref(false)

const hosts = shallowRef<SshHost[]>([])
const hostsLoading = ref(false)
const hostsError = ref<string | null>(null)

const testing = ref(false)
const testResult = shallowRef<ConnectionTestResult | null>(null)

const picked = computed(() => findSshHost(hosts.value, form.value.host))

async function loadHosts(): Promise<void> {
  hostsLoading.value = true
  hostsError.value = null
  try {
    hosts.value = await connections.listSshHosts()
  } catch (err) {
    hosts.value = []
    hostsError.value = api.errorText(err)
  } finally {
    hostsLoading.value = false
  }
}

watch(
  () => [form.value.host, form.value.path],
  () => {
    const next = applySshName(form.value, suggestedName)
    suggestedName = next.suggested
    if (next.name !== form.value.name) form.value = { ...form.value, name: next.name }
  },
  { immediate: !editing }
)

// Errors and test results belong to the values they were raised for.
watch(
  form,
  () => {
    errors.value = {}
    saveError.value = null
    testResult.value = null
  },
  { deep: true }
)

function pick(host: SshHost): void {
  form.value = { ...form.value, host: host.alias }
}

function validate(): boolean {
  errors.value = validateSshForm(form.value)
  return Object.keys(errors.value).length === 0
}

/** Connection as it would be saved (for Test). */
function draft(): SshConnection {
  return { ...(editing ?? {}), ...sshInput(form.value), id: editing?.id ?? 'ssh-test', type: 'ssh', createdAt: editing?.createdAt ?? Date.now() }
}

async function test(): Promise<void> {
  if (!validate()) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await connections.test(draft())
  } catch (err) {
    testResult.value = { ok: false, message: api.errorText(err), durationMs: 0 }
  } finally {
    testing.value = false
  }
}

async function submit(): Promise<void> {
  if (saving.value || !validate()) return
  saving.value = true
  saveError.value = null
  try {
    if (editing) {
      const saved = await connections.save({ ...editing, ...sshInput(form.value), type: 'ssh' })
      void environment.load(saved.id, true)
    } else {
      const conn = await connections.openSsh(sshInput(form.value))
      tabs.openProject(conn)
    }
    emit('close')
  } catch (err) {
    saveError.value = api.errorText(err)
  } finally {
    saving.value = false
  }
}

onMounted(() => void loadHosts())
</script>

<template>
  <Modal :title="editing ? 'Edit SSH Connection' : 'Open SSH Server'" size="md" initial-focus="[data-ssh-host]" @close="emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <!-- Host -->
      <section class="space-y-2">
        <div class="grid grid-cols-[1fr_96px] gap-3">
          <div data-ssh-host>
            <label class="mb-1.5 block text-xs font-semibold text-muted">Host</label>
            <TextInput v-model="form.host" monospace placeholder="Alias, host or user@host" :error="errors.host" @enter="submit" />
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-semibold text-muted">Port <span class="font-normal">(optional)</span></label>
            <TextInput v-model="form.port" monospace placeholder="22" :error="errors.port" @enter="submit" />
          </div>
        </div>
        <p class="text-xs text-muted">
          Uses your ssh setup (keys, agent, <span class="font-mono">~/.ssh/config</span>). Password logins are not supported: use a key.
        </p>
        <div class="flex items-center gap-1.5">
          <h3 class="flex-1 text-xs font-semibold text-muted">Hosts in <span class="font-mono font-normal">~/.ssh/config</span></h3>
          <IconButton :icon="RotateCw" label="Reload hosts" size="xs" :disabled="hostsLoading" @click="loadHosts" />
        </div>
        <div v-if="hostsLoading && hosts.length === 0" class="flex items-center gap-2 py-1 text-xs text-muted">
          <Spinner :size="13" /> Reading your ssh config…
        </div>
        <p v-else-if="hostsError" class="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning" data-testid="ssh-error">
          <TriangleAlert :size="14" class="mt-px shrink-0" /> <span class="selectable min-w-0">{{ hostsError }}</span>
        </p>
        <p v-else-if="hosts.length === 0" class="py-1 text-xs text-muted">No Host entries in ~/.ssh/config. Enter a host or user@host above.</p>
        <ul v-else class="max-h-[160px] overflow-y-auto rounded-xl border border-line" role="listbox" aria-label="Hosts from your ssh config">
          <li v-for="h in hosts" :key="h.alias" class="border-t border-line/70 first:border-t-0">
            <button
              type="button"
              role="option"
              :aria-selected="picked?.alias === h.alias"
              :class="['flex w-full items-center gap-3 px-3 py-2 text-left transition-colors', picked?.alias === h.alias ? 'bg-accent-soft' : 'hover:bg-hover']"
              @click="pick(h)"
            >
              <Server :size="15" class="shrink-0 text-muted" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] font-semibold text-fg">{{ h.alias }}</span>
                <span v-if="sshHostHint(h)" class="mt-0.5 block truncate font-mono text-[11px] text-muted">{{ sshHostHint(h) }}</span>
              </span>
              <Check v-if="picked?.alias === h.alias" :size="15" class="shrink-0 text-accent" aria-label="Selected" />
            </button>
          </li>
        </ul>
      </section>

      <!-- Project -->
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Project path on the server</label>
        <TextInput v-model="form.path" monospace placeholder="/var/www/app" :error="errors.path" @enter="submit" />
        <p class="mt-1 text-xs text-muted">Leave it empty to run plain PHP in your home directory on the server.</p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-muted">PHP binary</label>
          <TextInput v-model="form.phpBinary" monospace placeholder="php" @enter="submit" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-muted">Name</label>
          <TextInput v-model="form.name" :placeholder="form.host.trim() || 'Shown on tabs and in recent projects'" @enter="submit" />
        </div>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Local folder <span class="font-normal">(optional)</span></label>
        <TextInput v-model="form.hostPath" monospace folder-picker picker-title="Choose the local checkout" :error="errors.hostPath" @enter="submit" />
        <p class="mt-1 text-xs text-muted">Open files from output in your editor. A local checkout of the same project.</p>
      </div>
      <div data-testid="ssh-production">
        <Toggle v-model="form.production" label="Production server" description="Shows a red badge and asks before each run." />
      </div>

      <div
        v-if="testing || testResult"
        class="flex min-h-[34px] items-center gap-2 rounded-lg border border-line bg-app-alt/60 px-3 py-2 text-xs"
        data-testid="ssh-test-result"
      >
        <Spinner v-if="testing" :size="12" class="text-muted" />
        <template v-else-if="testResult">
          <CircleCheck v-if="testResult.ok" :size="14" class="shrink-0 text-success" />
          <TriangleAlert v-else :size="14" class="shrink-0 text-danger" />
          <span :class="['selectable min-w-0 flex-1 break-words', testResult.ok ? 'text-fg' : 'text-danger']">{{ testResult.message }}</span>
          <span v-if="testResult.durationMs > 0" class="shrink-0 font-mono text-muted">{{ formatDuration(testResult.durationMs) }}</span>
        </template>
        <span v-if="testing" class="text-muted">Connecting to the server…</span>
      </div>
      <p v-if="saveError" class="text-xs text-danger">{{ saveError }}</p>
    </form>

    <template #footer>
      <Button variant="ghost" size="sm" :icon="PlugZap" :loading="testing" :disabled="saving" data-testid="ssh-test" @click="test">Test</Button>
      <div class="flex-1" />
      <Button size="sm" @click="emit('close')">Cancel</Button>
      <Button variant="primary" size="sm" :loading="saving" data-testid="ssh-submit" @click="submit">{{ editing ? 'Save' : 'Connect' }}</Button>
    </template>
  </Modal>
</template>
