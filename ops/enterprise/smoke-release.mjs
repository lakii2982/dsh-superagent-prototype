#!/usr/bin/env node
/** Exercise the packaged installer and operator against a real, separately installed DSH host. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const [, , archiveArgument, reportArgument, ...extra] = process.argv
if (!archiveArgument || !reportArgument || extra.length) {
  console.error('Usage: node ops/enterprise/smoke-release.mjs <release.zip> <report.json>')
  process.exit(1)
}
if (!process.getuid || process.getuid() === 0) throw new Error('Run this check as a non-root account')
process.umask(0o077)
const archive = resolve(archiveArgument), reportFile = resolve(reportArgument)
const temporary = await mkdtemp(join(tmpdir(), 'dsh-release-smoke-'))
const deployment = join(temporary, 'deployment'), snapshot = join(temporary, 'snapshot')
const isolatedHost = join(temporary, 'host'), npmConfig = join(temporary, 'npmrc')
const allowedEnvironment = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']
const environment = Object.fromEntries(allowedEnvironment.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
Object.assign(environment, { DSH_HOME: isolatedHost, npm_config_userconfig: npmConfig,
  npm_config_cache: join(temporary, 'npm-cache'), CI: 'true' })
const operator = join(deployment, 'dsh-enterprise')
const checks = []
const started = Date.now()
let stage = 'prepare', token = '', config, supervisor, failure
const digest = value => createHash('sha256').update(value).digest('hex')
const redact = value => String(value).replaceAll(token || '\u0000', '[redacted]')
  .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[redacted]')
  .replace(/(bearer\s+|["']?(?:access[_-]?token|api[_-]?key|password)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1[redacted]')
async function command(program, args, timeout = 120_000) {
  try {
    return await exec(program, args, { cwd: temporary, env: environment, timeout, maxBuffer: 8 << 20 })
  } catch (error) {
    const detail = redact(error.stderr ?? error.message).slice(-6000)
    throw new Error(`${stage}: ${program} exited ${error.code ?? error.signal ?? 'unsuccessfully'}\n${detail}`)
  }
}
const operate = (...args) => command(process.execPath, [operator, ...args], 330_000)
async function step(name, action) {
  stage = name
  const time = Date.now()
  const evidence = await action()
  checks.push({ name, passed: true, durationMs: Date.now() - time, ...evidence })
  console.log(`PASS ${name}`)
}
async function vacantPort() {
  const server = createServer()
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
    return server.address().port
  } finally { if (server.listening) await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())) }
}
async function managerState(authorization = token) {
  const response = await fetch(`http://127.0.0.1:${config.port}/orchestrator/manager/state`, {
    headers: authorization ? { authorization: `Bearer ${authorization}` } : {},
    redirect: 'error', signal: AbortSignal.timeout(3000),
  })
  return { response, value: await response.json() }
}
async function launch() {
  const output = await open(join(temporary, 'supervisor.log'), 'a', 0o600)
  try {
    supervisor = spawn(process.execPath, [operator, 'foreground'], {
      cwd: temporary, env: environment, detached: true, stdio: ['ignore', output.fd, output.fd],
    })
    await new Promise((accept, reject) => { supervisor.once('spawn', accept); supervisor.once('error', reject) })
  } finally { await output.close() }
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) throw new Error('Real DSH host exited during startup')
    const result = await managerState().catch(() => undefined)
    if (result?.response.ok) {
      const pid = Number((await readFile(join(deployment, 'manager.pid'), 'utf8')).trim())
      assert.equal(result.value.pid, pid)
      assert.equal(result.value.stateDir, join(deployment, 'manager'))
      return result.value
    }
    await wait(250)
  }
  throw new Error('Real DSH host did not expose its authenticated manager API within 90 seconds')
}
async function stop() {
  await operate('stop')
  const deadline = Date.now() + 10_000
  while (supervisor && supervisor.exitCode === null && supervisor.signalCode === null && Date.now() < deadline) await wait(100)
  assert.ok(!supervisor || supervisor.exitCode !== null || supervisor.signalCode !== null, 'Foreground supervisor did not exit')
  supervisor = undefined
}
function checkEmptyManager(value) {
  assert.equal(value.enterprisePilot, true)
  assert.equal(value.requireProtectedBranches, true)
  assert.equal(value.capacity.maxRunningRepositories, 12)
  assert.equal(value.capacity.runningRepositories, 0)
  assert.deepEqual(value.repositories, [])
  assert.equal(value.bot, null)
}

try {
  await mkdir(isolatedHost, { mode: 0o700 })
  await writeFile(npmConfig, '', { mode: 0o600 })
  await step('official-host-version', async () => {
    const { stdout } = await command('dsh', ['--version'])
    assert.equal(stdout.trim(), '0.2.2-rc.5')
    return { dshVersion: stdout.trim(), nodeVersion: process.version }
  })
  await step('extract-release', async () => {
    // Python's ZIP parser checks entry types before extracting; no archive-controlled symlinks or parent paths.
    await command('python3', ['-c', `import pathlib, stat, sys, zipfile
archive, target = sys.argv[1:]
with zipfile.ZipFile(archive) as package:
    entries = package.infolist()
    if sum(entry.file_size for entry in entries) > 512 * 1024 * 1024:
        raise ValueError('Release is unexpectedly large')
    for entry in entries:
        name = pathlib.PurePosixPath(entry.filename)
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'dsh-enterprise-release' or kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('Unsupported release entry')
    package.extractall(target)
`, archive, temporary])
    // zipfile does not restore executable modes; these are the exact two public release executables.
    for (const name of ['install.sh', 'dsh-enterprise']) await chmod(join(temporary, 'dsh-enterprise-release', name), 0o700)
    return { releaseSha256: digest(await readFile(archive)) }
  })
  await step('install-clean-profile', async () => {
    const port = await vacantPort()
    await command('bash', [join(temporary, 'dsh-enterprise-release', 'install.sh'), '--home', deployment,
      '--port', String(port), '--capacity', '12', '--no-start'], 180_000)
    config = JSON.parse(await readFile(join(deployment, 'service.json'), 'utf8'))
    token = (await readFile(join(deployment, 'operator.token'), 'utf8')).trim()
    assert.match(token, /^[a-f0-9]{64}$/)
    assert.equal((await stat(join(deployment, 'operator.token'))).mode & 0o777, 0o600)
    assert.equal(await stat(join(deployment, 'manager.pid')).then(() => true, () => false), false)
    return { installedPackageSha256: config.sha256, capacity: config.capacity }
  })
  await step('start-and-authenticate', async () => {
    checkEmptyManager(await launch())
    const status = JSON.parse((await operate('status')).stdout)
    assert.equal(status.repositories, 0)
    assert.equal(status.capacity.maxRunningRepositories, 12)
    const unauthorized = await managerState('')
    assert.equal(unauthorized.response.status, 401)
    assert.equal(unauthorized.value.code, 'operator_auth_required')
    const wrong = await managerState('invalid-smoke-token')
    assert.equal(wrong.response.status, 401)
    return { authorizedStatus: 200, anonymousStatus: 401, invalidTokenStatus: 401 }
  })
  await step('graceful-stop', stop)
  let databaseDigest
  const marker = join(deployment, 'manager', 'smoke-marker.json')
  await step('backup-and-verify', async () => {
    await writeFile(marker, '{"checkpoint":"before"}\n', { mode: 0o600 })
    databaseDigest = digest(await readFile(join(deployment, 'manager', 'manager.sqlite')))
    const backup = JSON.parse((await operate('backup', snapshot)).stdout)
    assert.equal(backup.verified, true)
    const verified = JSON.parse((await operate('verify-backup', snapshot)).stdout)
    assert.equal(verified.verified, true)
    return { verifiedEntries: verified.entries }
  })
  await step('restore-and-preserve-current-state', async () => {
    await writeFile(marker, '{"checkpoint":"after"}\n', { mode: 0o600 })
    const restored = JSON.parse((await operate('restore', snapshot)).stdout)
    assert.equal(restored.running, false)
    assert.equal(await readFile(marker, 'utf8'), '{"checkpoint":"before"}\n')
    assert.equal(digest(await readFile(join(deployment, 'manager', 'manager.sqlite'))), databaseDigest)
    assert.equal(await readFile(join(restored.preservedCurrentState, 'snapshot', 'manager', 'smoke-marker.json'), 'utf8'), '{"checkpoint":"after"}\n')
    assert.equal(await stat(join(deployment, 'manager.pid')).then(() => true, () => false), false)
    return { databasePreserved: true, priorStatePreserved: true, automaticallyStarted: false }
  })
  await step('restart-restored-profile', async () => {
    checkEmptyManager(await launch())
    await operate('status')
    await stop()
    return { restoredManagerAuthenticated: true }
  })
} catch (error) {
  failure = { stage, message: redact(error.message) }
  console.error(`FAIL ${stage}: ${failure.message}`)
  for (const name of ['install.log', 'manager.log']) {
    const log = await readFile(join(deployment, name), 'utf8').catch(() => '')
    if (log) console.error(`Diagnostic ${name}:\n${redact(log.split('\n').slice(-35).join('\n'))}`)
  }
  process.exitCode = 1
} finally {
  // Signal only the process group created by this script, never a PID read from an external installation.
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
    try { process.kill(-supervisor.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    const deadline = Date.now() + 5000
    while (supervisor.exitCode === null && supervisor.signalCode === null && Date.now() < deadline) await wait(100)
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      try { process.kill(-supervisor.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  await mkdir(dirname(reportFile), { recursive: true })
  await writeFile(reportFile, JSON.stringify({ schema: 1, passed: !failure, durationMs: Date.now() - started,
    scope: 'Real DSH host: clean installation, operator authentication, stop, backup, restore and restart. No model or external work was submitted.',
    checks, ...(failure ? { failure } : {}) }, null, 2) + '\n', { mode: 0o600 })
  await rm(temporary, { recursive: true, force: true })
}
