/** Exercises the real local HTTP boundary with an isolated fake bot and repository instance. */
import { createServer, type Server } from 'node:http'
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

vi.setConfig({ testTimeout: 15000 })
let directory: string, manager: Manager, server: Server, instance: Server, origin: string, repository: Repository
let received: unknown[], failReceive: boolean, replyCalls: number
const listen = (server: Server) => new Promise<number>(resolve => { server.listen(0, '127.0.0.1', () => { resolve((server.address() as { port: number }).port) }) })
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
const response = (res: import('node:http').ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const request = (path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST', headers: Record<string, string> = { 'x-orchestrator-request': '1' }) =>
  fetch(`${origin}/orchestrator/${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'manager-http-')); received = []; failReceive = false; replyCalls = 0
  const botCli = join(directory, 'bot')
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
  instance = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${repository.token}`) { response(res, { error: 'auth' }, 403); return }
    if (req.url?.endsWith('/health')) { response(res, { repositoryId: repository.id, pid: process.pid, configured: true }); return }
    if (req.url?.endsWith('/settings')) { response(res, { blocks: { policy: { revision: 1, value: { sources: { github: { allowed: [] }, feishu: { allowed: [] } } } } },
      sources: [{ id: 'feishu', revision: 1, value: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } }] }); return }
    if (req.url?.includes('/settings/')) { response(res, { saved: true }); return }
    if (req.url?.includes('/tickets')) { response(res, { items: [] }); return }
    if (req.url?.endsWith('/receive')) {
      if (failReceive) { response(res, { error: 'offline' }, 503); return }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); received.push(JSON.parse(Buffer.concat(chunks).toString())); response(res, { result: 'stored' }); return
    }
    response(res, {})
  })
  const port = await listen(instance)
  repository = { ...ManagerStore.identity(), port, name: 'Repo', remote: 'acme/widgets', directory: '/repo', githubCli: '/bin/false', allowedGithub: [], allowedFeishu: [], enabled: true }
  let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
  server = createServer((req, res) => { void handler(req, res) }); const managerPort = await listen(server); origin = `http://127.0.0.1:${managerPort}`
  const ctx = { subprocess: nativeSubprocess, workspaceRegistry: { list: () => [] }, webServer: { host: '127.0.0.1', port: managerPort,
    register: (value: { handler: typeof handler }) => { handler = value.handler; return () => {} } } } as unknown as Context
  manager = new Manager(ctx, testMachine({ stateDir: directory }))
  manager.store.save([repository], [{ chatId: 'oc_team', repositoryId: repository.id, enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }], 0)
  manager.store.set('bot-cli', botCli)
  await manager.start()
})
afterEach(async () => { await manager.stop(); await close(server); await close(instance); rmSync(directory, { recursive: true, force: true }) })
it('hides instance credentials and rejects cross-origin browser and unauthenticated internal calls', async () => {
  const state = await (await request('manager/state')).text()
  expect(state).not.toContain(repository.token); expect(state).not.toContain('"token"')
  expect((await request('manager/state', undefined, 'GET', { origin: 'https://example.com' })).status).toBe(403)
  expect((await request(`internal/${repository.id}/receive`, feishu('1', 'request'))).status).toBe(403)
  const wrong = feishu('1', 'wrong group', { chat_id: 'oc_second' })
  expect((await request(`internal/${repository.id}/receive`, wrong, 'POST', { authorization: `Bearer ${repository.token}` })).status).toBe(400)
})
it('delivers a persisted event only to its authenticated instance and acknowledges duplicate ingress', async () => {
  const trigger = feishu('1', 'request')
  expect(manager.store.route(trigger)).toBe('stored')
  await vi.waitFor(() => { expect(received).toHaveLength(1) }, { timeout: 7000 })
  await vi.waitFor(() => { expect(manager.store.pending()).toEqual([]) })
  const duplicate = await request(`internal/${repository.id}/receive`, trigger, 'POST', { authorization: `Bearer ${repository.token}` })
  expect(await duplicate.json()).toEqual({ result: 'duplicate' })
  expect(received).toHaveLength(1)
})
it('keeps failed deliveries queued for the original repository', async () => {
  failReceive = true; const trigger = feishu('1', 'request'); manager.store.route(trigger)
  await vi.waitFor(() => { expect(manager.store.pending(100, false)[0]?.attempts).toBeGreaterThan(0) }, { timeout: 7000 })
  expect(manager.store.pending(100, false)[0]).toMatchObject({ repositoryId: repository.id, error: 'offline' })
  failReceive = false
  await vi.waitFor(() => { expect(received).toHaveLength(1) }, { timeout: 7000 })
})
it('refuses arbitrary shared-bot commands and enforces group disable on pending replies', async () => {
  const trigger = feishu('1', 'request'); manager.store.route(trigger)
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
