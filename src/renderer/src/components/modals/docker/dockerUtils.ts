import type { DockerConnection, DockerContainer } from '@shared/types'
import type { DockerConnectionInput } from '../../../stores/connections'

/**
 * Pure logic of the Docker connection form: suggestions from `docker inspect` (project path, host folder, name),
 * validation that mirrors the main process, and the conversion to a connection.
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
}

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
export function suggestPath(c: DockerContainer): string {
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
  // A field that was never filled keeps its null sentinel, so later suggestions leave it alone too.
  const track = (previous: string | null, value: string, filled: boolean): string | null => (previous === null && !filled ? null : value)
  return {
    form: next,
    suggested: { path: track(last.path, path, fillPath), hostPath: track(last.hostPath, hostPath, fillHostPath), name: track(last.name, name, fillName) }
  }
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

/** Trimmed connection fields. Empty optional fields are sent as '' so saving clears them. */
export function dockerInput(form: DockerFormState): DockerConnectionInput {
  const container = form.container.trim()
  return {
    container,
    path: trimSlashes(form.path.trim()),
    hostPath: form.hostPath.trim(),
    phpBinary: form.phpBinary.trim(),
    user: form.user.trim(),
    name: form.name.trim() || container
  }
}
