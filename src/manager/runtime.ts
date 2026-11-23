/** Unified local manager: independent Feishu bots, deterministic group routing, isolated repository processes. */
import type { Context } from '@deepseek-ai/cordis'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { SetupError } from '../setup.ts'
import { Commands } from '../infra/commands.ts'
import { verifyRepository } from '../infra/repository.ts'
import { executable, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type DesktopModeView, type Machine } from '../deployment.ts'
import { workerBin } from '../infra/environment.ts'
import { packagePath } from '../infra/paths.ts'
import { sameOrigin } from '../app/http.ts'
import type { SourceContext } from '../sources/host.ts'
import { runFeishu } from '../sources/feishu-loops.ts'
import { scopeManagedFeishuTrigger } from '../sources/feishu-trigger.ts'
import { feishuKind, MembersSchema, type FeishuConfig } from '../sources/feishu.ts'
import { KV } from '../kv.ts'
import { LIMITS } from '../limits.ts'
import { key, type Trigger } from '../core/index.ts'
import type { Health } from '../sources/host.ts'
import { ManagerStore, RepositorySchema, BindingSchema, type Repository, type BotConnection, type Binding } from './store.ts'
import { readiness } from './readiness.ts'
import { authorized, bridgeOptions, FeishuTriggerSchema, publishManagerOrigin } from './protocol.ts'
import { loadOperatorAuth, OPERATOR_AUTH_REQUIRED } from './operator-auth.ts'
import { instanceHealth, instanceRequest, instanceUiUrl, provision, startInstance, type InstanceHealth } from './instances.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1048576) throw new Error('Request exceeds 1 MiB'); chunks.push(bytes) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  res.end(JSON.stringify(value))
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const PILOT_MODE_MISMATCH = 'Repository instance is not running in enterprise pilot mode; use a dedicated pilot state directory'
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)) })
})

/** Manager-owned commands verify the selected identity immediately before every read or send. */
class BotCommands extends Commands {
  constructor(private readonly currentDeployment: () => Deployment, private readonly currentSignal: AbortSignal,
    private readonly verifyIdentity: () => Promise<void>) { super(currentDeployment, {}, currentSignal) }
  override withSignal(signal?: AbortSignal): Commands {
    return signal ? new BotCommands(this.currentDeployment, AbortSignal.any([this.currentSignal, signal]), this.verifyIdentity) : this
  }
  override async verifyFeishuIdentity(): Promise<void> { await this.verifyIdentity() }
  override async lark<T>(args: string[], cwd?: string): Promise<T> {
    await this.verifyFeishuIdentity()
    return super.lark<T>(args, cwd)
  }
}
interface BotRuntime {
  bot?: Deployment['feishu']; commands?: Commands
  consumer?: { abort: AbortController; done: Promise<unknown> }
  health: Map<string, Health>; fingerprint?: string; retryAt?: number; failures?: number
}
/** Supervises repository instances and routes Feishu events without making domain decisions. */
export class Manager {
  readonly store: ManagerStore
  private readonly lifetime = new AbortController()
  private readonly health = new Map<string, Health>()
  private readonly instances = new Map<string, { online: boolean; configured?: boolean; paused?: boolean; error?: string; state?: string
    agent?: InstanceHealth['agent'] }>()
  private readonly probes = new Map<string, Promise<InstanceHealth | undefined>>()
  private readonly starting = new Set<string>()
  private readonly children = new Map<string, ChildProcess>()
  private readonly maxRunningRepositories: number
  private readonly enterprisePilot: boolean
  private readonly requireProtectedBranches: boolean
  private readonly operatorAuthorized?: (authorization: string | undefined) => boolean
  private readonly desktopMode?: () => DesktopModeView
  private switchingMode = false
  private readonly botRuntimes = new Map<string, BotRuntime>()
  private readonly connectingBots = new Map<string, Promise<void>>()
  private readonly botIdentityChecks = new Map<string, Promise<void>>()
  private legacyRetryAt = 0
  private legacyRecovery?: Promise<void>
  private ticking?: Promise<void>
  private readonly requests = new Set<Promise<void>>()
  private closed = false
  private readonly unlock: () => void
  private timer?: ReturnType<typeof setInterval>
  private disposeHttp?: () => void
  constructor(private readonly ctx: Context, private readonly machine: Machine,
    options: { maxRunningRepositories?: number; enterprisePilot?: boolean; requireProtectedBranches?: boolean; operatorTokenFile?: string;
      desktopMode?: () => DesktopModeView } = {}) {
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('The manager requires a loopback web server')
    this.maxRunningRepositories = options.maxRunningRepositories ?? LIMITS.maxRunningRepositories.default
    this.enterprisePilot = options.enterprisePilot ?? false
    this.requireProtectedBranches = options.requireProtectedBranches ?? false
    this.desktopMode = options.desktopMode
    if (options.operatorTokenFile !== undefined) this.operatorAuthorized = loadOperatorAuth(options.operatorTokenFile)
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    this.unlock = lockSync(machine.stateDir)
    try { this.store = new ManagerStore(machine.stateDir) } catch (error) { this.unlock(); throw error }
  }
  private get origin(): string { return `http://127.0.0.1:${this.ctx.webServer.port}` }
  private async checkProtectedBranch(repository: Repository): Promise<void> {
    if (!this.requireProtectedBranches && !repository.requiredChecks?.length) return
    const githubCli = executable(repository.githubCli, process.env.PATH ?? '', workerBin(this.machine.stateDir))
    // The installer and the supervisor share the same gate, including named CI checks and failure messages.
    const moduleUrl = pathToFileURL(packagePath('ops', 'enterprise', 'check-branches.mjs')).href
    const { checkBranchRules } = await import(moduleUrl) as {
      checkBranchRules(input: Pick<Repository, 'remote' | 'githubCli' | 'requiredChecks'>, options: { signal: AbortSignal }): Promise<unknown>
    }
    await checkBranchRules({ remote: repository.remote, githubCli, requiredChecks: repository.requiredChecks }, { signal: this.lifetime.signal })
  }
  async start(): Promise<void> {
    publishManagerOrigin(this.machine.stateDir, this.origin)
    // Count surviving instances before accepting any new start on a restarted manager.
    await Promise.all(this.store.repositories().map(repository => this.refreshInstance(repository)))
    if (this.closed) return
    this.disposeHttp = this.ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: (req, res) => { const request = this.http(req, res); this.requests.add(request); void request.finally(() => this.requests.delete(request)); return request } })
    await this.connectBots()
    this.timer = setInterval(() => { if (!this.ticking) this.ticking = this.tick().finally(() => { this.ticking = undefined }) }, 2000)
    this.timer.unref?.()
  }
  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true; if (this.timer) clearInterval(this.timer)
    this.disposeHttp?.(); this.lifetime.abort()
    for (const runtime of this.botRuntimes.values()) runtime.consumer?.abort.abort()
    await Promise.allSettled([...this.botRuntimes.values()].map(runtime => runtime.consumer?.done))
    await this.ticking; await Promise.allSettled([...this.connectingBots.values(), ...this.botIdentityChecks.values(), this.legacyRecovery, ...this.requests])
    this.store.close(); this.unlock()
    // Repository processes deliberately survive a manager restart; authenticated health probes rediscover them.
  }
  private botKey(botId: string, name: string): string {
    return this.store.bots().find(bot => bot.id === botId)?.legacy ? name : `bot:${botId}:${name}`
  }
  private botChats(botId: string): Record<string, string> {
    return this.store.get<Record<string, string>>(this.botKey(botId, KV.sources.labels('feishu'))) ?? {}
  }
  private singleBot(): BotConnection {
    const bots = this.store.bots()
    if (bots.length !== 1) throw new Error(bots.length ? 'Choose a specific Feishu bot' : 'Connect the Feishu bot first')
    return bots[0]!
  }
  private repositoryBots(repositoryId: string): BotConnection[] {
    const ids = new Set(this.store.repositoryBotIds(repositoryId))
    return this.store.bots().filter(bot => ids.has(bot.id))
  }
  private availableBots(repositoryId: string): BotConnection[] {
    return this.repositoryBots(repositoryId).filter(bot => bot.enabled && this.botRuntimes.get(bot.id)?.bot)
  }
  private sourceContext(botId: string): SourceContext {
    const manager = this, runtime = this.botRuntimes.get(botId)!
    return {
      get deployment() { return { ...manager.machine, repository: '', github: { cli: 'gh', login: '', noreply: '' }, feishu: runtime.bot } },
      get commands() { return runtime.commands! }, ready: Promise.resolve(), configured: () => !!runtime.bot,
      config: <C extends Record<string, unknown>>() => {
        const bot = manager.store.bots().find(item => item.id === botId)
        if (!bot?.enabled) return undefined
        const chats = manager.store.bindings().filter(item => item.enabled && manager.store.bindingBotId(item) === botId)
          .map(item => ({ chatId: item.chatId, listen: 'mentions' }))
        return feishuKind.schema.parse({ cli: bot.cli, ...(bot.profile ? { profile: bot.profile } : {}), chats, directMessages: false, otherChats: 'none' }) as unknown as C
      },
      receive: trigger => manager.store.route(trigger, botId), atomic: work => manager.store.atomic(work),
      state: { get: name => manager.store.get(manager.botKey(botId, name)), set: (name, value) => manager.store.set(manager.botKey(botId, name), value), keys: () => [] },
      threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
      tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
      triggers: { get: () => undefined, latest: () => undefined }, notify: () => {},
      report: (name, value) => { runtime.health.set(name, value) },
    }
  }
  /** Upgrade the existing connection only after verifying its original identity; historical IDs remain unchanged. */
  private async connectBots(): Promise<void> {
    const cli = this.store.get<string>('bot-cli')
    if (!this.store.legacyBotId() && cli) {
      try {
        const verified = await this.verifyBot(cli)
        if (this.closed) return
        const expected = this.store.get<string>('bot-id')
        if (expected && expected !== verified.botId) throw new Error('The legacy Feishu CLI changed bot identity; restore its original account')
        if (!this.store.legacyBotId()) {
          await this.assertExclusiveCli(verified)
          this.store.saveBot({ id: randomUUID(), ...verified, cli, enabled: true, legacy: true }, this.store.revision())
        }
        this.health.delete('feishu')
      } catch (error) { this.legacyRetryAt = Date.now() + 10_000; this.health.set('feishu', { state: 'error', detail: errorText(error) }); return }
    }
    await Promise.all(this.store.bots().map(bot => this.connectBot(bot.id)))
  }
  private async verifyBot(cli: string, profile?: string): Promise<NonNullable<Deployment['feishu']>> {
    const bot = await resolveFeishuBot(this.machine, { cli, ...(profile ? { profile } : {}) }, workerProbe(this.ctx.subprocess, this.machine.stateDir, this.machine.stateDir, this.lifetime.signal))
    if (!bot) throw new Error('The bot could not be verified')
    return bot
  }
  private async assertExclusiveCli(verified: NonNullable<Deployment['feishu']>, exclude?: string): Promise<void> {
    const target = await realpath(verified.cli)
    for (const record of this.store.bots()) {
      if (record.id === exclude || (record.profile ?? '') !== (verified.profile ?? '')) continue
      let candidate: string
      try { candidate = await realpath(executable(record.cli, process.env.PATH ?? '', workerBin(this.machine.stateDir))) }
      catch { continue /* A removed executable cannot alias the verified connection. */ }
      if (candidate === target) throw new Error('This CLI and profile already belong to another bot connection')
    }
  }
  private verifyTransport(botId: string): Promise<void> {
    const pending = this.botIdentityChecks.get(botId)
    if (pending) return pending
    const check = (async () => {
      const record = this.store.bots().find(bot => bot.id === botId), runtime = this.botRuntimes.get(botId)
      if (!record?.enabled || !runtime?.bot) throw new Error('This bot connection is unavailable')
      try {
        const actual = await this.verifyBot(record.cli, record.profile)
        if (this.closed || this.botRuntimes.get(botId) !== runtime) throw new Error('The bot connection changed during identity verification')
        const current = this.store.bots().find(bot => bot.id === botId)
        if (!current?.enabled || current.cli !== record.cli || current.profile !== record.profile) throw new Error('The bot connection changed during identity verification')
        if (actual.botId !== record.botId || actual.appId !== record.appId || actual.brand !== record.brand) throw new Error('The CLI profile now belongs to a different bot; restore its original identity')
      } catch (error) {
        runtime.consumer?.abort.abort(); runtime.bot = undefined; runtime.fingerprint = undefined
        runtime.retryAt = Date.now() + 2000
        runtime.health.set('feishu', { state: 'error', detail: errorText(error) })
        throw error
      }
    })().finally(() => { if (this.botIdentityChecks.get(botId) === check) this.botIdentityChecks.delete(botId) })
    this.botIdentityChecks.set(botId, check)
    return check
  }
  private connectBot(botId: string): Promise<void> {
    const previous = this.connectingBots.get(botId)
    if (previous) return previous.then(() => this.connectBot(botId))
    const connecting = this.reconnectBot(botId).finally(() => {
      if (this.connectingBots.get(botId) === connecting) this.connectingBots.delete(botId)
    })
    this.connectingBots.set(botId, connecting)
    return connecting
  }
  private async reconnectBot(botId: string): Promise<void> {
    const record = this.store.bots().find(bot => bot.id === botId)
    if (!record) return
    const previous = this.botRuntimes.get(botId)
    const fingerprint = JSON.stringify({ cli: record.cli, profile: record.profile, enabled: record.enabled,
      chats: this.store.bindings().filter(binding => binding.enabled && this.store.bindingBotId(binding) === botId).map(binding => binding.chatId).sort() })
    if (previous?.fingerprint === fingerprint) return
    previous?.consumer?.abort.abort(); await previous?.consumer?.done
    if (this.closed) return
    const runtime: BotRuntime = { health: new Map(), fingerprint }
    this.botRuntimes.set(botId, runtime)
    if (!record.enabled) { runtime.health.set('feishu', { state: 'paused', detail: 'Bot connection is disabled' }); return }
    try {
      const bot = await this.verifyBot(record.cli, record.profile)
      if (bot.botId !== record.botId || bot.appId !== record.appId || bot.brand !== record.brand) throw new Error('The CLI now belongs to a different bot; restore this connection or add that bot separately')
      const current = this.store.bots().find(item => item.id === botId)
      if (this.closed || this.botRuntimes.get(botId) !== runtime) return
      const currentFingerprint = current ? JSON.stringify({ cli: current.cli, profile: current.profile, enabled: current.enabled,
        chats: this.store.bindings().filter(binding => binding.enabled && this.store.bindingBotId(binding) === botId).map(binding => binding.chatId).sort() }) : undefined
      if (currentFingerprint !== fingerprint) { runtime.fingerprint = undefined; runtime.retryAt = Date.now(); return }
      runtime.bot = bot
      const deployment = { ...this.machine, repository: '', github: { cli: 'gh', login: '', noreply: '' }, feishu: bot }
      runtime.commands = new BotCommands(() => deployment, this.lifetime.signal, () => this.verifyTransport(botId))
      if (!this.store.bindings().some(binding => binding.enabled && this.store.bindingBotId(binding) === botId)) {
        runtime.health.set('feishu', { state: 'paused', detail: 'Bot connected; no group binding is enabled' }); return
      }
      const abort = new AbortController(), done = runFeishu(this.sourceContext(botId), abort.signal)
      runtime.consumer = { abort, done }
    } catch (error) {
      runtime.fingerprint = undefined; runtime.failures = (previous?.failures ?? 0) + 1
      runtime.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(runtime.failures, 6))
      runtime.health.set('feishu', { state: 'error', detail: errorText(error) })
    }
  }
  private async chatMembers(botId: string, chatId: string) {
    const runtime = this.botRuntimes.get(botId)
    if (!runtime?.bot || !runtime.commands || !Object.hasOwn(this.botChats(botId), chatId)) throw new Error('Choose a known group for this bot')
    const members = MembersSchema.parse(await runtime.commands.lark(['im', '+chat-members-list', '--chat-id', chatId,
      '--member-types', 'user', '--page-all', '--page-limit', '0']))
    if (members.has_more || members.truncations?.length) throw new Error('Could not read the full group member list')
    return members
  }
  private pilotMatches(status: InstanceHealth): boolean {
    return !this.enterprisePilot || status.enterprisePilot === true
  }
  private async assertPilotInstance(repository: Repository): Promise<void> {
    if (!this.enterprisePilot) return
    const status = await this.refreshInstance(repository)
    if (!status) throw new Error('Repository instance is not reachable')
    if (!this.pilotMatches(status)) throw new Error(PILOT_MODE_MISMATCH)
  }
  /** Share a probe between the scheduler and startup so an older result cannot overwrite a newer one. */
  private refreshInstance(repository: Repository): Promise<InstanceHealth | undefined> {
    const running = this.probes.get(repository.id)
    if (running) return running
    const probe = instanceHealth(repository).then(status => {
      const matches = this.pilotMatches(status)
      this.instances.set(repository.id, { online: true, configured: matches && status.configured, paused: status.paused, ...(status.state ? { state: status.state } : {}),
        ...(status.agent ? { agent: status.agent } : {}), ...(!matches ? { error: PILOT_MODE_MISMATCH } : {}) })
      return status
    }, () => { this.instances.set(repository.id, { online: false }); return undefined })
      .finally(() => this.probes.delete(repository.id))
    this.probes.set(repository.id, probe)
    return probe
  }
  private runningRepositories(): number {
    // A child continues to hold its slot while alive even if its HTTP health check times out.
    const occupied = new Set([...this.starting, ...this.children.keys()])
    for (const [id, status] of this.instances) if (status.online) occupied.add(id)
    return occupied.size
  }
  /** Detached workers remain alive when the manager closes, so returning modes requires stopping them first. */
  desktopModeBlocked(): boolean { return this.runningRepositories() !== 0 }
  prepareDesktopModeSwitch(): boolean {
    if (this.desktopModeBlocked()) return false
    this.switchingMode = true
    return true
  }
  cancelDesktopModeSwitch(): void { this.switchingMode = false }
  private async tick(): Promise<void> {
    try {
      if (!this.store.legacyBotId() && this.store.get<string>('bot-cli') && Date.now() >= this.legacyRetryAt && !this.legacyRecovery) {
        this.legacyRecovery = this.connectBots().finally(() => { this.legacyRecovery = undefined })
      }
      // Reconnect failed identities independently; a slow verification never delays another bot's deliveries.
      for (const bot of this.store.bots()) {
        const runtime = this.botRuntimes.get(bot.id)
        if (!bot.enabled || runtime?.bot || this.connectingBots.has(bot.id) || (runtime?.retryAt ?? 0) > Date.now()) continue
        const reconnect = this.connectBot(bot.id).finally(() => this.requests.delete(reconnect))
        this.requests.add(reconnect)
      }
      const repositories = this.store.repositories()
      const eligible = new Map<string, Repository>()
      await Promise.all(repositories.map(async repository => {
        const status = await this.refreshInstance(repository)
        if (!status?.configured || this.closed || !this.pilotMatches(status)) return
        const current = this.instances.get(repository.id)
        try { await this.syncGroups(repository) }
        catch (error) {
          // Keep the health this tick already read, including the agent probe, while adding the group-sync error.
          if (this.instances.get(repository.id) === current) this.instances.set(repository.id, { ...current, online: true, configured: true, error: errorText(error) })
          return
        }
        if (repository.enabled) eligible.set(repository.id, repository)
      }))
      if (this.closed) return
      // A delivery pass releases the next message of a topic it completed; bounded so a stuck pass cannot spin.
      for (let pass = 0; pass < 20; pass++) {
        const connectedBots = new Set(this.store.bots().filter(bot => bot.enabled && this.botRuntimes.get(bot.id)?.bot).map(bot => bot.id))
        const items = this.store.pending(100, true, eligible, connectedBots)
        if (!items.length || this.closed) return
        let progress = false
        await Promise.all(items.map(async item => {
          const repository = eligible.get(item.repositoryId)!
          try {
            await instanceRequest(repository, 'receive', { repositoryId: repository.id, trigger: item.trigger })
            if (!this.closed) { this.store.delivered(item.id); progress = true }
          } catch (error) { if (!this.closed) { this.store.failed(item.id, errorText(error)); progress = true } }
        }))
        if (!progress) return
      }
    } catch (error) { if (!this.closed) this.health.set('delivery', { state: 'error', detail: errorText(error) }) }
  }
  private async syncGroups(repository: Repository): Promise<void> {
    const settings = await instanceRequest(repository, 'settings') as { sources: { id: string; revision: number; value: Record<string, unknown> }[] }
    const block = settings.sources.find(source => source.id === 'feishu')
    if (!block) throw new Error('The repository Feishu Source is not installed')
    const old = block.value as { enabled: boolean; config: FeishuConfig }
    const chats = this.store.chats(repository.id)
    const policy = (settings as unknown as { blocks: { policy: { revision: number; value: { sources: Record<string, { allowed: { id: string }[] }> } } } }).blocks.policy
    const botMembers = this.availableBots(repository.id).flatMap(bot => [...(bot.legacy ? repository.allowedFeishu : []), ...(repository.allowedFeishuByBot?.[bot.id] ?? [])])
    const desired = { ...policy.value, sources: { ...policy.value.sources,
      feishu: { ...policy.value.sources.feishu, allowed: [...new Set(botMembers)].map(id => ({ id })) },
      github: { ...policy.value.sources.github, allowed: repository.allowedGithub.map(id => ({ id })) } } }
    if (JSON.stringify(desired) !== JSON.stringify(policy.value)) await instanceRequest(repository, 'settings/policy', { revision: policy.revision, value: desired }, 'PUT')
    const cli = this.availableBots(repository.id).length ? 'dsh-manager-bridge' : ''
    if (old.config.cli === cli && JSON.stringify(old.config.chats.map(chat => chat.chatId).sort()) === JSON.stringify(chats.sort())) return
    await instanceRequest(repository, 'settings/source:feishu', { revision: block.revision,
      value: { ...old, config: { ...old.config, cli, chats: chats.map(chatId => ({ chatId, listen: 'mentions' })), directMessages: false, otherChats: 'none' } } }, 'PUT')
  }
  private view() {
    const repositories = this.store.repositories(), bindings = this.store.bindings(), counts = this.store.queueCounts()
    const bots = this.store.bots().map(bot => {
      const runtime = this.botRuntimes.get(bot.id)
      return { ...bot, connected: !!runtime?.bot, chats: this.botChats(bot.id), health: Object.fromEntries(runtime?.health ?? []) }
    })
    const legacy = bots.find(bot => bot.legacy) ?? (bots.length === 1 ? bots[0] : undefined)
    const health = { ...Object.fromEntries(this.health), ...(legacy ? legacy.health : {}) }
    const byChat = (rows: typeof counts): Record<string, number> => {
      const result: Record<string, number> = {}
      for (const row of rows) result[row.chatId] = (result[row.chatId] ?? 0) + row.count
      return result
    }
    const pendingLegacy = !this.store.legacyBotId() ? this.store.get<string>('bot-cli') : undefined
    return { revision: this.store.revision(), bots, ...(pendingLegacy ? { legacyConnection: { cli: pendingLegacy, error: this.health.get('feishu')?.detail ?? 'The original bot connection must be restored before adding bots' } } : {}), bot: legacy?.connected ? { name: legacy.name, id: legacy.botId } : null,
      botCli: legacy?.cli ?? pendingLegacy ?? '', workspaces: this.ctx.workspaceRegistry.list().map(workspace => workspace.path), health,
      ...(this.operatorAuthorized ? { stateDir: this.machine.stateDir, pid: process.pid } : {}),
      enterprisePilot: this.enterprisePilot, requireProtectedBranches: this.requireProtectedBranches,
      capacity: { maxRunningRepositories: this.maxRunningRepositories, runningRepositories: this.runningRepositories() },
      repositories: repositories.map(repository => {
        const { token, ...repo } = repository
        const status = this.instances.get(repo.id) ?? { online: false }
        const queued = counts.filter(row => row.repositoryId === repo.id)
        const pending = { total: queued.reduce((sum, row) => sum + row.count, 0), byChat: byChat(queued) }
        const groups = bindings.filter(binding => binding.repositoryId === repo.id && binding.enabled)
        const connected = groups.every(binding => bots.some(bot => bot.id === this.store.bindingBotId(binding) && bot.enabled && bot.connected))
        return { ...repo, status, starting: this.starting.has(repo.id), url: `http://127.0.0.1:${repo.port}`, pending,
          readiness: readiness({ repository, status, bot: groups.length ? connected : this.availableBots(repo.id).length > 0, groups: groups.length, pending }) }
      }),
      bindings, chats: legacy?.chats ?? {},
      queues: { total: counts.reduce((sum, row) => sum + row.count, 0),
        byRepository: Object.fromEntries(repositories.map(repo => [repo.id, counts.filter(row => row.repositoryId === repo.id).reduce((sum, row) => sum + row.count, 0)])),
        byChat: byChat(counts), byBinding: counts },
      pending: this.store.outstanding().map(({ trigger, ...item }) => item) }
  }
  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/orchestrator/mode') { json(res, 200, { mode: 'manager', ...this.desktopMode?.() }); return }
    const internal = /^\/orchestrator\/internal\/([^/]+)\/(receive|lark|feishu-bots)$/.exec(url.pathname)
    try {
      if (internal) {
        const repository = this.store.repositories().find(repo => repo.id === internal[1])
        if (!repository || !authorized(req.headers.authorization, repository.token)) { json(res, 403, { error: 'Repository authorization required' }); return }
        if (internal[2] === 'feishu-bots') {
          if (req.method !== 'GET') throw new Error('GET required')
          json(res, 200, { bots: this.availableBots(repository.id).map(({ id, botId, appId, name, brand, legacy }) => ({ id, botId, appId, name, brand, legacy })) }); return
        }
        if (req.method !== 'POST') throw new Error('POST required')
        await this.assertPilotInstance(repository)
        const data = await body(req)
        if (internal[2] === 'receive') {
          const trigger = FeishuTriggerSchema.parse(data)
          const botId = typeof trigger.meta.managerBotId === 'string' ? trigger.meta.managerBotId : this.store.legacyBotId()
          const bot = this.store.bots().find(item => item.id === botId)
          if (!bot || !bot.enabled) throw new Error('Choose an enabled bot for this repository')
          const scoped = scopeManagedFeishuTrigger(trigger, bot.id, { legacy: bot.legacy === true })
          const pinned = this.store.routeOwner(scoped.threads[0]!.id, bot.id)
          const target = pinned ?? this.store.bindings().find(binding => this.store.bindingBotId(binding) === bot.id && binding.chatId === trigger.meta.chatId)?.repositoryId
          if (target !== repository.id) throw new Error('Message belongs to another repository')
          json(res, 200, { result: this.store.route(trigger, bot.id) }); return
        }
        const { args, cwd, botId } = z.object({ args: z.array(z.string()).max(30), cwd: z.string().optional(), botId: z.string().min(1).optional() }).parse(data)
        json(res, 200, { data: await this.lark(repository, args, cwd, botId) }); return
      }
      if (!sameOrigin(req, this.ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      const route = url.pathname.slice('/orchestrator/manager/'.length)
      if (!url.pathname.startsWith('/orchestrator/manager/')) { json(res, 404, { error: 'Unknown manager operation' }); return }
      if (this.operatorAuthorized && !this.operatorAuthorized(req.headers.authorization)) {
        json(res, 401, { code: OPERATOR_AUTH_REQUIRED, error: 'Manager operator credentials are required' },
          { 'www-authenticate': 'Bearer realm="dsh-superagent-manager"' })
        return
      }
      // The browser sees one panel: a managed repository's own API is forwarded with the credential the manager keeps.
      const proxy = /^repositories\/([^/]+)\/api\/(.+)$/.exec(route)
      if (proxy) {
        const target = this.store.repositories().find(repository => repository.id === proxy[1])
        if (!target) { json(res, 404, { error: 'Repository not found' }); return }
        await this.assertPilotInstance(target)
        await this.forward(target, req, res, proxy[2]!, url.search)
        return
      }
      if (route === 'state' && req.method === 'GET') { json(res, 200, this.view()); return }
      if (route === 'bots' && req.method === 'POST') {
        if (!this.store.legacyBotId() && this.store.get<string>('bot-cli')) throw new Error('Restore the existing Feishu bot connection before adding another bot')
        const { cli, profile, revision } = z.object({ cli: z.string().trim().min(1), profile: z.string().trim().max(200).optional(), revision: z.number().int() }).parse(await body(req))
        const verified = await this.verifyBot(cli, profile)
        await this.assertExclusiveCli(verified)
        const record = { id: randomUUID(), ...verified, cli, ...(profile ? { profile } : {}), enabled: true }
        this.store.saveBot(record, revision)
        await this.connectBot(record.id)
        json(res, 200, this.view()); return
      }
      const botRoute = /^bots\/([^/]+)$/.exec(route)
      if (botRoute && (req.method === 'PUT' || req.method === 'DELETE')) {
        const botId = decodeURIComponent(botRoute[1]!)
        const current = this.store.bots().find(bot => bot.id === botId)
        if (!current) throw new Error('Bot connection not found')
        const data = z.object({ revision: z.number().int(), cli: z.string().trim().min(1).optional(), profile: z.string().trim().max(200).nullable().optional(), enabled: z.boolean().optional() }).parse(await body(req))
        if (req.method === 'DELETE') {
          this.store.removeBot(botId, data.revision)
          const runtime = this.botRuntimes.get(botId)
          runtime?.consumer?.abort.abort(); await runtime?.consumer?.done
          this.botRuntimes.delete(botId)
        } else {
          const cli = data.cli ?? current.cli, enabled = data.enabled ?? current.enabled
          const profile = data.profile === undefined ? current.profile : data.profile || undefined
          const verified = data.cli !== undefined || data.profile !== undefined || (enabled && !current.enabled) ? await this.verifyBot(cli, profile) : current
          if (data.cli !== undefined || data.profile !== undefined || (enabled && !current.enabled)) await this.assertExclusiveCli(verified, botId)
          this.store.saveBot({ ...current, ...verified, cli, profile, enabled }, data.revision)
          await this.connectBot(botId)
        }
        json(res, 200, this.view()); return
      }
      // Compatibility endpoint only applies while one bot identity is unambiguous.
      if (route === 'bot' && req.method === 'PUT') {
        const pendingLegacy = !this.store.legacyBotId() && this.store.get<string>('bot-cli')
        if (!pendingLegacy && this.store.bots().length > 1) throw new Error('Choose a specific Feishu bot')
        const { cli, profile: requestedProfile, revision = this.store.revision() } = z.object({ cli: z.string().trim().min(1), profile: z.string().trim().max(200).nullable().optional(), revision: z.number().int().optional() }).parse(await body(req))
        const previous = pendingLegacy ? undefined : this.store.bots()[0]
        const profile = requestedProfile === undefined ? previous?.profile : requestedProfile || undefined
        const bot = await this.verifyBot(cli, profile)
        await this.assertExclusiveCli(bot, previous?.id)
        const record = { ...(previous ?? { id: randomUUID(), legacy: true }), ...bot, cli, profile, enabled: true }
        this.store.saveBot(record, revision)
        await this.connectBot(record.id)
        json(res, 200, this.view()); return
      }
      if (route === 'repositories' && req.method === 'POST') {
        const data = RepositorySchema.omit({ id: true, token: true, profile: true, port: true }).extend({ revision: z.number().int() }).parse(await body(req))
        if (!data.directory && !this.enterprisePilot) throw new Error('A local Git checkout is required unless enterprise mode is enabled')
        const directory = data.directory ? await verifyRepository(data.directory, data.remote, this.ctx.subprocess, this.lifetime.signal) : ''
        const verified = await resolveDeployment(this.machine, { repository: data.remote, cli: data.githubCli }, workerProbe(this.ctx.subprocess, this.machine.stateDir, this.machine.stateDir, this.lifetime.signal))
        const remote = this.enterprisePilot ? verified.repository : data.remote
        const port = await freePort()
        const repositories = this.store.repositories()
        if (this.enterprisePilot && repositories.some(repository => repository.remote.toLowerCase() === remote.toLowerCase())) {
          throw new Error('This GitHub repository is already registered in the enterprise manager')
        }
        const { revision, ...fields } = data
        const repository = { ...fields, remote, directory, ...ManagerStore.identity(), port }
        this.store.save([...repositories, repository], this.store.bindings(), revision)
        json(res, 200, this.view()); return
      }
      if (route === 'bindings' && req.method === 'PUT') {
        const data = z.object({ revision: z.number().int(), bindings: z.array(BindingSchema.omit({ effectiveAt: true })),
          grant: BindingSchema.pick({ botId: true, chatId: true, repositoryId: true })
            .extend({ memberIds: z.array(z.string().min(1).max(200)).min(1).max(1000) }).optional(),
        }).parse(await body(req))
        const scopedBindings = data.bindings.map(binding => ({ ...binding, botId: binding.botId ?? this.singleBot().id }))
        let repositories = this.store.repositories()
        const old = this.store.bindings()
        const sameGroup = (left: Pick<Binding, 'botId' | 'chatId'>, right: Pick<Binding, 'botId' | 'chatId'>) =>
          this.store.bindingBotId(left as Binding) === this.store.bindingBotId(right as Binding) && left.chatId === right.chatId
        for (const binding of scopedBindings) {
          if (!this.store.bots().some(bot => bot.id === binding.botId)) throw new Error('Unknown bot in group binding')
          if (binding.enabled && !Object.hasOwn(this.botChats(binding.botId), binding.chatId)) throw new Error('Choose a group this bot has joined; refresh its group list first')
          const previous = old.find(row => sameGroup(row, binding))
          if (previous && previous.repositoryId !== binding.repositoryId) {
            const pending = this.store.queueCounts().filter(row => row.repositoryId === previous.repositoryId && row.botId === binding.botId && row.chatId === binding.chatId)
            if (pending.some(row => row.count)) throw new Error('Deliver or resolve queued messages before rebinding this group')
            const repository = this.store.repositories().find(repo => repo.id === previous.repositoryId)!
            const tickets = await instanceRequest(repository, 'tickets?state=open&limit=1') as { items: unknown[] }
            if (tickets.items.length) throw new Error('Finish or stop existing tickets before rebinding this group')
          }
        }
        if (data.grant) {
          const { chatId, repositoryId, memberIds } = data.grant
          const botId = data.grant.botId ?? this.singleBot().id
          if (!scopedBindings.some(binding => binding.enabled && binding.botId === botId && binding.chatId === chatId && binding.repositoryId === repositoryId)) {
            throw new Error('Grant access only for the selected bot, enabled group and repository')
          }
          const runtime = this.botRuntimes.get(botId), record = this.store.bots().find(bot => bot.id === botId)
          const members = new Set((await this.chatMembers(botId, chatId)).users.map(user => user.member_id))
          if (this.botRuntimes.get(botId) !== runtime) throw new Error('The bot changed while reading group members; refresh and try again')
          if (memberIds.some(id => !members.has(id))) throw new Error('Select members who are still in this bot group')
          repositories = repositories.map(repo => repo.id !== repositoryId ? repo : record?.legacy
            ? { ...repo, allowedFeishu: [...new Set([...repo.allowedFeishu, ...memberIds])] }
            : { ...repo, allowedFeishuByBot: { ...repo.allowedFeishuByBot, [botId]: [...new Set([...(repo.allowedFeishuByBot?.[botId] ?? []), ...memberIds])] } })
        }
        const bindings = scopedBindings.map(binding => ({ ...binding, effectiveAt: old.find(row => sameGroup(row, binding) && row.repositoryId === binding.repositoryId && row.enabled === binding.enabled)?.effectiveAt ?? new Date().toISOString() }))
        this.store.save(repositories, bindings, data.revision)
        await this.connectBots()
        json(res, 200, this.view()); return
      }
      const scopedMembers = /^bots\/([^/]+)\/chats\/(oc_[a-zA-Z0-9]+)\/members$/.exec(route)
      const memberGroup = /^chats\/(oc_[a-zA-Z0-9]+)\/members$/.exec(route)
      if ((scopedMembers || memberGroup) && req.method === 'GET') {
        const botId = scopedMembers ? decodeURIComponent(scopedMembers[1]!) : this.singleBot().id
        json(res, 200, await this.chatMembers(botId, scopedMembers?.[2] ?? memberGroup![1]!)); return
      }
      const scopedRefresh = /^bots\/([^/]+)\/chats\/refresh$/.exec(route)
      if ((scopedRefresh || route === 'chats/refresh') && req.method === 'POST') {
        const botId = scopedRefresh ? decodeURIComponent(scopedRefresh[1]!) : this.singleBot().id
        const runtime = this.botRuntimes.get(botId)
        if (!runtime?.bot) throw new Error('Connect and enable this Feishu bot first')
        const { refreshChatNames } = await import('../sources/feishu-loops.ts')
        await refreshChatNames(this.sourceContext(botId)); json(res, 200, this.view()); return
      }
      const editRepository = /^repositories\/([^/]+)$/.exec(route)
      if (editRepository && req.method === 'PUT') {
        const data = RepositorySchema.omit({ id: true, token: true, profile: true, port: true }).extend({ revision: z.number().int(),
          teamName: RepositorySchema.shape.teamName.nullable() }).parse(await body(req))
        const previous = this.store.repositories().find(repository => repository.id === editRepository[1])
        if (!previous) throw new Error('Repository not found')
        if (previous.directory !== data.directory || previous.remote !== data.remote || previous.githubCli !== data.githubCli) throw new Error('Create a new repository registration to change checkout, remote or execution account')
        if (this.enterprisePilot && previous.enabled && !data.enabled &&
          (await this.refreshInstance(previous) || this.starting.has(previous.id) || this.children.has(previous.id))) {
          throw new Error('Stop the enterprise repository before disabling it')
        }
        this.store.save(this.store.repositories().map(repository => repository.id === previous.id ? { ...repository, name: data.name,
          ...(data.teamName === undefined ? {} : { teamName: data.teamName ?? undefined }),
          ...(data.productLines === undefined ? {} : { productLines: data.productLines }),
          ...(data.requiredChecks === undefined ? {} : { requiredChecks: data.requiredChecks }),
          allowedGithub: data.allowedGithub, allowedFeishu: data.allowedFeishu,
          ...(data.allowedFeishuByBot === undefined ? {} : { allowedFeishuByBot: data.allowedFeishuByBot }), enabled: data.enabled } : repository), this.store.bindings(), data.revision)
        json(res, 200, this.view()); return
      }
      const action = /^repositories\/([^/]+)\/(start|stop|tasks|pause|open)$/.exec(route)
      if (action) {
        const repository = this.store.repositories().find(repo => repo.id === action[1])
        if (!repository) throw new Error('Repository not found')
        if (action[2] === 'tasks' && req.method === 'GET') {
          await this.assertPilotInstance(repository)
          json(res, 200, await instanceRequest(repository, 'tickets?state=open&limit=50')); return
        }
        if (req.method !== 'POST') throw new Error('POST required')
        if (action[2] === 'open') {
          if (!this.pilotMatches(await instanceHealth(repository))) throw new Error(PILOT_MODE_MISMATCH)
          json(res, 200, { url: await instanceUiUrl(repository, this.machine.stateDir) }); return
        }
        if (action[2] === 'start') {
          if (this.switchingMode) throw new Error('The manager is switching workspaces')
          if (this.starting.has(repository.id)) throw new Error('Repository is already starting')
          if (!repository.directory && !this.enterprisePilot) throw new Error('A local Git checkout is required unless enterprise mode is enabled')
          // A repository works through GitHub without Feishu; the bot only adds delivery and replies.
          const running = await this.refreshInstance(repository)
          if (running) {
            if (!this.pilotMatches(running)) throw new Error(PILOT_MODE_MISMATCH)
            await this.checkProtectedBranch(repository)
            json(res, 200, this.view()); return
          }
          if (this.switchingMode) throw new Error('The manager is switching workspaces')
          if (this.starting.has(repository.id)) throw new Error('Repository is already starting')
          if (this.children.has(repository.id)) throw new Error('Repository process is running but its health check failed; inspect its dedicated log')
          if (this.enterprisePilot && !this.store.repositories().find(item => item.id === repository.id)?.enabled) {
            throw new Error('Enable the enterprise repository before starting it')
          }
          if (this.runningRepositories() >= this.maxRunningRepositories) throw new Error(`At most ${this.maxRunningRepositories} repositories may run at once`)
          this.starting.add(repository.id)
          try {
            await this.checkProtectedBranch(repository)
            await provision(repository, this.machine.stateDir, this.origin, this.availableBots(repository.id).length ? 'dsh-manager-bridge' : '', this.store.chats(repository.id),
              { enterprisePilot: this.enterprisePilot })
            const child = await startInstance(repository, this.machine.stateDir, { enterprisePilot: this.enterprisePilot })
            if (child.exitCode === null && child.signalCode === null) {
              this.children.set(repository.id, child)
              child.once('exit', () => { this.children.delete(repository.id); this.instances.set(repository.id, { online: false }) })
            }
            try {
              // Wait for authenticated readiness before releasing the startup reservation.
              let ready = false
              for (let attempt = 0; attempt < 30; attempt++) {
                if (this.closed) throw new Error('Manager stopped during repository startup')
                if (child.exitCode !== null || child.signalCode !== null) throw new Error('Repository exited during startup; inspect its dedicated log')
                const status = await this.refreshInstance(repository)
                if (status && !this.pilotMatches(status)) throw new Error(PILOT_MODE_MISMATCH)
                if (status?.state === 'error') throw new Error('Repository initialization failed; inspect its dedicated log')
                if (status && (status.state === 'ready' || status.state === 'paused' || status.state === undefined)) {
                  ready = true; break
                }
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
              if (!ready) throw new Error('Repository did not start; inspect its dedicated log')
            } catch (error) { if (child.exitCode === null) child.kill('SIGTERM'); throw error }
          } finally { this.starting.delete(repository.id) }
        } else if (action[2] === 'stop') {
          const status = await instanceHealth(repository)
          process.kill(status.pid, 'SIGTERM')
          for (let attempt = 0; await this.refreshInstance(repository); attempt++) {
            if (attempt >= 40) throw new Error('Repository is still stopping. Refresh its status before retrying.')
            await new Promise(resolve => setTimeout(resolve, 250))
          }
        } else if (action[2] === 'pause') {
          await this.assertPilotInstance(repository)
          const { paused } = z.object({ paused: z.boolean() }).parse(await body(req))
          await instanceRequest(repository, 'executor/pause', { paused })
          const current = this.instances.get(repository.id)
          if (current) this.instances.set(repository.id, { ...current, paused })
        }
        json(res, 200, this.view()); return
      }
      json(res, 404, { error: 'Unknown manager operation' })
    } catch (error) {
      const problem = error as { code?: string | number; branch?: string; missing?: string[] }
      json(res, 400, { error: errorText(error), ...(problem.code ? { code: problem.code } : {}),
        ...(problem.code === 'branch_rules_missing' ? { branch: problem.branch, missing: problem.missing } : {}),
        ...(error instanceof SetupError ? { setup: error.problem } : {}) })
    }
  }
  /**
   * Forward one panel request to a managed repository instance. Only the manager's own origin reaches this, and only a
   * loopback port registered in the store; the repository token stays in this process and never reaches the browser.
   */
  private async forward(repository: Repository, req: IncomingMessage, res: ServerResponse, path: string, search: string): Promise<void> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT') { json(res, 405, { error: 'Unsupported method' }); return }
    let segments: string[]
    try { segments = path.split('/').map(segment => decodeURIComponent(segment)) }
    catch { json(res, 400, { error: 'A path segment has a malformed escape' }); return }
    if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) {
      json(res, 400, { error: 'Invalid repository API path' }); return
    }
    let payload: string | undefined
    if (method !== 'GET') payload = JSON.stringify(await body(req))
    let upstream: Response
    try {
      upstream = await fetch(new URL(`/orchestrator/instance/${path}${search}`, `http://127.0.0.1:${repository.port}`), {
        method, headers: { authorization: `Bearer ${repository.token}`, 'content-type': 'application/json' },
        ...payload === undefined ? {} : { body: payload }, signal: AbortSignal.timeout(60_000), redirect: 'error',
      })
    } catch (error) {
      json(res, 502, { error: `Repository instance is not reachable: ${errorText(error)}` }); return
    }
    const text = await upstream.text()
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(text)
  }
  private transportBot(repository: Repository, args: string[], requested: string | undefined, options: Map<string, string | true>): BotConnection {
    const option = (name: string) => { const value = options.get(name); return typeof value === 'string' ? value : undefined }
    let bots = this.availableBots(repository.id)
    if (!repository.enabled) throw new Error('This repository is disabled')
    if (requested) bots = bots.filter(bot => bot.id === requested)
    else if (args[1] === '+messages-reply' || args[1] === '+messages-resources-download') {
      bots = bots.filter(bot => this.knownMessage(repository.id, option('--message-id') ?? '', bot.id))
    } else if (args[1] === '+messages-mget') bots = bots.filter(bot => this.knownMessage(repository.id, option('--message-ids') ?? '', bot.id))
    else if (args[1] === '+threads-messages-list') bots = bots.filter(bot => this.knownThread(repository.id, option('--thread') ?? '', bot.id))
    else if (args[1] === '+chat-members-list') bots = bots.filter(bot => this.store.chats(repository.id, bot.id).includes(option('--chat-id') ?? ''))
    else if (args[0] === 'api') {
      const params = JSON.parse(option('--params') ?? '{}') as Record<string, unknown>
      if (args[2] === '/open-apis/im/v1/messages/mget' && Array.isArray(params.message_ids)) {
        bots = bots.filter(bot => (params.message_ids as unknown[]).every(id => typeof id === 'string' && this.knownMessage(repository.id, id, bot.id)))
      } else if (params.container_id_type === 'chat') bots = bots.filter(bot => this.store.chats(repository.id, bot.id).includes(String(params.container_id)))
      else if (params.container_id_type === 'thread') bots = bots.filter(bot => this.knownThread(repository.id, String(params.container_id), bot.id))
    }
    if (bots.length !== 1) throw new Error(bots.length ? 'Choose a specific bot for this repository operation' : 'The bot is unavailable or outside this repository scope')
    return bots[0]!
  }
  private async lark(repository: Repository, args: string[], cwd?: string, botId?: string): Promise<unknown> {
    const options = bridgeOptions(args)
    const bot = this.transportBot(repository, args, botId, options)
    const commands = this.botRuntimes.get(bot.id)!.commands!
    const option = (name: string) => { const value = options.get(name); return typeof value === 'string' ? value : undefined }
    if (args[1] === '+messages-resources-download') {
      const messageId = option('--message-id')
      if (!cwd || !messageId || !this.knownMessage(repository.id, messageId, bot.id) || option('--output') !== './image' || option('--type') !== 'image') throw new Error('Image download is outside the repository scope')
      const path = await realpath(cwd), root = await realpath(join(this.machine.stateDir, 'repositories', repository.id))
      if (dirname(path) !== root || !basename(path).startsWith('admission-image-')) throw new Error('Image download directory is outside repository state')
      return commands.lark(args, path)
    }
    const enabled = (chat: string) => this.store.chats(repository.id, bot.id).includes(chat)
      && this.store.bindings().some(binding => this.store.bindingBotId(binding) === bot.id && binding.chatId === chat && binding.enabled)
    if (args[0] === 'im' && args[1] === '+messages-reply') {
      const messageId = option('--message-id'), id = option('--idempotency-key')
      if (!messageId || !id || !this.store.owns(repository.id, messageId, bot.id)) throw new Error('Reply target belongs to another repository or bot')
      const row = this.store.db.prepare('SELECT value FROM inbox WHERE repository=? AND bot=?').all(repository.id, bot.id)
        .find(item => (JSON.parse(String(item.value)) as Trigger).meta.messageId === messageId)
      const chat = String((JSON.parse(String(row!.value)) as Trigger).meta.chatId)
      if (!enabled(chat)) throw new Error('This bot group is disabled')
      const replyId = bot.legacy ? key(repository.id, id) : key(repository.id, bot.id, id)
      const saved = this.store.db.prepare('SELECT sent,value,bot,repository FROM replies WHERE id=?').get(replyId)
      if (saved && (String(saved.value) !== JSON.stringify(args) || saved.bot !== bot.id || saved.repository !== repository.id)) throw new Error('Reply idempotency key reused with different content or bot')
      if (saved?.sent) return {}
      this.store.db.prepare('INSERT OR IGNORE INTO replies (id,repository,chat,value,bot) VALUES (?,?,?,?,?)').run(replyId, repository.id, chat, JSON.stringify(args), bot.id)
      const actual = [...args]; actual[actual.indexOf('--idempotency-key') + 1] = replyId
      const result = await commands.lark(actual)
      this.store.db.prepare('UPDATE replies SET sent=1 WHERE id=?').run(replyId)
      return result
    }
    if (args[0] === 'im' && args[1] === '+chat-members-list' && enabled(option('--chat-id') ?? '')) return commands.lark(args)
    if (args[0] === 'im' && args[1] === '+chat-list') {
      const result = await commands.lark<{ chats: { chat_id: string }[] }>(args)
      return { ...result, chats: result.chats.filter(chat => enabled(chat.chat_id)) }
    }
    if (args[0] === 'im' && args[1] === '+messages-mget') {
      const id = option('--message-ids')
      if (id && this.knownMessage(repository.id, id, bot.id)) return this.rememberRead(repository, bot, await commands.lark(args))
    }
    if (args[0] === 'im' && args[1] === '+threads-messages-list') {
      const id = option('--thread')
      if (id && this.knownThread(repository.id, id, bot.id)) return this.rememberRead(repository, bot, await commands.lark(args))
    }
    if (args[0] === 'api' && args[1] === 'GET') {
      const params = JSON.parse(option('--params') ?? '{}') as Record<string, string>
      if (args[2] === '/open-apis/im/v1/messages' && ((params.container_id_type === 'chat' && enabled(params.container_id ?? ''))
        || (params.container_id_type === 'thread' && this.knownThread(repository.id, params.container_id ?? '', bot.id)))) return this.rememberRead(repository, bot, await commands.lark(args))
      if (args[2] === '/open-apis/im/v1/messages/mget') {
        const ids = params.message_ids as unknown
        if (Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string' && this.knownMessage(repository.id, id, bot.id))) return this.rememberRead(repository, bot, await commands.lark(args))
      }
    }
    throw new Error('This Feishu operation is outside the repository bridge scope')
  }
  private rememberRead(repository: Repository, bot: BotConnection, result: unknown): unknown {
    const payload = result as { items?: Record<string, unknown>[]; messages?: Record<string, unknown>[] }
    const messages = payload.items ?? payload.messages ?? []
    for (const message of messages) {
      if (!this.store.chats(repository.id, bot.id).includes(String(message.chat_id))) throw new Error('Feishu returned a message outside this bot and repository groups')
    }
    this.store.atomic(() => {
      for (const message of messages) {
        for (const id of [message.message_id, message.parent_id, message.root_id]) if (typeof id === 'string' && id) this.store.set(`reference:${repository.id}:bot:${bot.id}:message:${id}`, true)
        if (typeof message.thread_id === 'string' && message.thread_id) this.store.set(`reference:${repository.id}:bot:${bot.id}:thread:${message.thread_id}`, true)
      }
    })
    return result
  }
  private knownMessage(repositoryId: string, id: string, botId: string): boolean {
    if (!id) return false
    if (this.store.get(`reference:${repositoryId}:bot:${botId}:message:${id}`)) return true
    if (this.store.bots().find(bot => bot.id === botId)?.legacy && this.store.get(`reference:${repositoryId}:message:${id}`)) return true
    return this.store.db.prepare('SELECT value FROM inbox WHERE repository=? AND bot=?').all(repositoryId, botId).some(row => {
      const trigger = JSON.parse(String(row.value)) as Trigger
      return [trigger.meta.messageId, trigger.meta.rootId, trigger.meta.parentId].includes(id)
    })
  }
  private knownThread(repositoryId: string, id: string, botId: string): boolean {
    if (!id) return false
    if (this.store.get(`reference:${repositoryId}:bot:${botId}:thread:${id}`)) return true
    if (this.store.bots().find(bot => bot.id === botId)?.legacy && this.store.get(`reference:${repositoryId}:thread:${id}`)) return true
    return this.store.db.prepare('SELECT value FROM inbox WHERE repository=? AND bot=?').all(repositoryId, botId)
      .some(row => (JSON.parse(String(row.value)) as Trigger).meta.threadId === id)
  }
}
