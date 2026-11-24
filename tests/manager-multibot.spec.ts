/** In-process HTTP regression for bot identity, group routing, and scoped transport without external services. */
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Manager } from '../src/manager/runtime.ts'
import { ManagerStore, type BotConnection, type Repository } from '../src/manager/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { scopeManagedFeishuTrigger } from '../src/sources/feishu-trigger.ts'
import { testMachine } from './fixtures/deployment.ts'
import { feishu } from './fixtures/host.ts'
import type { SourceContext } from '../src/sources/host.ts'

const state = vi.hoisted(() => ({ contexts: new Map<string, SourceContext>(), stopped: [] as string[], broken: new Set<string>(), identities: new Map<string, string>(), waiting: undefined as Promise<void> | undefined }))
vi.mock('../src/deployment.ts', async original => ({ ...await original<typeof import('../src/deployment.ts')>(),
  resolveFeishuBot: vi.fn(async (_machine, config: { cli: string; profile?: string }) => {
    await state.waiting
    if (state.broken.has(config.cli)) throw new Error('Bot verification failed')
    const suffix = state.identities.get(`${config.cli}:${config.profile ?? ''}`) ?? config.profile ?? basename(config.cli).replace('bot-', '')
    return { cli: isAbsolute(config.cli) ? config.cli : join(directory, config.cli), ...(config.profile ? { profile: config.profile } : {}), botId: `ou_bot${suffix}`, appId: `cli_${suffix}`, name: `Bot ${suffix}`, brand: 'feishu' }
  }),
}))
vi.mock('../src/manager/instances.ts', async original => ({ ...await original<typeof import('../src/manager/instances.ts')>(),
  instanceHealth: vi.fn(async () => ({ pid: process.pid, configured: true, state: 'ready' })),
  instanceRequest: vi.fn(async (_repository, path: string) => path === 'settings'
    ? { blocks: { policy: { revision: 1, value: { sources: { github: { allowed: [] }, feishu: { allowed: [] } } } } },
      sources: [{ id: 'feishu', revision: 1, value: { enabled: true, config: { cli: '', chats: [] } } }] }
    : path.startsWith('tickets') ? { items: [] } : {}),
}))
vi.mock('../src/sources/feishu-loops.ts', async original => ({ ...await original<typeof import('../src/sources/feishu-loops.ts')>(),
  runFeishu: vi.fn((ctx: SourceContext, signal: AbortSignal) => {
    const id = ctx.deployment.feishu!.botId
    state.contexts.set(id, ctx)
    ctx.report('feishu', { state: 'ready', detail: 'fixture consumer connected' })
    return new Promise<void>(resolve => signal.addEventListener('abort', () => { state.stopped.push(id); resolve() }, { once: true }))
  }),
}))

let directory: string, manager: Manager, ctx: Context
let handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
let calls: { bot: string; args: string[] }[]
const repo = (name: string, port: number): Repository => ({ ...ManagerStore.identity(), name, port, remote: `acme/${name}`,
  directory: `/repo/${name}`, githubCli: 'gh', enabled: true, allowedGithub: [], allowedFeishu: [] })
const call = async (path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST', repository?: Repository) => {
  const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]) as IncomingMessage
  Object.assign(req, { url: `/orchestrator/${path}`, method, headers: {
    host: '127.0.0.1:3081', 'x-orchestrator-request': '1', ...(repository ? { authorization: `Bearer ${repository.token}` } : {}),
  } })
  let status = 0, output = ''
  const res = { writeHead: (code: number) => { status = code }, end: (text: string) => { output = text } } as unknown as ServerResponse
  await handle(req, res)
  return { status, data: JSON.parse(output) as Record<string, any> }
}
const add = async (cli: string, profile?: string) => {
  const result = await call('manager/bots', { cli, ...(profile ? { profile } : {}), revision: manager.store.revision() })
  expect(result.status).toBe(200)
  return manager.store.bots().find(bot => bot.cli === cli && bot.profile === profile)!
}
const refresh = async (bot: BotConnection) => expect((await call(`manager/bots/${bot.id}/chats/refresh`, {})).status).toBe(200)
const bind = async (bindings: { botId: string; chatId: string; repositoryId: string; enabled: boolean }[], grant?: unknown) =>
  call('manager/bindings', { revision: manager.store.revision(), bindings, ...(grant ? { grant } : {}) }, 'PUT')
const ingress = async (repository: Repository, bot: BotConnection, id: string, chatId = 'oc_team', user = 'ou_alice') => {
  const trigger = feishu(id, 'request', { chat_id: chatId, sender_id: user })
  trigger.at = new Date(Date.now() + 1000).toISOString()
  return call(`internal/${repository.id}/receive`, scopeManagedFeishuTrigger(trigger, bot.id, { legacy: !!bot.legacy }), 'POST', repository)
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'manager-bots-'))
  calls = []; state.contexts.clear(); state.stopped.length = 0; state.broken.clear(); state.identities.clear(); state.waiting = undefined
  for (const name of ['bot-a', 'bot-b', 'bot-c', 'bot-shared']) { const path = join(directory, name); writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, 0o755) }
  vi.spyOn(Commands.prototype, 'lark').mockImplementation(async function (this: Commands, args: string[]) {
    const bot = this.deployment.feishu!.botId
    calls.push({ bot, args })
    if (args[1] === '+chat-list') return { chats: [{ chat_id: 'oc_team', name: `Team ${bot}` }, { chat_id: 'oc_second', name: 'Second' }] }
    if (args[1] === '+chat-members-list') return { users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false }
    return {}
  })
  ctx = { workspaceRegistry: { list: () => [] }, webServer: { host: '127.0.0.1', port: 3081,
    register: (input: { handler: typeof handle }) => { handle = input.handler; return () => {} } } } as unknown as Context
  manager = new Manager(ctx, testMachine({ stateDir: directory }))
  await manager.start()
})
afterEach(async () => { await manager?.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

it('connects multiple verified identities and rejects duplicate, stale or changed identities', async () => {
  const a = await add('bot-a'), revision = manager.store.revision()
  expect((await call('manager/bots', { cli: 'bot-a', revision })).status).toBe(400)
  expect((await call('manager/bots', { cli: 'bot-b', revision: revision - 1 })).status).toBe(400)
  expect(manager.store.bots()).toHaveLength(1)
  const before = manager.store.revision()
  expect((await call(`manager/bots/${a.id}`, { cli: 'bot-b', revision: before }, 'PUT')).status).toBe(400)
  expect(manager.store.bots()[0]!.botId).toBe('ou_bota')
  const b = await add('bot-b')
  const result = await call('manager/state')
  expect(result.data.bots).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, connected: true }), expect.objectContaining({ id: b.id, connected: true })]))
  expect((await call('manager/chats/refresh', {})).status).toBe(400)
  expect((await call('manager/bot', { cli: 'bot-c' }, 'PUT')).status).toBe(400)
})
it('keeps one bot on several groups and scopes member grants to the selected bot', async () => {
  const a = await add('bot-a'), b = await add('bot-b'), first = repo('first', 3101)
  manager.store.save([first], [], manager.store.revision())
  await refresh(a); await refresh(b)
  const bindings = [{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true },
    { botId: a.id, chatId: 'oc_second', repositoryId: first.id, enabled: true },
    { botId: b.id, chatId: 'oc_team', repositoryId: first.id, enabled: true }]
  expect((await bind(bindings, { botId: a.id, chatId: 'oc_team', repositoryId: first.id, memberIds: ['ou_alice'] })).status).toBe(200)
  expect(manager.store.repositories()[0]!.allowedFeishu).toEqual([])
  expect(manager.store.repositories()[0]!.allowedFeishuByBot).toEqual({ [a.id]: ['ou_alice'] })
  expect((await ingress(first, a, 'one')).data.result).toBe('stored')
  expect((await ingress(first, a, 'two', 'oc_second')).data.result).toBe('stored')
  expect((await ingress(first, b, 'three')).data.result).toBe('filtered')
  expect((await ingress(first, a, 'four', 'oc_team', 'ou_intruder')).data.result).toBe('filtered')
  expect(manager.store.pending()).toHaveLength(2)
})
it('routes the same chat and source message independently for different bots and repositories', async () => {
  const a = await add('bot-a'), b = await add('bot-b'), first = repo('first', 3101), second = repo('second', 3102)
  first.allowedFeishuByBot = { [a.id]: ['ou_alice'] }; second.allowedFeishuByBot = { [b.id]: ['ou_alice'] }
  manager.store.save([first, second], [], manager.store.revision())
  await refresh(a); await refresh(b)
  expect((await bind([{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true },
    { botId: b.id, chatId: 'oc_team', repositoryId: second.id, enabled: true }])).status).toBe(200)
  expect((await ingress(first, a, 'same')).data.result).toBe('stored')
  expect((await ingress(second, b, 'same')).data.result).toBe('stored')
  expect((await ingress(second, a, 'wrong')).status).toBe(400)
  expect(manager.store.pending().map(item => item.botId).sort()).toEqual([a.id, b.id].sort())
  expect(new Set(manager.store.pending().map(item => item.trigger.id)).size).toBe(2)
  expect(new Set(manager.store.pending().map(item => item.thread)).size).toBe(2)
  const listed = await call(`internal/${first.id}/feishu-bots`, undefined, 'GET', first)
  expect(listed.data.bots.map((bot: { id: string }) => bot.id)).toEqual([a.id])
  expect(JSON.stringify(listed.data)).not.toContain('bot-a')
})
it('uses each originating bot for replies and rejects an ambiguous or foreign bot', async () => {
  const a = await add('bot-a'), b = await add('bot-b'), c = await add('bot-c'), first = repo('first', 3101)
  first.allowedFeishuByBot = { [a.id]: ['ou_alice'], [b.id]: ['ou_alice'] }
  manager.store.save([first], [], manager.store.revision())
  await refresh(a); await refresh(b)
  expect((await bind([{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true },
    { botId: b.id, chatId: 'oc_team', repositoryId: first.id, enabled: true }])).status).toBe(200)
  await ingress(first, a, 'same'); await ingress(first, b, 'same')
  calls.length = 0
  const args = ['im', '+messages-reply', '--message-id', 'om_same', '--markdown', 'done', '--reply-in-thread', '--idempotency-key', 'same-reply']
  const reply = (botId?: string) => call(`internal/${first.id}/lark`, { args, ...(botId ? { botId } : {}) }, 'POST', first)
  expect((await reply()).status).toBe(400)
  expect((await reply(c.id)).status).toBe(400)
  expect((await reply(a.id)).status).toBe(200)
  expect((await reply(b.id)).status).toBe(200)
  expect((await reply(a.id)).status).toBe(200)
  expect(calls.map(call => call.bot)).toEqual(['ou_bota', 'ou_botb'])
  expect(calls[0]!.args.at(-1)).not.toBe(calls[1]!.args.at(-1))
  expect(manager.store.db.prepare('SELECT COUNT(*) AS count FROM replies WHERE sent=1').get()?.count).toBe(2)
})
it('disables one bot without restarting the other and keeps its queue on hold', async () => {
  const a = await add('bot-a'), b = await add('bot-b'), first = repo('first', 3101)
  first.allowedFeishuByBot = { [a.id]: ['ou_alice'], [b.id]: ['ou_alice'] }
  manager.store.save([first], [], manager.store.revision()); await refresh(a); await refresh(b)
  await bind([{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true }, { botId: b.id, chatId: 'oc_second', repositoryId: first.id, enabled: true }])
  await ingress(first, a, 'held'); await ingress(first, b, 'active', 'oc_second')
  state.stopped.length = 0
  expect((await call(`manager/bots/${a.id}`, { enabled: false, revision: manager.store.revision() }, 'PUT')).status).toBe(200)
  expect(state.stopped).toEqual(['ou_bota'])
  expect(manager.store.outstanding().find(item => item.botId === a.id)?.hold).toBe('bot-disabled')
  expect(manager.store.pending().map(item => item.botId)).toEqual([b.id])
  expect((await call(`manager/bots/${a.id}`, { revision: manager.store.revision() }, 'DELETE')).status).toBe(400)
  expect((await call(`manager/bots/${a.id}`, { enabled: true, revision: manager.store.revision() }, 'PUT')).status).toBe(200)
  expect(manager.store.pending()).toHaveLength(2)
})
it('keeps a failed bot identity separate from healthy connections', async () => {
  const a = await add('bot-a'), b = await add('bot-b'), first = repo('first', 3101)
  first.allowedFeishuByBot = { [a.id]: ['ou_alice'], [b.id]: ['ou_alice'] }
  manager.store.save([first], [], manager.store.revision()); await refresh(a); await refresh(b)
  state.broken.add('bot-a')
  await bind([{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true }, { botId: b.id, chatId: 'oc_second', repositoryId: first.id, enabled: true }])
  const result = await call('manager/state')
  expect(result.data.bots.find((bot: { id: string }) => bot.id === a.id)).toMatchObject({ connected: false, health: { feishu: { state: 'error' } } })
  expect(result.data.bots.find((bot: { id: string }) => bot.id === b.id)).toMatchObject({ connected: true })
  expect(result.data.repositories[0].readiness.feishu.state).toBe('pending')
})

it('supports one CLI with independent named profiles and rejects canonical path aliases for the same profile', async () => {
  const executable = join(directory, 'bot-shared')
  const a = await add(executable, 'a'), b = await add(executable, 'b')
  expect(a.profile).toBe('a'); expect(b.profile).toBe('b')
  expect(a.botId).toBe('ou_bota'); expect(b.botId).toBe('ou_botb')
  const alias = join(directory, 'bot-alias'); symlinkSync(executable, alias)
  state.identities.set(`${alias}:a`, 'c')
  const denied = await call('manager/bots', { cli: alias, profile: 'a', revision: manager.store.revision() })
  expect(denied.status).toBe(400)
  expect(denied.data.error).toContain('CLI and profile')
  expect(manager.store.bots()).toHaveLength(2)
})
it('rechecks CLI identity before sends, reads and group discovery after an external account switch', async () => {
  const a = await add('bot-a'), first = repo('first', 3101)
  first.allowedFeishuByBot = { [a.id]: ['ou_alice'] }
  manager.store.save([first], [], manager.store.revision()); await refresh(a)
  await bind([{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true }])
  await ingress(first, a, 'source')
  calls.length = 0
  state.identities.set('bot-a:', 'other')
  const args = ['im', '+messages-reply', '--message-id', 'om_source', '--markdown', 'must not send', '--idempotency-key', 'r']
  expect((await call(`internal/${first.id}/lark`, { args, botId: a.id }, 'POST', first)).status).toBe(400)
  expect(calls).toEqual([])
  expect((await call('manager/state')).data.bots[0]).toMatchObject({ connected: false, health: { feishu: { state: 'error' } } })
  expect((await call(`manager/bots/${a.id}/chats/refresh`, {})).status).toBe(400)
  // A second connection detects the same change on a read before invoking the CLI.
  const b = await add('bot-b')
  const current = manager.store.repositories()[0]!
  manager.store.save([{ ...current, allowedFeishuByBot: { ...current.allowedFeishuByBot, [b.id]: ['ou_alice'] } }], manager.store.bindings(), manager.store.revision())
  await refresh(b)
  await bind([...manager.store.bindings().map(({ effectiveAt, ...binding }) => ({ ...binding, botId: binding.botId! })),
    { botId: b.id, chatId: 'oc_second', repositoryId: first.id, enabled: true }])
  await ingress(first, b, 'read', 'oc_second')
  calls.length = 0; state.identities.set('bot-b:', 'different')
  expect((await call(`internal/${first.id}/lark`, { args: ['im', '+messages-mget', '--message-ids', 'om_read'], botId: b.id }, 'POST', first)).status).toBe(400)
  expect(calls).toEqual([])
})
it('preserves an unavailable legacy connection and migrates its original queue only after verified recovery', async () => {
  const first = { ...repo('first', 3101), allowedFeishu: ['ou_alice'] }
  manager.store.save([first], [{ chatId: 'oc_team', repositoryId: first.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }], manager.store.revision())
  const original = feishu('legacy', 'retained original task')
  expect(manager.store.route(original)).toBe('stored')
  manager.store.set('bot-cli', 'bot-a'); manager.store.set('bot-id', 'ou_bota')
  await manager.stop(); state.broken.add('bot-a')
  manager = new Manager(ctx, testMachine({ stateDir: directory })); await manager.start()
  expect(manager.store.bots()).toEqual([])
  expect(manager.store.outstanding()[0]).toMatchObject({ id: original.id, hold: 'bot-missing' })
  expect((await call('manager/state')).data.legacyConnection).toMatchObject({ cli: 'bot-a' })
  expect((await call('manager/bots', { cli: 'bot-b', revision: manager.store.revision() })).status).toBe(400)
  state.broken.delete('bot-a')
  expect((await call('manager/bot', { cli: 'bot-a', revision: manager.store.revision() }, 'PUT')).status).toBe(200)
  const legacy = manager.store.bots()[0]!
  expect(legacy.legacy).toBe(true)
  expect(manager.store.pending()[0]).toMatchObject({ id: original.id, botId: legacy.id })
  expect(manager.store.pending()[0]!.trigger.threads).toEqual(original.threads)
  expect((await call('manager/state')).data.legacyConnection).toBeUndefined()
  expect((await ingress(first, legacy, 'legacy')).data.result).toBe('duplicate')
})
it('serializes overlapping group changes so each bot keeps exactly one live consumer', async () => {
  const a = await add('bot-a'), first = repo('first', 3101)
  first.allowedFeishuByBot = { [a.id]: ['ou_alice'] }
  manager.store.save([first], [], manager.store.revision()); await refresh(a)
  let release!: () => void
  state.waiting = new Promise<void>(resolve => { release = resolve })
  const one = bind([{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true }])
  await vi.waitFor(() => expect(manager.store.bindings()).toHaveLength(1))
  const two = bind([{ botId: a.id, chatId: 'oc_team', repositoryId: first.id, enabled: true },
    { botId: a.id, chatId: 'oc_second', repositoryId: first.id, enabled: true }])
  await vi.waitFor(() => expect(manager.store.bindings()).toHaveLength(2))
  release(); state.waiting = undefined
  expect((await one).status).toBe(200); expect((await two).status).toBe(200)
  expect(state.contexts.size).toBe(1)
  expect(state.stopped).toEqual([])
  await manager.stop()
  expect(state.stopped).toEqual(['ou_bota'])
})
