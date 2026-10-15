/**
 * Compose projects for the Docker connection form: which compose files a folder uses, and parsing `docker compose
 * config` / `ps` output. The suite at the end runs the real CLI when TINKERBOX_TEST_DOCKER_COMPOSE names a folder.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { composeFilesIn, composeUp, parseComposeProject, parsePs, readComposeProject } from '../../../src/main/execution/dockerCompose'
import { cleanupTempDirs, makeTempDir, writeTree } from './helpers'

afterAll(cleanupTempDirs)

describe('composeFilesIn', () => {
  it('finds the compose file docker compose would use, plus its override', () => {
    const dir = makeTempDir('tw-compose-')
    expect(composeFilesIn(dir)).toEqual([])
    writeTree(dir, { 'docker-compose.yml': 'services: {}\n' })
    expect(composeFilesIn(dir)).toEqual([join(dir, 'docker-compose.yml')])
    writeTree(dir, { 'compose.yaml': 'services: {}\n', 'docker-compose.override.yml': 'services: {}\n' })
    expect(composeFilesIn(dir)).toEqual([join(dir, 'compose.yaml'), join(dir, 'docker-compose.override.yml')])
  })

  it('follows COMPOSE_FILE in .env', () => {
    const dir = makeTempDir('tw-compose-env-')
    writeTree(dir, { 'docker/dev.yml': 'services: {}\n', 'docker/extra.yml': '', '.env': 'APP_NAME=x\nCOMPOSE_FILE=docker/dev.yml:docker/extra.yml:docker/missing.yml\n' })
    expect(composeFilesIn(dir)).toEqual([join(dir, 'docker/dev.yml'), join(dir, 'docker/extra.yml')])
  })
})

describe('parsePs', () => {
  it('reads both the line-per-container and the array format', () => {
    const one = { Name: 'shop-web-1', Service: 'web', State: 'running' }
    expect(parsePs(`${JSON.stringify(one)}\n${JSON.stringify({ ...one, Name: 'shop-db-1', Service: 'db' })}\n`)).toHaveLength(2)
    expect(parsePs(JSON.stringify([one]))).toEqual([one])
    expect(parsePs('')).toEqual([])
  })
})

describe('parseComposeProject', () => {
  const config = JSON.stringify({
    name: 'shop',
    services: {
      web: {
        build: { context: '.' },
        volumes: [
          { type: 'bind', source: '/home/me/shop', target: '/var/www/html' },
          { type: 'volume', source: 'cache', target: '/cache' }
        ]
      },
      mysql: { image: 'mysql:8.4', user: 'mysql', working_dir: '/var/lib/mysql' },
      queue: { image: 'sail-8.4/app' }
    }
  })
  const ps = [
    { Name: 'shop-web-run-ab12', Service: 'web', State: 'running', Labels: 'com.docker.compose.oneoff=True' },
    { Name: 'shop-web-1', Service: 'web', State: 'exited', Labels: 'com.docker.compose.oneoff=False' },
    { Name: 'shop-web-2', Service: 'web', State: 'running', Labels: 'com.docker.compose.oneoff=False' },
    { Name: 'shop-mysql-1', Service: 'mysql', State: 'running', Labels: '' }
  ]
    .map((p) => JSON.stringify(p))
    .join('\n')

  it('lists services with their container, preferring running ones and skipping one-offs', () => {
    const project = parseComposeProject('/home/me/shop', ['/home/me/shop/compose.yaml'], config, ps)
    expect(project.project).toBe('shop')
    expect(project.services).toEqual([
      { name: 'mysql', image: 'mysql:8.4', workingDir: '/var/lib/mysql', user: 'mysql', mounts: [], container: 'shop-mysql-1', state: 'running' },
      { name: 'queue', image: 'sail-8.4/app', workingDir: '', user: '', mounts: [], container: '', state: '' },
      {
        name: 'web',
        image: '',
        workingDir: '',
        user: '',
        mounts: [{ source: '/home/me/shop', destination: '/var/www/html' }],
        container: 'shop-web-2',
        state: 'running'
      }
    ])
  })
})

const realFolder = process.env.TINKERBOX_TEST_DOCKER_COMPOSE ?? ''

describe.skipIf(!realFolder)('readComposeProject with the real CLI', () => {
  it('reads the project and its containers', async () => {
    const project = await readComposeProject(realFolder)
    expect(project?.project).toBeTruthy()
    expect(project?.services.length).toBeGreaterThan(0)
  })

  it.skipIf(!process.env.TINKERBOX_TEST_DOCKER_COMPOSE_SERVICE)('starts a service', async () => {
    const service = process.env.TINKERBOX_TEST_DOCKER_COMPOSE_SERVICE ?? ''
    const project = await composeUp(realFolder, service)
    expect(project.services.find((s) => s.name === service)?.state).toBe('running')
  }, 120_000)
})
