/** Transport-level routing and recovery across repository boundaries. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ManagerStore, type Repository } from '../src/manager/store.ts'
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
