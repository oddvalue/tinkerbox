/** Locating the Docker CLI, shared by the Docker transport, the container list and the compose helpers. */
import { expandHome, findExecutable } from '../env/which'

/** Where Docker Desktop, OrbStack, Colima and Homebrew put the CLI; GUI apps often start without them on PATH. */
const DOCKER_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '~/.orbstack/bin',
  '~/.docker/bin',
  '/Applications/Docker.app/Contents/Resources/bin',
  '/Applications/OrbStack.app/Contents/MacOS/xbin'
]

/**
 * The container CLI: `TINKERBOX_DOCKER` when set (a path or a name such as `podman`), else `docker` on PATH or in
 * the usual install folders. Returns null when none is found.
 */
export function findDockerCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.TINKERBOX_DOCKER?.trim()
  if (override) return findExecutable(override, DOCKER_DIRS.map((d) => expandHome(d)))
  return findExecutable('docker', DOCKER_DIRS.map((d) => expandHome(d)))
}

export const DOCKER_MISSING =
  'Docker CLI not found. Install Docker (or set TINKERBOX_DOCKER to the path of a compatible CLI such as podman) and restart Tinkerbox.'
