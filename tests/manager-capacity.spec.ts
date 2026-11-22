/** Exercises manager reservations and journal dispatch with in-process authenticated instance fixtures. */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Config } from '../src/deployment.ts'
import type { Trigger } from '../src/core/index.ts'
import * as instanceRuntime from '../src/manager/instances.ts'
import { Manager } from '../src/manager/runtime.ts'
import { ManagerStore, type Repository } from '../src/manager/store.ts'
import { testMachine } from './fixtures/deployment.ts'
import { feishu } from './fixtures/host.ts'

type Received = { repositoryId: string; trigger: Trigger }
type Instance = { repository: Repository; online: boolean; enterprisePilot: boolean; received: Received[] }
type State = {
  enterprisePilot: boolean
  capacity: { maxRunningRepositories: number; runningRepositories: number }
  repositories: { id: string; teamName?: string; productLines?: string[]; starting: boolean; status: { online: boolean; configured?: boolean; error?: string } }[]
}
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
const PORT = 3082
let directory: string, manager: Manager, ctx: Context, handler: Handler
const instances = new Map<string, Instance>()

vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createServer: () => {
    const port = 3200 + (manager?.store.revision() ?? 0)
    return {
      once() {}, listen: (_port: number, _host: string, ready: () => void) => ready(), address: () => ({ port }),
      close: (done: () => void) => done(),
    }
  },
}))

function registerInstance(line: number, team = 1, online = true, enterprisePilot = false): Instance {
  const repository = { ...ManagerStore.identity(), name: `Team ${team} Product ${line}`, remote: `acme/product${line}`,
    teamName: `Team ${team}`, productLines: [`Product ${line}`],
    directory: `/repo/product${line}`, githubCli: '/bin/false', allowedGithub: [], enabled: true, port: 3100 + line,
    allowedFeishu: Array.from({ length: 10 }, (_, user) => `ou_t${team}p${line}u${user}`),
  }
  const instance = { repository, online, enterprisePilot, received: [] }
  instances.set(repository.id, instance)
  return instance
}
function saveRepositories() {
  const repositories = [...instances.values()].map(instance => instance.repository)
  manager.store.save(repositories, repositories.map((repo, index) => ({
    chatId: `oc_product${index + 1}`, repositoryId: repo.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z',
  })), manager.store.revision())
}
function setupManager(options?: ConstructorParameters<typeof Manager>[2]) {
  manager = new Manager(ctx, testMachine({ stateDir: directory }), options)
}
async function request(path: string, method = 'GET', payload?: unknown) {
  const req = Object.assign(Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]), { url: `/orchestrator/manager/${path}`, method,
    headers: { host: `127.0.0.1:${PORT}`, 'x-orchestrator-request': '1' } })
  let status = 0, value: unknown
  const res = { writeHead: (code: number) => { status = code }, end: (text: string) => { value = JSON.parse(text) } }
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  return { status, value }
}
async function view(): Promise<State> {
  return (await request('state')).value as State
}
const start = (id: string) => request(`repositories/${id}/start`, 'POST')

beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'manager-capacity-'))
  ctx = { workspaceRegistry: { list: () => [] }, webServer: { host: '127.0.0.1', port: PORT,
    register: ({ handler: next }: { handler: Handler }) => { handler = next; return () => {} } } } as unknown as Context
  vi.spyOn(instanceRuntime, 'instanceHealth').mockImplementation(async repo => {
    const instance = instances.get(repo.id)!
    expect(repo.token).toBe(instance.repository.token)
    if (!instance.online) throw new Error('Instance offline')
    return { pid: process.pid, configured: true, enterprisePilot: instance.enterprisePilot }
  })
  vi.spyOn(instanceRuntime, 'instanceRequest').mockImplementation(async (repo, path, payload) => {
    const instance = instances.get(repo.id)!
    expect(repo.token).toBe(instance.repository.token)
    if (path === 'settings') return {
      sources: [{ id: 'feishu', revision: 1, value: { enabled: true, config: { cli: '', chats: [] } } }],
      blocks: { policy: { revision: 1, value: { sources: { github: { allowed: [] }, feishu: { allowed: [] } } } } },
    }
    if (path.startsWith('settings/')) return { saved: true }
    if (path !== 'receive') throw new Error(`Unexpected fixture request ${path}`)
    const received = payload as Received
    instance.received.push(received)
    return { result: 'stored' }
  })
})
afterEach(async () => {
  await manager?.stop()
  instances.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it('validates the configured capacity and preserves the legacy default', () => {
  const base = { stateDir: '/tmp/manager' }
  expect(Config(base)).toMatchObject({ maxRunningRepositories: 3, enterprisePilot: false, requireProtectedBranches: false })
  expect(Config({ ...base, mode: 'manager', maxRunningRepositories: 12, enterprisePilot: true, requireProtectedBranches: true }))
    .toMatchObject({ maxRunningRepositories: 12, enterprisePilot: true, requireProtectedBranches: true })
  expect(() => Config({ ...base, maxRunningRepositories: 0 })).toThrow()
  expect(() => Config({ ...base, maxRunningRepositories: 13 })).toThrow()
  expect(() => Config({ ...base, maxRunningRepositories: 3.5 })).toThrow()
})

it('registers multiple GitHub repositories without local checkouts and still requires write access', async () => {
  const spawn = vi.fn(({ argv }: { argv: string[] }) => {
    const resource = argv[4]
    const result = resource === 'user' ? { login: 'agent', id: 7 }
      : { name: resource?.replace('repos/acme/', 'Acme/'), push: resource !== 'repos/acme/readonly' }
    return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: JSON.stringify(result) }) } } }
  })
  Object.assign(ctx, { subprocess: { spawn } })
  const register = (repository: string, directory?: string) => request('repositories', 'POST', {
    name: repository, remote: `acme/${repository}`, githubCli: process.execPath, revision: manager.store.revision(),
    ...(directory === undefined ? {} : { directory }),
  })

  setupManager()
  await manager.start()
  const legacy = await register('first')
  expect(legacy.status).toBe(400)
  expect(legacy.value).toMatchObject({ error: expect.stringContaining('local Git checkout is required') })
  expect(spawn).not.toHaveBeenCalled()
  await manager.stop()

  setupManager({ enterprisePilot: true })
  await manager.start()
  const first = await register('first')
  expect(first.status, JSON.stringify(first.value)).toBe(200)
  const second = await register('second', '')
  expect(second.status, JSON.stringify(second.value)).toBe(200)
  expect(await register('first')).toMatchObject({ status: 400, value: { error: expect.stringContaining('already registered') } })
  expect(await register('readonly')).toMatchObject({ status: 400, value: { code: 'repositoryReadOnly' } })
  expect(manager.store.repositories()).toEqual([
    expect.objectContaining({ remote: 'Acme/first', directory: '' }),
    expect.objectContaining({ remote: 'Acme/second', directory: '' }),
  ])
})

it('reserves one slot per repository while competing starts reach the default limit', async () => {
  setupManager()
  registerInstance(1)
  const first = registerInstance(2, 1, false)
  const second = registerInstance(3, 1, false)
  const third = registerInstance(4, 1, false)
  saveRepositories()
  await manager.start()
  expect((await view()).capacity).toEqual({ maxRunningRepositories: 3, runningRepositories: 1 })
  const hold = Promise.withResolvers<void>(), reserved = Promise.withResolvers<void>()
  vi.spyOn(instanceRuntime, 'provision').mockImplementation(async repo => {
    if (repo.id !== first.repository.id) return
    reserved.resolve()
    await hold.promise
  })
  const launch = vi.spyOn(instanceRuntime, 'startInstance').mockImplementation(async repo => {
    instances.get(repo.id)!.online = true
    return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess
  })
  const starting = start(first.repository.id)
  try {
    await reserved.promise
    first.online = true
    await vi.advanceTimersByTimeAsync(2000)
    const state = await view()
    expect(state.repositories.find(repo => repo.id === first.repository.id)).toMatchObject({ starting: true, status: { online: true } })
    expect(state.capacity).toEqual({ maxRunningRepositories: 3, runningRepositories: 2 })
    const responses = await Promise.all([start(second.repository.id), start(third.repository.id)])
    expect(responses.map(result => result.status).sort()).toEqual([200, 400])
    expect(responses.find(result => result.status === 400)?.value).toEqual({ error: 'At most 3 repositories may run at once' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect((await view()).capacity.runningRepositories).toBe(3)
    const started = [second, third].find(instance => instance.online)!
    started.online = false
    await vi.advanceTimersByTimeAsync(2000)
    expect((await view()).capacity.runningRepositories).toBe(3)
  } finally {
    hold.resolve()
    expect((await starting).status).toBe(200)
  }
})

it('rediscovers twelve instances and dispatches 120 distinct synthetic actors across five teams', async () => {
  const options = { maxRunningRepositories: 12, enterprisePilot: true }
  setupManager(options)
  for (let i = 0; i < 12; i++) registerInstance(i + 1, Math.floor(i * 5 / 12) + 1, true, true)
  const last = [...instances.values()].at(-1)!
  last.online = false
  saveRepositories()
  await manager.start()
  expect((await view()).capacity).toEqual({ maxRunningRepositories: 12, runningRepositories: 11 })
  const provision = vi.spyOn(instanceRuntime, 'provision').mockResolvedValue(undefined)
  const launch = vi.spyOn(instanceRuntime, 'startInstance').mockImplementation(async repo => {
    instances.get(repo.id)!.online = true
    return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess
  })
  expect((await start(last.repository.id)).status).toBe(200)
  expect(provision.mock.calls[0]?.at(-1)).toEqual({ enterprisePilot: true })
  expect(launch.mock.calls[0]?.at(-1)).toEqual({ enterprisePilot: true })
  await manager.stop()
  setupManager(options)
  await manager.start()
  const shared = await view()
  expect(shared.capacity).toEqual({ maxRunningRepositories: 12, runningRepositories: 12 })
  expect(new Set(shared.repositories.map(repo => repo.teamName)).size).toBe(5)
  expect(new Set(shared.repositories.flatMap(repo => repo.productLines ?? [])).size).toBe(12)
  for (const [index, { repository }] of [...instances.values()].entries()) {
    for (const [user, actor] of repository.allowedFeishu.entries()) {
      const trigger = feishu(`p${index}u${user}`, 'Synthetic maintenance request', { chat_id: `oc_product${index + 1}`, sender_id: actor })
      expect(manager.store.route(trigger)).toBe('stored')
      expect(manager.store.route(trigger)).toBe('duplicate')
    }
  }
  await vi.advanceTimersByTimeAsync(2000)
  expect(manager.store.queueCounts()).toEqual([])
  for (const [index, { repository, received }] of [...instances.values()].entries()) {
    expect(received.map(item => item.trigger.actor.id).sort()).toEqual([...repository.allowedFeishu].sort())
    expect(received.every(item => item.repositoryId === repository.id && item.trigger.meta.chatId === `oc_product${index + 1}`)).toBe(true)
  }
  const extra = registerInstance(13, 5, false, true)
  saveRepositories()
  expect(await start(extra.repository.id)).toEqual({ status: 400, value: { error: 'At most 12 repositories may run at once' } })
  expect(launch).toHaveBeenCalledTimes(1)
})

it('delivers to healthy repositories even if older offline messages exceed the batch size', async () => {
  setupManager()
  const offline = registerInstance(1, 1, false), online = registerInstance(2)
  saveRepositories()
  await manager.start()
  for (let index = 0; index < 110; index++) manager.store.route(feishu(`offline${index}`, 'Offline request', { chat_id: 'oc_product1' }))
  manager.store.route(feishu('online', 'Online request', { chat_id: 'oc_product2' }))
  await vi.advanceTimersByTimeAsync(2000)
  expect(online.received.map(item => item.trigger.meta.messageId)).toEqual(['om_online'])
  expect(offline.received).toEqual([])
  expect(manager.store.queueCounts()).toEqual([{ repositoryId: offline.repository.id, chatId: 'oc_product1', count: 110 }])
  expect(manager.store.outstanding().every(item => item.attempts === 0)).toBe(true)
})

it('counts an online legacy profile without forwarding enterprise pilot tasks to it', async () => {
  setupManager({ enterprisePilot: true })
  const instance = registerInstance(1)
  saveRepositories()
  await manager.start()
  const state = await view()
  expect(state.enterprisePilot).toBe(true)
  expect(state.capacity.runningRepositories).toBe(1)
  expect(state.repositories[0]?.status).toMatchObject({ online: true, configured: false, error: expect.stringContaining('enterprise pilot mode') })
  manager.store.route(feishu('1', 'Synthetic request', { chat_id: 'oc_product1' }))
  expect((await request(`repositories/${instance.repository.id}/api/settings`)).status).toBe(400)
  expect((await start(instance.repository.id)).status).toBe(400)
  await vi.advanceTimersByTimeAsync(2000)
  expect(manager.store.outstanding()).toHaveLength(1)
  expect(instance.received).toEqual([])
  instance.enterprisePilot = true
  await vi.advanceTimersByTimeAsync(2000)
  expect(instance.received).toHaveLength(1)
})

it('refuses to start a disabled enterprise repository', async () => {
  setupManager({ enterprisePilot: true })
  const instance = registerInstance(1, 1, false, true)
  instance.repository.enabled = false
  saveRepositories()
  await manager.start()
  expect(await start(instance.repository.id)).toEqual({ status: 400, value: { error: 'Enable the enterprise repository before starting it' } })
})

it('makes the production start endpoint enforce rules before provisioning, including named checks', async () => {
  setupManager({ enterprisePilot: true, requireProtectedBranches: true })
  const protectedRepo = registerInstance(1, 1, false, true), missingCheck = registerInstance(2, 1, false, true)
  const fixture = join(directory, 'github-fixture')
  writeFileSync(fixture, `#!/usr/bin/env node
const path = process.argv.at(-1)
const rules = [
  {type:'pull_request',parameters:{required_approving_review_count:1}},
  {type:'required_status_checks',parameters:{required_status_checks:[{context:'unit'}]}},
  {type:'non_fast_forward'},{type:'deletion'}
]
const accepted = [1, 2].flatMap(index => ['repos/acme/product' + index, 'repos/acme/product' + index + '/rules/branches/main'])
if (process.argv[2] !== 'api' || !accepted.includes(path)) process.exit(9)
console.log(JSON.stringify(path.includes('/rules/') ? rules : {full_name:path.slice(6),default_branch:'main'}))
`, { mode: 0o700 })
  protectedRepo.repository.githubCli = fixture
  missingCheck.repository.githubCli = fixture
  const repositories = [{ ...protectedRepo.repository, requiredChecks: ['unit'] }, { ...missingCheck.repository, requiredChecks: ['integration'] }]
  manager.store.save(repositories, [], manager.store.revision())
  await manager.start()
  expect((await request('state')).value).toMatchObject({ requireProtectedBranches: true })
  const provision = vi.spyOn(instanceRuntime, 'provision').mockResolvedValue(undefined)
  const launch = vi.spyOn(instanceRuntime, 'startInstance').mockImplementation(async repo => {
    instances.get(repo.id)!.online = true
    return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess
  })
  expect(await start(missingCheck.repository.id)).toMatchObject({ status: 400, value: { error: expect.stringContaining('required CI status check "integration"') } })
  expect(provision).not.toHaveBeenCalled()
  expect(launch).not.toHaveBeenCalled()
  expect((await start(protectedRepo.repository.id)).status).toBe(200)
  expect(provision).toHaveBeenCalledTimes(1)
  expect(launch).toHaveBeenCalledTimes(1)
})
