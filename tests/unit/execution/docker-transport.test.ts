/**
 * Docker transport: argv, the PID line on stderr, error messages and stopping the process inside the container.
 * Most tests use a fake `docker` script that runs the command locally; the suite at the end runs against a real
 * container when TINKERBOX_TEST_DOCKER_CONTAINER is set (project path in TINKERBOX_TEST_DOCKER_PATH, default
 * /var/www/html).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { DockerConnection } from '@shared/types'
import { introspectEnvironment, listLogs, projectPanels, registerTransport, runCode, testConnection } from '../../../src/main/execution'
import { parseInspect } from '../../../src/main/execution/dockerContainers'
import {
  PID_MARKER,
  PidLineFilter,
  createDockerTransport,
  dockerExecArgs,
  dockerFailure,
  dockerTransport
} from '../../../src/main/execution/dockerTransport'
import type { TransportRequest } from '../../../src/main/execution/transport'
import { hostPathForContainerFile, localPathForFile } from '../../../src/main/ipc/editorPaths'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { cleanupTempDirs, fakeContext, makeTempDir, repoRoot, runOptions, runRequest, writeTree } from './helpers'

const posix = process.platform !== 'win32'
const hostPhp = posix ? spawnSync('sh', ['-c', 'command -v php'], { encoding: 'utf8' }).stdout.trim() : ''

afterAll(cleanupTempDirs)
afterEach(() => registerTransport(dockerTransport))

function dockerConnection(extra: Partial<DockerConnection> = {}): DockerConnection {
  return { id: 'docker-test', name: 'app', type: 'docker', container: 'app', path: '/var/www/html', createdAt: 0, ...extra }
}

/**
 * A `docker` stand-in: logs its arguments, fails like Docker for the containers "missing" and "stopped", and
 * otherwise drops the `exec` options and runs the command on this machine.
 */
function fakeDocker(): { cli: string; log: () => string[] } {
  const dir = makeTempDir('tw-fake-docker-')
  const logFile = join(dir, 'calls.log')
  writeTree(dir, {
    docker: `#!/bin/sh
printf '%s\\n' "$*" >> '${logFile}'
[ "$1" = exec ] || { echo "unsupported: $1" >&2; exit 2; }
shift
while [ $# -gt 0 ]; do
  case "$1" in
    -i) shift ;;
    --user|--workdir) shift 2 ;;
    *) break ;;
  esac
done
container="$1"; shift
case "$container" in
  missing) echo "Error response from daemon: No such container: missing" >&2; exit 1 ;;
  stopped) echo "Error response from daemon: container 4f2a is not running" >&2; exit 1 ;;
esac
exec "$@"
`,
    // PHP stand-ins: ignore the -d flags; run stdin as a shell script, or block.
    'sh-php': '#!/bin/sh\nexec sh\n',
    'slow-php': '#!/bin/sh\necho started\nexec sleep 30\n'
  })
  for (const file of ['docker', 'sh-php', 'slow-php']) chmodSync(join(dir, file), 0o755)
  return {
    cli: join(dir, 'docker'),
    log: () => {
      try {
        return readFileSync(logFile, 'utf8').trim().split('\n')
      } catch {
        return []
      }
    }
  }
}

function request(conn: DockerConnection, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    script: '<?php echo "hi";',
    connection: conn,
    settings: DEFAULT_SETTINGS,
    timeoutMs: 20_000,
    signal: new AbortController().signal,
    onStdout: () => {},
    onStderr: () => {},
    ...overrides
  }
}

describe('dockerExecArgs', () => {
  it('runs PHP through the PID wrapper with workdir and user', () => {
    const args = dockerExecArgs(dockerConnection({ user: 'www-data', phpBinary: '/usr/local/bin/php' }), ['-d', 'xdebug.mode=off'])
    expect(args.slice(0, 7)).toEqual(['exec', '-i', '--user', 'www-data', '--workdir', '/var/www/html', 'app'])
    expect(args.slice(7, 9)).toEqual(['sh', '-c'])
    expect(args[9]).toContain(PID_MARKER)
    expect(args.slice(10)).toEqual(['/usr/local/bin/php', '-d', 'xdebug.mode=off'])
  })

  it('leaves out the workdir for plain PHP and defaults the binary to php', () => {
    const args = dockerExecArgs(dockerConnection({ path: '' }), [])
    expect(args).not.toContain('--workdir')
    expect(args.at(-1)).toBe('php')
  })
})

describe('PidLineFilter', () => {
  it('takes the PID line off the front of stderr, also when it arrives in pieces', () => {
    const seen: string[] = []
    const filter = new PidLineFilter((c) => seen.push(c))
    filter.push('__TINKERBOX')
    filter.push('_PID__ 4')
    filter.push('2\nPHP Warning: x\n')
    filter.push('more\n')
    expect(filter.pid).toBe(42)
    expect(seen.join('')).toBe('PHP Warning: x\nmore\n')
  })

  it('holds Docker errors until the process ends, then passes them on (or drops them)', () => {
    const seen: string[] = []
    const filter = new PidLineFilter((c) => seen.push(c))
    filter.push('Error response from daemon: No such container: app\n')
    expect(seen).toEqual([])
    filter.flush()
    expect(filter.pid).toBeNull()
    expect(seen.join('')).toBe('Error response from daemon: No such container: app\n')
    const dropped: string[] = []
    const retried = new PidLineFilter((c) => dropped.push(c))
    retried.push('Error response from daemon: No such container: app\n')
    retried.flush(true)
    expect(dropped).toEqual([])
  })

  it('keeps Docker warnings printed before the PID line', () => {
    const seen: string[] = []
    const filter = new PidLineFilter((c) => seen.push(c))
    filter.push('WARNING: something\n__TINKERBOX_PID__ 7\nphp says hi\n')
    expect(filter.pid).toBe(7)
    expect(seen.join('')).toBe('WARNING: something\nphp says hi\n')
  })

  it('flushes a partial first line when the process ends', () => {
    const seen: string[] = []
    const filter = new PidLineFilter((c) => seen.push(c))
    filter.push('__TINK')
    filter.flush()
    expect(seen.join('')).toBe('__TINK')
  })
})

describe('dockerFailure', () => {
  const conn = dockerConnection()
  it('explains Docker errors from before PHP started', () => {
    expect(dockerFailure(conn, 1, 'Error response from daemon: No such container: app', false)).toMatch(/Container "app" not found/)
    expect(dockerFailure(conn, 1, 'Error response from daemon: container x is not running', false)).toMatch(/is not running/)
    expect(dockerFailure(conn, 1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', false)).toMatch(/Is Docker running/)
    expect(dockerFailure(conn, 126, 'OCI runtime exec failed: chdir to cwd ("/var/www/html") set in config.json failed: no such file or directory', false)).toMatch(
      /Project directory not found in container "app": \/var\/www\/html/
    )
  })

  it('explains a missing PHP binary and stays quiet for PHP failures', () => {
    expect(dockerFailure(conn, 127, 'sh: exec: line 0: php: not found', true)).toMatch(/PHP binary "php" not found in container "app"/)
    expect(dockerFailure(conn, 255, 'PHP Fatal error: …', true)).toBeNull()
  })
})

describe('parseInspect', () => {
  it('keeps names, working dir, bind mounts and compose labels', () => {
    const json = JSON.stringify([
      {
        Id: 'abcdef1234567890',
        Name: '/shop-laravel.test-1',
        Config: { Image: 'sail-8.4/app', WorkingDir: '/var/www/html', Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'laravel.test' } },
        Mounts: [
          { Type: 'bind', Source: '/home/me/shop', Destination: '/var/www/html' },
          { Type: 'volume', Source: '/var/lib/docker/volumes/x', Destination: '/data' }
        ]
      },
      { Id: '', Name: '/broken' },
      { Id: 'fff', Name: '/shop-web-run-1a2b', Config: { Labels: { 'com.docker.compose.oneoff': 'True' } } }
    ])
    expect(parseInspect(json)).toEqual([
      {
        id: 'abcdef123456',
        name: 'shop-laravel.test-1',
        image: 'sail-8.4/app',
        workingDir: '/var/www/html',
        mounts: [{ source: '/home/me/shop', destination: '/var/www/html' }],
        composeProject: 'shop',
        composeService: 'laravel.test'
      }
    ])
  })
})

describe('editor paths for Docker connections', () => {
  it('maps container paths inside the project to the host folder', () => {
    expect(hostPathForContainerFile('/var/www/html/app/Models/User.php', '/var/www/html', '/home/me/shop')).toBe('/home/me/shop/app/Models/User.php')
    expect(hostPathForContainerFile('app/Models/User.php', '/var/www/html', '/home/me/shop')).toBe('/home/me/shop/app/Models/User.php')
    expect(hostPathForContainerFile('/var/www/html', '/var/www/html', '/home/me/shop')).toBe('/home/me/shop')
  })

  it('leaves other paths alone', () => {
    expect(hostPathForContainerFile('/usr/local/lib/php/x.php', '/var/www/html', '/home/me/shop')).toBe('/usr/local/lib/php/x.php')
    expect(hostPathForContainerFile('/var/www/html-old/x.php', '/var/www/html', '/home/me/shop')).toBe('/var/www/html-old/x.php')
    expect(localPathForFile('app/x.php', dockerConnection())).toBe('app/x.php')
  })
})

describe.skipIf(!posix)('docker transport with a fake CLI', () => {
  it('streams output, hides the PID line and reports the exit code', async () => {
    const fake = fakeDocker()
    const transport = createDockerTransport({ findCli: () => fake.cli, listContainers: async () => [] })
    const err: string[] = []
    const result = await transport.run(
      request(dockerConnection({ phpBinary: join(fake.cli, '..', 'sh-php') }), { script: 'echo out; echo warn >&2; exit 3', onStderr: (c) => err.push(c) })
    )
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('warn\n')
    expect(err.join('')).toBe('warn\n')
    expect(result.exitCode).toBe(3)
    expect(fake.log()[0]).toMatch(/^exec -i --workdir \/var\/www\/html app sh -c /)
  })

  it('rejects with an actionable message when the container is missing or stopped', async () => {
    const fake = fakeDocker()
    const transport = createDockerTransport({ findCli: () => fake.cli, listContainers: async () => [] })
    await expect(transport.run(request(dockerConnection({ container: 'missing' })))).rejects.toThrow(/Container "missing" not found/)
    await expect(transport.run(request(dockerConnection({ container: 'stopped' })))).rejects.toThrow(/Container "stopped" is not running/)
  })

  it('runs in the compose service\'s current container when the saved one is gone', async () => {
    const fake = fakeDocker()
    const transport = createDockerTransport({
      findCli: () => fake.cli,
      listContainers: async () => [
        { id: '1', name: 'shop-web-2', image: '', workingDir: '', mounts: [], composeProject: 'shop', composeService: 'web' }
      ]
    })
    const err: string[] = []
    const conn = dockerConnection({ container: 'missing', phpBinary: join(fake.cli, '..', 'sh-php'), compose: { project: 'shop', service: 'web', dir: '/home/me/shop' } })
    const result = await transport.run(request(conn, { script: 'echo ok', onStderr: (c) => err.push(c) }))
    expect(result.stdout).toBe('ok\n')
    expect(result.stderr).toBe('')
    expect(err).toEqual([])
    expect(fake.log()).toHaveLength(2)
    expect(fake.log()[1]).toContain(' shop-web-2 sh -c ')
  })

  it('names the containers of a compose project typed as the container', async () => {
    const fake = fakeDocker()
    const transport = createDockerTransport({
      findCli: () => fake.cli,
      listContainers: async () => [
        { id: '1', name: 'missing-web-1', image: '', workingDir: '', mounts: [], composeProject: 'missing', composeService: 'web' },
        { id: '2', name: 'missing-mysql-1', image: '', workingDir: '', mounts: [], composeProject: 'missing', composeService: 'mysql' }
      ]
    })
    await expect(transport.run(request(dockerConnection({ container: 'missing' })))).rejects.toThrow(
      /"missing" is a compose project; its running containers are missing-web-1, missing-mysql-1/
    )
  })

  it('rejects when PHP is missing in the container', async () => {
    const fake = fakeDocker()
    const transport = createDockerTransport({ findCli: () => fake.cli, listContainers: async () => [] })
    await expect(transport.run(request(dockerConnection({ phpBinary: 'php-does-not-exist-here' })))).rejects.toThrow(
      /PHP binary "php-does-not-exist-here" not found in container "app"/
    )
  })

  it('rejects when there is no Docker CLI', async () => {
    const transport = createDockerTransport({ findCli: () => null })
    await expect(transport.run(request(dockerConnection()))).rejects.toThrow(/Docker CLI not found/)
  })

  it('stops the process inside the container on cancel', async () => {
    const fake = fakeDocker()
    const transport = createDockerTransport({ findCli: () => fake.cli, listContainers: async () => [] })
    const controller = new AbortController()
    const slowPhp = join(fake.cli, '..', 'slow-php')
    const running = transport.run(
      request(dockerConnection({ phpBinary: slowPhp }), {
        signal: controller.signal,
        onStdout: (c) => {
          if (c.includes('started')) controller.abort()
        }
      })
    )
    const result = await running
    expect(result.cancelled).toBe(true)
    // The kill goes through `docker exec <container> sh -c 'kill -TERM -<pid> …'` and is not awaited.
    for (let i = 0; i < 50 && fake.log().length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    expect(fake.log()[1]).toMatch(/^exec app sh -c kill -TERM -\d+ /)
  })

  it.skipIf(!hostPhp)('runs the real runner bundle through runCode', async () => {
    const fake = fakeDocker()
    registerTransport(createDockerTransport({ findCli: () => fake.cli, listContainers: async () => [] }))
    const dir = makeTempDir('tw-docker-project-')
    const conn = dockerConnection({ path: dir, phpBinary: hostPhp })
    const ctx = fakeContext({ resourcesPath: repoRoot, connections: { [conn.id]: conn } })
    const result = await runCode(ctx, runRequest('$x = 20;\n$x + 22', { connectionId: conn.id }), () => {})
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.returnValue).toMatchObject({ t: 'int', v: '42' })
    expect(fake.log()[0]).toContain(`--workdir ${dir} app sh -c`)
  })
})

const realContainer = process.env.TINKERBOX_TEST_DOCKER_CONTAINER ?? ''
const realPath = process.env.TINKERBOX_TEST_DOCKER_PATH ?? '/var/www/html'

describe.skipIf(!realContainer)('docker transport against a real container', () => {
  const conn = dockerConnection({ container: realContainer, path: realPath })
  const ctx = fakeContext({ resourcesPath: repoRoot, connections: { [conn.id]: conn } })

  it('detects the project and runs code', async () => {
    const test = await testConnection(ctx, conn)
    expect(test.ok).toBe(true)
    const result = await runCode(ctx, runRequest('PHP_VERSION', { connectionId: conn.id }), () => {})
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.returnValue).toMatchObject({ t: 'string' })
  })

  it('serves the data modes from inside the container', async () => {
    const env = await introspectEnvironment(ctx, { connectionId: conn.id })
    expect(env.classes.length).toBeGreaterThan(10)
    const logs = await listLogs(ctx, conn.id)
    expect(logs.root.startsWith(realPath)).toBe(true)
    const panels = await projectPanels(ctx, conn.id)
    expect(Array.isArray(panels)).toBe(true)
  })

  it('leaves no PHP process behind after a timeout', async () => {
    const result = await runCode(ctx, runRequest('sleep(60);', { connectionId: conn.id, options: runOptions({ timeoutMs: 1500 }) }), () => {})
    expect(result.timedOut).toBe(true)
    await new Promise((r) => setTimeout(r, 3500))
    const ps = spawnSync('docker', ['exec', realContainer, 'sh', '-c', 'ps -o args 2>/dev/null || ps'], { encoding: 'utf8' }).stdout
    expect(ps).not.toMatch(/sleep\(60\)|xdebug\.mode=off/)
  })
})
