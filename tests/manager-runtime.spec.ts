/** Exercises the real local HTTP boundary with isolated fake bot and repository instances. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Manager } from '../src/manager/runtime.ts'
import { ManagerStore, type Repository } from '../src/manager/store.ts'
import { testMachine } from './fixtures/deployment.ts'
import { nativeSubprocess } from './fixtures/subprocess.ts'
import { feishu } from './fixtures/host.ts'

vi.setConfig({ testTimeout: 20000 })
type Received = { repositoryId: string; trigger: { id: string; actor: { id: string }; threads: { id: string }[]; meta: { messageId: string; chatId: string } } }
type Fake = {
  server: Server; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>; port: number; id: string; token: string
  received: Received[]; requests: { messageId: string; result: string }[]; accepted: Set<string>; failing: Set<string>
}
type Readiness = { state: string; detail?: string; repair?: string; pending?: number; byChat?: Record<string, number> }
type State = {
  repositories: { id: string; status: { online: boolean }; pending: { total: number; byChat: Record<string, number> }; readiness: Record<string, Readiness> }[]
  queues: { total: number; byRepository: Record<string, number>; byChat: Record<string, number> }
  pending: { id: string; repositoryId: string; hold?: string }[]
}
let directory: string, manager: Manager, server: Server, origin: string, repository: Repository, ctx: Context, botCli: string
const fakes: Fake[] = []
const listen = (server: Server, port = 0) => new Promise<number>((resolve, reject) => {
  const failed = (error: Error) => reject(error)
  server.once('error', failed)
  server.listen(port, '127.0.0.1', () => {
    server.removeListener('error', failed)
    resolve((server.address() as { port: number }).port)
  })
})
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
const response = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const request = (path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST', headers: Record<string, string> = { 'x-orchestrator-request': '1' }) =>
  fetch(`${origin}/orchestrator/${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
const fakeOf = (repositoryId: string): Fake => fakes.find(item => item.id === repositoryId)!
const view = async (): Promise<State> => await (await request('manager/state')).json() as State
const arrived = (fake: Fake): string[] => fake.received.map(item => item.trigger.meta.messageId)

/** A repository instance fixture: authenticated health, settings, tickets and a deduplicating receive. */
const fakeInstance = async (): Promise<Fake> => {
  const fake = { received: [], requests: [], accepted: new Set<string>(), failing: new Set<string>(), id: '', token: '' } as unknown as Fake
  fake.handler = async (req, res) => {
    if (req.headers.authorization !== `Bearer ${fake.token}`) { response(res, { error: 'auth' }, 403); return }
    const url = req.url ?? ''
    if (url.endsWith('/health')) { response(res, { repositoryId: fake.id, pid: process.pid, configured: true,
      agent: [{ kind: 'codex', available: true, detail: 'codex was found' }] }); return }
    if (url.endsWith('/settings')) { response(res, { blocks: { policy: { revision: 1, value: { sources: { github: { allowed: [] }, feishu: { allowed: [] } } } } },
      sources: [{ id: 'feishu', revision: 1, value: { enabled: true, config: { cli: 'bot', chats: [] } } }] }); return }
    if (url.includes('/settings/')) { response(res, { saved: true }); return }
    if (url.includes('/tickets')) { response(res, { items: [] }); return }
    if (url.endsWith('/receive')) {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const data = JSON.parse(Buffer.concat(chunks).toString()) as Received
      const messageId = data.trigger.meta.messageId
      if (fake.failing.has(messageId)) { fake.requests.push({ messageId, result: 'failed' }); response(res, { error: 'offline' }, 503); return }
      const result = fake.accepted.has(data.trigger.id) ? 'duplicate' : 'stored'
      fake.accepted.add(data.trigger.id); fake.requests.push({ messageId, result })
      if (result === 'stored') fake.received.push(data)
      response(res, { result }); return
    }
    response(res, {})
  }
  fake.server = createServer((req, res) => { void fake.handler(req, res) }); fake.port = await listen(fake.server); fakes.push(fake)
  return fake
}
const repositoryFor = (fake: Fake, name: string, remote: string): Repository => {
  const created: Repository = { ...ManagerStore.identity(), port: fake.port, name, remote, directory: `/repo/${name}`, githubCli: '/bin/false', allowedGithub: [], allowedFeishu: ['ou_alice'], enabled: true }
  fake.id = created.id; fake.token = created.token
  return created
}
const restartManager = async (): Promise<void> => {
  await manager.stop()
  manager = new Manager(ctx, testMachine({ stateDir: directory }))
  await manager.start()
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'manager-http-'))
  botCli = join(directory, 'bot')
  writeFileSync(botCli, `#!/usr/bin/env node
const args=process.argv.slice(2), text=args.join(' ');
if(args[0]==='event'){process.stderr.write('[event] ready\\n');process.stdin.resume();return;}
if(text==='auth status'){console.log(JSON.stringify({appId:'cli_test',identities:{bot:{status:'ready'}}}));return;}
if(text==='config strict-mode'){console.log('strict-mode: bot');return;}
if(text.includes('/bot/v3/info')){console.log(JSON.stringify({bot:{open_id:'ou_bot',app_name:'Test Bot'}}));return;}
const data=args[1]==='+chat-list'?{chats:[{chat_id:'oc_team',name:'Team'},{chat_id:'oc_second',name:'Other'}]}:
args[1]==='+chat-members-list'?{users:[{member_id:'ou_alice',name:'Alice'}],has_more:false}:
args[0]==='api'?{items:[],has_more:false}:{};
console.log(JSON.stringify({ok:true,data}));
`); chmodSync(botCli, 0o755)
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async () => {}
  server = createServer((req, res) => { void handler(req, res) })
  origin = `http://127.0.0.1:${await listen(server)}`
  ctx = { subprocess: nativeSubprocess, workspaceRegistry: { list: () => [] }, webServer: { host: '127.0.0.1', port: Number(new URL(origin).port),
    register: (value: { handler: typeof handler }) => { handler = value.handler; return () => {} } } } as unknown as Context
  manager = new Manager(ctx, testMachine({ stateDir: directory }))
  const fake = await fakeInstance()
  repository = repositoryFor(fake, 'Repo', 'acme/widgets')
  manager.store.save([repository], [{ chatId: 'oc_team', repositoryId: repository.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }], 0)
  manager.store.set('bot-cli', botCli)
  await manager.start()
})
afterEach(async () => {
  try { await manager?.stop() }
  finally {
    try {
      if (server?.listening) await close(server)
      for (const fake of fakes) if (fake.server.listening) await close(fake.server)
    } finally { fakes.length = 0; if (directory) rmSync(directory, { recursive: true, force: true }) }
  }
})
it('hides instance credentials and rejects cross-origin browser and unauthenticated internal calls', async () => {
  const state = await (await request('manager/state')).text()
  expect(state).not.toContain(repository.token); expect(state).not.toContain('"token"')
  expect((await request('manager/state', undefined, 'GET', { origin: 'https://example.com' })).status).toBe(403)
  expect((await request(`internal/${repository.id}/receive`, feishu('1', 'request'))).status).toBe(403)
  const wrong = feishu('1', 'wrong group', { chat_id: 'oc_second' })
  expect((await request(`internal/${repository.id}/receive`, wrong, 'POST', { authorization: `Bearer ${repository.token}` })).status).toBe(400)
})
it('atomically binds a group and grants access to its selected verified members', async () => {
  expect((await request('manager/chats/refresh', {})).status).toBe(200)
  const revision = manager.store.revision()
  manager.store.save([{ ...repository, allowedFeishu: ['ou_other'] }], manager.store.bindings(), revision)
  const before = manager.store.revision()
  const bindings = [...manager.store.bindings().map(({ effectiveAt, ...binding }) => binding),
    { chatId: 'oc_second', repositoryId: repository.id, enabled: true }]
  const grant = { chatId: 'oc_second', repositoryId: repository.id, memberIds: ['ou_missing'] }
  expect((await request('manager/bindings', { revision: before, bindings, grant }, 'PUT')).status).toBe(400)
  expect(manager.store.revision()).toBe(before)
  expect(manager.store.bindings()).toHaveLength(1)
  expect(manager.store.repositories()[0]?.allowedFeishu).toEqual(['ou_other'])
  grant.memberIds = ['ou_alice']
  expect((await request('manager/bindings', { revision: before, bindings, grant }, 'PUT')).status).toBe(200)
  expect(manager.store.revision()).toBe(before + 1)
  expect(manager.store.bindings()).toHaveLength(2)
  expect(manager.store.repositories()[0]?.allowedFeishu).toEqual(['ou_other', 'ou_alice'])
})
it('forwards a managed repository panel request with its own credential and keeps that credential in the manager', async () => {
  const seen: { method: string; url: string; auth: string; body: string }[] = []
  const upstream = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method ?? 'GET', url: req.url ?? '', auth: req.headers.authorization ?? '', body })
    response(res, { ok: true, method: req.method, body: body ? JSON.parse(body) as unknown : null })
  })
  const port = await listen(upstream)
  const proxy = { ...ManagerStore.identity(), port, name: 'Proxy', remote: 'acme/proxy', directory: '/repo/proxy', githubCli: '/bin/false',
    allowedGithub: [], allowedFeishu: [], enabled: true }
  manager.store.save([...manager.store.repositories(), proxy], manager.store.bindings(), manager.store.revision())
  try {
    const get = await request(`manager/repositories/${proxy.id}/api/state?scope=1`)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ ok: true, method: 'GET', body: null })
    expect(seen.find(item => item.url === '/orchestrator/instance/state?scope=1')).toMatchObject({ method: 'GET',
      auth: `Bearer ${proxy.token}` })
    const body = { revision: 2, value: { sources: {} } }
    const put = await request(`manager/repositories/${proxy.id}/api/settings/policy`, body, 'PUT')
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ ok: true, method: 'PUT', body })
    expect(seen.find(item => item.url === '/orchestrator/instance/settings/policy')).toMatchObject({ method: 'PUT',
      auth: `Bearer ${proxy.token}`, body: JSON.stringify(body) })
    // Traversal, an unknown repository and an unsupported method never reach an instance.
    expect((await request(`manager/repositories/${proxy.id}/api/..%2f..%2fetc/passwd`)).status).toBe(400)
    expect((await request('manager/repositories/not-a-repository/api/state')).status).toBe(404)
    expect((await request(`manager/repositories/${proxy.id}/api/state`, undefined, 'DELETE')).status).toBe(405)
    // An offline instance answers with its own reason instead of exposing or reusing the token elsewhere.
    await close(upstream)
    expect((await request(`manager/repositories/${proxy.id}/api/state`)).status).toBe(502)
  } finally { if (upstream.listening) await close(upstream) }
})
it('delivers a persisted event only to its authenticated instance and acknowledges duplicate ingress', async () => {
  const fake = fakeOf(repository.id)
  const trigger = feishu('1', 'request')
  expect(manager.store.route(trigger)).toBe('stored')
  await vi.waitFor(() => { expect(arrived(fake)).toEqual(['om_1']) }, { timeout: 7000 })
  await vi.waitFor(() => { expect(manager.store.pending()).toEqual([]) })
  const duplicate = await request(`internal/${repository.id}/receive`, trigger, 'POST', { authorization: `Bearer ${repository.token}` })
  expect(await duplicate.json()).toEqual({ result: 'duplicate' })
  expect(arrived(fake)).toHaveLength(1)
})
it('keeps failed deliveries queued for the original repository', async () => {
  const fake = fakeOf(repository.id); fake.failing.add('om_1')
  manager.store.route(feishu('1', 'request'))
  await vi.waitFor(() => { expect(manager.store.outstanding()[0]?.attempts).toBeGreaterThan(0) }, { timeout: 7000 })
  expect(manager.store.outstanding()[0]).toMatchObject({ repositoryId: repository.id, error: 'offline' })
  fake.failing.clear()
  await vi.waitFor(() => { expect(arrived(fake)).toEqual(['om_1']) }, { timeout: 7000 })
})
it('keeps same-topic order while another topic retries in parallel', async () => {
  const fake = fakeOf(repository.id)
  const head = feishu('1', 'first'), follow = feishu('2', 'second', { root_id: 'om_1', mentions: [] }), other = feishu('3', 'other topic')
  fake.failing.add('om_1')
  for (const trigger of [head, follow, other]) expect(manager.store.route(trigger)).toBe('stored')
  // The retrying topic head blocks only its own follow-up; the other topic is delivered meanwhile.
  await vi.waitFor(() => { expect(arrived(fake)).toEqual(['om_3']) }, { timeout: 7000 })
  expect(manager.store.outstanding().find(item => item.id === follow.id)).toMatchObject({ attempts: 0 })
  fake.failing.clear()
  await vi.waitFor(() => { expect(arrived(fake)).toEqual(['om_3', 'om_1', 'om_2']) }, { timeout: 10000 })
})
it('isolates concurrent ingress from 120 identities across 5 teams and 12 repositories over real HTTP', async () => {
  // Control-plane regression: real sockets and journal, simulated identities and downstream executors.
  const instances = [fakeOf(repository.id), ...await Promise.all(Array.from({ length: 11 }, () => fakeInstance()))]
  const repositories = instances.map((fake, index) => ({
    ...(index === 0 ? repository : repositoryFor(fake, `Product${index + 1}`, `acme/product${index + 1}`)),
    teamName: `Team ${(index % 5) + 1}`, productLines: [`Product ${index + 1}`],
    allowedFeishu: Array.from({ length: 10 }, (_, member) => `ou_product${index + 1}member${member + 1}`),
  }))
  const bindings = repositories.map((repo, index) => ({
    chatId: `oc_product${index + 1}`, repositoryId: repo.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z',
  }))
  manager.store.save(repositories, bindings, manager.store.revision())
  await manager.stop()
  manager = new Manager(ctx, testMachine({ stateDir: directory }), { maxRunningRepositories: 12 })
  await manager.start()
  expect(new Set(manager.store.repositories().map(repo => repo.teamName)).size).toBe(5)
  const cases = repositories.flatMap((repo, index) => repo.allowedFeishu.map((sender, member) => ({
    repo, trigger: feishu(`scale${index * 10 + member + 1}`, `Product ${index + 1} request ${member + 1}`, {
      chat_id: bindings[index]!.chatId, sender_id: sender,
    }),
  })))
  expect(new Set(cases.map(item => item.trigger.actor.id)).size).toBe(120)

  // A valid credential for a neighboring repository grants no access to this repository's bridge.
  // A repository's own credential also cannot inject a message for another repository's bound group.
  await Promise.all(repositories.map(async (repo, index) => {
    const neighbor = repositories[(index + 1) % repositories.length]!
    const trigger = feishu(`denied${index + 1}`, 'must never reach an executor', { chat_id: bindings[index]!.chatId })
    const unauthorized = await request(`internal/${repo.id}/receive`, trigger, 'POST', { authorization: `Bearer ${neighbor.token}` })
    expect(unauthorized.status).toBe(403)
    expect(await unauthorized.json()).toEqual({ error: 'Repository authorization required' })
    const wrongRoute = await request(`internal/${neighbor.id}/receive`, trigger, 'POST', { authorization: `Bearer ${neighbor.token}` })
    expect(wrongRoute.status).toBe(400)
    expect(await wrongRoute.json()).toEqual({ error: 'Message belongs to another repository' })
  }))
  expect((await view()).queues.total).toBe(0)
  expect(instances.flatMap(fake => fake.requests)).toEqual([])

  // Race two copies of every event: one durable insert and one duplicate acknowledgement per identity.
  await Promise.all(cases.map(async ({ repo, trigger }) => {
    const results = await Promise.all([0, 1].map(async () => {
      const result = await request(`internal/${repo.id}/receive`, trigger, 'POST', { authorization: `Bearer ${repo.token}` })
      expect(result.status).toBe(200)
      return await result.json() as { result: string }
    }))
    expect(results.map(result => result.result).sort()).toEqual(['duplicate', 'stored'])
  }))

  await vi.waitFor(async () => {
    const state = await view()
    expect(state.repositories).toHaveLength(12)
    expect(state.queues).toEqual({ total: 0, byRepository: Object.fromEntries(repositories.map(repo => [repo.id, 0])), byChat: {}, byBinding: [] })
    expect(state.pending).toEqual([])
    expect(state.repositories.every(repo => repo.status.online && repo.pending.total === 0)).toBe(true)
    for (const [index, fake] of instances.entries()) {
      const repo = repositories[index]!
      const expected = cases.filter(item => item.repo.id === repo.id)
      const deliveries = fake.received.map(item => ({ repositoryId: item.repositoryId, triggerId: item.trigger.id,
        messageId: item.trigger.meta.messageId, chatId: item.trigger.meta.chatId, actorId: item.trigger.actor.id }))
      expect(deliveries).toHaveLength(10)
      expect(deliveries).toEqual(expect.arrayContaining(expected.map(({ trigger }) => ({ repositoryId: repo.id,
        triggerId: trigger.id, messageId: trigger.meta.messageId, chatId: trigger.meta.chatId, actorId: trigger.actor.id }))))
      // Assert HTTP delivery attempts too: downstream deduplication must not hide double dispatch.
      expect(fake.requests).toHaveLength(10)
      expect(fake.requests.every(item => item.result === 'stored')).toBe(true)
    }
  }, { timeout: 15000, interval: 100 })
  expect(manager.store.pending()).toEqual([])
  expect(manager.store.outstanding()).toEqual([])
}, 30000)
it('keeps two groups on two repositories on their own routes without cross delivery', async () => {
  const first = fakeOf(repository.id), second = await fakeInstance()
  const other = repositoryFor(second, 'Other', 'acme/other')
  manager.store.save([repository, other], [...manager.store.bindings(),
    { chatId: 'oc_second', repositoryId: other.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }], manager.store.revision())
  const triggers = [feishu('1', 'a1'), feishu('2', 'a2', { root_id: 'om_1', mentions: [] }),
    feishu('3', 'b1', { chat_id: 'oc_second' }), feishu('4', 'b2', { chat_id: 'oc_second', root_id: 'om_3', mentions: [] })]
  for (const trigger of triggers) expect(manager.store.route(trigger)).toBe('stored')
  await vi.waitFor(() => { expect(arrived(first)).toEqual(['om_1', 'om_2']); expect(arrived(second)).toEqual(['om_3', 'om_4']) }, { timeout: 10000 })
  expect(first.received.every(item => item.repositoryId === repository.id)).toBe(true)
  expect(second.received.every(item => item.repositoryId === other.id)).toBe(true)
})
it('pauses a disabled group while another group continues and revalidates before resuming', async () => {
  const fake = fakeOf(repository.id)
  manager.store.save([repository], [...manager.store.bindings(),
    { chatId: 'oc_second', repositoryId: repository.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }], manager.store.revision())
  const paused = feishu('1', 'paused group'), active = feishu('2', 'active group', { chat_id: 'oc_second' })
  manager.store.route(paused); manager.store.route(active)
  manager.store.save([repository], manager.store.bindings().map(binding => binding.chatId === 'oc_team' ? { ...binding, enabled: false } : binding), manager.store.revision())
  await vi.waitFor(() => { expect(arrived(fake)).toEqual(['om_2']) }, { timeout: 7000 })
  // A paused group keeps its message and never counts a failure; the reason is visible to the operator.
  expect(manager.store.outstanding().find(item => item.id === paused.id)).toMatchObject({ repositoryId: repository.id, hold: 'group-disabled', attempts: 0 })
  manager.store.save([repository], manager.store.bindings().map(binding => ({ ...binding, enabled: true })), manager.store.revision())
  await vi.waitFor(() => { expect(arrived(fake).sort()).toEqual(['om_1', 'om_2']) }, { timeout: 7000 })
  expect(fake.received.every(item => item.repositoryId === repository.id)).toBe(true)
})
it('keeps messages while their repository is disabled and resumes to the original repository', async () => {
  const fake = fakeOf(repository.id)
  manager.store.route(feishu('1', 'request'))
  manager.store.save([{ ...repository, enabled: false }], manager.store.bindings(), manager.store.revision())
  await new Promise(resolve => setTimeout(resolve, 2500))
  expect(arrived(fake)).toEqual([])
  expect(manager.store.outstanding()[0]).toMatchObject({ repositoryId: repository.id, hold: 'repository-disabled', attempts: 0 })
  manager.store.save([repository], manager.store.bindings(), manager.store.revision())
  await vi.waitFor(() => { expect(arrived(fake)).toEqual(['om_1']) }, { timeout: 7000 })
  expect(fake.received[0]!.repositoryId).toBe(repository.id)
})
it('rediscovers a surviving instance after a manager restart and keeps the original target while offline', async () => {
  const fake = fakeOf(repository.id)
  await vi.waitFor(async () => { expect((await view()).repositories[0]?.status.online).toBe(true) }, { timeout: 7000 })
  await manager.stop()
  await close(fake.server)
  await restartManager()
  const stopped = (await view()).repositories
  expect(stopped).toHaveLength(1); expect(stopped[0]!.id).toBe(repository.id); expect(stopped[0]!.status.online).toBe(false)
  manager.store.route(feishu('1', 'offline request'))
  await new Promise(resolve => setTimeout(resolve, 2500))
  // Nothing is delivered or marked failed while the original repository is offline.
  expect(arrived(fake)).toEqual([])
  expect(manager.store.outstanding()[0]).toMatchObject({ repositoryId: repository.id, attempts: 0 })
  fake.server = createServer((req, res) => { void fake.handler(req, res) }); await listen(fake.server, fake.port)
  await vi.waitFor(() => { expect(arrived(fake)).toEqual(['om_1']) }, { timeout: 10000 })
  expect(fake.received[0]!.repositoryId).toBe(repository.id)
  expect(manager.store.pending()).toEqual([])
  await vi.waitFor(async () => { expect((await view()).repositories[0]?.status.online).toBe(true) }, { timeout: 7000 })
})
it('reports every readiness dimension with a repair entry and the delivery backlog', async () => {
  const fake = fakeOf(repository.id)
  await vi.waitFor(async () => { expect((await view()).repositories[0]?.status.online).toBe(true) }, { timeout: 7000 })
  const ready = (await view()).repositories[0]!
  expect(ready.readiness.instance!.state).toBe('ok')
  expect(ready.readiness.repository!.state).toBe('ok')
  // The agent dimension comes from the instance's real probe, not from a guess.
  expect(ready.readiness.agent).toMatchObject({ state: 'ok' })
  expect(ready.readiness.feishu!.state).toBe('ok')
  expect(ready.readiness.delivery!.state).toBe('ok')
  fake.failing.add('om_1'); manager.store.route(feishu('1', 'request'))
  await vi.waitFor(async () => {
    const state = await view()
    expect(state.queues.total).toBe(1); expect(state.queues.byRepository[repository.id]).toBe(1)
    expect(state.repositories[0]!.readiness.delivery).toMatchObject({ state: 'pending', pending: 1, byChat: { oc_team: 1 } })
  }, { timeout: 10000 })
  await close(fake.server)
  await vi.waitFor(async () => {
    const state = (await view()).repositories[0]!
    expect(state.readiness.instance!.state).toBe('pending'); expect(state.readiness.repository!.state).toBe('pending')
    expect(state.readiness.instance!.repair).toBe('repository')
  }, { timeout: 7000 })
  manager.store.save([repository], manager.store.bindings().map(binding => ({ ...binding, enabled: false })), manager.store.revision())
  expect((await view()).repositories[0]!.readiness.feishu).toMatchObject({ state: 'pending', repair: 'feishu' })
})
it('refuses arbitrary shared-bot commands and enforces group disable on pending replies', async () => {
  manager.store.route(feishu('1', 'request'))
  const call = (args: string[]) => request(`internal/${repository.id}/lark`, { args }, 'POST', { authorization: `Bearer ${repository.token}` })
  expect((await call(['api', 'POST', '/open-apis/im/v1/messages'])).status).toBe(400)
  expect((await call(['im', '+messages-reply', '--message-id', 'om_unknown', '--markdown', 'hello', '--idempotency-key', 'r'])).status).toBe(400)
  const args = ['im', '+messages-reply', '--message-id', 'om_1', '--markdown', 'hello', '--reply-in-thread', '--idempotency-key', 'reply-1']
  expect((await call(args)).status).toBe(200)
  expect((await call(args)).status).toBe(200)
  expect(manager.store.db.prepare('SELECT COUNT(*) AS count FROM replies WHERE sent=1').get()?.count).toBe(1)
  manager.store.save([repository], manager.store.bindings().map(binding => ({ ...binding, enabled: false })), manager.store.revision())
  expect((await call([...args.slice(0, -1), 'reply-2'])).status).toBe(400)
})
