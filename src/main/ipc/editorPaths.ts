import { isAbsolute, join, posix } from 'node:path'
import type { Connection } from '../../shared/types'

/**
 * Resolve a file path reported by PHP for "open in editor". The runner reports project files relative to the
 * project root (ExceptionFormatter), so relative paths are joined with the project directory; absolute paths are
 * returned unchanged. For a Docker or SSH connection, paths inside the remote project directory are mapped to its
 * folder on this machine (the bind-mount source or a local checkout); without one they are returned unchanged and
 * will not be found.
 */
export function localPathForFile(file: string, connection: Connection | null): string {
  if (connection && connection.type !== 'local') return hostPathForContainerFile(file, connection.path, connection.hostPath ?? '')
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return file
  if (!connection || !connection.path) return file
  return join(connection.path, file)
}

/** Map a container path (absolute, or relative to the container project directory) into `hostRoot`. */
export function hostPathForContainerFile(file: string, containerRoot: string, hostRoot: string): string {
  if (!hostRoot) return file
  if (!posix.isAbsolute(file)) return join(hostRoot, file)
  if (!containerRoot) return file
  const relative = posix.relative(containerRoot, posix.normalize(file))
  if (relative === '') return hostRoot
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) return file
  return join(hostRoot, ...relative.split('/'))
}
