<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { Check, CircleCheck, Container, PlugZap, RotateCw, TriangleAlert } from 'lucide-vue-next'
import type { ConnectionTestResult, DockerConnection, DockerContainer } from '@shared/types'
import { api } from '../../../api'
import { isDockerConnection, useConnectionsStore } from '../../../stores/connections'
import { useEnvironmentStore } from '../../../stores/environment'
import { useTabsStore } from '../../../stores/tabs'
import { formatDuration } from '../../../utils/format'
import Badge from '../../common/Badge.vue'
import Button from '../../common/Button.vue'
import IconButton from '../../common/IconButton.vue'
import Modal from '../../common/Modal.vue'
import Spinner from '../../common/Spinner.vue'
import TextInput from '../../common/TextInput.vue'
import {
  applySuggestions,
  composeLabel,
  dockerFormFrom,
  dockerInput,
  emptyDockerForm,
  findContainer,
  validateDockerForm,
  type DockerFormErrors,
  type DockerSuggestions
} from './dockerUtils'

/**
 * Docker connection form: pick a running container (or type its name), the project path inside it, an optional
 * host folder, PHP binary and user. Picking a container prefills path, host folder and name from `docker inspect`.
 * New connections open in a tab on Connect; `connectionId` edits a stored one.
 */
const props = defineProps<{ connectionId?: string }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const connections = useConnectionsStore()
const environment = useEnvironmentStore()
const tabs = useTabsStore()

const stored = connections.byId(props.connectionId)
const editing: DockerConnection | null = isDockerConnection(stored) ? stored : null

const form = ref(editing ? dockerFormFrom(editing) : emptyDockerForm())
// Edit mode never overwrites saved values with suggestions (null sentinels).
let suggested: DockerSuggestions = editing ? { path: null, hostPath: null, name: null } : { path: '', hostPath: '', name: '' }
const errors = ref<DockerFormErrors>({})
const saveError = ref<string | null>(null)
const saving = ref(false)

const containers = shallowRef<DockerContainer[]>([])
const containersLoading = ref(false)
const containersError = ref<string | null>(null)

const testing = ref(false)
const testResult = shallowRef<ConnectionTestResult | null>(null)

const picked = computed(() => findContainer(containers.value, form.value.container))

async function loadContainers(): Promise<void> {
  containersLoading.value = true
  containersError.value = null
  try {
    containers.value = await connections.listContainers()
  } catch (err) {
    containers.value = []
    containersError.value = api.errorText(err)
  } finally {
    containersLoading.value = false
  }
}

function prefill(): void {
  const next = applySuggestions(form.value, suggested, picked.value)
  suggested = next.suggested
  const current = form.value
  if ((Object.keys(current) as Array<keyof typeof current>).some((key) => next.form[key] !== current[key])) form.value = next.form
}

watch(picked, prefill)
watch(() => form.value.path, prefill)

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

function pick(container: DockerContainer): void {
  form.value = { ...form.value, container: container.name }
}

function validate(): boolean {
  errors.value = validateDockerForm(form.value)
  return Object.keys(errors.value).length === 0
}

/** Connection as it would be saved (for Test). */
function draft(): DockerConnection {
  return { ...(editing ?? {}), ...dockerInput(form.value), id: editing?.id ?? 'docker-test', type: 'docker', createdAt: editing?.createdAt ?? Date.now() }
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
      const saved = await connections.save({ ...editing, ...dockerInput(form.value), type: 'docker' })
      void environment.load(saved.id, true)
    } else {
      const conn = await connections.openDocker(dockerInput(form.value))
      tabs.openProject(conn)
    }
    emit('close')
  } catch (err) {
    saveError.value = api.errorText(err)
  } finally {
    saving.value = false
  }
}

onMounted(() => void loadContainers())
</script>

<template>
  <Modal :title="editing ? 'Edit Docker Connection' : 'Open Docker Container'" size="md" initial-focus="[data-docker-container]" @close="emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <p class="-mt-1 text-[13px] text-muted">
        Code runs inside a running container with <span class="font-mono">docker exec</span>.
      </p>

      <!-- Container -->
      <section class="space-y-2">
        <div data-docker-container>
          <label class="mb-1.5 block text-xs font-semibold text-muted">Container</label>
          <TextInput v-model="form.container" monospace placeholder="Name or id" :error="errors.container" @enter="submit" />
        </div>
        <div class="flex items-center gap-1.5">
          <h3 class="flex-1 text-xs font-semibold text-muted">Running containers</h3>
          <IconButton :icon="RotateCw" label="Reload containers" size="xs" :disabled="containersLoading" @click="loadContainers" />
        </div>
        <div v-if="containersLoading && containers.length === 0" class="flex items-center gap-2 py-1 text-xs text-muted">
          <Spinner :size="13" /> Looking for running containers…
        </div>
        <p v-else-if="containersError" class="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning" data-testid="docker-error">
          <TriangleAlert :size="14" class="mt-px shrink-0" /> <span class="selectable min-w-0">{{ containersError }}</span>
        </p>
        <p v-else-if="containers.length === 0" class="py-1 text-xs text-muted">No running containers. Start one and reload, or enter its name above.</p>
        <ul v-else class="max-h-[180px] overflow-y-auto rounded-xl border border-line" role="listbox" aria-label="Running containers">
          <li v-for="c in containers" :key="c.id" class="border-t border-line/70 first:border-t-0">
            <button
              type="button"
              role="option"
              :aria-selected="picked?.id === c.id"
              :class="['flex w-full items-center gap-3 px-3 py-2 text-left transition-colors', picked?.id === c.id ? 'bg-accent-soft' : 'hover:bg-hover']"
              :title="c.id"
              @click="pick(c)"
            >
              <Container :size="15" class="shrink-0 text-muted" />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="truncate text-[13px] font-semibold text-fg">{{ c.name }}</span>
                  <Badge v-if="composeLabel(c)" size="xs">{{ composeLabel(c) }}</Badge>
                </span>
                <span class="mt-0.5 block truncate font-mono text-[11px] text-muted">{{ c.image }}</span>
              </span>
              <Check v-if="picked?.id === c.id" :size="15" class="shrink-0 text-accent" aria-label="Selected" />
            </button>
          </li>
        </ul>
      </section>

      <!-- Project -->
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Project path in the container</label>
        <TextInput v-model="form.path" monospace placeholder="/var/www/html" :error="errors.path" @enter="submit" />
        <p class="mt-1 text-xs text-muted">Leave it empty to run plain PHP in the container.</p>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Host folder <span class="font-normal">(optional)</span></label>
        <TextInput v-model="form.hostPath" monospace folder-picker picker-title="Choose the host folder" :error="errors.hostPath" @enter="submit" />
        <p class="mt-1 text-xs text-muted">Open files from output in your editor. Usually the folder you mounted into the container.</p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-muted">PHP binary</label>
          <TextInput v-model="form.phpBinary" monospace placeholder="php" @enter="submit" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-muted">User <span class="font-normal">(optional)</span></label>
          <TextInput v-model="form.user" monospace placeholder="Container default" :error="errors.user" @enter="submit" />
        </div>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Name</label>
        <TextInput v-model="form.name" :placeholder="form.container.trim() || 'Shown on tabs and in recent projects'" @enter="submit" />
      </div>

      <div
        v-if="testing || testResult"
        class="flex min-h-[34px] items-center gap-2 rounded-lg border border-line bg-app-alt/60 px-3 py-2 text-xs"
        data-testid="docker-test-result"
      >
        <Spinner v-if="testing" :size="12" class="text-muted" />
        <template v-else-if="testResult">
          <CircleCheck v-if="testResult.ok" :size="14" class="shrink-0 text-success" />
          <TriangleAlert v-else :size="14" class="shrink-0 text-danger" />
          <span :class="['selectable min-w-0 flex-1 break-words', testResult.ok ? 'text-fg' : 'text-danger']">{{ testResult.message }}</span>
          <span v-if="testResult.durationMs > 0" class="shrink-0 font-mono text-muted">{{ formatDuration(testResult.durationMs) }}</span>
        </template>
        <span v-if="testing" class="text-muted">Testing the connection…</span>
      </div>
      <p v-if="saveError" class="text-xs text-danger">{{ saveError }}</p>
    </form>

    <template #footer>
      <Button variant="ghost" size="sm" :icon="PlugZap" :loading="testing" :disabled="saving" data-testid="docker-test" @click="test">Test</Button>
      <div class="flex-1" />
      <Button size="sm" @click="emit('close')">Cancel</Button>
      <Button variant="primary" size="sm" :loading="saving" data-testid="docker-submit" @click="submit">{{ editing ? 'Save' : 'Connect' }}</Button>
    </template>
  </Modal>
</template>
