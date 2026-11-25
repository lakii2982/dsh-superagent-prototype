/** Delegation to the local agent CLIs: command building, durable runs, delivery gating, stop ordering, and the worker tool. */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runningAssignment, type Ticket } from '../src/core/index.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import { AgentRuns, agentCommand, agentEnvironment, agentErrorKind, parseClaude, parseCodex, parseSystemProxy, probeAgents,
  type AgentDelegation, type AgentProbe, type AgentRun, type AgentRunsHost } from '../src/executor/agents.ts'
import * as agentsModule from '../src/executor/agents.ts'
import { KV } from '../src/kv.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { Settings } from '../src/policy.ts'
import { gitEnv } from './fixtures/git.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))
const BINARIES = { claude: [process.execPath, FIXTURE, 'claude'], codex: [process.execPath, FIXTURE, 'codex'] }
/** The fixture process is available independently of the host's real CLIs and sandbox installation. */
const fixtureProbe = (): AgentProbe[] => [{ kind: 'claude', available: true }, { kind: 'codex', available: true }]
const runFile = promisify(execFile)
const directories: string[] = []
const lifetimes: AbortController[] = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A ticket with one running Assignment in `directory`. */
const ticketOf = (id: string, assignmentId: string, directory: string): Ticket => ({
  id, title: `Ticket ${id}`, decisionId: `decision-${id}`, channels: [],
  assignments: [{ id: assignmentId, state: 'running', createdAt: '2026-05-01T00:00:00.000Z' }],
  inputs: [], undelivered: [], createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
  origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
  execution: { name: id, directory, assignment: 'Do the work' },
} as unknown as Ticket)

/** A real child-process `SubprocessRuntime` that runs the fake CLI and records the argv of every exit. */
const fixtureSubprocess = (onExit?: (code: number | null) => void) => {
  const exits: { argv: readonly string[]; code: number | null }[] = []
  const subprocess = {
    spawn: (spec: { argv: readonly string[]; cwd: string; env?: Record<string, string | undefined> }) => {
      const [command, ...rest] = spec.argv
      const child = spawn(command!, rest, { cwd: spec.cwd, env: { ...process.env, ...spec.env } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.on('close', (code, signal) => {
          exits.push({ argv: spec.argv, code })
          onExit?.(code)
          resolve({ exitCode: code, signal })
        })
        // A spawn whose cwd a finished test already removed reports here instead of throwing into the run loop.
        child.on('error', () => { resolve({ exitCode: null, signal: null }) })
      })
      return {
        done,
        collected: { stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) } },
        terminate: () => { child.kill('SIGTERM') },
        waitForExit: () => done,
      }
    },
  }
  return { subprocess: subprocess as unknown as SubprocessRuntime, exits }
}

/** An in-memory KV for the runner and Executor tests, recording every key deleted. */
const memoryStore = (tickets: Ticket[], deleted: string[] = []) => {
  const values = new Map<string, unknown>()
  const store = {
    get: <V>(name: string): V | undefined => values.get(name) as V | undefined,
    set: <V>(name: string, value: V) => { values.set(name, value) },
    delete: (name: string) => { values.delete(name); deleted.push(name) },
    tickets: { list: () => tickets, get: (id: string) => tickets.find(ticket => ticket.id === id), open: () => tickets },
  }
  return { values, store }
}

interface Delivered { ticketId: string; assignmentId: string; requestId: string; text: string }
/** What the fixture CLI observed from inside the child process: its argv, its cwd, and the environment boundary. */
interface Invocation { agent: string; args: string[]; cwd: string; proxy: string | null; home: string | null; tmp: string | null
  homeMode: number | null; ghToken: string | null; dshHome: string | null; feishu: string | null; sshSock: string | null; awsKey: string | null }
interface World {
  dir: string
  tickets: Ticket[]
  values: Map<string, unknown>
  host: AgentRunsHost
  runs: AgentRuns
  delivered: Delivered[]
  invocations: () => Invocation[]
  exits: { argv: readonly string[]; code: number | null }[]
}
/** A runner over a fresh temporary workspace, with a host whose delivery, running and refusal checks the test controls. */
const makeWorld = async (options: { running?: (ticketId: string, assignmentId: string) => boolean
  writeRefusal?: () => string | undefined; stopMs?: number; probe?: () => AgentProbe[] } = {}): Promise<World> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agents-')))
  directories.push(dir)
  process.env.FAKE_AGENT_LOG = join(dir, 'invocations.ndjson')
  const tickets = [ticketOf('t1', 'a1', dir)]
  const { values, store } = memoryStore(tickets)
  const delivered: Delivered[] = []
  const { subprocess, exits } = fixtureSubprocess()
  const lifetime = new AbortController()
  lifetimes.push(lifetime)
  const host: AgentRunsHost = {
    subprocess, store: store as unknown as AgentRunsHost['store'], lifetime: lifetime.signal,
    running: options.running ?? (() => true),
    ...options.writeRefusal ? { writeRefusal: options.writeRefusal } : {},
    deliver: async (ticketId, assignmentId, requestId, text) => { delivered.push({ ticketId, assignmentId, requestId, text }) },
  }
  const runs = new AgentRuns(host, { binaries: BINARIES, ...options.stopMs === undefined ? {} : { stopMs: options.stopMs },
    probe: options.probe ?? fixtureProbe })
  const invocations = () => {
    try {
      return readFileSync(join(dir, 'invocations.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as Invocation)
    } catch {
      return []
    }
  }
  return { dir, tickets, values, host, runs, delivered, invocations, exits }
}
/** Waits until a run leaves `running`, and returns its record. */
const settled = async (runs: AgentRuns, ticketId: string, runId: string, timeoutMs = 5000): Promise<AgentRun> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = runs.status(ticketId, runId)
    if (found && !Array.isArray(found) && found.status !== 'running') return found
    await delay(10)
  }
  throw new Error(`The run ${runId} did not settle`)
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const lifetime of lifetimes.splice(0)) lifetime.abort()
  for (const name of Object.keys(process.env)) if (name.startsWith('FAKE_AGENT_')) delete process.env[name]
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('agent commands', () => {
  it('builds read and write commands, a session id for a fresh run, and --resume for a continued one', () => {
    expect(agentCommand({ agent: 'claude', permission: 'read', directory: '/work', prompt: 'inspect', sessionId: 'session-1' }))
      .toEqual(['claude', '-p', 'inspect', '--output-format', 'json', '--permission-mode', 'plan', '--allowedTools', 'Read,Grep,Glob',
        '--session-id', 'session-1'])
    expect(agentCommand({ agent: 'claude', permission: 'write', directory: '/work', prompt: 'fix', sessionId: 'session-1' }))
      .toEqual(['claude', '-p', 'fix', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--session-id', 'session-1'])
    expect(agentCommand({ agent: 'claude', permission: 'write', directory: '/work', prompt: 'fix', sessionId: 'session-1' }))
      .not.toContain('bypassPermissions')
    expect(agentCommand({ agent: 'claude', permission: 'read', directory: '/work', prompt: 'go on', resume: 'external-1' }))
      .toEqual(['claude', '-p', 'go on', '--output-format', 'json', '--permission-mode', 'plan', '--allowedTools', 'Read,Grep,Glob',
        '--resume', 'external-1'])
    expect(agentCommand({ agent: 'codex', permission: 'read', directory: '/work', prompt: 'inspect' }))
      .toEqual(['codex', 'exec', '--json', '--skip-git-repo-check', '-C', '/work', '-s', 'read-only', 'inspect'])
    expect(agentCommand({ agent: 'codex', permission: 'write', directory: '/work', prompt: 'fix' }))
      .toEqual(['codex', 'exec', '--json', '--skip-git-repo-check', '-C', '/work', '-s', 'workspace-write', 'fix'])
    expect(agentCommand({ agent: 'codex', permission: 'read', directory: '/work', prompt: 'go on', resume: 'thread-1' }))
      .toEqual(['codex', 'exec', 'resume', 'thread-1', 'go on', '--json', '--skip-git-repo-check', '-C', '/work', '-s', 'read-only'])
  })

  it('parses the claude json and codex jsonl shapes, ignoring extra lines', () => {
    const claude = parseClaude(`warning: something\n${JSON.stringify({ is_error: false, session_id: 'session-9', result: 'done it',
      usage: { input_tokens: 1 }, total_cost_usd: 0.03 })}\n`)
    expect(claude).toEqual({ text: 'done it', externalId: 'session-9', usage: { input_tokens: 1 }, costUsd: 0.03 })
    const codex = parseCodex(`not json\n${JSON.stringify({ type: 'thread.started', thread_id: 'thread-9' })}\n`
      + `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } })}\n`
      + `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last' } })}\n`
      + `${JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 2 } })}\n`)
    expect(codex).toEqual({ text: 'last', externalId: 'thread-9', usage: { output_tokens: 2 } })
    expect(parseClaude('only human text').error).toContain('no JSON result')
    const proxyError = JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (request timed out)' })
    expect(parseCodex(proxyError).error).toBe('Reconnecting... 2/5 (request timed out)')
    expect(agentErrorKind(parseCodex(proxyError).error ?? '')).toBe('unavailable')
  })

  it('probes each CLI for its binary and for a file-access boundary this host can hold', () => {
    const missing = probeAgents({ binaries: { claude: ['no-such-cli'], codex: ['no-such-cli'] }, searchPath: '/nonexistent', exists: () => false })
    expect(missing).toHaveLength(2)
    expect(missing.every(entry => !entry.available)).toBe(true)
    expect(missing[0]).toMatchObject({ kind: 'claude', available: false })
    expect(missing[0]!.detail).toContain('not on PATH')
    expect(missing[0]!.repair).toContain('Install')

    const unconstrained = probeAgents({ binaries: { claude: ['sh'], codex: ['sh'] }, platform: 'freebsd', searchPath: '/bin', exists: () => true })
    expect(unconstrained[0]).toMatchObject({ available: false })
    expect(unconstrained[0]!.detail).toContain('cannot constrain')
    expect(unconstrained[0]!.repair).toBeTruthy()

    // Linux without bwrap cannot hold the boundary either, even with the CLI installed.
    const linux = probeAgents({ binaries: { claude: ['sh'] }, platform: 'linux', searchPath: '/bin', exists: path => path === '/bin/sh' })
    expect(linux[0]!.detail).toContain('cannot constrain')

    const ready = probeAgents({ binaries: { claude: ['sh'], codex: ['sh'] }, platform: 'darwin', searchPath: '/bin', exists: () => true })
    expect(ready[0]).toMatchObject({ kind: 'claude', available: true })
  })
  it('gives agent processes the explicit, host, or macOS system proxy in that order', () => {
    expect(agentEnvironment({}, { HTTPS_PROXY: 'http://host:1' }, () => ({ HTTPS_PROXY: 'http://system:2' })))
      .toEqual({ HTTPS_PROXY: 'http://host:1' })
    expect(agentEnvironment({}, {}, () => ({ HTTPS_PROXY: 'http://system:2' }))).toEqual({ HTTPS_PROXY: 'http://system:2' })
    expect(agentEnvironment({ NO_PROXY: 'localhost' }, { HTTPS_PROXY: 'http://host:1' }, () => ({})))
      .toEqual({ HTTPS_PROXY: 'http://host:1', NO_PROXY: 'localhost' })
    expect(parseSystemProxy(`
      <dictionary> {
        HTTPEnable : 1
        HTTPPort : 10902
        HTTPProxy : 127.0.0.1
        HTTPSEnable : 1
        HTTPSPort : 10902
        HTTPSProxy : 127.0.0.1
        SOCKSEnable : 1
        SOCKSPort : 10021
        SOCKSProxy : 127.0.0.1
      }`)).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:10902', HTTP_PROXY: 'http://127.0.0.1:10902',
      ALL_PROXY: 'socks5://127.0.0.1:10021' })
  })
})

describe('agent runs', () => {
  it('starts one process for a duplicate submission and returns the stored run', async () => {
    process.env.FAKE_AGENT_MODE = 'sleep'
    const previousProxy = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10902'
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const first = world.runs.start(ticket, { agent: 'claude', prompt: 'hold on', permission: 'read' })
    await vi.waitFor(() => expect(world.invocations()).toHaveLength(1))
    expect(world.invocations()[0]!.proxy).toBe('http://127.0.0.1:10902')
    if (previousProxy) process.env.HTTPS_PROXY = previousProxy
    else delete process.env.HTTPS_PROXY
    const second = world.runs.start(ticket, { agent: 'claude', prompt: 'hold on', permission: 'read' })
    expect(second.id).toBe(first.id)
    await delay(150)
    expect(world.invocations()).toHaveLength(1)
    await world.runs.stopAll(ticket.id, 'test over')
  })

  it('records the session id, result, and real workspace difference when a run ends', async () => {
    process.env.FAKE_AGENT_MODE = 'ok'
    process.env.FAKE_AGENT_TEXT = 'built the thing'
    process.env.FAKE_AGENT_WRITE_FILE = 'agent-output.txt'
    const world = await makeWorld()
    await runFile('git', ['init'], { cwd: world.dir, env: gitEnv() })
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'claude', prompt: '  build it  ', permission: 'read' })
    expect(run.prompt).toBe('build it')
    const done = await settled(world.runs, ticket.id, run.id)
    expect(done).toMatchObject({ status: 'done', externalId: 'claude-session-1', exitCode: 0, result: { text: 'built the thing' } })
    expect(done.changes?.status).toContain('agent-output.txt')
    expect(done.changes?.stat).toBe('')
    const call = world.invocations()[0]!
    expect(call.cwd).toBe(world.dir)
    expect(call.args).toContain('--session-id')
    expect(world.delivered).toHaveLength(1)
    expect(world.delivered[0]!.requestId).toBe(`agent:${run.id}`)
    expect(world.delivered[0]!.text).toContain(run.id)
    expect(world.delivered[0]!.text).toContain('not a check')
  })

  it('reports a login failure with its repair hint and no result', async () => {
    process.env.FAKE_AGENT_MODE = 'login'
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'codex', prompt: 'inspect', permission: 'read' })
    const done = await settled(world.runs, ticket.id, run.id)
    expect(done.status).toBe('failed')
    expect(done.errorKind).toBe('login')
    expect(done.error).toContain('Not logged in')
    expect(world.delivered[0]!.text).toContain('not signed in')
  })

  it('delivers the note only for the assignment that still runs the ticket', async () => {
    let current = 'a1'
    const world = await makeWorld({ running: (_ticketId, assignmentId) => assignmentId === current })
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'claude', prompt: 'inspect', permission: 'read' })
    expect(run.assignmentId).toBe('a1')
    current = 'a2'
    const done = await settled(world.runs, ticket.id, run.id)
    expect(done.status).toBe('done')
    expect(world.delivered).toHaveLength(0)
  })

  it('records a late result of an older assignment without delivering it', async () => {
    process.env.FAKE_AGENT_DELAY_MS = '250'
    let current = 'a1'
    const world = await makeWorld({ running: (_ticketId, assignmentId) => assignmentId === current })
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'codex', prompt: 'slow work', permission: 'read' })
    current = 'a2'
    const done = await settled(world.runs, ticket.id, run.id)
    expect(done).toMatchObject({ status: 'done', assignmentId: 'a1', externalId: 'codex-session-1', result: { text: `finished in ${world.dir}` } })
    expect(world.delivered).toHaveLength(0)
  })

  it('stops a run, marks it stopped, and reports the stop as confirmed only after the process exited', async () => {
    process.env.FAKE_AGENT_MODE = 'sleep'
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'claude', prompt: 'hold on', permission: 'read' })
    await vi.waitFor(() => expect(world.invocations()).toHaveLength(1))
    const result = await world.runs.stopAll(ticket.id, 'ticket ended')
    expect(result.confirmed).toBe(true)
    expect(result.runs.map(entry => entry.status)).toEqual(['stopped'])
    expect(world.exits.filter(entry => entry.argv.includes(FIXTURE))).toHaveLength(1)
    const stopped = world.runs.status(ticket.id, run.id)
    expect(stopped).toMatchObject({ status: 'stopped' })
    expect((stopped as AgentRun).error).toContain('ticket ended')
  })

  it('confirms a single stop with the run record it settled', async () => {
    process.env.FAKE_AGENT_MODE = 'sleep'
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'claude', prompt: 'hold on', permission: 'read' })
    await vi.waitFor(() => expect(world.invocations()).toHaveLength(1))
    const { run: stopped, confirmed } = await world.runs.stop(ticket.id, run.id, 'stop now')
    expect(confirmed).toBe(true)
    expect(stopped).toMatchObject({ id: run.id, status: 'stopped', error: 'Stopped: stop now' })
    expect(stopped.stopRequestedAt).toBeTruthy()
    expect(stopped.stopUnconfirmed).toBeUndefined()
  })

  it('keeps a process that ignores the stop running, and settles it as stopped only when it is really gone', async () => {
    process.env.FAKE_AGENT_MODE = 'stubborn'
    const world = await makeWorld({ stopMs: 100 })
    const release = join(world.dir, 'allow-exit')
    process.env.FAKE_AGENT_EXIT_FILE = release
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'claude', prompt: 'hold on', permission: 'read' })
    try {
      await vi.waitFor(() => expect(world.invocations()).toHaveLength(1))
      const { run: still, confirmed } = await world.runs.stop(ticket.id, run.id, 'stop now')
      // The process survived the bound: the run is still running, so its write slot is not released.
      expect(confirmed).toBe(false)
      expect(still).toMatchObject({ status: 'running', stopUnconfirmed: true })
      expect(still.stopRequestedAt).toBeTruthy()
    } finally {
      await writeFile(release, '')
      await settled(world.runs, ticket.id, run.id)
    }
    const done = await settled(world.runs, ticket.id, run.id, 5000)
    expect(done).toMatchObject({ status: 'stopped' })
    expect(done.stopUnconfirmed).toBeUndefined()
    expect(done.error).toContain('stop now')
  })

  it('reports stopAll as unconfirmed instead of recording a stop the process did not make', async () => {
    process.env.FAKE_AGENT_MODE = 'stubborn'
    const world = await makeWorld({ stopMs: 100 })
    const release = join(world.dir, 'allow-exit')
    process.env.FAKE_AGENT_EXIT_FILE = release
    const ticket = world.tickets[0]!
    const run = world.runs.start(ticket, { agent: 'claude', prompt: 'hold on', permission: 'read' })
    try {
      await vi.waitFor(() => expect(world.invocations()).toHaveLength(1))
      const result = await world.runs.stopAll(ticket.id, 'ticket ended')
      expect(result.confirmed).toBe(false)
      expect(result.runs).toHaveLength(1)
      expect(result.runs[0]).toMatchObject({ id: run.id, status: 'running', stopUnconfirmed: true })
      expect(world.runs.status(ticket.id, run.id)).toMatchObject({ status: 'running' })
    } finally {
      await writeFile(release, '')
      await settled(world.runs, ticket.id, run.id)
    }
  })

  it('refuses an agent the host cannot run, for reading as well as writing', async () => {
    const world = await makeWorld({ probe: () => [{ kind: 'claude', available: false, detail: 'This host cannot constrain claude.',
      repair: 'Install sandbox-exec.' }] })
    const ticket = world.tickets[0]!
    expect(() => world.runs.start(ticket, { agent: 'claude', prompt: 'inspect', permission: 'read' }))
      .toThrow('This host cannot constrain claude. Install sandbox-exec.')
    expect(world.invocations()).toHaveLength(0)
    // A codex run is not in this probe at all, so this runner does not block it.
    const run = world.runs.start(ticket, { agent: 'codex', prompt: 'inspect', permission: 'read' })
    expect(run.agent).toBe('codex')
    await world.runs.stopAll(ticket.id, 'test over')
  })

  it('gives the agent a private 0700 home and none of the host credentials', async () => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, DSH_HOME: process.env.DSH_HOME, FEISHU_APP_ID: process.env.FEISHU_APP_ID,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID }
    process.env.GH_TOKEN = 'ghp_secret'; process.env.DSH_HOME = '/host/dsh-home'; process.env.FEISHU_APP_ID = 'cli_secret'
    process.env.SSH_AUTH_SOCK = '/tmp/ssh.sock'; process.env.AWS_ACCESS_KEY_ID = 'AKIA_SECRET'
    try {
      const world = await makeWorld()
      const ticket = world.tickets[0]!
      const run = world.runs.start(ticket, { agent: 'claude', prompt: 'inspect', permission: 'read' })
      await settled(world.runs, ticket.id, run.id)
      const call = world.invocations()[0]!
      expect(call.home).not.toBe(process.env.HOME)
      expect(call.home).toContain('dsh-agent-home-')
      expect(call.tmp).toBe(call.home)
      expect(call.homeMode).toBe(0o700)
      expect(call.ghToken).toBeNull()
      expect(call.dshHome).toBeNull()
      expect(call.feishu).toBeNull()
      expect(call.sshSock).toBeNull()
      expect(call.awsKey).toBeNull()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('records a write run\'s paths outside the ticket scope for approval, and none when the scope covers them', async () => {
    process.env.FAKE_AGENT_MODE = 'ok'
    process.env.FAKE_AGENT_WRITE_FILE = 'outside.txt'
    const world = await makeWorld()
    await runFile('git', ['init'], { cwd: world.dir, env: gitEnv() })
    const ticket = world.tickets[0]!
    ticket.scope = ['src']
    const run = world.runs.start(ticket, { agent: 'claude', prompt: 'write it', permission: 'write' })
    const done = await settled(world.runs, ticket.id, run.id)
    expect(done.status).toBe('done')
    // The fixture's own invocation log is untracked in the workspace too; the assertion is that the out-of-scope path is listed.
    expect(world.values.get(KV.executor.overrun(ticket.id))).toMatchObject({ runId: run.id, paths: expect.arrayContaining(['outside.txt']) })
    expect(world.delivered.at(-1)!.text).toContain('outside this ticket\'s scope')
    expect(world.delivered.at(-1)!.text).toContain('- outside.txt')

    // Clear the first run's file, so only this run's own writes are judged.
    await unlink(join(world.dir, 'outside.txt'))
    process.env.FAKE_AGENT_WRITE_FILE = 'inside.txt'
    ticket.scope = ['inside.txt', 'invocations.ndjson']
    const covered = world.runs.start(ticket, { agent: 'claude', prompt: 'write inside', permission: 'write' })
    await settled(world.runs, ticket.id, covered.id)
    // A covered run neither creates nor clears an overrun another run still awaits approval for.
    expect(world.values.get(KV.executor.overrun(ticket.id))).toMatchObject({ runId: run.id })

    ticket.scope = undefined
    process.env.FAKE_AGENT_WRITE_FILE = 'anywhere.txt'
    const whole = world.runs.start(ticket, { agent: 'claude', prompt: 'write anywhere', permission: 'write' })
    await settled(world.runs, ticket.id, whole.id)
    expect(world.values.get(KV.executor.overrun(ticket.id))).toMatchObject({ runId: run.id })
  })

  it('refuses a write run while another ticket writes the repository and allows it once the slot is free', async () => {
    process.env.FAKE_AGENT_MODE = 'sleep'
    const refusal = 'Another ticket is writing in this repository: Ticket t2 (t2).'
    let blocked: string | undefined = refusal
    const world = await makeWorld({ writeRefusal: () => blocked })
    const ticket = world.tickets[0]!
    expect(() => world.runs.start(ticket, { agent: 'claude', prompt: 'write now', permission: 'write' })).toThrow(refusal)
    const read = world.runs.start(ticket, { agent: 'claude', prompt: 'read now', permission: 'read' })
    blocked = undefined
    const write = world.runs.start(ticket, { agent: 'claude', prompt: 'write later', permission: 'write' })
    expect(write.permission).toBe('write')
    expect(write.id).not.toBe(read.id)
    await world.runs.stopAll(ticket.id, 'test over')
  })

  it('keeps run records durable across a fresh runner and bounds the ticket index', async () => {
    process.env.FAKE_AGENT_TEXT = 'durable'
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const first = world.runs.start(ticket, { agent: 'claude', prompt: 'first', permission: 'read' })
    const done = await settled(world.runs, ticket.id, first.id)
    expect(done.result?.text).toBe('durable')
    const fresh = new AgentRuns(world.host, { binaries: BINARIES, probe: fixtureProbe })
    expect(fresh.status(ticket.id, first.id)).toMatchObject({ status: 'done', result: { text: 'durable' } })

    const base: AgentRun = { id: 'old-0', ticketId: ticket.id, assignmentId: 'a1', agent: 'claude', permission: 'read', prompt: 'old',
      status: 'done', directory: world.dir, startedAt: '2026-05-01T00:00:00.000Z', endedAt: '2026-05-01T00:00:01.000Z' }
    const old = Array.from({ length: 20 }, (_, index) => `old-${index}`)
    old.forEach((id, index) => world.values.set(KV.executor.agentRun(ticket.id, id), { ...base, id, prompt: `old ${String(index)}` }))
    world.values.set(KV.executor.agentRuns(ticket.id), old)
    const latest = world.runs.start(ticket, { agent: 'claude', prompt: 'newest', permission: 'read' })
    await settled(world.runs, ticket.id, latest.id)
    const index = world.values.get(KV.executor.agentRuns(ticket.id)) as string[]
    expect(index).toHaveLength(20)
    expect(index.at(-1)).toBe(latest.id)
    expect(index).not.toContain('old-0')
    expect(world.values.has(KV.executor.agentRun(ticket.id, 'old-0'))).toBe(false)
    expect(world.values.has(KV.executor.agentRun(ticket.id, 'old-1'))).toBe(true)
  })

  it('marks a run a restart cut off as interrupted and keeps its session', async () => {
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const stored: AgentRun = { id: 'cut-off', ticketId: ticket.id, assignmentId: 'a1', agent: 'claude', permission: 'read',
      prompt: 'old', status: 'running', externalId: 'claude-session-9', directory: world.dir, startedAt: '2026-05-01T00:00:00.000Z' }
    world.values.set(KV.executor.agentRun(ticket.id, stored.id), stored)
    world.values.set(KV.executor.agentRuns(ticket.id), [stored.id])
    const fresh = new AgentRuns(world.host, { binaries: BINARIES, probe: fixtureProbe })
    expect(fresh.status(ticket.id, stored.id)).toMatchObject({ status: 'interrupted', externalId: 'claude-session-9' })
  })

  it('continues a finished run through its external session', async () => {
    process.env.FAKE_AGENT_TEXT = 'first answer'
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const first = world.runs.start(ticket, { agent: 'claude', prompt: 'begin', permission: 'read' })
    const done = await settled(world.runs, ticket.id, first.id)
    const next = world.runs.resume(ticket, first.id, 'continue please')
    expect(next).toMatchObject({ resumeOf: first.id, externalId: done.externalId, status: 'running' })
    const second = await settled(world.runs, ticket.id, next.id)
    expect(second.status).toBe('done')
    const call = world.invocations()[1]!
    expect(call.args).toContain('--resume')
    expect(call.args).toContain('claude-session-1')
  })
})

describe('agent runs in the Executor', () => {
  it("stops the ticket's agent processes before releasing its write slot", async () => {
    process.env.FAKE_AGENT_MODE = 'sleep'
    // Exercise the real runner lifecycle with a controlled process, never the host's installed agent CLI.
    const ActualAgentRuns = AgentRuns
    const runner = vi.spyOn(agentsModule, 'AgentRuns').mockImplementation(function (host: AgentRunsHost) {
      return new ActualAgentRuns(host, { binaries: BINARIES, probe: fixtureProbe })
    } as unknown as typeof AgentRuns)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agents-executor-'))
    directories.push(dir)
    const invocationLog = join(dir, 'invocations.ndjson')
    process.env.FAKE_AGENT_LOG = invocationLog
    const ticket = ticketOf('t9', 'a9', dir)
    const settings = { executor: { workspaceMode: 'isolated', maxWorkers: 5 } } as unknown as Settings
    const order: string[] = []
    const { values, store } = memoryStore([ticket], order)
    const lifetime = new AbortController()
    lifetimes.push(lifetime)
    const { subprocess } = fixtureSubprocess(() => order.push('agent-exit'))
    const executor = new DshExecutor({
      context: { subprocess, agents: { get: () => undefined }, get: () => undefined } as unknown as Context,
      engine: {} as unknown as ExecutorHost['engine'],
      store: { ...store, triggers: { get: () => undefined }, settings: () => settings,
        atomic: <T>(operation: () => T) => operation(), afterCommit: (action: () => void) => action() } as unknown as ExecutorHost['store'],
      effects: { enqueue: vi.fn(), handle: vi.fn() } as unknown as ExecutorHost['effects'],
      health: { get: () => undefined, set: vi.fn(), release: vi.fn() },
      machine: { stateDir: dir },
      lifetime: lifetime.signal,
      sessions: { ensure: vi.fn(), prompt: vi.fn(async () => {}), promptedId: vi.fn(), relay: vi.fn(), holds: vi.fn(() => false) } as unknown as ExecutorHost['sessions'],
      closing: () => false,
      paused: () => false,
      environment: () => [],
      sourceLink: async () => ({}),
      repliedTo: () => undefined,
    })
    const agents = executor.agents
    if (!agents) throw new Error('The executor exposes no agents')
    const run = agents.start(ticket, { agent: 'claude', prompt: 'write it', permission: 'read' })
    await vi.waitFor(() => expect(readFileSync(invocationLog, 'utf8')).toContain('"agent":"claude"'))
    executor.stop(ticket, runningAssignment(ticket)!, 'ticket ended')
    await vi.waitFor(() => expect(order).toContain(KV.executor.scope(ticket.id)), { timeout: 5000 })
    expect(order.indexOf('agent-exit')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('agent-exit')).toBeLessThan(order.indexOf(KV.executor.scope(ticket.id)))
    expect(values.has(KV.executor.agentRun(ticket.id, run.id))).toBe(true)
    expect(agents.status(ticket.id, run.id)).toMatchObject({ status: 'stopped' })
    executor.dispose()
    runner.mockRestore()
  }, 15_000)
})

describe('orchestrator_agent', () => {
  /** A stub delegation that records what the tool asked for, so the tool's own choices are testable without a process. */
  const stubAgents = (calls: string[], probes: AgentProbe[] = fixtureProbe()): AgentDelegation => {
    const base: AgentRun = { id: 'run-1', ticketId: 't1', assignmentId: 'a1', agent: 'codex', permission: 'read', prompt: 'x',
      status: 'running', directory: '/work', startedAt: '2026-05-01T00:00:00.000Z' }
    return {
      start: (_ticket, request) => { calls.push(`start:${request.agent}`); return { ...base, agent: request.agent, prompt: request.prompt } },
      resume: () => base,
      status: () => base,
      stop: async () => ({ run: { ...base, status: 'stopped' }, confirmed: true }),
      stopAll: async () => ({ confirmed: true, runs: [] }),
      probe: () => probes,
    }
  }
  const toolOf = (agents: AgentDelegation, agent: string | undefined) => {
    const settings = { executor: agent ? { agent } : {} } as unknown as Settings
    const host = { agents, sendReplies: vi.fn(), engine: {}, store: { settings: () => settings }, sessions: {}, resources: {},
      github: { deployment: { github: { login: 'alice' } } } }
    return executorTools(host as unknown as ExecutorToolsHost, ticketOf('t1', 'a1', '/work'))
      .find(candidate => candidate.name === 'orchestrator_agent')!
  }

  it('reports the ticket runs through the worker tool', async () => {
    process.env.FAKE_AGENT_MODE = 'sleep'
    const world = await makeWorld()
    const ticket = world.tickets[0]!
    const host = { agents: world.runs, sendReplies: vi.fn(), engine: {}, store: {}, sessions: {}, resources: {},
      github: { deployment: { github: { login: 'alice' } } } }
    const tool = executorTools(host as unknown as ExecutorToolsHost, ticket).find(candidate => candidate.name === 'orchestrator_agent')!
    const run = await tool.execute({ action: 'run', agent: 'claude', prompt: 'hold on' }, new AbortController().signal) as { run: { run_id: string } }
    const listed = await tool.execute({ action: 'status' }, new AbortController().signal) as { runs: { run_id: string }[] }
    expect(listed.runs.map(entry => entry.run_id)).toContain(run.run.run_id)
    const stopped = await tool.execute({ action: 'stop', run_id: run.run.run_id }, new AbortController().signal) as { run: { status: string }; confirmed: boolean }
    expect(stopped.run.status).toBe('stopped')
    expect(stopped.confirmed).toBe(true)
    await unlink(join(world.dir, 'invocations.ndjson')).catch(() => undefined)
  })

  it('runs the configured default agent when the caller names none', async () => {
    const calls: string[] = []
    const tool = toolOf(stubAgents(calls), 'codex')
    const answer = await tool.execute({ action: 'run', prompt: 'go' }, new AbortController().signal) as { run: { agent: string } }
    expect(calls).toEqual(['start:codex'])
    expect(answer.run.agent).toBe('codex')
  })

  it('says where to configure a default agent when neither side chose one', async () => {
    const tool = toolOf(stubAgents([]), undefined)
    await expect(tool.execute({ action: 'run', prompt: 'go' }, new AbortController().signal))
      .rejects.toThrow('set the default execution agent in Settings')
  })

  it('refuses an explicitly chosen agent the host cannot run, with the repair', async () => {
    const calls: string[] = []
    const tool = toolOf(stubAgents(calls, [{ kind: 'codex', available: true }, { kind: 'claude', available: false,
      detail: 'This host cannot constrain claude.', repair: 'Install sandbox-exec.' }]), 'codex')
    await expect(tool.execute({ action: 'run', agent: 'claude', prompt: 'go' }, new AbortController().signal))
      .rejects.toThrow('This host cannot constrain claude. Install sandbox-exec.')
    expect(calls).toEqual([])
  })
})
