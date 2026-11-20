import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { deliveryTools, type DeliveryToolsHost } from '../src/app/tools/delivery.ts'
import { SettingsSchema } from '../src/policy.ts'
import { KV, type DeliveryPlan } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Deployment } from '../src/deployment.ts'
import type { Ticket } from '../src/core/index.ts'

const base = 'a'.repeat(40)
const local = 'b'.repeat(40)
const remote = 'c'.repeat(40)
let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-delivery-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_a', name: 'Alice' }] },
    github: { allowed: [{ id: 'agent' }] } } } }))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

/** The resolved deployment the host reads its repository and its agent GitHub identity from. */
const deployment = (): Deployment => ({ repository: 'acme/widgets', stateDir: directory, promptMaxChars: 100000 as never,
  admissionContextMaxPages: 10 as never, admissionContextTimeoutMs: 15000 as never,
  github: { cli: 'gh', login: 'agent', noreply: 'agent@users.noreply.github.com' } })

function ticketOf(extra: Partial<Ticket> = {}): Ticket {
  const at = '2026-09-22T00:00:00Z'
  return { id: 't1', title: 'Fix login', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_a' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] },
    execution: { name: 't1', directory: '/w/t1', assignment: 'a1', repository: 'acme/widgets',
      worktree: { path: '/w/t1', branch: 'agent/t1', baseRef: 'origin/main', baseSha: base, repositoryId: 'acme/widgets' } },
    assignments: [], inputs: [], ...extra }
}

/** A Pull as GitHub's `pulls/<n>` and `gh pr list` answer it, filed by the agent from the ticket's branch. */
const pullBody = (number: number, state = 'open') => ({ number, state, html_url: `https://github.com/acme/widgets/pull/${number}`,
  user: { login: 'agent', id: 1 }, head: { sha: local, ref: 'agent/t1', repo: { full_name: 'acme/widgets' } },
  merged: state === 'closed' ? false : undefined })
const listed = (number: number, state = 'open') => ({ number, state, url: `https://github.com/acme/widgets/pull/${number}`,
  headRefOid: local, baseRefName: 'main' })

interface Fake {
  commands: Commands
  calls: { git: string[][]; run: string[][]; gh: string[][] }
  host: DeliveryToolsHost
}
function fake(handlers: { git?: (args: string[]) => string | Promise<string>; gh?: (args: string[]) => unknown;
  run?: (args: string[]) => string; pull?: (number: number) => unknown } = {}): Fake {
  const calls = { git: [] as string[][], run: [] as string[][], gh: [] as string[][] }
  const commands = {
    git: vi.fn(async (args: string[]) => {
      calls.git.push(args)
      if (!handlers.git) throw new Error(`unexpected git ${args.join(' ')}`)
      return handlers.git(args)
    }),
    run: vi.fn(async (_program: string, args: string[]) => {
      calls.run.push(args)
      if (!handlers.run) throw new Error(`unexpected command ${args.join(' ')}`)
      return handlers.run(args)
    }),
    gh: vi.fn(async (args: string[]) => {
      calls.gh.push(args)
      if (!handlers.gh) throw new Error(`unexpected gh ${args.join(' ')}`)
      return handlers.gh(args)
    }),
    api: vi.fn(async (_schema: unknown, path: string) => {
      const number = Number(path.replace(/^pulls\//, ''))
      return handlers.pull?.(number) ?? pullBody(number)
    }),
    withSignal: () => commands,
  }
  const github = {
    deployment: deployment(), commands: commands as unknown as Commands,
    tickets: { get: (id: string) => store.tickets.get(id), open: () => [], bindThread: vi.fn(), threadClosed: vi.fn() },
    triggers: { get: () => undefined, latest: () => undefined },
    threads: { get: () => undefined, subscribed: () => [], describe: vi.fn(), patch: vi.fn() },
    atomic: <T>(work: () => T) => work(),
  } as unknown as SourceContext
  return { commands: commands as unknown as Commands, calls, host: { store, commands: commands as unknown as Commands, github } }
}
const call = (host: DeliveryToolsHost, args: Record<string, unknown>, ticket = ticketOf()) =>
  deliveryTools(host, ticket)[0]!.execute(args as never, new AbortController().signal) as Promise<Record<string, unknown>>
const savedPlan = (): DeliveryPlan | undefined => store.get(KV.executor.delivery('t1'))

it('records the plan before any write, with the branch, base and expected head', async () => {
  store.tickets.save(ticketOf())
  const { host, calls } = fake()
  const result = await call(host, { action: 'plan', expected: remote })
  expect(result).toMatchObject({ ok: true, action: 'plan', recorded: true })
  expect(savedPlan()).toMatchObject({ action: 'push', branch: 'agent/t1', base: 'main', expected: remote })
  expect(calls.git).toEqual([])
})

it('refuses to push over a remote head that moved, showing the remote commits and recording a failed result', async () => {
  store.tickets.save(ticketOf())
  const { host, calls } = fake({ git: args => args[0] === 'ls-remote' ? `${remote}\trefs/heads/agent/t1\n`
    : args[0] === 'rev-parse' ? `${local}\n` : args[0] === 'fetch' ? ''
      : args[0] === 'log' ? `${remote.slice(0, 7)} someone else's fix\n` : '' })
  const result = await call(host, { action: 'push', expected: base })
  expect(result).toMatchObject({ ok: false, reason: 'remote_head_moved', remote_head: remote, expected: base,
    recent_commits: [`${remote.slice(0, 7)} someone else's fix`] })
  expect(result.suggestion).toMatch(/reconcile/)
  expect(savedPlan()!.result).toMatchObject({ outcome: 'failed', branchSha: remote })
  expect(calls.git.some(args => args[0] === 'push')).toBe(false)
})

it('pushes only after the remote head matches, and records the applied branch sha', async () => {
  store.tickets.save(ticketOf())
  const { host, calls } = fake({ git: args => args[0] === 'ls-remote' ? `${remote}\trefs/heads/agent/t1\n`
    : args[0] === 'rev-parse' ? `${local}\n` : '' })
  const result = await call(host, { action: 'push', expected: remote })
  expect(result).toMatchObject({ ok: true, action: 'push', branch: 'agent/t1', branch_sha: local, remote_head: local, forced: false })
  expect(calls.git.find(args => args[0] === 'push')).toEqual(['push', 'origin', 'agent/t1'])
  expect(savedPlan()!.result).toMatchObject({ outcome: 'applied', branchSha: local })
})

it('creates a new remote branch from its expected base, without force', async () => {
  store.tickets.save(ticketOf())
  const { host, calls } = fake({ git: args => args[0] === 'ls-remote' ? ''
    : args[0] === 'rev-parse' ? `${local}\n` : args[0] === 'merge-base' ? '' : '' })
  const result = await call(host, { action: 'push', expected: base })
  expect(result).toMatchObject({ ok: true, action: 'push', branch: 'agent/t1', branch_sha: local, remote_head: local,
    forced: false, created: true })
  expect(calls.git.find(args => args[0] === 'push')).toEqual(['push', 'origin', 'agent/t1'])
  expect(savedPlan()!.result).toMatchObject({ outcome: 'applied', branchSha: local })
})

it('refuses to create a new remote branch from a base it does not descend from', async () => {
  store.tickets.save(ticketOf())
  const { host, calls } = fake({ git: args => args[0] === 'ls-remote' ? ''
    : args[0] === 'rev-parse' ? `${local}\n` : args[0] === 'merge-base' ? (() => { throw new Error('not an ancestor') })() : '' })
  const result = await call(host, { action: 'push', expected: base })
  expect(result).toMatchObject({ ok: false, reason: 'base_mismatch', remote_head: null })
  expect(calls.git.some(args => args[0] === 'push')).toBe(false)
})

it('reuses the existing pull request instead of creating a second one, and binds it to the ticket', async () => {
  store.tickets.save(ticketOf())
  const bind = vi.fn()
  const { host, calls } = fake({ gh: () => [listed(7)] })
  ;(host.github.tickets as { bindThread: unknown }).bindThread = bind
  const result = await call(host, { action: 'open' })
  expect(result).toMatchObject({ ok: true, action: 'open', created: false, reused: true,
    pr: { number: 7, state: 'open', url: 'https://github.com/acme/widgets/pull/7', head_sha: local, base: 'main' } })
  expect(calls.run).toEqual([])
  expect(bind).toHaveBeenCalledWith('t1', { source: 'github', id: '7' }, true)
  expect(savedPlan()).toMatchObject({ action: 'pr', branch: 'agent/t1', pr: 7, result: { outcome: 'applied', pr: 7 } })
})

it('creates the pull request only when none exists for the branch, then records and claims it', async () => {
  store.tickets.save(ticketOf())
  let listedOnce = false
  const { host, calls } = fake({ gh: () => listedOnce ? [listed(9)] : [],
    run: () => { listedOnce = true; return 'https://github.com/acme/widgets/pull/9' } })
  const result = await call(host, { action: 'open', title: 'Fix login' })
  expect(result).toMatchObject({ ok: true, action: 'open', created: true, pr: { number: 9 } })
  expect(calls.run[0]!.slice(0, 3)).toEqual(['pr', 'create', '--head'])
  expect(savedPlan()!.result).toMatchObject({ outcome: 'applied', pr: 9, state: 'open' })
})

it('refuses push and open while a scope overrun waits for approval, and allows them once approved', async () => {
  store.tickets.save(ticketOf())
  store.set(KV.executor.overrun('t1'), { runId: 'r1', paths: ['src/kv.ts'], at: '2026-09-22T00:00:00Z' })
  const blocked = fake()
  await expect(call(blocked.host, { action: 'push', expected: remote })).resolves
    .toMatchObject({ ok: false, reason: 'overrun_pending_approval', paths: ['src/kv.ts'] })
  await expect(call(blocked.host, { action: 'open' })).resolves.toMatchObject({ reason: 'overrun_pending_approval' })
  expect(blocked.calls.git).toEqual([])
  store.set(KV.executor.overrun('t1'), { runId: 'r1', paths: ['src/kv.ts'], at: '2026-09-22T00:00:00Z',
    approval: { at: '2026-09-22T00:01:00Z', by: 'ou_a', paths: ['src/kv.ts'] } })
  const allowed = fake({ git: args => args[0] === 'ls-remote' ? `${remote}\trefs/heads/agent/t1\n`
    : args[0] === 'rev-parse' ? `${local}\n` : '' })
  await expect(call(allowed.host, { action: 'push', expected: remote })).resolves.toMatchObject({ ok: true })
})

it('recovers an unknown result by querying the branch and its pull requests, without writing', async () => {
  store.tickets.save(ticketOf())
  store.set(KV.executor.delivery('t1'), { action: 'push', branch: 'agent/t1', base: 'main', expected: base, at: '2026-09-22T00:00:00Z',
    result: { at: '2026-09-22T00:00:01Z', outcome: 'unknown', detail: 'network drop' } })
  const { host, calls } = fake({ git: () => `${remote}\trefs/heads/agent/t1\n`, gh: () => [listed(7)] })
  const result = await call(host, { action: 'recover' })
  expect(result).toMatchObject({ ok: true, action: 'recover', remote_head: remote, expected: base, remote_moved: true,
    branch_exists: true, next: 'none', pulls: [{ number: 7, state: 'open' }] })
  expect(calls.git.every(args => args[0] !== 'push')).toBe(true)
  expect(calls.run).toEqual([])
})

it('reads the plan and its result back with status', async () => {
  store.tickets.save(ticketOf())
  store.set(KV.executor.delivery('t1'), { action: 'pr', branch: 'agent/t1', base: 'main', expected: base, at: '2026-09-22T00:00:00Z',
    result: { at: '2026-09-22T00:00:01Z', outcome: 'applied', branchSha: local, pr: 7, state: 'open' } })
  const result = await call(fake().host, { action: 'status' })
  expect(result).toMatchObject({ ok: true, action: 'status', branch: 'agent/t1',
    result: { outcome: 'applied', branchSha: local, pr: 7, state: 'open' } })
})

it('returns the same applied result when the push already landed, instead of treating its own commit as a moved head', async () => {
  store.tickets.save(ticketOf())
  const { host, calls } = fake({ git: args => args[0] === 'ls-remote' ? `${local}\trefs/heads/agent/t1\n`
    : args[0] === 'rev-parse' ? `${local}\n` : '' })
  const result = await call(host, { action: 'push', expected: remote })
  expect(result).toMatchObject({ ok: true, action: 'push', already: true, branch_sha: local })
  expect(calls.git.some(args => args[0] === 'push')).toBe(false)
  expect(savedPlan()!.result).toMatchObject({ outcome: 'applied', branchSha: local })
})

it('pushes a real commit to a real remote once the checked head matches', async () => {
  // The other cases stub Commands; this one runs git itself against a bare remote in the temporary directory, so the
  // ls-remote, fetch, push and recorded result are proved against real git rather than an injected answer.
  const remote = join(directory, 'remote.git'), work = join(directory, 'work')
  const environment = { GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@users.noreply.github.com', ...args],
    { cwd: work, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
  execFileSync('git', ['clone', remote, work], { stdio: 'ignore' })
  writeFileSync(join(work, 'README.md'), '# base\n')
  git('add', 'README.md'); git('commit', '-m', 'base'); git('branch', '-M', 'main'); git('push', 'origin', 'main')
  git('checkout', '-b', 'agent/t1'); writeFileSync(join(work, 'fix.ts'), 'export const fix = 1\n')
  git('add', 'fix.ts'); git('commit', '-m', 'fix'); git('push', 'origin', 'agent/t1')
  const checked = git('rev-parse', 'HEAD')
  writeFileSync(join(work, 'later.ts'), 'export const later = 2\n')
  git('add', 'later.ts'); git('commit', '-m', 'later')
  const head = git('rev-parse', 'HEAD')
  const commands = new Commands(deployment, environment, new AbortController().signal)
  const host = { store, commands, github: { deployment: deployment(), commands } as unknown as SourceContext }
  const ticket = ticketOf({ execution: { name: 't1', directory: work, assignment: 'a1', repository: 'acme/widgets',
    worktree: { path: work, branch: 'agent/t1', baseRef: 'main', baseSha: checked, repositoryId: 'acme/widgets' } } })
  store.tickets.save(ticket)
  const result = await call(host, { action: 'push', expected: checked }, ticket)
  expect(result).toMatchObject({ ok: true, action: 'push', branch: 'agent/t1', branch_sha: head, remote_head: head, forced: false })
  expect(git('ls-remote', 'origin', 'refs/heads/agent/t1')).toContain(head)
  expect(savedPlan()!.result).toMatchObject({ outcome: 'applied', branchSha: head })
})

it('creates a real new remote branch from its base when no remote branch exists yet', async () => {
  // The first push of a ticket: the branch exists only locally. The recorded expected head is the base commit the branch
  // was cut from, and the tool must create the remote branch from it without force.
  const remote = join(directory, 'remote.git'), work = join(directory, 'work')
  const environment = { GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@users.noreply.github.com', ...args],
    { cwd: work, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
  execFileSync('git', ['clone', remote, work], { stdio: 'ignore' })
  writeFileSync(join(work, 'README.md'), '# base\n')
  git('add', 'README.md'); git('commit', '-m', 'base'); git('branch', '-M', 'main'); git('push', 'origin', 'main')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-b', 'agent/t1'); writeFileSync(join(work, 'fix.ts'), 'export const fix = 1\n')
  git('add', 'fix.ts'); git('commit', '-m', 'fix')
  const head = git('rev-parse', 'HEAD')
  const commands = new Commands(deployment, environment, new AbortController().signal)
  const host = { store, commands, github: { deployment: deployment(), commands } as unknown as SourceContext }
  const ticket = ticketOf({ execution: { name: 't1', directory: work, assignment: 'a1', repository: 'acme/widgets',
    worktree: { path: work, branch: 'agent/t1', baseRef: 'main', baseSha: base, repositoryId: 'acme/widgets' } } })
  store.tickets.save(ticket)
  const result = await call(host, { action: 'push', expected: base }, ticket)
  expect(result).toMatchObject({ ok: true, action: 'push', branch: 'agent/t1', branch_sha: head, created: true, forced: false })
  expect(git('ls-remote', 'origin', 'refs/heads/agent/t1')).toContain(head)
  expect(savedPlan()!.result).toMatchObject({ outcome: 'applied', branchSha: head })
})
