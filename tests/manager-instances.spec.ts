/** Provisioning uses an executable fixture so CLI environment and durable state are exercised together. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { instanceHome, provision } from '../src/manager/instances.ts'
import { ManagerStore, type Repository } from '../src/manager/store.ts'
import { readiness } from '../src/manager/readiness.ts'
import { Store } from '../src/app/store.ts'

let directory: string, repository: Repository
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'manager-provision-'))
  const bin = join(directory, 'bin'), operator = join(directory, 'operator')
  mkdirSync(bin); mkdirSync(operator)
  writeFileSync(join(operator, '.credentials.yaml'), 'fixture credentials')
  const executable = join(bin, 'dsh')
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.DSH_HOME, 'calls.jsonl'), JSON.stringify({args, home:process.env.DSH_HOME})+'\\n');
if(args[0]!=='plugin') fs.mkdirSync(path.join(process.env.DSH_HOME,'profiles',args[0]),{recursive:true});
`)
  chmodSync(executable, 0o755)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`); vi.stubEnv('DSH_HOME', operator)
  repository = { ...ManagerStore.identity(), port: 3099, name: 'Fixture', directory: '/fixture', remote: 'acme/fixture', githubCli: '/bin/false', enabled: true, allowedGithub: [], allowedFeishu: [] }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
const prepare = () => provision(repository, directory, 'http://127.0.0.1:3082', '/bin/false', [])
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
