<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { Check, CircleCheck, Container, FileCode, Play, PlugZap, RotateCw, TriangleAlert } from 'lucide-vue-next'
import type {
  ConnectionTestResult,
  DockerComposeProject,
  DockerComposeRef,
  DockerComposeService,
  DockerConnection,
  DockerContainer
} from '@shared/types'
import { api } from '../../../api'
import { isDockerConnection, isImplicitConnection, useConnectionsStore } from '../../../stores/connections'
import { useEnvironmentStore } from '../../../stores/environment'
import { useTabsStore } from '../../../stores/tabs'
import type { DockerFlow } from '../../../stores/ui'
import { formatDuration } from '../../../utils/format'
import Badge from '../../common/Badge.vue'
import Button from '../../common/Button.vue'
import IconButton from '../../common/IconButton.vue'
import Modal from '../../common/Modal.vue'
import SegmentedControl from '../../common/SegmentedControl.vue'
import Spinner from '../../common/Spinner.vue'
import TextInput from '../../common/TextInput.vue'
import Toggle from '../../common/Toggle.vue'
import type { Segment } from '../../common/types'
import {
  EDIT_SUGGESTIONS,
  NEW_SUGGESTIONS,
  applyComposeService,
  applySuggestions,
  composeFileNames,
  composeLabel,
  composeRef,
  dockerFormFrom,
  dockerInput,
  emptyDockerForm,
  findContainer,
  pickPhpService,
  sameHostPath,
  validateDockerForm,
  type DockerFormErrors,
  type DockerFormState,
  type DockerSuggestions
} from './dockerUtils'

/**
 * Docker connection form. Two ways to pick where code runs: a service of a compose project (pick the project
 * folder, Tinkerbox reads the compose file and suggests the PHP service) or any running container. Either one
 * prefills the project path inside the container, the host folder and the name; PHP binary and user are optional.
 * New connections open in a tab on Connect; `connectionId` edits a stored one.
 */
const props = defineProps<{ connectionId?: string; flow?: DockerFlow; pickFolder?: boolean }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const connections = useConnectionsStore()
const environment = useEnvironmentStore()
const tabs = useTabsStore()

const stored = connections.byId(props.connectionId)
const editing: DockerConnection | null = isDockerConnection(stored) ? stored : null

const FLOWS: Segment<DockerFlow>[] = [
  { value: 'compose', label: 'Compose file', icon: FileCode },
  { value: 'containers', label: 'Running containers', icon: Container }
]
const flow = ref<DockerFlow>(props.flow ?? (editing?.compose ? 'compose' : 'containers'))
/** The caller or the user chose the flow; detecting a compose file in the active project does not switch it. */
let flowChosen = !!props.flow || !!editing

const form = ref<DockerFormState>(editing ? dockerFormFrom(editing) : emptyDockerForm())
// Edit mode never overwrites saved values with suggestions (null sentinels).
let suggested: DockerSuggestions = { ...(editing ? EDIT_SUGGESTIONS : NEW_SUGGESTIONS) }
const errors = ref<DockerFormErrors>({})
const saveError = ref<string | null>(null)
const saving = ref(false)

const containers = shallowRef<DockerContainer[]>([])
const containersLoading = ref(false)
const containersError = ref<string | null>(null)

const composeDir = ref(editing?.compose?.dir ?? '')
const project = shallowRef<DockerComposeProject | null>(null)
/** A lookup finished for the folder (project null then means "no compose file"). */
const composeLoaded = ref(false)
const composeLoading = ref(false)
const composeError = ref<string | null>(null)
const selectedService = ref<string | null>(editing?.compose?.service ?? null)
/** Compose service the connection is saved with (only a running service sets it). */
const composeSelection = ref<DockerComposeRef | null>(editing?.compose ?? null)
/** Edit mode shows the saved service without refilling the form until the user picks one. */
let keepSavedService = !!editing?.compose
const starting = ref(false)
const startError = ref<string | null>(null)

const testing = ref(false)
const testResult = shallowRef<ConnectionTestResult | null>(null)

const picked = computed(() => findContainer(containers.value, form.value.container))
const selected = computed(() => project.value?.services.find((s) => s.name === selectedService.value) ?? null)
const likelyService = computed(() => (project.value ? (pickPhpService(project.value)?.name ?? null) : null))

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

function setForm(next: { form: DockerFormState; suggested: DockerSuggestions }): void {
  suggested = next.suggested
  const current = form.value
  if ((Object.keys(current) as Array<keyof DockerFormState>).some((key) => next.form[key] !== current[key])) form.value = next.form
}

function prefill(): void {
  if (flow.value === 'containers') setForm(applySuggestions(form.value, suggested, picked.value))
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

function setFlow(value: DockerFlow | undefined): void {
  if (!value) return
  flowChosen = true
  flow.value = value
}

// Switching to the compose flow applies the selected service to the form.
watch(flow, (value) => {
  errors.value = {}
  if (value === 'compose' && selected.value && !keepSavedService) chooseService(selected.value)
})

function pick(container: DockerContainer): void {
  form.value = { ...form.value, container: container.name }
}

/** Select a service. A running one fills the form (in the compose flow); a stopped one offers "Start service". */
function chooseService(service: DockerComposeService): void {
  keepSavedService = false
  selectedService.value = service.name
  startError.value = null
  const current = project.value
  if (!current || !service.container || service.state !== 'running') {
    composeSelection.value = null
    return
  }
  composeSelection.value = composeRef(current, service)
  if (flow.value !== 'compose') return
  setForm(applyComposeService(form.value, suggested, current, service, findContainer(containers.value, service.container)))
}

/** After loading a project: keep the saved or chosen service when it is still there, else suggest the PHP one. */
function selectInitialService(result: DockerComposeProject): void {
  const kept = result.services.find((s) => s.name === selectedService.value)
  if (kept && keepSavedService && editing?.compose && sameHostPath(editing.compose.dir, result.dir)) return
  const service = kept ?? pickPhpService(result)
  if (service) chooseService(service)
  else {
    selectedService.value = null
    composeSelection.value = null
  }
}

let composeToken = 0
/** Read the compose project in a folder. `quiet` hides errors (used to detect one in the active project). */
async function loadCompose(dir = composeDir.value, quiet = false): Promise<boolean> {
  const wanted = dir.trim()
  if (!wanted) return false
  const token = ++composeToken
  composeDir.value = wanted
  // Another folder replaces the saved service.
  if (keepSavedService && !(editing?.compose && sameHostPath(editing.compose.dir, wanted))) {
    keepSavedService = false
    composeSelection.value = null
  }
  composeLoading.value = true
  composeError.value = null
  try {
    const result = await connections.composeProject(wanted)
    if (token !== composeToken) return false
    project.value = result
    composeLoaded.value = true
    if (result) selectInitialService(result)
    else composeSelection.value = null
    return result !== null
  } catch (err) {
    if (token !== composeToken) return false
    project.value = null
    composeLoaded.value = false
    if (!quiet) composeError.value = api.errorText(err)
    return false
  } finally {
    if (token === composeToken) composeLoading.value = false
  }
}

async function browseComposeFolder(): Promise<void> {
  try {
    const dir = await api.invoke('dialog:openDirectory', 'Choose the compose project folder')
    if (dir) await loadCompose(dir)
  } catch (err) {
    composeError.value = api.errorText(err)
  }
}

async function startService(service: DockerComposeService): Promise<void> {
  if (!project.value || starting.value) return
  starting.value = true
  startError.value = null
  try {
    const refreshed = await connections.composeUp(project.value.dir, service.name)
    project.value = refreshed
    await loadContainers()
    const again = refreshed.services.find((s) => s.name === service.name)
    if (again) chooseService(again)
    if (!again || again.state !== 'running') startError.value = `${service.name} did not start. Check the output of docker compose logs ${service.name}.`
  } catch (err) {
    startError.value = api.errorText(err)
  } finally {
    starting.value = false
  }
}

/**
 * Folder on this machine behind the active tab, to look for a compose file there: a local project, or the compose
 * folder / host folder of a Docker connection. Never a path that only exists inside a container or on a server.
 */
function activeProjectDir(): string {
  const tab = tabs.activeTab
  if (tab?.kind !== 'code') return ''
  const id = connections.effectiveId(tab.connectionId)
  const conn = isImplicitConnection(id) ? undefined : connections.byId(id)
  if (!conn) return ''
  if (conn.type === 'docker') return conn.compose?.dir || conn.hostPath || ''
  return conn.type === 'local' ? conn.path : ''
}

function validate(): boolean {
  const found = validateDockerForm(form.value)
  if (flow.value === 'compose' && !composeSelection.value) {
    found.container = project.value ? 'Choose a running service, or start it first.' : 'Choose a project folder with a compose file.'
  }
  errors.value = found
  return Object.keys(found).length === 0
}

function input() {
  return dockerInput(form.value, flow.value === 'compose' ? composeSelection.value : null)
}

/** Connection as it would be saved (for Test). */
function draft(): DockerConnection {
  return { ...(editing ?? {}), ...input(), id: editing?.id ?? 'docker-test', type: 'docker', createdAt: editing?.createdAt ?? Date.now() }
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
      const saved = await connections.save({ ...editing, ...input(), type: 'docker' })
      void environment.load(saved.id, true)
    } else {
      const conn = await connections.openDocker(input())
      tabs.openProject(conn)
    }
    emit('close')
  } catch (err) {
    saveError.value = api.errorText(err)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadContainers()
  if (props.pickFolder) {
    void browseComposeFolder()
  } else if (composeDir.value) {
    void loadCompose()
  } else if (!editing) {
    // Start with the compose flow when the active project has a compose file.
    const dir = activeProjectDir()
    if (!dir) return
    composeDir.value = dir
    void loadCompose(dir, true).then((found) => {
      if (found && !flowChosen && !form.value.container.trim()) flow.value = 'compose'
    })
  }
})
</script>

<template>
  <Modal
    :title="editing ? 'Edit Docker Connection' : 'Open Docker Container'"
    size="md"
    :initial-focus="flow === 'compose' ? '[data-docker-folder]' : '[data-docker-container]'"
    @close="emit('close')"
  >
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <div class="-mt-1 flex flex-wrap items-center justify-between gap-2">
        <p class="text-[13px] text-muted">Code runs inside a container with <span class="font-mono">docker exec</span>.</p>
        <SegmentedControl :model-value="flow" :options="FLOWS" size="sm" data-testid="docker-flow" @update:model-value="setFlow" />
      </div>

      <!-- Compose file -->
      <section v-if="flow === 'compose'" class="space-y-2" data-testid="docker-compose">
        <div data-docker-folder>
          <label class="mb-1.5 block text-xs font-semibold text-muted">Project folder</label>
          <TextInput
            v-model="composeDir"
            monospace
            folder-picker
            picker-title="Choose the compose project folder"
            placeholder="Folder with a compose file"
            @enter="loadCompose()"
            @picked="loadCompose"
          />
        </div>
        <div v-if="composeLoading" class="flex items-center gap-2 py-1 text-xs text-muted">
          <Spinner :size="13" /> Reading the compose file…
        </div>
        <p v-else-if="composeError" class="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning" data-testid="compose-error">
          <TriangleAlert :size="14" class="mt-px shrink-0" /> <span class="selectable min-w-0 break-words">{{ composeError }}</span>
        </p>
        <p v-else-if="composeLoaded && !project" class="py-1 text-xs text-muted" data-testid="compose-none">
          No compose file in this folder (compose.yaml, compose.yml, docker-compose.yaml or docker-compose.yml).
        </p>
        <template v-else-if="project">
          <div class="flex items-center gap-1.5">
            <h3 class="min-w-0 flex-1 truncate text-xs text-muted" :title="project.files.join('\n')">
              <span class="font-semibold">Services</span> · <span class="font-mono">{{ composeFileNames(project) }}</span> · project
              <span class="font-mono">{{ project.project }}</span>
            </h3>
            <IconButton :icon="RotateCw" label="Reload the compose project" size="xs" :disabled="composeLoading || starting" @click="loadCompose()" />
          </div>
          <ul class="max-h-[180px] overflow-y-auto rounded-xl border border-line" role="listbox" aria-label="Compose services">
            <li v-for="service in project.services" :key="service.name" class="border-t border-line/70 first:border-t-0">
              <button
                type="button"
                role="option"
                :aria-selected="selectedService === service.name"
                :class="[
                  'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                  selectedService === service.name ? 'bg-accent-soft' : 'hover:bg-hover'
                ]"
                @click="chooseService(service)"
              >
                <Container :size="15" class="shrink-0 text-muted" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[13px] font-semibold text-fg">{{ service.name }}</span>
                    <Badge size="xs" :variant="service.state === 'running' ? 'success' : service.state ? 'warning' : 'neutral'">
                      {{ service.state || 'not created' }}
                    </Badge>
                    <Badge v-if="likelyService === service.name" size="xs" variant="accent">PHP app</Badge>
                  </span>
                  <span class="mt-0.5 block truncate font-mono text-[11px] text-muted">
                    {{ service.image || 'build' }}{{ service.container ? ` · ${service.container}` : '' }}
                  </span>
                </span>
                <Check v-if="selectedService === service.name" :size="15" class="shrink-0 text-accent" aria-label="Selected" />
              </button>
            </li>
          </ul>
          <div v-if="selected && selected.state !== 'running'" class="flex items-center gap-2 text-xs text-muted">
            <span class="min-w-0 flex-1">{{ selected.name }} is not running.</span>
            <Button size="xs" :icon="Play" :loading="starting" data-testid="compose-start" @click="startService(selected)">Start service</Button>
          </div>
          <p v-if="starting" class="text-xs text-muted">Starting {{ selectedService }}. Pulling or building images can take a while.</p>
          <p v-if="startError" class="selectable text-xs break-words text-danger">{{ startError }}</p>
        </template>
        <p v-if="errors.container" class="text-xs text-danger">{{ errors.container }}</p>
      </section>

      <!-- Running containers -->
      <section v-else class="space-y-2">
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
      <div data-testid="docker-production">
        <Toggle v-model="form.production" label="Production" description="Shows a red badge and asks before each run." />
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
