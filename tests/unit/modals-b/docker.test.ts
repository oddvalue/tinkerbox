import { describe, expect, it } from 'vitest'
import type { DockerContainer } from '@shared/types'
import {
  applySuggestions,
  composeLabel,
  dockerInput,
  emptyDockerForm,
  findContainer,
  suggestHostPath,
  suggestName,
  suggestPath,
  validateDockerForm,
  type DockerSuggestions
} from '@/components/modals/docker/dockerUtils'

function container(patch: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: '0123456789abcdef',
    name: 'shop-app-1',
    image: 'php:8.4-fpm',
    workingDir: '/var/www/html',
    mounts: [{ source: '/Users/dev/shop', destination: '/var/www/html' }],
    composeProject: 'shop',
    composeService: 'app',
    ...patch
  }
}

const FRESH: DockerSuggestions = { path: '', hostPath: '', name: '' }

describe('docker suggestions', () => {
  it('suggests the working directory, else a mounted /var/www/html', () => {
    expect(suggestPath(container({ workingDir: '/app/' }))).toBe('/app')
    expect(suggestPath(container({ workingDir: '/' }))).toBe('/var/www/html')
    expect(suggestPath(container({ workingDir: '' }))).toBe('/var/www/html')
    expect(suggestPath(container({ workingDir: '', mounts: [] }))).toBe('')
  })

  it('finds the host folder of the mount at or above the path', () => {
    const c = container({ mounts: [{ source: '/Users/dev/shop', destination: '/var/www' }, { source: '/Users/dev/shop/public', destination: '/var/www/public' }] })
    expect(suggestHostPath(c, '/var/www')).toBe('/Users/dev/shop')
    expect(suggestHostPath(c, '/var/www/html')).toBe('/Users/dev/shop/html')
    expect(suggestHostPath(c, '/var/www/public/')).toBe('/Users/dev/shop/public')
    expect(suggestHostPath(c, '/srv')).toBe('')
    expect(suggestHostPath(c, '')).toBe('')
    expect(suggestHostPath(container({ mounts: [{ source: 'C:\\code\\shop', destination: '/app' }] }), '/app/src')).toBe('C:\\code\\shop\\src')
  })

  it('names the connection after the Compose project or the container', () => {
    expect(suggestName(container())).toBe('shop')
    expect(suggestName(container({ composeProject: '' }))).toBe('shop-app-1')
    expect(composeLabel(container())).toBe('shop / app')
    expect(composeLabel(container({ composeProject: '', composeService: '' }))).toBe('')
  })

  it('finds containers by name, id or a unique id prefix', () => {
    const list = [container(), container({ id: '0123ffff', name: 'shop-db-1' })]
    expect(findContainer(list, ' shop-db-1 ')?.id).toBe('0123ffff')
    expect(findContainer(list, '0123456789abcdef')?.name).toBe('shop-app-1')
    expect(findContainer(list, '012345')?.name).toBe('shop-app-1')
    expect(findContainer(list, '0123')).toBeNull()
    expect(findContainer(list, 'nope')).toBeNull()
  })
})

describe('docker form prefill', () => {
  it('fills path, host folder and name when a container is picked', () => {
    const { form, suggested } = applySuggestions({ ...emptyDockerForm(), container: 'shop-app-1' }, FRESH, container())
    expect(form).toMatchObject({ path: '/var/www/html', hostPath: '/Users/dev/shop', name: 'shop' })
    expect(suggested).toEqual({ path: '/var/www/html', hostPath: '/Users/dev/shop', name: 'shop' })
  })

  it('keeps fields the user edited and recomputes the host folder when the path changes', () => {
    const c = container({ mounts: [{ source: '/Users/dev/shop', destination: '/var/www' }] })
    let step = applySuggestions(emptyDockerForm(), FRESH, c)
    expect(step.form.hostPath).toBe('/Users/dev/shop/html')
    step = applySuggestions({ ...step.form, path: '/var/www/app', name: 'My shop' }, step.suggested, c)
    expect(step.form).toMatchObject({ path: '/var/www/app', hostPath: '/Users/dev/shop/app', name: 'My shop' })

    // An edited host folder survives later path changes and another container.
    step = applySuggestions({ ...step.form, hostPath: '/elsewhere' }, step.suggested, c)
    step = applySuggestions({ ...step.form, path: '/var/www' }, step.suggested, container({ name: 'other', composeProject: '' }))
    expect(step.form).toMatchObject({ path: '/var/www', hostPath: '/elsewhere', name: 'My shop' })
  })

  it('changes nothing for an unknown container and leaves saved values alone in edit mode', () => {
    const form = { ...emptyDockerForm(), container: 'typed', path: '/x' }
    expect(applySuggestions(form, FRESH, null).form).toBe(form)
    const saved = { container: 'shop-app-1', path: '', hostPath: '', phpBinary: 'php8.3', user: '', name: 'Shop' }
    const edit = applySuggestions(saved, { path: null, hostPath: null, name: null }, container())
    expect(edit.form).toEqual(saved)
    expect(edit.suggested).toEqual({ path: null, hostPath: null, name: null })
  })
})

describe('docker form validation', () => {
  it('mirrors the main process rules', () => {
    expect(validateDockerForm(emptyDockerForm()).container).toBeTruthy()
    expect(validateDockerForm({ ...emptyDockerForm(), container: '-bad' }).container).toBeTruthy()
    const errors = validateDockerForm({ container: 'app', path: 'var/www', hostPath: 'relative', phpBinary: '', user: 'www data', name: '' })
    expect(Object.keys(errors).sort()).toEqual(['hostPath', 'path', 'user'])
    expect(validateDockerForm({ container: 'app', path: '', hostPath: 'C:\\code', phpBinary: '', user: '1000:1000', name: '' })).toEqual({})
  })

  it('trims the input and falls back to the container as name', () => {
    expect(dockerInput({ container: ' app ', path: '/var/www/html/ ', hostPath: ' ', phpBinary: ' php8.3 ', user: '', name: ' ' })).toEqual({
      container: 'app',
      path: '/var/www/html',
      hostPath: '',
      phpBinary: 'php8.3',
      user: '',
      name: 'app'
    })
  })
})
