import type { DockerComposeProject, DockerComposeRef, DockerComposeService, DockerConnection, DockerContainer } from '@shared/types'
import type { DockerConnectionInput } from '../../../stores/connections'

/**
 * Pure logic of the Docker connection form: suggestions from `docker inspect` (project path, host folder, name) or
 * from a compose project (which service runs PHP), validation that mirrors the main process, and the conversion to
 * a connection.
 */

export interface DockerFormState {
  container: string
  path: string
  hostPath: string
  phpBinary: string
  user: string
  name: string
}

/** Values the form last filled in by itself. null never matches, so the field is left alone (edit mode). */
export interface DockerSuggestions {
  path: string | null
  hostPath: string | null
  name: string | null
  user: string | null
}

/** Suggestions for a new connection (empty fields count as untouched) and for edit mode (saved values are kept). */
export const NEW_SUGGESTIONS: Readonly<DockerSuggestions> = { path: '', hostPath: '', name: '', user: '' }
export const EDIT_SUGGESTIONS: Readonly<DockerSuggestions> = { path: null, hostPath: null, name: null, user: null }

export type DockerFormErrors = Partial<Record<keyof DockerFormState, string>>

/** Same rules as the main process (`sanitizeConnection`). */
export const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
export const CONTAINER_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/

const WEB_ROOT = '/var/www/html'

export function emptyDockerForm(): DockerFormState {
  return { container: '', path: '', hostPath: '', phpBinary: '', user: '', name: '' }
}

export function dockerFormFrom(conn: DockerConnection): DockerFormState {
  return {
    container: conn.container,
    path: conn.path,
    hostPath: conn.hostPath ?? '',
    phpBinary: conn.phpBinary ?? '',
    user: conn.user ?? '',
    name: conn.name
  }
}

function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** Container by name or id (a unique id prefix like `docker ps` shows also matches). */
export function findContainer(list: readonly DockerContainer[], value: string): DockerContainer | null {
  const wanted = value.trim()
  if (!wanted) return null
  const exact = list.find((c) => c.name === wanted || c.id === wanted)
  if (exact) return exact
  if (wanted.length < 4) return null
  const prefixed = list.filter((c) => c.id.startsWith(wanted))
  return prefixed.length === 1 ? prefixed[0] : null
}

/** Compose project and service ("shop / app"), '' for a container started without Compose. */
export function composeLabel(c: DockerContainer): string {
  return [c.composeProject, c.composeService].filter(Boolean).join(' / ')
}

/** Project directory inside a container: its working directory, else /var/www/html when something is mounted there. */
export function suggestPath(c: Pick<DockerContainer, 'workingDir' | 'mounts'>): string {
  const workingDir = trimSlashes(c.workingDir.trim())
  if (workingDir && workingDir !== '/') return workingDir
  if (c.mounts.some((m) => trimSlashes(m.destination) === WEB_ROOT)) return WEB_ROOT
  return ''
}

/**
 * Host folder behind a path inside the container: the source of the mount at that path, or of the closest mount
 * above it with the rest of the path appended. '' when the path is not on a bind mount.
 */
export function suggestHostPath(c: DockerContainer, path: string): string {
  const inner = trimSlashes(path.trim())
  if (!inner.startsWith('/')) return ''
  let best: { source: string; destination: string } | null = null
  for (const mount of c.mounts) {
    const destination = trimSlashes(mount.destination)
    const covers = destination === inner || inner.startsWith(destination === '/' ? '/' : `${destination}/`)
    if (covers && mount.source && (!best || destination.length > best.destination.length)) best = { source: mount.source, destination }
  }
  if (!best) return ''
  const rest = inner.slice(best.destination === '/' ? 1 : best.destination.length + 1)
  if (!rest) return best.source
  const windows = best.source.includes('\\') && !best.source.includes('/')
  const sep = windows ? '\\' : '/'
  return best.source.replace(/[\\/]+$/, '') + sep + (windows ? rest.replace(/\//g, '\\') : rest)
}

/** Display name for a new connection: the Compose project, else the container name. */
export function suggestName(c: DockerContainer): string {
  return c.composeProject || c.name
}

/**
 * Prefill after the container or the path changed. Path, host folder and name take the new suggestion only while
 * they still hold the previous one (the user has not edited them); an empty name is always filled. Returns the
 * next form and the suggestions to compare against next time. An unknown container changes nothing.
 */
export function applySuggestions(
  form: DockerFormState,
  last: DockerSuggestions,
  container: DockerContainer | null
): { form: DockerFormState; suggested: DockerSuggestions } {
  if (!container) return { form, suggested: last }
  const next = { ...form }
  const path = suggestPath(container)
  const fillPath = next.path === last.path
  if (fillPath) next.path = path
  const hostPath = suggestHostPath(container, next.path)
  const fillHostPath = next.hostPath === last.hostPath
  if (fillHostPath) next.hostPath = hostPath
  const name = suggestName(container)
  const fillName = next.name === last.name || next.name.trim() === ''
  if (fillName) next.name = name
  return {
    form: next,
    suggested: {
      path: track(last.path, path, fillPath),
      hostPath: track(last.hostPath, hostPath, fillHostPath),
      name: track(last.name, name, fillName),
      user: last.user
    }
  }
}

/** A field that was never filled keeps its null sentinel, so later suggestions leave it alone too. */
function track(previous: string | null, value: string, filled: boolean): string | null {
  return previous === null && !filled ? null : value
}

// ---------------------------------------------------------------------------------------------------------------
// Compose projects
// ---------------------------------------------------------------------------------------------------------------

/** Services that usually run something other than PHP (matched against the name and image words). */
const NON_PHP_WORDS = new Set([
  'mysql', 'mariadb', 'postgres', 'postgresql', 'pgsql', 'redis', 'valkey', 'memcached', 'mailhog', 'mailpit',
  'meilisearch', 'typesense', 'clickhouse', 'selenium', 'minio', 'nginx', 'caddy', 'traefik', 'elasticsearch',
  'opensearch', 'rabbitmq', 'mongo', 'mongodb', 'soketi', 'phpmyadmin', 'adminer', 'node', 'vite'
])

/** Service names that usually run the PHP app. */
const APP_NAMES = new Set(['app', 'web', 'php', 'laravel.test', 'workspace', 'fpm', 'php-fpm', 'laravel', 'api', 'backend'])

/** Words of a service name and of its image's base name ("mysql/mysql-server:8.0" → mysql, server). */
function serviceWords(service: DockerComposeService): string[] {
  const image = service.image.split('/').pop()?.split(':')[0] ?? ''
  return `${service.name} ${image}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

export function isNonPhpService(service: DockerComposeService): boolean {
  return serviceWords(service).some((word) => NON_PHP_WORDS.has(word))
}

function normalizeHostPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '') || path.trim()
  // Windows paths compare case-insensitively.
  return /^[A-Za-z]:|\\/.test(trimmed) ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
}

export function sameHostPath(a: string, b: string): boolean {
  return a.trim() !== '' && normalizeHostPath(a) === normalizeHostPath(b)
}

/** Bind mount of the project folder into the service, if any. */
export function projectMount(service: DockerComposeService, dir: string): { source: string; destination: string } | null {
  return service.mounts.find((m) => sameHostPath(m.source, dir)) ?? null
}

/**
 * How likely a service runs the PHP app: it mounts the project folder, has a usual app name or a PHP image, and
 * is running. -1 for databases, caches, mail catchers, web servers and the like.
 */
export function phpServiceScore(service: DockerComposeService, dir: string): number {
  if (isNonPhpService(service)) return -1
  let score = 0
  if (projectMount(service, dir)) score += 4
  if (APP_NAMES.has(service.name.toLowerCase())) score += 2
  if (/php/i.test(service.image)) score += 1
  if (service.state === 'running') score += 1
  return score
}

/** The service that most likely runs PHP (first one on a tie), null when every service looks like something else. */
export function pickPhpService(project: DockerComposeProject): DockerComposeService | null {
  let best: DockerComposeService | null = null
  let bestScore = -1
  for (const service of project.services) {
    const score = phpServiceScore(service, project.dir)
    if (score > bestScore) {
      best = service
      bestScore = score
    }
  }
  return best
}

export function composeRef(project: DockerComposeProject, service: DockerComposeService): DockerComposeRef {
  return { project: project.project, service: service.name, dir: project.dir }
}

/** Compose file names for display ("docker-compose.yml, docker-compose.override.yml"). */
export function composeFileNames(project: DockerComposeProject): string {
  return project.files.map((file) => file.split(/[\\/]/).pop() || file).join(', ')
}

/**
 * Form values for a running service. Path: where the project folder is mounted, else the service's working
 * directory, else what the running container suggests. Name: the project for the app service, else
 * "project service".
 */
export function composeFill(
  project: DockerComposeProject,
  service: DockerComposeService,
  container: DockerContainer | null = null
): Pick<DockerFormState, 'container' | 'path' | 'hostPath' | 'user' | 'name'> {
  const mount = projectMount(service, project.dir)
  const workingDir = trimSlashes(service.workingDir.trim())
  const path = mount
    ? trimSlashes(mount.destination)
    : workingDir && workingDir !== '/'
      ? workingDir
      : (container ? suggestPath(container) : '') || suggestPath(service)
  const app = pickPhpService(project)?.name === service.name
  return {
    container: service.container,
    path,
    hostPath: project.dir,
    user: service.user,
    name: app ? project.project : `${project.project} ${service.name}`
  }
}

/**
 * Prefill after a compose service was picked. The container always follows the service; path, host folder, user
 * and name follow the same rule as applySuggestions().
 */
export function applyComposeService(
  form: DockerFormState,
  last: DockerSuggestions,
  project: DockerComposeProject,
  service: DockerComposeService,
  container: DockerContainer | null = null
): { form: DockerFormState; suggested: DockerSuggestions } {
  const fill = composeFill(project, service, container)
  const next = { ...form, container: fill.container }
  const suggested = { ...last }
  for (const key of ['path', 'hostPath', 'user', 'name'] as const) {
    const filled = next[key] === last[key] || (key === 'name' && next.name.trim() === '')
    if (filled) next[key] = fill[key]
    suggested[key] = track(last[key], fill[key], filled)
  }
  return { form: next, suggested }
}

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

export function validateDockerForm(form: DockerFormState): DockerFormErrors {
  const errors: DockerFormErrors = {}
  const container = form.container.trim()
  if (!container) errors.container = 'Choose a running container or enter its name.'
  else if (!CONTAINER_NAME.test(container)) errors.container = 'Enter a container name or id.'
  const path = form.path.trim()
  if (path && !path.startsWith('/')) errors.path = 'Use an absolute path, for example /var/www/html.'
  const hostPath = form.hostPath.trim()
  if (hostPath && !isAbsoluteHostPath(hostPath)) errors.hostPath = 'Use an absolute path.'
  const user = form.user.trim()
  if (user && !CONTAINER_USER.test(user)) errors.user = 'Enter a user name or uid, optionally with :group.'
  return errors
}

/**
 * Trimmed connection fields. Empty optional fields are sent as '' so saving clears them; `compose` is set for a
 * connection made from a compose file and explicitly undefined otherwise (so saving drops an old one).
 */
export function dockerInput(form: DockerFormState, compose: DockerComposeRef | null = null): DockerConnectionInput {
  const container = form.container.trim()
  return {
    compose: compose ?? undefined,
    container,
    path: trimSlashes(form.path.trim()),
    hostPath: form.hostPath.trim(),
    phpBinary: form.phpBinary.trim(),
    user: form.user.trim(),
    name: form.name.trim() || container
  }
}
