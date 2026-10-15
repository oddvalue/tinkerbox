import { describe, expect, it } from 'vitest'
import type { SshConnection } from '@shared/types'
import {
  applySshName,
  emptySshForm,
  findSshHost,
  sshFormFrom,
  sshHostHint,
  sshInput,
  suggestSshName,
  validateSshForm
} from '@/components/modals/ssh/sshUtils'

describe('ssh hosts', () => {
  it('describes what an alias points to', () => {
    expect(sshHostHint({ alias: 'prod-web', hostName: '203.0.113.7', user: 'deploy', port: 2222 })).toBe('deploy@203.0.113.7:2222')
    expect(sshHostHint({ alias: 'box', hostName: '', user: 'me', port: 0 })).toBe('me@box')
    expect(sshHostHint({ alias: 'bare', hostName: '', user: '', port: 0 })).toBe('')
  })

  it('finds hosts by alias only', () => {
    const list = [{ alias: 'prod-web', hostName: 'web.example.com', user: '', port: 0 }]
    expect(findSshHost(list, ' prod-web ')?.hostName).toBe('web.example.com')
    expect(findSshHost(list, 'web.example.com')).toBeNull()
    expect(findSshHost(list, '')).toBeNull()
  })
})

describe('ssh form name', () => {
  it('suggests host plus project folder, without the user', () => {
    expect(suggestSshName('prod-web', '/var/www/shop/')).toBe('prod-web shop')
    expect(suggestSshName('deploy@203.0.113.7', '')).toBe('203.0.113.7')
    expect(suggestSshName('', '/srv/app')).toBe('app')
  })

  it('follows host and path until the name is edited', () => {
    let form = { ...emptySshForm(), host: 'prod-web' }
    let step = applySshName(form, '')
    expect(step.name).toBe('prod-web')
    form = { ...form, name: step.name, path: '/var/www/shop' }
    step = applySshName(form, step.suggested)
    expect(step.name).toBe('prod-web shop')
    form = { ...form, name: 'Shop live', path: '/var/www/shop2' }
    expect(applySshName(form, step.suggested).name).toBe('Shop live')
  })

  it('keeps a saved name in edit mode and fills an empty one', () => {
    const form = { ...emptySshForm(), host: 'prod-web', path: '/srv/x', name: 'Saved' }
    expect(applySshName(form, null)).toEqual({ name: 'Saved', suggested: null })
    expect(applySshName({ ...form, name: '' }, null).name).toBe('prod-web x')
  })
})

describe('ssh form validation', () => {
  it('mirrors the main process rules', () => {
    expect(validateSshForm(emptySshForm()).host).toBeTruthy()
    // A leading dash would turn the host into an ssh option.
    expect(validateSshForm({ ...emptySshForm(), host: '-oProxyCommand=x' }).host).toBeTruthy()
    expect(validateSshForm({ ...emptySshForm(), host: 'my host' }).host).toBeTruthy()
    const errors = validateSshForm({ ...emptySshForm(), host: 'deploy@web-1.example.com', port: '70000', path: 'var/www', hostPath: 'code' })
    expect(Object.keys(errors).sort()).toEqual(['hostPath', 'path', 'port'])
    expect(validateSshForm({ ...emptySshForm(), host: 'prod-web', port: 'abc' }).port).toBeTruthy()
    expect(validateSshForm({ ...emptySshForm(), host: 'prod-web', port: '2222', path: '/var/www/app', hostPath: '/Users/me/app' })).toEqual({})
  })

  it('converts the form to a connection and back', () => {
    const input = sshInput({ host: ' prod-web ', port: ' 2222 ', path: '/var/www/shop/', hostPath: ' ', phpBinary: '', name: ' ', production: true })
    expect(input).toEqual({ host: 'prod-web', port: 2222, path: '/var/www/shop', hostPath: '', phpBinary: '', name: 'prod-web shop', production: true })
    expect(sshInput({ ...emptySshForm(), host: 'x' }).port).toBeUndefined()
    const conn: SshConnection = { id: 'ssh-1', type: 'ssh', name: 'Shop', host: 'prod-web', port: 2222, path: '/srv', createdAt: 1, production: true }
    expect(sshFormFrom(conn)).toEqual({ host: 'prod-web', port: '2222', path: '/srv', hostPath: '', phpBinary: '', name: 'Shop', production: true })
  })
})
