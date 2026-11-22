import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { KV } from '../src/kv.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { testMachine } from './fixtures/deployment.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), machine: testMachine(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('requires managed pilot operators to use the manager proxy', async () => {
  const call = serve({ machine: testMachine({ managed: { repositoryId: 'repo', url: 'http://127.0.0.1:3081', token: 'fixture', enterprisePilot: true } }) })
  expect(await call('GET', 'settings')).toEqual({ status: 403, body: { error: 'Open this repository through the enterprise manager' } })
  expect(await call('POST', 'executor/pause', { paused: true })).toMatchObject({ status: 403 })
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('approves the paths a run wrote outside its declared scope, joining them to the declared scope and recording who approved them', async () => {
  const ticket = { id: 't7', title: 'Fix login', scope: ['src/app/'], createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' }
  const overrun = { runId: 'r7', paths: ['src/app/login.ts', 'docs/login.md'], at: '2026-09-22T00:00:00.000Z' }
  const records = new Map<string, unknown>([[KV.executor.overrun('t7'), overrun]])
  const saved: { scope?: string[]; updatedAt: string }[] = [], refreshed: string[] = []
  const save = (value: { scope?: string[]; updatedAt: string }) => {
    saved.push(value)
    if (value.scope?.length) ticket.scope = value.scope
  }
  const call = serve({
    store: { tickets: { get: (id: string) => id === 't7' ? ticket : undefined, save },
      get: (key: string) => records.get(key), set: (key: string, value: unknown) => { records.set(key, value) }, atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    executor: { activeCount: () => 0, refreshScope: (id: string) => { refreshed.push(id) } },
  })
  // Without paths, every path the run reported is approved, and the widened scope is returned for the panel.
  const all = await call('POST', 'tickets/t7/scope-approval', {})
  expect(all).toMatchObject({ status: 200, body: { scope: ['src/app', 'src/app/login.ts', 'docs/login.md'],
    overrun: { runId: 'r7', approval: { by: 'panel', paths: ['src/app/login.ts', 'docs/login.md'] } } } })
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ scope: ['src/app', 'src/app/login.ts', 'docs/login.md'] })
  expect(refreshed).toEqual(['t7'])
  // A later approval of one reported path keeps the earlier one and appends only that path.
  records.set(KV.executor.overrun('t7'), { ...(records.get(KV.executor.overrun('t7')) as typeof overrun),
    paths: ['src/app/login.ts', 'docs/login.md', 'src/app/session.ts'] })
  const one = await call('POST', 'tickets/t7/scope-approval', { paths: ['src/app/session.ts'] })
  expect(one).toMatchObject({ status: 200, body: { scope: ['src/app', 'src/app/login.ts', 'docs/login.md', 'src/app/session.ts'],
    overrun: { approval: { paths: ['src/app/login.ts', 'docs/login.md', 'src/app/session.ts'] } } } })
  // A path the run never reported is refused, and nothing is saved.
  expect(await call('POST', 'tickets/t7/scope-approval', { paths: ['src/other.ts'] }))
    .toEqual({ status: 400, body: { error: 'The paths src/other.ts were not part of the overrun' } })
  expect(saved).toHaveLength(2)
})

it('refuses a scope approval for an unknown ticket or a ticket without an overrun', async () => {
  const ticket = { id: 't8', title: 'Fix cart', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' }
  const call = serve({
    store: { tickets: { get: (id: string) => id === 't8' ? ticket : undefined, save: () => {} },
      get: () => undefined, set: () => {}, atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    executor: { activeCount: () => 0, refreshScope: () => {} },
  })
  expect(await call('POST', 'tickets/t9/scope-approval', {})).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('POST', 'tickets/t8/scope-approval', {})).toEqual({ status: 400,
    body: { error: 'The ticket has no scope overrun waiting for approval' } })
  // A whole-repository ticket keeps its empty scope, which already covers every approved path.
  expect(await serve({ store: { tickets: { get: () => ticket, save: () => {} }, get: () => ({ runId: 'r8', paths: ['src/a.ts'], at: 'now' }),
    set: () => {}, atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    executor: { activeCount: () => 0, refreshScope: () => {} } })('POST', 'tickets/t8/scope-approval', {}))
    .toMatchObject({ status: 200, body: { scope: [], overrun: { approval: { by: 'panel' } } } })
})
