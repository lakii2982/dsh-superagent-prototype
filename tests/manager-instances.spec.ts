/** Provisioning uses an executable fixture so CLI environment and durable state are exercised together. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { instanceHome, provision } from '../src/manager/instances.ts'
import { ManagerStore, type Repository } from '../src/manager/store.ts'
import { readiness } from '../src/manager/readiness.ts'
import { Store } from '../src/app/store.ts'

const bundle = vi.hoisted(() => ({ root: '' }))
vi.mock('../src/infra/paths.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/infra/paths.ts')>(), packageRoot: () => bundle.root,
}))
let directory: string, repository: Repository
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'manager-provision-'))
  bundle.root = join(directory, 'release-one'); mkdirSync(bundle.root)
  const bin = join(directory, 'bin'), operator = join(directory, 'operator')
  mkdirSync(bin); mkdirSync(operator)
  writeFileSync(join(operator, '.credentials.yaml'), 'fixture credentials')
  const executable = join(bin, 'dsh')
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.DSH_HOME, 'calls.jsonl'), JSON.stringify({args, home:process.env.DSH_HOME, ambient:process.env.FIXTURE_AMBIENT_SECRET})+'\\n');
if(args[0]!=='plugin') fs.mkdirSync(path.join(process.env.DSH_HOME,'profiles',args[0]),{recursive:true});
else {
  if(fs.existsSync(path.join(process.env.DSH_HOME,'fail-plugin-before'))) { console.error('fixture install failed'); process.exit(23); }
  const profile=args[args.indexOf('--profile')+1], target=args.find(arg=>arg.startsWith('link:')).slice(5);
  const link=path.join(process.env.DSH_HOME,'profiles',profile,'node_modules','dsh-superagent');
  if(!fs.existsSync(path.join(process.env.DSH_HOME,'skip-plugin-link'))) {
    fs.mkdirSync(path.dirname(link),{recursive:true}); fs.rmSync(link,{recursive:true,force:true}); fs.symlinkSync(target,link,'dir');
  }
  if(fs.existsSync(path.join(process.env.DSH_HOME,'fail-plugin-after'))) { console.error('fixture install failed after linking'); process.exit(24); }
}
`)
  chmodSync(executable, 0o755)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`); vi.stubEnv('DSH_HOME', operator)
  repository = { ...ManagerStore.identity(), port: 3099, name: 'Fixture', directory: '/fixture', remote: 'acme/fixture', githubCli: '/bin/false', enabled: true, allowedGithub: [], allowedFeishu: [] }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
const prepare = () => provision(repository, directory, 'http://127.0.0.1:3082', '/bin/false', [])
const preparePilot = () => provision(repository, directory, 'http://127.0.0.1:3082', '', [], { enterprisePilot: true })
const profileDirectory = () => join(instanceHome(directory, repository.id), 'profiles', repository.profile)
const bundleMarker = () => join(profileDirectory(), '.superagent-bundle.json')
const calls = () => readFileSync(join(instanceHome(directory, repository.id), 'calls.jsonl'), 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as { args: string[]; home: string })
const nextRelease = () => { bundle.root = join(directory, 'release-two'); mkdirSync(bundle.root) }
it('isolates profile storage and CLI environment while reusing only model credentials', async () => {
  await prepare()
  const home = instanceHome(directory, repository.id)
  const calls = readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toHaveLength(2)
  expect(calls.every(call => call.home === home)).toBe(true)
  expect(realpathSync(join(home, '.credentials.yaml'))).toBe(realpathSync(join(directory, 'operator', '.credentials.yaml')))
  expect(existsSync(join(directory, 'operator', 'profiles'))).toBe(false)
  const store = new Store(join(directory, 'repositories', repository.id, 'orchestrator.sqlite'))
  try { expect(store.settings().executor.repositoryPath).toBe(repository.directory) } finally { store.close() }
})
it('preserves settings and avoids reprovisioning an initialized instance on restart', async () => {
  await prepare()
  const store = new Store(join(directory, 'repositories', repository.id, 'orchestrator.sqlite'))
  try { const settings = store.settings(); store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } }) } finally { store.close() }
  await prepare()
  const reopened = new Store(join(directory, 'repositories', repository.id, 'orchestrator.sqlite'))
  try { expect(reopened.settings().executor.maxWorkers).toBe(2) } finally { reopened.close() }
  expect(readFileSync(join(instanceHome(directory, repository.id), 'calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
})
it('refreshes an owned profile to the new release without rewriting its patch, settings or tickets', async () => {
  await preparePilot()
  const profile = profileDirectory(), patch = join(profile, 'cordis.patch.yml')
  const customPatch = `${readFileSync(patch, 'utf8')}\n# operator configuration retained\n`
  writeFileSync(patch, customPatch)
  const database = join(directory, 'repositories', repository.id, 'orchestrator.sqlite')
  const store = new Store(database)
  try {
    const settings = store.settings(); store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
    store.tickets.save({ id: 'existing', title: 'Work from the previous release', decisionId: '',
      mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] } })
  } finally { store.close() }
  nextRelease()
  await preparePilot()
  expect(calls()).toHaveLength(3)
  expect(calls()[2]!.args).toEqual(['plugin', '--profile', repository.profile, 'add', '--offline', `link:${realpathSync(bundle.root)}`])
  expect(realpathSync(join(profile, 'node_modules', 'dsh-superagent'))).toBe(realpathSync(bundle.root))
  expect(JSON.parse(readFileSync(bundleMarker(), 'utf8'))).toEqual({ root: realpathSync(bundle.root), phase: 'ready' })
  expect(readFileSync(patch, 'utf8')).toBe(customPatch)
  expect(readFileSync(join(profile, '.superagent-ready'), 'utf8')).toBe(`${repository.id}:enterprise-pilot`)
  const reopened = new Store(database)
  try {
    expect(reopened.settings().executor.maxWorkers).toBe(2)
    expect(reopened.tickets.get('existing')?.title).toBe('Work from the previous release')
  } finally { reopened.close() }
  await preparePilot()
  expect(calls()).toHaveLength(3)
})
it('verifies an older ready profile with no bundle record and treats aliases of the same release as unchanged', async () => {
  await prepare()
  rmSync(bundleMarker())
  const alias = join(directory, 'current-release'); symlinkSync(bundle.root, alias, 'dir'); bundle.root = alias
  await prepare()
  expect(calls()).toHaveLength(2)
  expect(JSON.parse(readFileSync(bundleMarker(), 'utf8'))).toEqual({ root: realpathSync(bundle.root), phase: 'ready' })
  rmSync(bundleMarker())
  nextRelease()
  await prepare()
  expect(calls()).toHaveLength(3)
  expect(calls()[2]!.args).toContain('--offline')
  expect(realpathSync(join(profileDirectory(), 'node_modules', 'dsh-superagent'))).toBe(realpathSync(bundle.root))
})
it('retries an interrupted update even when the failed installer already changed the package link', async () => {
  await preparePilot()
  const home = instanceHome(directory, repository.id), fail = join(home, 'fail-plugin-after')
  const patch = readFileSync(join(profileDirectory(), 'cordis.patch.yml'), 'utf8')
  nextRelease(); writeFileSync(fail, '')
  await expect(preparePilot()).rejects.toThrow('fixture install failed after linking')
  expect(JSON.parse(readFileSync(bundleMarker(), 'utf8'))).toEqual({ root: realpathSync(bundle.root), phase: 'updating' })
  expect(realpathSync(join(profileDirectory(), 'node_modules', 'dsh-superagent'))).toBe(realpathSync(bundle.root))
  expect(readFileSync(join(profileDirectory(), 'cordis.patch.yml'), 'utf8')).toBe(patch)
  rmSync(fail)
  await preparePilot()
  expect(calls()).toHaveLength(4)
  expect(JSON.parse(readFileSync(bundleMarker(), 'utf8'))).toEqual({ root: realpathSync(bundle.root), phase: 'ready' })
  await preparePilot()
  expect(calls()).toHaveLength(4)
})
it('requires the installed real path to match even if the installer reports success or the completion marker is stale', async () => {
  await prepare()
  const home = instanceHome(directory, repository.id), skip = join(home, 'skip-plugin-link')
  nextRelease(); writeFileSync(skip, '')
  await expect(prepare()).rejects.toThrow('did not link the current Superagent bundle')
  expect(JSON.parse(readFileSync(bundleMarker(), 'utf8')).phase).toBe('updating')
  rmSync(skip); await prepare()
  expect(calls()).toHaveLength(4)
  // The real symlink is authoritative; a ready record alone cannot mask a removed installation.
  rmSync(join(profileDirectory(), 'node_modules', 'dsh-superagent'))
  await prepare()
  expect(calls()).toHaveLength(5)
  expect(JSON.parse(readFileSync(bundleMarker(), 'utf8')).phase).toBe('ready')
  await prepare()
  expect(calls()).toHaveLength(5)
})
it('checks rollout mode and isolated credentials before refreshing an existing profile', async () => {
  await preparePilot()
  const original = realpathSync(join(profileDirectory(), 'node_modules', 'dsh-superagent'))
  nextRelease()
  await expect(prepare()).rejects.toThrow('rollout mode cannot change')
  const home = instanceHome(directory, repository.id)
  symlinkSync(join(directory, 'operator', '.credentials.yaml'), join(home, '.credentials.yaml'))
  await expect(preparePilot()).rejects.toThrow('dedicated file')
  expect(calls()).toHaveLength(2)
  expect(realpathSync(join(profileDirectory(), 'node_modules', 'dsh-superagent'))).toBe(original)
})
it('provisions an enterprise pilot in worktree mode without inheriting ambient credentials', async () => {
  vi.stubEnv('FIXTURE_AMBIENT_SECRET', 'fixture only')
  await preparePilot()
  const home = instanceHome(directory, repository.id)
  expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  expect(readFileSync(join(home, 'calls.jsonl'), 'utf8')).not.toContain('fixture only')
  const profile = join(home, 'profiles', repository.profile, 'cordis.patch.yml')
  expect(JSON.parse(readFileSync(profile, 'utf8'))[1].config.managed.enterprisePilot).toBe(true)
  const store = new Store(join(directory, 'repositories', repository.id, 'orchestrator.sqlite'))
  try {
    expect(store.settings()).toMatchObject({ executor: { workspaceMode: 'worktree', maxWorkers: 1, repositoryPath: '' }, eval: { mode: 'off' } })
  } finally { store.close() }
  await expect(preparePilot()).resolves.toBeUndefined()
  await expect(prepare()).rejects.toThrow('rollout mode cannot change')
})
it('requires explicit migration for existing registrations and refuses linked pilot credentials', async () => {
  await prepare()
  await expect(preparePilot()).rejects.toThrow('rollout mode cannot change')
  repository = { ...repository, ...ManagerStore.identity() }
  const home = instanceHome(directory, repository.id)
  mkdirSync(home, { recursive: true })
  symlinkSync(join(directory, 'operator', '.credentials.yaml'), join(home, '.credentials.yaml'))
  await expect(preparePilot()).rejects.toThrow('dedicated file')
})
it('provisions a repository that works through GitHub before Feishu is connected', async () => {
  // No bot CLI and no groups: the repository must still start and pick up GitHub work.
  await provision(repository, directory, 'http://127.0.0.1:3082', '', [])
  const store = new Store(join(directory, 'repositories', repository.id, 'orchestrator.sqlite'))
  try {
    const settings = store.settings()
    expect(settings.sources.github).toMatchObject({ enabled: true, config: { repository: repository.remote } })
    expect(settings.sources.feishu?.config).toMatchObject({ cli: '', chats: [] })
  } finally { store.close() }
  expect(existsSync(join(instanceHome(directory, repository.id), 'profiles', repository.profile, '.superagent-ready'))).toBe(true)
})
it('reports Feishu readiness as a repair instead of blocking a GitHub-only repository', () => {
  const pending = { total: 0, byChat: {} }
  const offline = readiness({ repository, status: { online: true, configured: true }, bot: false, groups: 0, pending })
  expect(offline.repository).toMatchObject({ state: 'ok' })
  expect(offline.feishu).toMatchObject({ state: 'pending', repair: 'feishu' })
  // An instance that reports no probe yet stays unknown; a probe that says every agent is unavailable is an error with its reason.
  expect(offline.agent).toMatchObject({ state: 'unknown', repair: 'agent' })
  const constrained = readiness({ repository, status: { online: true, configured: true,
    agent: [{ kind: 'codex', available: true, detail: 'codex was found' }, { kind: 'claude', available: false, detail: 'no sandbox tool' }] },
  bot: true, groups: 1, pending })
  expect(constrained.agent).toMatchObject({ state: 'ok' })
  const blocked = readiness({ repository, status: { online: true, configured: true,
    agent: [{ kind: 'codex', available: false, detail: 'This host cannot constrain codex\'s file access.' }] }, bot: true, groups: 1, pending })
  expect(blocked.agent).toMatchObject({ state: 'error', repair: 'agent', detail: 'This host cannot constrain codex\'s file access.' })
  expect(offline.delivery).toMatchObject({ state: 'ok', pending: 0 })
  const connected = readiness({ repository, status: { online: true, configured: true }, bot: true, groups: 2, pending: { total: 3, byChat: { oc_team: 3 } } })
  expect(connected.feishu).toMatchObject({ state: 'ok', detail: '2 个飞书群' })
  expect(connected.delivery).toMatchObject({ state: 'pending', detail: '3 条消息待投递', byChat: { oc_team: 3 } })
  const disabled = readiness({ repository: { ...repository, enabled: false }, status: { online: true, configured: true }, bot: true, groups: 1, pending })
  expect(disabled.repository).toMatchObject({ state: 'error', repair: 'repository' })
})
it('refuses to overwrite an unowned profile', async () => {
  mkdirSync(join(instanceHome(directory, repository.id), 'profiles', repository.profile), { recursive: true })
  await expect(prepare()).rejects.toThrow('Refusing to replace')
})

it('preserves legacy tickets and blocks switching their session storage implicitly', async () => {
  const stateDir = join(directory, 'repositories', repository.id)
  mkdirSync(stateDir, { recursive: true })
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  try {
    store.tickets.save({ id: 'legacy', title: 'Legacy work', decisionId: '',
      mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] } })
  } finally { store.close() }
  await expect(prepare()).rejects.toThrow('explicit session migration')
  expect(existsSync(join(instanceHome(directory, repository.id), 'profiles', repository.profile, '.superagent-ready'))).toBe(false)
  const reopened = new Store(join(stateDir, 'orchestrator.sqlite'))
  try { expect(reopened.tickets.get('legacy')?.title).toBe('Legacy work') } finally { reopened.close() }
})
