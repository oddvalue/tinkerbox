import { describe, expect, it } from 'vitest'
import type { DockerComposeProject, DockerComposeService, DockerContainer } from '@shared/types'
import {
  EDIT_SUGGESTIONS,
  NEW_SUGGESTIONS,
  applyComposeService,
  applySuggestions,
  composeFileNames,
  composeFill,
  isNonPhpService,
  pickPhpService,
  sameHostPath,
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

const FRESH: DockerSuggestions = NEW_SUGGESTIONS

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
    expect(suggested).toEqual({ path: '/var/www/html', hostPath: '/Users/dev/shop', name: 'shop', user: '' })
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
    const edit = applySuggestions(saved, EDIT_SUGGESTIONS, container())
    expect(edit.form).toEqual(saved)
    expect(edit.suggested).toEqual(EDIT_SUGGESTIONS)
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

// Real project from a user's machine: the PHP app runs in "web", next to databases and other helpers.
const TMSTORES_DIR = '/home/jim/Projects/tmstores'

function service(name: string, patch: Partial<DockerComposeService> = {}): DockerComposeService {
  return { name, image: '', workingDir: '', user: '', mounts: [], container: `tmstores-${name}-1`, state: 'running', ...patch }
}

function tmstores(patch: Partial<DockerComposeProject> = {}): DockerComposeProject {
  return {
    dir: TMSTORES_DIR,
    files: [`${TMSTORES_DIR}/docker-compose.yml`],
    project: 'tmstores',
    services: [
      service('mysql', { image: 'mysql:8.0' }),
      service('mysql-test', { image: 'mysql:8.0' }),
      service('web', {
        mounts: [
          { source: TMSTORES_DIR, destination: '/home/tmstores/current' },
          { source: '/home/jim/.ssh', destination: '/home/tmstores/.ssh' }
        ]
      }),
      service('redis', { image: 'redis:alpine' }),
      service('mailhog', { image: 'mailhog/mailhog' }),
      service('typesense', { image: 'typesense/typesense:27.1' }),
      service('clickhouse', { image: 'clickhouse/clickhouse-server' })
    ],
    ...patch
  }
}

describe('compose service pick', () => {
  it('picks the service that mounts the project folder', () => {
    expect(pickPhpService(tmstores())?.name).toBe('web')
  })

  it('skips databases, caches and other helpers by name or image', () => {
    expect(isNonPhpService(service('db', { image: 'mariadb:11' }))).toBe(true)
    expect(isNonPhpService(service('mysql-test'))).toBe(true)
    expect(isNonPhpService(service('cache', { image: 'bitnami/redis:7' }))).toBe(true)
    expect(isNonPhpService(service('laravel.test', { image: 'sail-8.4/app' }))).toBe(false)
    expect(isNonPhpService(service('php-fpm', { image: 'php:8.3-fpm' }))).toBe(false)
    expect(pickPhpService(tmstores({ services: [service('mysql'), service('redis')] }))).toBeNull()
  })

  it('prefers usual app names and PHP images when nothing mounts the folder', () => {
    const project = tmstores({ services: [service('mysql'), service('worker', { image: 'node:20' }), service('queue'), service('app')] })
    expect(pickPhpService(project)?.name).toBe('app')
    expect(pickPhpService(tmstores({ services: [service('queue'), service('runner', { image: 'php:8.4-cli' })] }))?.name).toBe('runner')
    // Running beats stopped when nothing else tells them apart.
    expect(pickPhpService(tmstores({ services: [service('one', { state: 'exited' }), service('two')] }))?.name).toBe('two')
  })

  it('compares host folders without trailing slashes, Windows paths without case', () => {
    expect(sameHostPath('/home/jim/Projects/tmstores/', TMSTORES_DIR)).toBe(true)
    expect(sameHostPath('/home/jim/projects/tmstores', TMSTORES_DIR)).toBe(false)
    expect(sameHostPath('C:\\Code\\Shop\\', 'c:/code/shop')).toBe(true)
    expect(sameHostPath('', '')).toBe(false)
  })

  it('names compose files for display', () => {
    expect(composeFileNames(tmstores({ files: ['/a/compose.yaml', '/a/compose.override.yaml'] }))).toBe('compose.yaml, compose.override.yaml')
  })
})

describe('compose prefill', () => {
  it('fills the form from the PHP service', () => {
    const project = tmstores()
    const web = project.services.find((s) => s.name === 'web')!
    expect(composeFill(project, web)).toEqual({
      container: 'tmstores-web-1',
      path: '/home/tmstores/current',
      hostPath: TMSTORES_DIR,
      user: '',
      name: 'tmstores'
    })
  })

  it('names other services after project and service, and falls back to the working directory', () => {
    const project = tmstores({ services: [service('web', { mounts: [{ source: TMSTORES_DIR, destination: '/app/' }] }), service('cli', { workingDir: '/srv/app', user: 'www-data' })] })
    expect(composeFill(project, project.services[0]).path).toBe('/app')
    expect(composeFill(project, project.services[1])).toMatchObject({ path: '/srv/app', user: 'www-data', name: 'tmstores cli' })
    // Without a mount or working directory, the running container's working directory decides.
    const bare = tmstores({ services: [service('app')] })
    const running: DockerContainer = { id: 'x', name: 'tmstores-app-1', image: '', workingDir: '/var/www', mounts: [], composeProject: 'tmstores', composeService: 'app' }
    expect(composeFill(bare, bare.services[0], running).path).toBe('/var/www')
    expect(composeFill(bare, bare.services[0]).path).toBe('')
  })

  it('keeps edited fields and saved values', () => {
    const project = tmstores()
    const web = project.services.find((s) => s.name === 'web')!
    const mysql = project.services[0]
    let step = applyComposeService(emptyDockerForm(), FRESH, project, web)
    expect(step.form).toMatchObject({ container: 'tmstores-web-1', path: '/home/tmstores/current', name: 'tmstores' })
    step = applyComposeService({ ...step.form, user: 'tmstores' }, step.suggested, project, mysql)
    expect(step.form).toMatchObject({ container: 'tmstores-mysql-1', user: 'tmstores', name: 'tmstores mysql', hostPath: TMSTORES_DIR })

    const saved = { container: 'old-web-1', path: '/srv', hostPath: '', phpBinary: '', user: 'tmstores', name: 'Shop' }
    const edit = applyComposeService(saved, EDIT_SUGGESTIONS, project, web)
    expect(edit.form).toEqual({ ...saved, container: 'tmstores-web-1' })
    expect(edit.suggested).toEqual(EDIT_SUGGESTIONS)
  })

  it('sends the compose reference only when given', () => {
    const ref = { project: 'tmstores', service: 'web', dir: TMSTORES_DIR }
    const form = { ...emptyDockerForm(), container: 'tmstores-web-1' }
    expect(dockerInput(form, ref).compose).toEqual(ref)
    expect('compose' in dockerInput(form)).toBe(true)
    expect(dockerInput(form).compose).toBeUndefined()
  })
})
