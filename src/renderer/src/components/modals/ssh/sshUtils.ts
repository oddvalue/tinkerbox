import type { SshConnection, SshHost } from '@shared/types'
import type { SshConnectionInput } from '../../../stores/connections'
import { isAbsoluteHostPath } from '../docker/dockerUtils'

/**
 * Pure logic of the SSH connection form: host hints from ~/.ssh/config, the suggested name, validation that mirrors
 * the main process, and the conversion to a connection.
 */

export interface SshFormState {
  host: string
  /** Text field; '' = the default (22 or what ~/.ssh/config says). */
  port: string
  path: string
  hostPath: string
  phpBinary: string
  name: string
  production: boolean
}

export type SshFormErrors = Partial<Record<keyof SshFormState, string>>

/** Same rule as the main process: a Host alias, host or user@host, never starting with a dash (an ssh option). */
export const SSH_HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@%:-]*$/

export function emptySshForm(): SshFormState {
  return { host: '', port: '', path: '', hostPath: '', phpBinary: '', name: '', production: false }
}

export function sshFormFrom(conn: SshConnection): SshFormState {
  return {
    host: conn.host,
    port: conn.port ? String(conn.port) : '',
    path: conn.path,
    hostPath: conn.hostPath ?? '',
    phpBinary: conn.phpBinary ?? '',
    name: conn.name,
    production: conn.production === true
  }
}

function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** What an alias resolves to, for the host list: "deploy@203.0.113.7:2222" ('' when the block sets nothing). */
export function sshHostHint(host: SshHost): string {
  if (!host.hostName && !host.user && !host.port) return ''
  return `${host.user ? `${host.user}@` : ''}${host.hostName || host.alias}${host.port ? `:${host.port}` : ''}`
}

export function findSshHost(list: readonly SshHost[], value: string): SshHost | null {
  const wanted = value.trim()
  return wanted ? (list.find((h) => h.alias === wanted) ?? null) : null
}

/** Default name: the host without the user, plus the project folder name ("prod-web shop"). */
export function suggestSshName(host: string, path: string): string {
  const server = host.trim().replace(/^[^@]*@/, '')
  const folder = trimSlashes(path.trim()).split('/').pop() ?? ''
  return [server, folder].filter(Boolean).join(' ')
}

/**
 * Keep the name in step with host and path while it still holds the last suggestion (or is empty). Returns the
 * next name and the suggestion to compare against next time. `last` null (edit mode) leaves the name alone.
 */
export function applySshName(form: SshFormState, last: string | null): { name: string; suggested: string | null } {
  const suggestion = suggestSshName(form.host, form.path)
  if (last === null && form.name.trim() !== '') return { name: form.name, suggested: null }
  if (form.name === last || form.name.trim() === '') return { name: suggestion, suggested: suggestion }
  return { name: form.name, suggested: suggestion }
}

export function validateSshForm(form: SshFormState): SshFormErrors {
  const errors: SshFormErrors = {}
  const host = form.host.trim()
  if (!host) errors.host = 'Choose a host from your ssh config or enter one.'
  else if (!SSH_HOST.test(host)) errors.host = 'Enter a Host alias, a host name or user@host.'
  const port = form.port.trim()
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) errors.port = 'Use a port from 1 to 65535.'
  const path = form.path.trim()
  if (path && !path.startsWith('/')) errors.path = 'Use an absolute path, for example /var/www/app.'
  const hostPath = form.hostPath.trim()
  if (hostPath && !isAbsoluteHostPath(hostPath)) errors.hostPath = 'Use an absolute path.'
  return errors
}

/** Trimmed connection fields. Empty optional fields are sent as '' (or an undefined port) so saving clears them. */
export function sshInput(form: SshFormState): SshConnectionInput {
  const host = form.host.trim()
  const path = trimSlashes(form.path.trim())
  const port = form.port.trim()
  return {
    host,
    port: port ? Number(port) : undefined,
    path,
    hostPath: form.hostPath.trim(),
    phpBinary: form.phpBinary.trim(),
    name: form.name.trim() || suggestSshName(host, path) || host,
    production: form.production
  }
}
