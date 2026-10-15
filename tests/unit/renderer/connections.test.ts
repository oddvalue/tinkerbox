import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { setBridge } from '@/api'
import type { DockerConnection } from '@shared/types'
import { connectionSubtitle, hostPathOf, useConnectionsStore } from '@/stores/connections'
import { useSettingsStore } from '@/stores/settings'
import { fakeBridge, type FakeBridge } from './helpers'

const EXISTING = '/Users/dev/projects/shop'

let fake: FakeBridge

beforeEach(async () => {
  fake = fakeBridge({ 'file:isDirectory': (path) => path === EXISTING, 'connections:list': () => [] })
  setBridge(fake.bridge)
  setActivePinia(createPinia())
  await useSettingsStore().load()
})

afterEach(() => {
  useConnectionsStore().dispose()
  setBridge(null)
})

describe('Default Working Directory', () => {
  it('is the project of tabs without one when the folder exists', async () => {
    const connections = useConnectionsStore()
    await useSettingsStore().set('defaultWorkingDirectory', EXISTING)
    expect(await connections.checkDefaultDirectory()).toBe(true)
    expect(connections.defaultDirectoryMissing).toBe(false)
    expect(connections.label(null)).toBe('shop')
    expect(connections.path(null)).toBe(EXISTING)
  })

  it('is ignored like the main process does when the folder does not exist', async () => {
    const connections = useConnectionsStore()
    await connections.load()
    await useSettingsStore().set('defaultWorkingDirectory', '/nonexistent/dir/abc')
    await nextTick()
    // The store re-checks whenever the setting changes.
    expect(fake.callsTo('file:isDirectory').map(([path]) => path)).toContain('/nonexistent/dir/abc')
    await connections.checkDefaultDirectory()
    expect(connections.defaultDirectoryMissing).toBe(true)
    expect(connections.defaultDirectory).toBe('')
    // Tabs without a project are labelled the way they run: the sandbox / plain PHP, not "abc".
    expect(connections.label(null)).not.toBe('abc')
    expect(connections.path(null)).toBe('')
    expect(connections.effectiveId(null)).toMatch(/^(sandbox|scratch)$/)
  })

  it('forgets a missing folder once the setting is cleared or fixed', async () => {
    const connections = useConnectionsStore()
    const settings = useSettingsStore()
    await settings.set('defaultWorkingDirectory', '/gone')
    await connections.checkDefaultDirectory()
    expect(connections.defaultDirectoryMissing).toBe(true)
    await settings.set('defaultWorkingDirectory', EXISTING)
    // A new value is not "missing" before it was checked.
    expect(connections.defaultDirectoryMissing).toBe(false)
    await connections.checkDefaultDirectory()
    expect(connections.label(null)).toBe('shop')
    await settings.set('defaultWorkingDirectory', '')
    expect(await connections.checkDefaultDirectory()).toBe(true)
    expect(connections.defaultDirectoryMissing).toBe(false)
  })
})

describe('Docker connections', () => {
  const DOCKER: DockerConnection = {
    id: 'docker-1',
    name: 'shop',
    type: 'docker',
    container: 'shop-app-1',
    path: EXISTING,
    hostPath: '/Users/dev/projects/shop',
    createdAt: 1,
    lastUsedAt: 5
  }

  it('are recent projects but never match a folder on this machine', async () => {
    const connections = useConnectionsStore()
    connections.connections = [DOCKER, { ...DOCKER, id: 'docker-2', path: '', lastUsedAt: 4 }]
    expect(connections.recent.map((c) => c.id)).toEqual(['docker-1', 'docker-2'])
    // Same path string as a local folder, but it lives inside the container.
    expect(connections.findByPath(EXISTING)).toBeUndefined()
    connections.connections = [...connections.connections, { id: 'local-1', name: 'shop', type: 'local', path: EXISTING, createdAt: 1 }]
    expect(connections.findByPath(`${EXISTING}/`)?.id).toBe('local-1')
    expect(connections.isDocker('docker-1')).toBe(true)
    expect(connections.isDocker('local-1')).toBe(false)
  })

  it('describe where they run', () => {
    expect(connectionSubtitle(DOCKER)).toBe(`shop-app-1:${EXISTING}`)
    expect(connectionSubtitle({ ...DOCKER, path: '' })).toBe('shop-app-1 (plain PHP)')
    expect(connectionSubtitle({ id: 'l', name: 'l', type: 'local', path: '/Users/dev/x', createdAt: 0 }, '/Users/dev')).toBe('~/x')
  })

  it('map container paths to the host folder', () => {
    const conn = { ...DOCKER, path: '/var/www/html', hostPath: '/Users/dev/shop' }
    expect(hostPathOf(conn)).toBe('/Users/dev/shop')
    expect(hostPathOf(conn, '/var/www/html')).toBe('/Users/dev/shop')
    expect(hostPathOf(conn, '/var/www/html/storage/logs')).toBe('/Users/dev/shop/storage/logs')
    expect(hostPathOf(conn, '/var/log')).toBe('')
    expect(hostPathOf({ ...conn, hostPath: '' }, '/var/www/html/storage')).toBe('')
    expect(hostPathOf({ id: 'l', name: 'l', type: 'local', path: '/a', createdAt: 0 }, '/a/b')).toBe('/a/b')
  })

  it('opens a container: saves it as used and reuses the same container + path', async () => {
    const connections = useConnectionsStore()
    const before = Date.now()
    const conn = await connections.openDocker({ container: 'shop-app-1', path: '/var/www/html', hostPath: '', phpBinary: '', user: '', name: 'shop' })
    expect(conn.id).toMatch(/^docker-/)
    expect(conn.type).toBe('docker')
    expect(conn.lastUsedAt).toBeGreaterThanOrEqual(before)
    expect(fake.callsTo('connections:save')[0][0]).toMatchObject({ type: 'docker', container: 'shop-app-1', path: '/var/www/html' })
    expect(connections.byId(conn.id)).toMatchObject({ container: 'shop-app-1' })

    const again = await connections.openDocker({ container: 'shop-app-1', path: '/var/www/html', hostPath: '/Users/dev/shop', phpBinary: '', user: '', name: 'shop' })
    expect(again.id).toBe(conn.id)
    expect(again.createdAt).toBe(conn.createdAt)
    expect(again.hostPath).toBe('/Users/dev/shop')

    const other = await connections.openDocker({ container: 'shop-app-1', path: '/var/www/html', hostPath: '', phpBinary: '', user: 'www-data', name: 'shop' })
    expect(other.id).not.toBe(conn.id)
  })

  it('reuses the connection of the same compose service', async () => {
    const connections = useConnectionsStore()
    const compose = { project: 'tmstores', service: 'web', dir: '/home/jim/Projects/tmstores' }
    const first = await connections.openDocker({ container: 'tmstores-web-1', path: '/home/tmstores/current', compose, name: 'tmstores' })
    // The service was recreated: new container, same service.
    const again = await connections.openDocker({ container: 'tmstores-web-2', path: '/home/tmstores/current', compose, name: 'tmstores' })
    expect(again.id).toBe(first.id)
    expect(again.container).toBe('tmstores-web-2')
    const other = await connections.openDocker({ container: 'tmstores-web-2', path: '/home/tmstores/current', compose: { ...compose, service: 'worker' }, name: 'w' })
    expect(other.id).not.toBe(first.id)
    // Saving without a compose reference drops it.
    const plain = await connections.openDocker({ id: first.id, container: 'tmstores-web-2', path: '/home/tmstores/current', name: 'tmstores' })
    expect(plain.compose).toBeUndefined()
  })

  it('lists running containers and passes the Docker error through', async () => {
    const container = { id: 'abc', name: 'app', image: 'php:8.4', workingDir: '/app', mounts: [], composeProject: '', composeService: '' }
    fake = fakeBridge({ 'docker:containers': () => [container] })
    setBridge(fake.bridge)
    expect(await useConnectionsStore().listContainers()).toEqual([container])
    fake = fakeBridge({
      'docker:containers': () => {
        throw new Error('Docker is not running. Start Docker Desktop and try again.')
      }
    })
    setBridge(fake.bridge)
    await expect(useConnectionsStore().listContainers()).rejects.toThrow('Docker is not running')
  })
})
