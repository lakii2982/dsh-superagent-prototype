/** Transport-level routing and recovery across repository boundaries. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ManagerStore, type BotConnection, type Repository } from '../src/manager/store.ts'
import { authorized, bridgeOptions, managerUrl } from '../src/manager/protocol.ts'
import { feishu } from './fixtures/host.ts'

let directory: string, store: ManagerStore, a: Repository, b: Repository
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'manager-')); store = new ManagerStore(directory)
  a = { ...ManagerStore.identity(), name: 'A', remote: 'acme/a', directory: '/repo/a', githubCli: 'gh-agent', allowedGithub: [], allowedFeishu: ['ou_alice'], enabled: true, port: 3101 }
  b = { ...ManagerStore.identity(), name: 'B', remote: 'acme/b', directory: '/repo/b', githubCli: 'gh-agent', allowedGithub: [], allowedFeishu: ['ou_alice'], enabled: true, port: 3102 }
  store.save([a, b], [{ chatId: 'oc_team', repositoryId: a.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z' },
    { chatId: 'oc_second', repositoryId: b.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }], 0)
})
afterEach(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers() })
it('routes each group to its repository and persists an unacknowledged delivery across restart', () => {
  const first = feishu('1', 'A request'), second = feishu('2', 'B request', { chat_id: 'oc_second' })
  expect(store.route(first)).toBe('stored'); expect(store.route(second)).toBe('stored'); expect(store.route(first)).toBe('duplicate')
  store.close(); store = new ManagerStore(directory)
  expect(store.pending().map(item => item.repositoryId)).toEqual([a.id, b.id])
  expect(store.pending()[0]!.trigger.meta.managerBindingRevision).toBe(1)
  store.delivered(first.id)
  expect(store.pending().map(item => item.repositoryId)).toEqual([b.id])
})
it('pins an old topic across group rebinding, while new topics use the new repository', () => {
  const root = feishu('1', 'start'); store.route(root); store.delivered(root.id)
  store.save([a, b], store.bindings().map(binding => binding.chatId === 'oc_team' ? { ...binding, repositoryId: b.id } : binding), store.revision())
  const followup = feishu('2', 'continue', { root_id: 'om_1', mentions: [] })
  expect(store.route(followup)).toBe('stored')
  expect(store.pending()[0]!.repositoryId).toBe(a.id)
  store.delivered(followup.id); store.route(feishu('3', 'new request'))
  expect(store.pending()[0]!.repositoryId).toBe(b.id)
})
it('does not admit unbound groups, private chats, unmentioned new topics or pre-activation history', () => {
  expect(store.route(feishu('1', 'not mentioned', { mentions: [] }))).toBe('filtered')
  expect(store.route(feishu('2', 'unbound', { chat_id: 'oc_unknown' }))).toBe('filtered')
  expect(store.route(feishu('3', 'private', { chat_type: 'p2p' }))).toBe('filtered')
  store.save([a, b], store.bindings().map(binding => ({ ...binding, effectiveAt: '2027-01-01T00:00:00Z' })), store.revision())
  expect(store.route(feishu('4', 'old history'))).toBe('filtered')
  expect(store.pending()).toEqual([])
})
it('orders delivery per topic so a retried topic never blocks another topic or group', () => {
  const head = feishu('1', 'first'), follow = feishu('2', 'second', { root_id: 'om_1', mentions: [] }), other = feishu('3', 'other', { chat_id: 'oc_second' })
  for (const trigger of [head, follow, other]) expect(store.route(trigger)).toBe('stored')
  // Only the oldest message of each topic is deliverable; the follow-up waits for its own topic head.
  expect(store.pending().map(item => item.id)).toEqual([head.id, other.id])
  store.failed(head.id, 'repository offline')
  expect(store.pending().map(item => item.id)).toEqual([other.id])
  expect(store.pending(100, false).map(item => item.id)).toEqual([head.id, other.id])
  store.delivered(head.id)
  // The same-topic follow-up becomes the head once its predecessor is delivered, without waiting for other groups.
  expect(store.pending().map(item => item.id)).toEqual([follow.id, other.id])
})
it('pauses a disabled group without counting failures and explains why queued messages wait', () => {
  const first = feishu('1', 'first'), other = feishu('2', 'other', { chat_id: 'oc_second' })
  store.route(first); store.route(other)
  store.save([a, b], store.bindings().map(binding => ({ ...binding, enabled: binding.chatId !== 'oc_team' })), store.revision())
  expect(store.route(feishu('3', 'disabled group'))).toBe('filtered')
  expect(store.pending().map(item => item.id)).toEqual([other.id])
  expect(store.outstanding()).toEqual([expect.objectContaining({ id: first.id, repositoryId: a.id, hold: 'group-disabled', attempts: 0 }), expect.objectContaining({ id: other.id })])
  store.save([{ ...a, enabled: false }, b], store.bindings().map(binding => ({ ...binding, enabled: true })), store.revision())
  expect(store.pending().map(item => item.id)).toEqual([other.id])
  expect(store.outstanding()[0]).toMatchObject({ id: first.id, repositoryId: a.id, hold: 'repository-disabled', attempts: 0 })
})
it('revalidates the group, topic owner and original repository when a paused group resumes', () => {
  const root = feishu('1', 'start'); store.route(root)
  store.save([a, b], store.bindings().map(binding => ({ ...binding, enabled: false })), store.revision())
  store.save([a, b], store.bindings().map(binding => ({ ...binding, enabled: true })), store.revision())
  expect(store.pending().map(item => item.id)).toEqual([root.id])
  // A topic that now points at another repository is withheld instead of being delivered to the wrong one.
  store.db.prepare('UPDATE routes SET repository=? WHERE thread=?').run(b.id, 'oc_team:om_1')
  expect(store.pending()).toEqual([])
  expect(store.outstanding()[0]).toMatchObject({ id: root.id, repositoryId: a.id, hold: 'thread-reassigned' })
  store.db.prepare('UPDATE routes SET repository=? WHERE thread=?').run(a.id, 'oc_team:om_1')
  // A binding that disappeared while the group was paused never silently drops the message.
  store.save([a, b], [], store.revision())
  expect(store.outstanding()[0]).toMatchObject({ id: root.id, repositoryId: a.id, hold: 'binding-missing' })
})
it('stores each Trigger once even when an acknowledgement is lost after delivery', () => {
  const trigger = feishu('1', 'request')
  expect(store.route(trigger)).toBe('stored'); expect(store.route(trigger)).toBe('duplicate')
  store.delivered(trigger.id)
  expect(store.pending()).toEqual([])
  // A crash between the instance accepting the message and the manager acknowledging it replays the send, not the row.
  store.db.prepare('UPDATE inbox SET delivered=0 WHERE id=?').run(trigger.id)
  expect(store.pending().map(item => item.id)).toEqual([trigger.id])
  expect(store.route(trigger)).toBe('duplicate')
  expect(store.pending()).toHaveLength(1)
  store.delivered(trigger.id)
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM inbox').get()?.count).toBe(1)
})
it('counts the delivery backlog per repository and per group', () => {
  const head = feishu('1', 'first')
  store.route(head); store.route(feishu('2', 'second', { chat_id: 'oc_second' }))
  store.route(feishu('3', 'third', { root_id: 'om_1', mentions: [] }))
  // Counts are ordered by repository and group ids, which are random, so read them per group.
  const counts = () => Object.fromEntries(store.queueCounts().map(row => [row.chatId, row.count]))
  expect(counts()).toEqual({ oc_team: 2, oc_second: 1 })
  store.delivered(head.id)
  expect(counts()).toEqual({ oc_team: 1, oc_second: 1 })
})
it('adds per-topic ordering to a database written before the delivery columns existed', () => {
  const legacy = join(directory, 'legacy'); mkdirSync(legacy)
  const db = new DatabaseSync(join(legacy, 'manager.sqlite'))
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE routes (thread TEXT PRIMARY KEY, repository TEXT NOT NULL, chat TEXT NOT NULL);
    CREATE TABLE inbox (id TEXT PRIMARY KEY, repository TEXT NOT NULL, value TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT, next_at INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);`)
  db.prepare('INSERT INTO kv VALUES (?,?)').run('repositories', JSON.stringify([a, b]))
  db.prepare('INSERT INTO kv VALUES (?,?)').run('bindings', JSON.stringify(store.bindings()))
  db.prepare('INSERT INTO kv VALUES (?,?)').run('revision', JSON.stringify(store.revision()))
  const head = feishu('1', 'first'), follow = feishu('2', 'second', { root_id: 'om_1', mentions: [] })
  for (const trigger of [head, follow]) db.prepare('INSERT INTO inbox (id,repository,value) VALUES (?,?,?)').run(trigger.id, a.id, JSON.stringify(trigger))
  db.close()
  const upgraded = new ManagerStore(legacy)
  try {
    // The upgrade backfills each row's topic and group from the stored Trigger and keeps the old arrival order.
    expect(upgraded.pending().map(item => item.id)).toEqual([head.id])
    expect(upgraded.pending()[0]).toMatchObject({ repositoryId: a.id, chatId: 'oc_team', thread: 'oc_team:om_1' })
    upgraded.delivered(head.id)
    expect(upgraded.pending().map(item => item.id)).toEqual([follow.id])
  } finally { upgraded.close() }
})
it('refuses duplicate bindings, checkout registrations, port collisions and stale saves atomically', () => {
  expect(() => store.save([a, b], [...store.bindings(), store.bindings()[0]!], 1)).toThrow('one repository')
  expect(() => store.save([a, { ...b, directory: a.directory }], store.bindings(), 1)).toThrow('already registered')
  expect(() => store.save([a, { ...b, port: a.port }], store.bindings(), 1)).toThrow('ports')
  expect(() => store.save([a, b], [], 0)).toThrow('Configuration changed')
  expect(store.revision()).toBe(1); expect(store.bindings()).toHaveLength(2)
})
it('refuses inconsistent channel targets and scopes message ownership to the repository', () => {
  const trigger = feishu('1', 'request')
  expect(store.route({ ...trigger, channel: { ...trigger.channel!, address: { chatId: 'oc_second', messageId: 'om_1' } } })).toBe('filtered')
  store.route(trigger)
  expect(store.owns(a.id, 'om_1')).toBe(true); expect(store.owns(b.id, 'om_1')).toBe(false)
})
it('uses independent credentials, loopback origins and a restricted bot CLI protocol', () => {
  expect(a.token).not.toBe(b.token)
  expect(authorized(`Bearer ${a.token}`, a.token)).toBe(true)
  expect(authorized(`Bearer ${a.token}`, b.token)).toBe(false)
  expect(() => managerUrl('https://example.com')).toThrow('loopback')
  expect(() => managerUrl('http://127.0.0.1:3082/other')).toThrow('loopback')
  expect(managerUrl('http://127.0.0.1:3082')).toBe('http://127.0.0.1:3082')
  expect(() => bridgeOptions(['im', '+messages-reply', '--as', 'user'])).toThrow()
  expect(() => bridgeOptions(['api', 'POST', '/open-apis/im/v1/messages'])).toThrow()
  expect(() => bridgeOptions(['im', '+messages-reply', '--message-id', 'om_1', '--message-id', 'om_2'])).toThrow('duplicate')
  expect(bridgeOptions(['im', '+messages-reply', '--markdown', '--as', '--message-id', 'om_1']).get('--markdown')).toBe('--as')
})

const firstBot: BotConnection = { id: 'legacy-bot', cli: '/bin/lark-one', botId: 'ou_bot_one', appId: 'cli_one',
  brand: 'feishu', name: 'Team One', enabled: true, legacy: true }
const secondBot: BotConnection = { id: 'second-bot', cli: '/bin/lark-two', botId: 'ou_bot_two', appId: 'cli_two',
  brand: 'lark', name: 'Team Two', enabled: true }
function connectBots(): void {
  store.saveBot(firstBot, store.revision())
  store.saveBot(secondBot, store.revision())
  a = { ...a, allowedFeishuByBot: { [secondBot.id]: ['ou_alice'] } }
  b = { ...b, allowedFeishuByBot: { [secondBot.id]: ['ou_alice'] } }
  store.save([a, b], store.bindings(), store.revision())
}
function bindSecondBot(repositoryId: string): void {
  store.save([a, b], [...store.bindings(), { botId: secondBot.id, chatId: 'oc_team', repositoryId,
    enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }], store.revision())
}

it('migrates a legacy bot without rewriting existing trigger, actor, topic or reply identities', () => {
  const trigger = feishu('legacy', 'existing request')
  store.route(trigger)
  store.db.prepare('INSERT INTO replies (id,repository,chat,value,sent) VALUES (?,?,?,?,?)')
    .run('prior-reply-key', a.id, 'oc_team', '[]', 1)
  store.set('bot-cli', firstBot.cli); store.set('bot-id', firstBot.botId)
  store.saveBot(firstBot, store.revision())
  const retained = store.pending()[0]!
  expect(retained).toMatchObject({ id: trigger.id, botId: firstBot.id, thread: trigger.threads[0]!.id,
    trigger: { actor: trigger.actor, channel: { address: { botId: firstBot.id } }, meta: { managerBotId: firstBot.id } } })
  expect(store.db.prepare('SELECT id,bot FROM replies').get()).toEqual({ id: 'prior-reply-key', bot: firstBot.id })
  expect(store.bindings().every(binding => binding.botId === firstBot.id)).toBe(true)
  expect(store.route(trigger, firstBot.id)).toBe('duplicate')
  store.close(); store = new ManagerStore(directory)
  expect(store.legacyBotId()).toBe(firstBot.id)
  expect(store.pending()[0]!.id).toBe(trigger.id)
  expect(store.revision()).toBe(2)
})

it('allows one bot to route several groups into one repository', () => {
  store.saveBot(firstBot, store.revision())
  store.save([a, b], store.bindings().map(binding => ({ ...binding, repositoryId: a.id })), store.revision())
  expect(store.route(feishu('one', 'first group'), firstBot.id)).toBe('stored')
  expect(store.route(feishu('two', 'second group', { chat_id: 'oc_second' }), firstBot.id)).toBe('stored')
  expect(store.pending().map(item => item.repositoryId)).toEqual([a.id, a.id])
  expect(store.chats(a.id, firstBot.id)).toEqual(['oc_team', 'oc_second'])
  expect(store.repositoryBotIds(a.id)).toEqual([firstBot.id])
})

it('isolates the same group, message and thread received by two bots into different repositories', () => {
  connectBots(); bindSecondBot(b.id)
  const trigger = feishu('shared', 'both bots receive this request', { thread_id: 'omt_shared' })
  expect(store.route(trigger, firstBot.id)).toBe('stored')
  expect(store.route(trigger, secondBot.id)).toBe('stored')
  expect(store.route(trigger, firstBot.id)).toBe('duplicate')
  expect(store.route(trigger, secondBot.id)).toBe('duplicate')
  const rows = store.pending()
  expect(rows.map(row => [row.botId, row.repositoryId])).toEqual([[firstBot.id, a.id], [secondBot.id, b.id]])
  expect(new Set(rows.map(row => row.id)).size).toBe(2)
  expect(new Set(rows.map(row => row.thread)).size).toBe(2)
  expect(rows[0]!.trigger.actor).toEqual(rows[1]!.trigger.actor)
  expect(rows[1]!.trigger.channel?.address).toMatchObject({ botId: secondBot.id, brand: 'lark' })
  expect(store.routeOwner(rows[1]!.thread, secondBot.id)).toBe(b.id)
  expect(store.routeOwner(rows[1]!.thread, firstBot.id)).toBeUndefined()
  expect(store.owns(a.id, 'om_shared', firstBot.id)).toBe(true)
  expect(store.owns(a.id, 'om_shared', secondBot.id)).toBe(false)
  expect(store.messageBotIds(a.id, 'om_shared')).toEqual([firstBot.id])
  expect(store.threadBotIds(b.id, 'omt_shared')).toEqual([secondBot.id])
  expect(store.queueCounts()).toHaveLength(2)
  expect(store.route(rows[0]!.trigger, secondBot.id)).toBe('filtered')
  expect(store.route(rows[1]!.trigger, secondBot.id)).toBe('duplicate')
  store.close(); store = new ManagerStore(directory)
  expect(store.pending().map(row => [row.id, row.botId, row.repositoryId])).toEqual(rows.map(row => [row.id, row.botId, row.repositoryId]))
})

it('accepts two bots for one repository while retaining separate receipts and reply ownership', () => {
  connectBots(); bindSecondBot(a.id)
  const trigger = feishu('same', 'same group and repository')
  store.route(trigger, firstBot.id); store.route(trigger, secondBot.id)
  const pending = store.pending()
  expect(pending).toHaveLength(2)
  expect(pending.every(row => row.repositoryId === a.id)).toBe(true)
  expect(store.messageBotIds(a.id, 'om_same').sort()).toEqual([firstBot.id, secondBot.id].sort())
  store.delivered(pending[0]!.id)
  expect(store.pending().map(row => row.botId)).toEqual([secondBot.id])
  expect(store.queueCounts()).toEqual([{ botId: secondBot.id, repositoryId: a.id, chatId: 'oc_team', count: 1 }])
})

it('pauses only a disabled bot and does not count holds as failed delivery attempts', () => {
  connectBots(); bindSecondBot(b.id)
  const trigger = feishu('queued', 'waiting for delivery')
  store.route(trigger, firstBot.id); store.route(trigger, secondBot.id)
  store.saveBot({ ...secondBot, enabled: false }, store.revision())
  expect(store.pending().map(item => item.botId)).toEqual([firstBot.id])
  expect(store.outstanding().find(item => item.botId === secondBot.id)).toMatchObject({ hold: 'bot-disabled', attempts: 0 })
  expect(store.route(feishu('new', 'paused bot'), secondBot.id)).toBe('filtered')
  store.saveBot(secondBot, store.revision())
  expect(store.pending().map(item => item.botId)).toEqual([firstBot.id, secondBot.id])
})

it('checks permissions in each bot identity space and holds queued work after access is revoked', () => {
  connectBots(); bindSecondBot(a.id)
  const trigger = feishu('authorized', 'accepted before access removal')
  expect(store.route(trigger, secondBot.id)).toBe('stored')
  a = { ...a, allowedFeishuByBot: { [secondBot.id]: [] } }
  store.save([a, b], store.bindings(), store.revision())
  // Legacy grants and another repository's grants cannot authorize this bot and repository.
  expect(a.allowedFeishu).toContain('ou_alice')
  expect(store.route(feishu('revoked', 'new request'), secondBot.id)).toBe('filtered')
  expect(store.route(feishu('followup', 'existing thread', { root_id: 'om_authorized', mentions: [] }), secondBot.id)).toBe('filtered')
  expect(store.pending()).toEqual([])
  expect(store.outstanding()[0]).toMatchObject({ botId: secondBot.id, hold: 'unauthorized', attempts: 0 })
  expect(store.route(feishu('legacy-allowed', 'legacy still authorized'), firstBot.id)).toBe('stored')
  expect(store.pending(1)[0]?.botId).toBe(firstBot.id)
  expect(store.route(trigger, secondBot.id)).toBe('duplicate')
})

it('rejects unknown bot scopes, duplicate bot-group bindings and stale identity changes atomically', () => {
  connectBots(); bindSecondBot(a.id)
  const revision = store.revision()
  const duplicate = store.bindings().find(binding => binding.botId === secondBot.id)!
  expect(() => store.save([a, b], [...store.bindings(), duplicate], revision)).toThrow('one repository')
  expect(() => store.save([a, b], [{ ...duplicate, botId: 'unknown' }], revision)).toThrow('registered bot')
  expect(() => store.saveBot({ ...secondBot, botId: 'different-bot' }, revision)).toThrow('change identity')
  expect(() => store.saveBot({ ...secondBot, id: 'duplicate-identity' }, revision)).toThrow('already connected')
  expect(() => store.saveBot({ ...secondBot, enabled: false }, revision - 1)).toThrow('Configuration changed')
  expect(store.route(feishu('unknown', 'unknown transport'), 'unknown')).toBe('filtered')
  expect(store.revision()).toBe(revision)
  expect(store.bots()).toEqual([firstBot, secondBot])
})

it('does not remove a bot while bindings or historical conversation ownership still refer to it', () => {
  connectBots(); bindSecondBot(a.id)
  expect(() => store.removeBot(secondBot.id, store.revision())).toThrow('group bindings')
  store.route(feishu('retained', 'existing conversation'), secondBot.id)
  store.save([a, b], store.bindings().filter(binding => binding.botId !== secondBot.id), store.revision())
  expect(() => store.removeBot(secondBot.id, store.revision())).toThrow('conversation history')
  expect(store.bots()).toHaveLength(2)
})

it('removes an unused bot without leaving grants that a future connection could inherit', () => {
  connectBots()
  const revision = store.revision()
  store.removeBot(secondBot.id, revision)
  expect(store.bots()).toEqual([firstBot])
  expect(store.repositories().every(repository => repository.allowedFeishuByBot?.[secondBot.id] === undefined)).toBe(true)
  expect(store.revision()).toBe(revision + 1)
})

it('selects connected bots before applying the delivery limit without retrying disconnected bot messages', () => {
  connectBots(); bindSecondBot(a.id)
  for (let index = 0; index < 3; index++) store.route(feishu(`disconnected${index}`, 'oldest bot is unavailable'), firstBot.id)
  store.route(feishu('healthy', 'connected bot remains deliverable'), secondBot.id)
  expect(store.pending(1, true, undefined, new Set([secondBot.id])).map(item => item.botId)).toEqual([secondBot.id])
  expect(store.pending(1, true, undefined, new Set())).toEqual([])
  expect(store.outstanding().every(item => item.attempts === 0)).toBe(true)
})

it('holds old unscoped messages until the configured legacy bot identity has been verified and migrated', () => {
  store.route(feishu('legacy-pending', 'accepted by the old manager'))
  store.set('bot-cli', firstBot.cli); store.set('bot-id', firstBot.botId)
  expect(store.pending()).toEqual([])
  expect(store.outstanding()[0]).toMatchObject({ hold: 'bot-missing', attempts: 0 })
  expect(() => store.saveBot({ ...firstBot, botId: 'unexpected' }, store.revision())).toThrow('does not match')
  expect(store.bots()).toEqual([])
  store.saveBot(firstBot, store.revision())
  expect(store.pending()).toHaveLength(1)
  expect(store.pending()[0]!.botId).toBe(firstBot.id)
})

it('allows one CLI executable to connect different bots through distinct fixed profiles', () => {
  store.saveBot({ ...firstBot, profile: 'team-one' }, store.revision())
  store.saveBot({ ...secondBot, cli: firstBot.cli, profile: '  team-two  ' }, store.revision())
  expect(store.bots().map(bot => [bot.cli, bot.profile, bot.appId])).toEqual([
    [firstBot.cli, 'team-one', firstBot.appId], [firstBot.cli, 'team-two', secondBot.appId],
  ])
})

it('rejects different bot identities sharing the same CLI and profile, including its default account', () => {
  store.saveBot(firstBot, store.revision())
  expect(() => store.saveBot({ ...secondBot, cli: firstBot.cli }, store.revision())).toThrow('CLI and profile')
  store.saveBot({ ...firstBot, profile: 'team-one' }, store.revision())
  const revision = store.revision()
  expect(() => store.saveBot({ ...secondBot, cli: firstBot.cli, profile: ' team-one ' }, revision)).toThrow('CLI and profile')
  expect(store.revision()).toBe(revision)
  expect(store.bots()).toHaveLength(1)
})

it('rejects authorization maps referring to an unregistered bot without changing saved configuration', () => {
  connectBots()
  const revision = store.revision(), repositories = store.repositories()
  expect(() => store.save([{ ...a, allowedFeishuByBot: { ...a.allowedFeishuByBot, unknown: ['ou_alice'] } }, b],
    store.bindings(), revision)).toThrow('Unknown bot in Feishu authorization')
  expect(store.repositories()).toEqual(repositories)
  expect(store.revision()).toBe(revision)
})
