/** Unified local manager: one Feishu consumer, deterministic group routing, isolated repository processes. */
import type { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:net'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { Commands } from '../infra/commands.ts'
import { verifyRepository } from '../infra/repository.ts'
import { resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { sameOrigin } from '../app/http.ts'
import type { SourceContext } from '../sources/host.ts'
import { runFeishu } from '../sources/feishu-loops.ts'
import { feishuKind, type FeishuConfig } from '../sources/feishu.ts'
import { KV } from '../kv.ts'
import { key, type Trigger } from '../core/index.ts'
import type { Health } from '../sources/host.ts'
import { ManagerStore, RepositorySchema, BindingSchema, type Repository } from './store.ts'
import { readiness } from './readiness.ts'
import { authorized, bridgeOptions, FeishuTriggerSchema } from './protocol.ts'
import { instanceHealth, instanceRequest, instanceUiUrl, provision, startInstance, type InstanceHealth } from './instances.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1048576) throw new Error('Request exceeds 1 MiB'); chunks.push(bytes) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)) })
})

/** Supervises repository instances and routes Feishu events without making domain decisions. */
export class Manager {
  readonly store: ManagerStore
  private readonly lifetime = new AbortController()
  private readonly health = new Map<string, Health>()
  private readonly instances = new Map<string, { online: boolean; configured?: boolean; error?: string; state?: string
    agent?: InstanceHealth['agent'] }>()
  private readonly starting = new Set<string>()
  private bot?: Deployment['feishu']
  private consumer?: { abort: AbortController; done: Promise<unknown> }
  private ticking?: Promise<void>
  private commands?: Commands
  private readonly requests = new Set<Promise<void>>()
  private closed = false
  private readonly unlock: () => void
  private timer?: ReturnType<typeof setInterval>
  private disposeHttp?: () => void
  constructor(private readonly ctx: Context, private readonly machine: Machine) {
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('The manager requires a loopback web server')
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    this.unlock = lockSync(machine.stateDir)
    try { this.store = new ManagerStore(machine.stateDir) } catch (error) { this.unlock(); throw error }
  }
  private get origin(): string { return `http://127.0.0.1:${this.ctx.webServer.port}` }
  async start(): Promise<void> {
    this.disposeHttp = this.ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: (req, res) => { const request = this.http(req, res); this.requests.add(request); void request.finally(() => this.requests.delete(request)); return request } })
    try { await this.connectBot() } catch (error) { this.health.set('feishu', { state: 'error', detail: errorText(error) }) }
    this.timer = setInterval(() => { if (!this.ticking) this.ticking = this.tick().finally(() => { this.ticking = undefined }) }, 2000)
    this.timer.unref?.()
  }
  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true; if (this.timer) clearInterval(this.timer)
    this.disposeHttp?.(); this.lifetime.abort(); this.consumer?.abort.abort()
    await this.consumer?.done; await this.ticking; await Promise.allSettled([...this.requests])
    this.store.close(); this.unlock()
    // Repository processes deliberately survive a manager restart; authenticated health probes rediscover them.
  }
  private sourceContext(): SourceContext {
    const manager = this
    return {
      get deployment() { return { ...manager.machine, repository: '', github: { cli: 'gh', login: '', noreply: '' }, feishu: manager.bot } },
      get commands() { return manager.commands! }, ready: Promise.resolve(), configured: () => !!manager.bot,
      config: <C extends Record<string, unknown>>() => {
        const chats = manager.store.bindings().filter(item => item.enabled).map(item => ({ chatId: item.chatId, listen: 'mentions' }))
        return feishuKind.schema.parse({ cli: manager.store.get<string>('bot-cli'), chats, directMessages: false, otherChats: 'none' }) as unknown as C
      },
      receive: trigger => manager.store.route(trigger), atomic: work => manager.store.atomic(work),
      state: { get: name => manager.store.get(name), set: (name, value) => manager.store.set(name, value), keys: family => [] },
      threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
      tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
      triggers: { get: () => undefined, latest: () => undefined }, notify: () => {},
      report: (name, health) => { manager.health.set(name, health) },
    }
  }
  private async connectBot(): Promise<void> {
    this.consumer?.abort.abort(); await this.consumer?.done; this.consumer = undefined
    const cli = this.store.get<string>('bot-cli')
    this.bot = cli ? await resolveFeishuBot(this.machine, { cli }, workerProbe(this.ctx.subprocess, this.machine.stateDir, this.machine.stateDir, this.lifetime.signal)) : undefined
    if (!this.bot) return
    const deployment = { ...this.machine, repository: '', github: { cli: 'gh', login: '', noreply: '' }, feishu: this.bot }
    this.commands = new Commands(() => deployment, {}, this.lifetime.signal)
    if (!this.store.bindings().some(binding => binding.enabled)) {
      this.health.set('feishu', { state: 'paused', detail: 'Bot connected; no group binding is enabled' })
      return
    }
    const abort = new AbortController(), done = runFeishu(this.sourceContext(), abort.signal)
    this.consumer = { abort, done }
  }
  private async tick(): Promise<void> {
    try {
      const repositories = this.store.repositories()
      await Promise.all(repositories.map(async repository => {
        let status: InstanceHealth
        try { status = await instanceHealth(repository) }
        catch { this.instances.set(repository.id, { online: false }); return }
        this.instances.set(repository.id, { online: true, configured: status.configured, ...(status.state ? { state: status.state } : {}),
          ...status.agent ? { agent: status.agent } : {} })
        if (status.configured && !this.closed) {
          try { await this.syncGroups(repository) }
          // Keep the health this tick already read, including the agent probe, while adding the group-sync error.
          catch (error) { this.instances.set(repository.id, { ...this.instances.get(repository.id), online: true, configured: true, error: errorText(error) }) }
        }
      }))
      if (this.closed) return
      // A delivery pass releases the next message of a topic it completed; bounded so a stuck pass cannot spin.
      for (let pass = 0; pass < 20; pass++) {
        const items = this.store.pending()
        if (!items.length || this.closed) return
        let progress = false
        await Promise.all(items.map(async item => {
          const repository = repositories.find(repo => repo.id === item.repositoryId)
          const status = repository ? this.instances.get(repository.id) : undefined
          // Offline, unconfigured or paused repositories keep their messages here; nothing is marked failed.
          if (!repository?.enabled || !status?.configured || status.error) return
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
    const desired = { ...policy.value, sources: { ...policy.value.sources,
      feishu: { ...policy.value.sources.feishu, allowed: repository.allowedFeishu.map(id => ({ id })) },
      github: { ...policy.value.sources.github, allowed: repository.allowedGithub.map(id => ({ id })) } } }
    if (JSON.stringify(desired) !== JSON.stringify(policy.value)) await instanceRequest(repository, 'settings/policy', { revision: policy.revision, value: desired }, 'PUT')
    const cli = this.store.get<string>('bot-cli') ?? ''
    if (old.config.cli === cli && JSON.stringify(old.config.chats.map(chat => chat.chatId).sort()) === JSON.stringify(chats.sort())) return
    await instanceRequest(repository, 'settings/source:feishu', { revision: block.revision,
      value: { ...old, config: { ...old.config, cli, chats: chats.map(chatId => ({ chatId, listen: 'mentions' })), directMessages: false, otherChats: 'none' } } }, 'PUT')
  }
  private view() {
    const repositories = this.store.repositories(), bindings = this.store.bindings(), counts = this.store.queueCounts()
    return { revision: this.store.revision(), bot: this.bot ? { name: this.bot.name, id: this.bot.botId } : null,
      botCli: this.store.get<string>('bot-cli') ?? '', workspaces: this.ctx.workspaceRegistry.list().map(workspace => workspace.path), health: Object.fromEntries(this.health),
      repositories: repositories.map(repository => {
        const { token, ...repo } = repository
        const status = this.instances.get(repo.id) ?? { online: false }
        const queued = counts.filter(row => row.repositoryId === repo.id)
        const pending = { total: queued.reduce((sum, row) => sum + row.count, 0), byChat: Object.fromEntries(queued.map(row => [row.chatId, row.count])) }
        return { ...repo, status, starting: this.starting.has(repo.id), url: `http://127.0.0.1:${repo.port}`, pending,
          readiness: readiness({ repository, status, bot: this.bot !== undefined, groups: bindings.filter(binding => binding.repositoryId === repo.id && binding.enabled).length, pending }) }
      }),
      bindings, chats: this.store.get<Record<string, string>>(KV.sources.labels('feishu')) ?? {},
      // Delivery backlog per repository and per group, including messages held by a paused group.
      queues: { total: counts.reduce((sum, row) => sum + row.count, 0),
        byRepository: Object.fromEntries(repositories.map(repo => [repo.id, counts.filter(row => row.repositoryId === repo.id).reduce((sum, row) => sum + row.count, 0)])),
        byChat: Object.fromEntries(counts.reduce<[string, number][]>((rows, row) => { const found = rows.find(([chat]) => chat === row.chatId); if (found) found[1] += row.count; else rows.push([row.chatId, row.count]); return rows }, [])) },
      pending: this.store.outstanding().map(({ trigger, ...item }) => item) }
  }
  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/orchestrator/mode') { json(res, 200, { mode: 'manager' }); return }
    const internal = /^\/orchestrator\/internal\/([^/]+)\/(receive|lark)$/.exec(url.pathname)
    try {
      if (internal) {
        const repository = this.store.repositories().find(repo => repo.id === internal[1])
        if (!repository || !authorized(req.headers.authorization, repository.token)) { json(res, 403, { error: 'Repository authorization required' }); return }
        if (req.method !== 'POST') throw new Error('POST required')
        const data = await body(req)
        if (internal[2] === 'receive') {
          const trigger = FeishuTriggerSchema.parse(data)
          const pinned = this.store.db.prepare('SELECT repository FROM routes WHERE thread=?').get(trigger.threads[0]!.id)
          const target = pinned ? String(pinned.repository) : this.store.bindings().find(binding => binding.chatId === trigger.meta.chatId)?.repositoryId
          if (target !== repository.id) throw new Error('Message belongs to another repository')
          json(res, 200, { result: this.store.route(trigger) }); return
        }
        const { args, cwd } = z.object({ args: z.array(z.string()).max(30), cwd: z.string().optional() }).parse(data)
        json(res, 200, { data: await this.lark(repository, args, cwd) }); return
      }
      if (!sameOrigin(req, this.ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      const route = url.pathname.slice('/orchestrator/manager/'.length)
      if (!url.pathname.startsWith('/orchestrator/manager/')) { json(res, 404, { error: 'Unknown manager operation' }); return }
      if (route === 'state' && req.method === 'GET') { json(res, 200, this.view()); return }
      if (route === 'bot' && req.method === 'PUT') {
        const { cli } = z.object({ cli: z.string().min(1) }).parse(await body(req))
        const bot = await resolveFeishuBot(this.machine, { cli }, workerProbe(this.ctx.subprocess, this.machine.stateDir, this.machine.stateDir, this.lifetime.signal))
        if (!bot) throw new Error('The bot could not be verified')
        const existing = this.store.get<string>('bot-id')
        if (existing && existing !== bot.botId && Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM routes').get()?.count)) throw new Error('Existing repository routes belong to another bot; create a separate manager')
        this.store.set('bot-cli', cli); this.store.set('bot-id', bot.botId); await this.connectBot()
        json(res, 200, this.view()); return
      }
      if (route === 'repositories' && req.method === 'POST') {
        const data = RepositorySchema.omit({ id: true, token: true, profile: true, port: true }).extend({ revision: z.number().int() }).parse(await body(req))
        const directory = await verifyRepository(data.directory, data.remote, this.ctx.subprocess, this.lifetime.signal)
        await resolveDeployment(this.machine, { repository: data.remote, cli: data.githubCli }, workerProbe(this.ctx.subprocess, this.machine.stateDir, this.machine.stateDir, this.lifetime.signal))
        const repository = { ...data, directory, ...ManagerStore.identity(), port: await freePort() }
        this.store.save([...this.store.repositories(), repository], this.store.bindings(), data.revision)
        json(res, 200, this.view()); return
      }
      if (route === 'bindings' && req.method === 'PUT') {
        const data = z.object({ revision: z.number().int(), bindings: z.array(BindingSchema.omit({ effectiveAt: true })) }).parse(await body(req))
        const old = this.store.bindings()
        for (const binding of data.bindings) {
          if (binding.enabled && !this.store.get<Record<string, string>>(KV.sources.labels('feishu'))?.[binding.chatId]) throw new Error('Choose a group the bot has joined; refresh the group list first')
          const previous = old.find(row => row.chatId === binding.chatId)
          if (previous && previous.repositoryId !== binding.repositoryId) {
            const pending = this.store.db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE delivered=0 AND repository=? AND json_extract(value,'$.meta.chatId')=?").get(previous.repositoryId, binding.chatId)
            if (Number(pending?.count)) throw new Error('Deliver or resolve queued messages before rebinding this group')
            const repository = this.store.repositories().find(repo => repo.id === previous.repositoryId)!
            const tickets = await instanceRequest(repository, 'tickets?state=open&limit=1') as { items: unknown[] }
            if (tickets.items.length) throw new Error('Finish or stop existing tickets before rebinding this group')
          }
        }
        const bindings = data.bindings.map(binding => ({ ...binding, effectiveAt: old.find(row => row.chatId === binding.chatId && row.repositoryId === binding.repositoryId && row.enabled === binding.enabled)?.effectiveAt ?? new Date().toISOString() }))
        this.store.save(this.store.repositories(), bindings, data.revision)
        await this.connectBot()
        json(res, 200, this.view()); return
      }
      const memberGroup = /^chats\/(oc_[a-zA-Z0-9]+)\/members$/.exec(route)
      if (memberGroup && req.method === 'GET') {
        if (!this.commands || !this.store.get<Record<string, string>>(KV.sources.labels('feishu'))?.[memberGroup[1]!]) throw new Error('Choose a known bot group')
        const members = await this.commands.lark<{ users: unknown[]; has_more: boolean; truncations?: unknown[] }>(['im', '+chat-members-list', '--chat-id', memberGroup[1]!, '--member-types', 'user', '--page-all', '--page-limit', '0'])
        if (members.has_more || members.truncations?.length) throw new Error('Could not read the full group member list')
        json(res, 200, members); return
      }
      if (route === 'chats/refresh' && req.method === 'POST') {
        const { refreshChatNames } = await import('../sources/feishu-loops.ts')
        if (!this.bot) throw new Error('Connect the Feishu bot first')
        await refreshChatNames(this.sourceContext()); json(res, 200, this.view()); return
      }
      const editRepository = /^repositories\/([^/]+)$/.exec(route)
      if (editRepository && req.method === 'PUT') {
        const data = RepositorySchema.omit({ id: true, token: true, profile: true, port: true }).extend({ revision: z.number().int() }).parse(await body(req))
        const previous = this.store.repositories().find(repository => repository.id === editRepository[1])
        if (!previous) throw new Error('Repository not found')
        if (previous.directory !== data.directory || previous.remote !== data.remote || previous.githubCli !== data.githubCli) throw new Error('Create a new repository registration to change checkout, remote or execution account')
        this.store.save(this.store.repositories().map(repository => repository.id === previous.id ? { ...repository, name: data.name, allowedGithub: data.allowedGithub, allowedFeishu: data.allowedFeishu, enabled: data.enabled } : repository), this.store.bindings(), data.revision)
        json(res, 200, this.view()); return
      }
      const action = /^repositories\/([^/]+)\/(start|stop|tasks|pause|open)$/.exec(route)
      if (action) {
        const repository = this.store.repositories().find(repo => repo.id === action[1])
        if (!repository) throw new Error('Repository not found')
        if (action[2] === 'tasks' && req.method === 'GET') { json(res, 200, await instanceRequest(repository, 'tickets?state=open&limit=50')); return }
        if (req.method !== 'POST') throw new Error('POST required')
        if (action[2] === 'open') {
          await instanceHealth(repository); json(res, 200, { url: await instanceUiUrl(repository, this.machine.stateDir) }); return
        }
        if (action[2] === 'start') {
          if (this.starting.has(repository.id)) throw new Error('Repository is already starting')
          // A repository works through GitHub without Feishu; the bot only adds delivery and replies.
          if (await instanceHealth(repository).then(() => true, () => false)) { json(res, 200, this.view()); return }
          if (this.starting.has(repository.id)) throw new Error('Repository is already starting')
          if (this.starting.size + [...this.instances.values()].filter(value => value.online).length >= 3) throw new Error('At most three repositories may run at once')
          this.starting.add(repository.id)
          try {
            await provision(repository, this.machine.stateDir, this.origin, this.store.get<string>('bot-cli') ?? '', this.store.chats(repository.id))
            const child = await startInstance(repository, this.machine.stateDir)
            try {
              // Wait for authenticated readiness before releasing the startup reservation.
              let ready = false
              for (let attempt = 0; attempt < 30; attempt++) {
                if (this.closed) throw new Error('Manager stopped during repository startup')
                if (child.exitCode !== null || child.signalCode !== null) throw new Error('Repository exited during startup; inspect its dedicated log')
                const status = await instanceHealth(repository).catch(() => undefined)
                if (status?.state === 'error') throw new Error('Repository initialization failed; inspect its dedicated log')
                if (status && (status.state === 'ready' || status.state === undefined)) {
                  this.instances.set(repository.id, { online: true, configured: status.configured }); ready = true; break
                }
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
              if (!ready) throw new Error('Repository did not start; inspect its dedicated log')
            } catch (error) { if (child.exitCode === null) child.kill('SIGTERM'); throw error }
          } finally { this.starting.delete(repository.id) }
        } else if (action[2] === 'stop') {
          const status = await instanceHealth(repository); process.kill(status.pid, 'SIGTERM')
        } else if (action[2] === 'pause') { await instanceRequest(repository, 'executor/pause', await body(req)) }
        json(res, 200, this.view()); return
      }
      json(res, 404, { error: 'Unknown manager operation' })
    } catch (error) {
      const code = (error as { code?: number }).code
      json(res, 400, { error: errorText(error), ...(code ? { code } : {}) })
    }
  }
  private async lark(repository: Repository, args: string[], cwd?: string): Promise<unknown> {
    if (!this.commands) throw new Error('Feishu bot is not connected')
    const options = bridgeOptions(args)
    const option = (name: string) => { const value = options.get(name); return typeof value === 'string' ? value : undefined }
    if (args[1] === '+messages-resources-download') {
      const messageId = option('--message-id')
      if (!cwd || !messageId || !this.knownMessage(repository.id, messageId) || option('--output') !== './image' || option('--type') !== 'image') throw new Error('Image download is outside the repository scope')
      const path = await realpath(cwd), root = await realpath(join(this.machine.stateDir, 'repositories', repository.id))
      if (dirname(path) !== root || !basename(path).startsWith('admission-image-')) throw new Error('Image download directory is outside repository state')
      return this.commands.lark(args, path)
    }
    const enabled = (chat: string) => this.store.chats(repository.id).includes(chat) && this.store.bindings().some(binding => binding.chatId === chat && binding.enabled)
    if (args[0] === 'im' && args[1] === '+messages-reply') {
      const messageId = option('--message-id'), id = option('--idempotency-key')
      if (!messageId || !id || !this.store.owns(repository.id, messageId)) throw new Error('Reply target belongs to another repository')
      const row = this.store.db.prepare('SELECT value FROM inbox WHERE repository=?').all(repository.id)
        .find(item => (JSON.parse(String(item.value)) as Trigger).meta.messageId === messageId)
      const chat = String((JSON.parse(String(row!.value)) as Trigger).meta.chatId)
      if (!enabled(chat)) throw new Error('This group is disabled')
      const replyId = key(repository.id, id)
      const saved = this.store.db.prepare('SELECT sent,value FROM replies WHERE id=?').get(replyId)
      if (saved && String(saved.value) !== JSON.stringify(args)) throw new Error('Reply idempotency key reused with different content')
      if (saved?.sent) return {}
      this.store.db.prepare('INSERT OR IGNORE INTO replies (id,repository,chat,value) VALUES (?,?,?,?)').run(replyId, repository.id, chat, JSON.stringify(args))
      const actual = [...args]; actual[actual.indexOf('--idempotency-key') + 1] = replyId
      const result = await this.commands.lark(actual)
      this.store.db.prepare('UPDATE replies SET sent=1 WHERE id=?').run(replyId)
      return result
    }
    if (args[0] === 'im' && args[1] === '+chat-members-list' && enabled(option('--chat-id') ?? '')) return this.commands.lark(args)
    if (args[0] === 'im' && args[1] === '+chat-list') {
      const result = await this.commands.lark<{ chats: { chat_id: string }[] }>(args)
      return { ...result, chats: result.chats.filter(chat => enabled(chat.chat_id)) }
    }
    if (args[0] === 'im' && args[1] === '+messages-mget') {
      const id = option('--message-ids')
      if (id && this.knownMessage(repository.id, id)) return this.rememberRead(repository, await this.commands.lark(args))
    }
    if (args[0] === 'im' && args[1] === '+threads-messages-list') {
      const id = option('--thread')
      if (id && this.knownThread(repository.id, id)) return this.commands.lark(args)
    }
    if (args[0] === 'api' && args[1] === 'GET') {
      const params = JSON.parse(option('--params') ?? '{}') as Record<string, string>
      if (args[2] === '/open-apis/im/v1/messages' && ((params.container_id_type === 'chat' && enabled(params.container_id ?? ''))
        || (params.container_id_type === 'thread' && this.knownThread(repository.id, params.container_id ?? '')))) return this.commands.lark(args)
      if (args[2] === '/open-apis/im/v1/messages/mget') {
        const ids = params.message_ids as unknown
        if (Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string' && this.knownMessage(repository.id, id))) return this.rememberRead(repository, await this.commands.lark(args))
      }
    }
    throw new Error('This Feishu operation is outside the repository bridge scope')
  }
  private rememberRead(repository: Repository, result: unknown): unknown {
    const payload = result as { items?: Record<string, unknown>[]; messages?: Record<string, unknown>[] }
    for (const message of payload.items ?? payload.messages ?? []) {
      if (!this.store.chats(repository.id).includes(String(message.chat_id))) throw new Error('Feishu returned a message outside repository groups')
      for (const id of [message.message_id, message.parent_id, message.root_id]) if (typeof id === 'string' && id) this.store.set(`reference:${repository.id}:message:${id}`, true)
      if (typeof message.thread_id === 'string' && message.thread_id) this.store.set(`reference:${repository.id}:thread:${message.thread_id}`, true)
    }
    return result
  }
  private knownMessage(repositoryId: string, id: string): boolean {
    if (this.store.get(`reference:${repositoryId}:message:${id}`)) return true
    return this.store.db.prepare('SELECT value FROM inbox WHERE repository=?').all(repositoryId).some(row => {
      const trigger = JSON.parse(String(row.value)) as Trigger
      return [trigger.meta.messageId, trigger.meta.rootId, trigger.meta.parentId].includes(id)
    })
  }
  private knownThread(repositoryId: string, id: string): boolean {
    if (this.store.get(`reference:${repositoryId}:thread:${id}`)) return true
    return this.store.db.prepare('SELECT value FROM inbox WHERE repository=?').all(repositoryId)
      .some(row => (JSON.parse(String(row.value)) as Trigger).meta.threadId === id)
  }
}
