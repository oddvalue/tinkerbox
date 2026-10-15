/**
 * Host aliases from ~/.ssh/config for the SSH connection form. Only what the form shows is read (Host, HostName,
 * User, Port); `ssh` itself still applies the whole file. `Include` is followed (relative to ~/.ssh, `*` globs in the
 * file name), wildcard patterns and negations are skipped.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { SshHost } from '@shared/types'
import { expandHome } from '../env/which'

const MAX_DEPTH = 5

function globFiles(pattern: string): string[] {
  const dir = dirname(pattern)
  const name = basename(pattern)
  if (!/[*?]/.test(name)) return [pattern]
  const regex = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  try {
    return readdirSync(dir)
      .filter((f) => regex.test(f))
      .sort()
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** Pure: the Host entries of one config text; `include(path)` returns the text of an included file (or ''). */
export function parseSshConfig(text: string, include: (pattern: string) => string[] = () => [], depth = 0): SshHost[] {
  const hosts: SshHost[] = []
  let current: SshHost[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].replace(/\s+#.*$/, '').trim()
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((alias) => alias && !/[*?!]/.test(alias))
        .map((alias) => ({ alias, hostName: '', user: '', port: 0 }))
      hosts.push(...current)
    } else if (key === 'match') {
      current = []
    } else if (key === 'include' && depth < MAX_DEPTH) {
      for (const pattern of value.split(/\s+/)) for (const content of include(pattern)) hosts.push(...parseSshConfig(content, include, depth + 1))
    } else {
      // ssh uses the first value it finds for each key.
      for (const host of current) {
        if (key === 'hostname' && !host.hostName) host.hostName = value
        else if (key === 'user' && !host.user) host.user = value
        else if (key === 'port' && !host.port) host.port = Number(value) || 0
      }
    }
  }
  return hosts
}

/** Host aliases from ~/.ssh/config, first definition of each alias wins; [] when there is no config. */
export function listSshHosts(home = homedir()): SshHost[] {
  const sshDir = join(home, '.ssh')
  const read = (path: string): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  const include = (pattern: string): string[] => {
    const expanded = expandHome(pattern, home)
    const path = isAbsolute(expanded) ? expanded : join(sshDir, expanded)
    return globFiles(path).map(read)
  }
  const seen = new Set<string>()
  return parseSshConfig(read(join(sshDir, 'config')), include).filter((h) => !seen.has(h.alias) && seen.add(h.alias))
}
