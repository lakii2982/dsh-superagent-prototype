import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, SETUP_FIELDS, type Machine, type Probe } from '../src/deployment.ts'
import { publishManagerOrigin } from '../src/manager/protocol.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('follows the current manager port across desktop restarts from a running repository', () => {
    const stateDir = join(dir, 'repositories', 'widget')
    const url = 'http://127.0.0.1:3001'
    const worker = machineOf(Config({ stateDir, managed: { repositoryId: 'widget', url, token: 'fixture' } }))
    expect(worker.managed?.url).toBe(url)
    publishManagerOrigin(dir, 'http://127.0.0.1:3002')
    expect(worker.managed?.url).toBe('http://127.0.0.1:3002')
    publishManagerOrigin(dir, 'http://127.0.0.1:3003')
    expect(worker.managed?.url).toBe('http://127.0.0.1:3003')
    expect(() => publishManagerOrigin(dir, 'https://example.com')).toThrow('loopback')
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
  it('resolves managed bot identities through the repository bridge without running a configured local CLI', async () => {
    const managed = { repositoryId: 'repository-a', url: 'http://127.0.0.1:3082', token: 'private-repository-token' }
    const bot = { id: 'registry-a', botId: 'ou_botA', appId: 'cli_botA', name: 'Team A', brand: 'feishu', legacy: true }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ bots: [{ ...bot, cli: '/private/bot-cli' }] }))
    const localProbe = vi.fn<Probe>()
    const resolved = await resolveFeishuBot(machine({ managed }), { cli: '/must-not-run' }, localProbe, '/empty-path')
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3082/orchestrator/internal/repository-a/feishu-bots', expect.objectContaining({
      headers: { authorization: 'Bearer private-repository-token' }, redirect: 'error', signal: expect.any(AbortSignal),
    }))
    expect(localProbe).not.toHaveBeenCalled()
    expect(resolved).toEqual({ cli: 'dsh-manager-bridge', registryId: bot.id, botId: bot.botId, appId: bot.appId,
      name: bot.name, brand: bot.brand, legacy: true, managedBots: [bot] })
    expect(resolved?.managedBots?.[0]).not.toHaveProperty('cli')
    expect(JSON.stringify(resolved)).not.toContain(managed.token)
  })
  it('pins every standalone identity probe to its explicit CLI profile and retains the selected profile', async () => {
    const selectedProfile = 'team-a'
    const scopedProbe = vi.fn<Probe>(async argv => {
      expect(argv.at(-1)).toBe(`--profile=${selectedProfile}`)
      expect(argv.filter(arg => arg.startsWith('--profile'))).toHaveLength(1)
      const command = argv.slice(4, -1).join(' ')
      if (command === 'auth status') return JSON.stringify({ appId: 'cli_teamA', brand: 'feishu', identities: { bot: { status: 'ready' } } })
      if (command === 'config strict-mode') return 'strict-mode: bot (source: profile)'
      if (command === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') return JSON.stringify({ bot: { open_id: 'ou_teamA', app_name: 'Team A' } })
      throw new Error(`Unexpected probe: ${command}`)
    })
    const resolved = await resolveFeishuBot(machine(), { cli: 'lark-cli', profile: ' team-a ' }, scopedProbe, path)
    expect(resolved).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_teamA', brand: 'feishu', botId: 'ou_teamA', name: 'Team A', profile: selectedProfile })
    expect(scopedProbe).toHaveBeenCalledTimes(3)
    expect(SETUP_FIELDS.feishu).toContain('profile')
  })
  it('keeps every associated bot identity and labels multiple managed bots without claiming one shared bot', async () => {
    const bots = [
      { id: 'new', botId: 'ou_new', appId: 'cli_new', name: 'New', brand: 'lark', legacy: false },
      { id: 'existing', botId: 'ou_existing', appId: 'cli_existing', name: 'Existing', brand: 'feishu', legacy: true },
    ]
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ bots }))
    const managed = { repositoryId: 'repository-a', url: 'http://127.0.0.1:3082', token: 'fixture' }
    const localProbe = vi.fn<Probe>()
    const resolved = await resolveFeishuBot(machine({ managed }), {}, localProbe)
    expect(resolved).toMatchObject({ registryId: 'existing', name: '管理器按绑定路由（2 个机器人）', managedBots: bots })
    expect(localProbe).not.toHaveBeenCalled()
    fetcher.mockResolvedValueOnce(Response.json({ bots: [] }))
    expect(await resolveFeishuBot(machine({ managed }), { cli: 'lark-cli' }, localProbe, path)).toBeUndefined()
    expect(localProbe).not.toHaveBeenCalled()
  })
  it('fails closed when managed identities cannot be authenticated or validated, without a local CLI fallback', async () => {
    const managed = { repositoryId: 'repository-a', url: 'http://127.0.0.1:3082', token: 'fixture' }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }))
    const localProbe = vi.fn<Probe>()
    const resolve = () => resolveFeishuBot(machine({ managed }), { cli: 'lark-cli' }, localProbe, path)
    await expect(resolve()).rejects.toEqual(setupError('feishu', 'feishuCliFailed', { output: expect.stringContaining('HTTP 403') }))
    fetcher.mockResolvedValueOnce(Response.json({ bots: [{ id: 'bot', botId: 'invalid', appId: 'cli_valid' }] }))
    await expect(resolve()).rejects.toEqual(setupError('feishu', 'feishuCliFailed'))
    const identity = { id: 'duplicate', botId: 'ou_bot', appId: 'cli_bot' }
    fetcher.mockResolvedValueOnce(Response.json({ bots: [identity, identity] }))
    await expect(resolve()).rejects.toEqual(setupError('feishu', 'feishuCliFailed', { output: expect.stringContaining('Duplicate managed bot identities') }))
    expect(localProbe).not.toHaveBeenCalled()
  })
  it('never sends a managed repository credential to an untrusted manager origin', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'), localProbe = vi.fn<Probe>()
    const managed = { repositoryId: 'repository-a', url: 'https://example.com', token: 'fixture-private-token' }
    await expect(resolveFeishuBot(machine({ managed }), {}, localProbe)).rejects.toEqual(setupError('feishu', 'feishuCliFailed'))
    expect(fetcher).not.toHaveBeenCalled()
    expect(localProbe).not.toHaveBeenCalled()
  })
})
