/** Transport-level routing and recovery across repository boundaries. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers() })
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
it('holds disabled groups without changing queued ownership and preserves per-repository ordering', () => {
  const first = feishu('1', 'first'), next = feishu('2', 'second'); store.route(first); store.route(next)
  store.save([a, b], store.bindings().map(binding => ({ ...binding, enabled: false })), store.revision())
  expect(store.route(feishu('3', 'disabled'))).toBe('filtered')
  expect(store.pending()).toHaveLength(1)
  store.failed(first.id, 'offline')
  expect(store.pending()).toEqual([])
  expect(store.pending(100, false)[0]).toMatchObject({ id: first.id, repositoryId: a.id, attempts: 1 })
  store.delivered(first.id)
  expect(store.pending()[0]!.id).toBe(next.id)
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
