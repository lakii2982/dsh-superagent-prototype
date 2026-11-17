/** Provisioning uses an executable fixture so CLI environment and durable state are exercised together. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { instanceHome, provision } from '../src/manager/instances.ts'
import { ManagerStore, type Repository } from '../src/manager/store.ts'
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
