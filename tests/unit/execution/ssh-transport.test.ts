/**
 * SSH transport: quoting for the remote login shell, ssh arguments, error messages and ~/.ssh/config parsing. The
 * suite at the end runs against a real server when TINKERBOX_TEST_SSH_HOST is set (an ssh destination with key
 * login; TINKERBOX_SSH can point to a wrapper that adds `-F <config>`). Project path in TINKERBOX_TEST_SSH_PATH
 * (default /srv/app), PHP binary in TINKERBOX_TEST_SSH_PHP; TINKERBOX_TEST_SSH_FISH_HOST adds a user with fish as
 * login shell, TINKERBOX_TEST_SSH_NOKEY_HOST / _NEWKEY_HOST hosts that fail to log in.
 */
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import type { SshConnection } from '@shared/types'
import { runCode, testConnection } from '../../../src/main/execution'
import { parseSshConfig } from '../../../src/main/execution/sshConfig'
import { createSshTransport, shellQuote, sshFailure, sshRunArgs } from '../../../src/main/execution/sshTransport'
import { cleanupTempDirs, fakeContext, repoRoot, runOptions, runRequest } from './helpers'

afterAll(cleanupTempDirs)

function sshConnection(extra: Partial<SshConnection> = {}): SshConnection {
  return { id: 'ssh-test', name: 'prod', type: 'ssh', host: 'prod-web', path: '/var/www/app', createdAt: 0, ...extra }
}

describe('shellQuote', () => {
  it('single-quotes words, including quotes inside them', () => {
    expect(shellQuote('/var/www/app')).toBe("'/var/www/app'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    const echoed = spawnSync('sh', ['-c', `printf %s ${shellQuote("a 'b' $HOME `x`")}`], { encoding: 'utf8' }).stdout
    expect(echoed).toBe("a 'b' $HOME `x`")
  })
})

describe('sshRunArgs', () => {
  it('runs without prompts, shares the connection, and quotes the remote words', () => {
    const args = sshRunArgs(sshConnection({ port: 2222, phpBinary: '/usr/bin/php8.3' }), ['-d', 'xdebug.mode=off'], '/tmp/tbx')
    expect(args.slice(0, 3)).toEqual(['-T', '-o', 'BatchMode=yes'])
    expect(args).toContain('ControlPath=/tmp/tbx/%C')
    expect(args.slice(-5, -2)).toEqual(['-p', '2222', '--'])
    expect(args.at(-2)).toBe('prod-web')
    expect(args.at(-1)).toMatch(/^exec sh -c '[^']+' 'tinkerbox' '\/var\/www\/app' '\/usr\/bin\/php8.3' '-d' 'xdebug.mode=off'$/)
  })

  it('leaves out connection sharing when there is no socket folder', () => {
    expect(sshRunArgs(sshConnection(), [], null).join(' ')).not.toContain('ControlMaster')
  })

  it('runs the wrapper under sh: cd, PID line, exec', () => {
    const remote = sshRunArgs(sshConnection({ path: '/tmp', phpBinary: 'pwd' }), [], null).at(-1)!
    const r = spawnSync('sh', ['-c', remote], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('/tmp')
    expect(r.stderr).toMatch(/^__TINKERBOX_PID__ \d+\n$/)
    const missing = spawnSync('sh', ['-c', sshRunArgs(sshConnection({ path: '/does/not/exist' }), [], null).at(-1)!], { encoding: 'utf8' })
    expect(missing.status).toBe(97)
  })
})

describe('sshFailure', () => {
  const conn = sshConnection()
  it('explains ssh errors from before PHP started', () => {
    expect(sshFailure(conn, 255, 'Host key verification failed.', false)).toMatch(/host key of prod-web is not known yet/)
    expect(sshFailure(conn, 255, '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', false)).toMatch(/ssh-keygen -R prod-web/)
    expect(sshFailure(conn, 255, 'deploy@prod-web: Permission denied (publickey).', false)).toMatch(/password logins are not supported/)
    expect(sshFailure(conn, 255, 'ssh: Could not resolve hostname prod-web: Name or service not known', false)).toMatch(/Unknown host: prod-web/)
    expect(sshFailure(conn, 255, 'ssh: connect to host 10.0.0.5 port 22: Connection timed out', false)).toMatch(/Cannot reach prod-web/)
    expect(sshFailure(conn, 97, "sh: cd: line 1: can't cd to /var/www/app: No such file or directory", false)).toBe(
      'Project directory not found on prod-web: /var/www/app'
    )
  })

  it('explains a missing PHP binary and stays quiet for PHP failures', () => {
    expect(sshFailure(conn, 127, 'sh: exec: line 1: php: not found', true)).toMatch(/PHP binary "php" not found on prod-web/)
    expect(sshFailure(conn, 255, 'PHP Fatal error', true)).toBeNull()
  })
})

describe('parseSshConfig', () => {
  it('lists Host aliases with HostName, User and Port, skipping patterns and Match blocks', () => {
    const text = `
# comment
Host prod-web prod
  HostName 203.0.113.10
  User deploy
  Port 2200
Host *.internal !bastion
  User ops
Host staging
  hostname=staging.example.com # trailing comment
  User first
  User second
Match host foo
  User nobody
Include conf.d/*.conf
`
    const include = (pattern: string) => (pattern === 'conf.d/*.conf' ? ['Host extra\n  HostName 198.51.100.7\n'] : [])
    expect(parseSshConfig(text, include)).toEqual([
      { alias: 'prod-web', hostName: '203.0.113.10', user: 'deploy', port: 2200 },
      { alias: 'prod', hostName: '203.0.113.10', user: 'deploy', port: 2200 },
      { alias: 'staging', hostName: 'staging.example.com', user: 'first', port: 0 },
      { alias: 'extra', hostName: '198.51.100.7', user: '', port: 0 }
    ])
  })
})

const realHost = process.env.TINKERBOX_TEST_SSH_HOST ?? ''
const realPath = process.env.TINKERBOX_TEST_SSH_PATH ?? '/srv/app'
const realPhp = process.env.TINKERBOX_TEST_SSH_PHP ?? ''

describe.skipIf(!realHost)('ssh transport against a real server', () => {
  const conn = sshConnection({ host: realHost, path: realPath, ...(realPhp ? { phpBinary: realPhp } : {}) })
  const ctx = fakeContext({ resourcesPath: repoRoot, connections: { [conn.id]: conn } })

  it('detects the project and runs code', async () => {
    const test = await testConnection(ctx, conn)
    expect(test.ok, test.message).toBe(true)
    const result = await runCode(ctx, runRequest('gethostname() . " " . getcwd()', { connectionId: conn.id }), () => {})
    expect(result.error).toBeUndefined()
    expect(result.returnValue).toMatchObject({ t: 'string' })
    expect(String((result.returnValue as { v: string }).v)).toContain(realPath)
  })

  it.skipIf(!process.env.TINKERBOX_TEST_SSH_FISH_HOST)('works when the login shell is fish', async () => {
    const fish = sshConnection({ id: 'ssh-fish', host: process.env.TINKERBOX_TEST_SSH_FISH_HOST, path: realPath })
    const c = fakeContext({ resourcesPath: repoRoot, connections: { [fish.id]: fish } })
    const result = await runCode(c, runRequest('"it\'s " . PHP_OS', { connectionId: fish.id }), () => {})
    expect(result.error).toBeUndefined()
    expect(result.returnValue).toMatchObject({ t: 'string', v: "it's Linux" })
  })

  it('stops PHP on the server when a run times out', async () => {
    const result = await runCode(ctx, runRequest('sleep(60);', { connectionId: conn.id, options: runOptions({ timeoutMs: 1500 }) }), () => {})
    expect(result.timedOut).toBe(true)
    await new Promise((r) => setTimeout(r, 4000))
    const ssh = process.env.TINKERBOX_SSH || 'ssh'
    const ps = spawnSync(ssh, ['-o', 'BatchMode=yes', realHost, 'ps -o args 2>/dev/null || ps ax'], { encoding: 'utf8' }).stdout
    expect(ps).not.toMatch(/xdebug\.mode=off/)
  })

  it('reports a wrong project path and a missing PHP binary', async () => {
    const transport = createSshTransport({ controlDir: null })
    const req = (c: SshConnection) => ({
      script: '<?php echo 1;',
      connection: c,
      settings: ctx.getSettings(),
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      onStdout: () => {},
      onStderr: () => {}
    })
    await expect(transport.run(req({ ...conn, path: '/no/such/dir' }))).rejects.toThrow(`Project directory not found on ${realHost}: /no/such/dir`)
    await expect(transport.run(req({ ...conn, phpBinary: 'php-not-installed' }))).rejects.toThrow(/PHP binary "php-not-installed" not found/)
  })

  it.skipIf(!process.env.TINKERBOX_TEST_SSH_NOKEY_HOST)('explains a failed key login and an unknown host key', async () => {
    const t = (host: string) => testConnection(ctx, sshConnection({ id: `ssh-${host}`, host, path: realPath }))
    expect((await t(process.env.TINKERBOX_TEST_SSH_NOKEY_HOST!)).message).toMatch(/Permission denied by .*password logins are not supported/)
    expect((await t(process.env.TINKERBOX_TEST_SSH_NEWKEY_HOST!)).message).toMatch(/is not known yet/)
  })
})
