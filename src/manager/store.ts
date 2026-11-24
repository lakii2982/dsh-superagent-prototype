/** Durable repository bindings and at-least-once Feishu delivery journal. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { scopeManagedFeishuTrigger } from '../sources/feishu-trigger.ts'

export const BotConnectionSchema = z.object({
  id: z.string().min(1).max(200), cli: z.string().min(1), profile: z.string().trim().min(1).max(200).optional(), botId: z.string().min(1), appId: z.string().min(1),
  brand: z.enum(['feishu', 'lark']), name: z.string(), enabled: z.boolean(), legacy: z.boolean().optional(),
})
export type BotConnection = z.infer<typeof BotConnectionSchema>

export const RepositorySchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100),
  teamName: z.string().trim().min(1).max(100).optional(),
  productLines: z.array(z.string().trim().min(1).max(100)).max(100)
    .refine(lines => new Set(lines).size === lines.length, 'Duplicate product lines').optional(),
  requiredChecks: z.array(z.string().trim().min(1).max(200)).max(100)
    .refine(checks => new Set(checks).size === checks.length, 'Duplicate required GitHub checks').optional(),
  remote: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  directory: z.union([z.literal(''), z.string().startsWith('/')]).default(''),
  githubCli: z.string().min(1), allowedGithub: z.array(z.string().min(1)).default([]),
  allowedFeishu: z.array(z.string().min(1)).default([]),
  allowedFeishuByBot: z.record(z.string().min(1), z.array(z.string().min(1))).optional(), enabled: z.boolean().default(true),
  port: z.number().int().min(1024).max(65535), token: z.string().min(32), profile: z.string(),
})
export type Repository = z.infer<typeof RepositorySchema>
export const BindingSchema = z.object({ botId: z.string().min(1).max(200).optional(), chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), repositoryId: z.string().uuid(), enabled: z.boolean(), effectiveAt: z.string().datetime() })
export type Binding = z.infer<typeof BindingSchema>
export interface JournalItem { id: string; botId?: string; repositoryId: string; chatId: string; thread: string; trigger: Trigger; attempts: number; nextAt: number; error?: string }
/** Why a queued message is withheld: its group is paused, its repository is disabled, its binding vanished, or its topic moved. */
export type HoldReason = 'binding-missing' | 'group-disabled' | 'repository-disabled' | 'thread-reassigned' | 'bot-disabled' | 'bot-missing' | 'unauthorized'
export interface QueuedItem extends JournalItem { hold?: HoldReason }
export interface QueueCount { botId?: string; repositoryId: string; chatId: string; count: number }

const bindingKey = (botId: string | undefined, chatId: string): string => JSON.stringify([botId ?? '', chatId])

/** Stores only management configuration and transport records; repository Engines own their work. */
export class ManagerStore {
  readonly db: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'manager.sqlite')
    this.db = new DatabaseSync(path); chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (thread TEXT PRIMARY KEY, repository TEXT NOT NULL, chat TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, repository TEXT NOT NULL, value TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, next_at INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
        thread TEXT, chat TEXT);
      CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, repository TEXT NOT NULL, chat TEXT NOT NULL, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);`)
    this.migrate()
  }
  /** Add the topic columns to databases written before delivery was ordered per topic; safe to repeat. */
  private migrate(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(inbox)').all().map(row => String(row.name)))
    if (!columns.has('thread')) this.db.exec('ALTER TABLE inbox ADD COLUMN thread TEXT')
    if (!columns.has('chat')) this.db.exec('ALTER TABLE inbox ADD COLUMN chat TEXT')
    for (const table of ['inbox', 'routes', 'replies']) {
      const fields = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)))
      if (!fields.has('bot')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN bot TEXT NOT NULL DEFAULT ''`)
    }
    // Rows written earlier kept the topic and group inside the Trigger JSON, so the upgrade never loses their order.
    this.db.exec(`UPDATE inbox SET thread=COALESCE(json_extract(value,'$.threads[0].id'),''),
        chat=COALESCE(json_extract(value,'$.meta.chatId'),'') WHERE thread IS NULL OR chat IS NULL;
      CREATE INDEX IF NOT EXISTS inbox_topic ON inbox(delivered, thread);
      CREATE INDEX IF NOT EXISTS inbox_repository ON inbox(delivered, repository);
      CREATE INDEX IF NOT EXISTS inbox_group ON inbox(delivered, chat);
      CREATE INDEX IF NOT EXISTS inbox_bot_group ON inbox(delivered, bot, chat);
      CREATE INDEX IF NOT EXISTS routes_bot ON routes(bot, repository, chat);`)
  }
  close(): void { this.db.close() }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  set(key: string, value: unknown): void {
    if (value === undefined) this.db.prepare('DELETE FROM kv WHERE key=?').run(key)
    else this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value))
  }
  atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  repositories(): Repository[] { return this.get<Repository[]>('repositories') ?? [] }
  bots(): BotConnection[] { return this.get<BotConnection[]>('bots') ?? [] }
  legacyBotId(): string | undefined { return this.bots().find(bot => bot.legacy)?.id }
  bindingBotId(binding: Pick<Binding, 'botId'>): string | undefined { return binding.botId ?? this.legacyBotId() }
  bindings(): Binding[] {
    const legacy = this.legacyBotId()
    return (this.get<Binding[]>('bindings') ?? []).map(binding => !binding.botId && legacy ? { ...binding, botId: legacy } : binding)
  }
  revision(): number { return this.get<number>('revision') ?? 0 }
  /** Bot identity is immutable. A CLI can be reconnected only to the same verified application and bot. */
  saveBot(input: BotConnection, revision: number): void {
    const bot = BotConnectionSchema.parse(input)
    this.atomic(() => {
      if (revision !== this.revision()) throw new Error('Configuration changed; reload before saving')
      const bots = this.bots(), previous = bots.find(item => item.id === bot.id)
      if (previous && (previous.botId !== bot.botId || previous.appId !== bot.appId || previous.brand !== bot.brand || !!previous.legacy !== !!bot.legacy)) {
        throw new Error('A saved bot connection cannot change identity')
      }
      if (bots.some(item => item.id !== bot.id && (item.appId === bot.appId || (item.brand === bot.brand && item.botId === bot.botId)))) {
        throw new Error('This Feishu bot is already connected')
      }
      if (bots.some(item => item.id !== bot.id && item.cli === bot.cli && (item.profile ?? '') === (bot.profile ?? ''))) {
        throw new Error('This Feishu CLI and profile are already assigned to another bot')
      }
      if (bot.legacy && bots.some(item => item.legacy && item.id !== bot.id)) throw new Error('The legacy Feishu bot is already registered')
      if (bot.legacy && this.get<string>('bot-id') && this.get<string>('bot-id') !== bot.botId) throw new Error('The legacy Feishu bot identity does not match')
      this.set('bots', previous ? bots.map(item => item.id === bot.id ? bot : item) : [...bots, bot])
      if (bot.legacy) {
        // Assign ownership without rewriting historical IDs retained by repository engines and outboxes.
        this.set('bindings', this.bindings())
        for (const row of this.db.prepare("SELECT id,value FROM inbox WHERE bot=''").all()) {
          const trigger = scopeManagedFeishuTrigger(JSON.parse(String(row.value)) as Trigger, bot.id, { legacy: true, brand: bot.brand, name: bot.name })
          this.db.prepare('UPDATE inbox SET bot=?,value=? WHERE id=?').run(bot.id, JSON.stringify(trigger), String(row.id))
        }
        for (const table of ['routes', 'replies']) this.db.prepare(`UPDATE ${table} SET bot=? WHERE bot=''`).run(bot.id)
        this.set('bot-cli', bot.cli); this.set('bot-id', bot.botId)
      }
      this.set('revision', revision + 1)
    })
  }
  /** Connections with conversation history are retained so retries can never silently use another identity. */
  removeBot(id: string, revision: number): void {
    this.atomic(() => {
      if (revision !== this.revision()) throw new Error('Configuration changed; reload before saving')
      const bot = this.bots().find(item => item.id === id)
      if (!bot) throw new Error('Feishu bot not found')
      if (this.bindings().some(binding => this.bindingBotId(binding) === id)) throw new Error('Remove the bot group bindings before removing this connection')
      for (const table of ['inbox', 'routes', 'replies']) if (this.db.prepare(`SELECT 1 FROM ${table} WHERE bot=? LIMIT 1`).get(id)) {
        throw new Error('This bot has retained conversation history; disable it instead of removing it')
      }
      this.set('repositories', this.repositories().map(repository => {
        const allowedFeishuByBot = { ...repository.allowedFeishuByBot }; delete allowedFeishuByBot[id]
        return { ...repository, allowedFeishuByBot, ...(bot.legacy ? { allowedFeishu: [] } : {}) }
      }))
      this.set('bots', this.bots().filter(item => item.id !== id))
      if (bot.legacy) { this.set('bot-cli', undefined); this.set('bot-id', undefined) }
      this.set('revision', revision + 1)
    })
  }
  save(repositories: Repository[], bindings: Binding[], revision: number): void {
    this.atomic(() => {
      if (revision !== this.revision()) throw new Error('Configuration changed; reload before saving')
      const normalized = bindings.map(binding => {
        const botId = this.bindingBotId(binding)
        return botId ? { ...binding, botId } : binding
      })
      if (new Set(normalized.map(item => bindingKey(item.botId, item.chatId))).size !== normalized.length) throw new Error('A bot group can bind to only one repository')
      const bots = this.bots()
      if (normalized.some(binding => binding.botId ? !bots.some(bot => bot.id === binding.botId) : bots.length > 0)) throw new Error('Choose a registered bot for every group binding')
      const botIds = new Set(bots.map(bot => bot.id))
      if (repositories.some(repository => Object.keys(repository.allowedFeishuByBot ?? {}).some(id => !botIds.has(id)))) {
        throw new Error('Unknown bot in Feishu authorization')
      }
      const checkouts = repositories.map(item => item.directory).filter(Boolean)
      if (new Set(checkouts).size !== checkouts.length) throw new Error('This local checkout is already registered')
      if (new Set(repositories.map(item => item.port)).size !== repositories.length) throw new Error('Repository ports must be unique')
      if (bindings.some(item => !repositories.some(repo => repo.id === item.repositoryId))) throw new Error('Unknown repository in group binding')
      this.set('repositories', repositories); this.set('bindings', normalized); this.set('revision', revision + 1)
    })
  }
  route(input: Trigger, botId?: string): 'stored' | 'duplicate' | 'filtered' {
    return this.atomic(() => {
      const bots = this.bots(), selected = botId ?? this.legacyBotId()
      const bot = bots.find(item => item.id === selected)
      if ((selected && !bot) || (bots.length && !bot)) return 'filtered'
      if (input.source !== 'feishu' || input.meta.direct === true) return 'filtered'
      const chat = String(input.meta.chatId ?? '')
      if (input.channel?.address.chatId !== chat || input.channel?.address.messageId !== input.meta.messageId || !input.threads[0]?.id.startsWith(`${chat}:`)) return 'filtered'
      if (typeof input.meta.managerBotId === 'string' && input.meta.managerBotId !== selected) return 'filtered'
      if (input.channel?.address.botId && input.channel.address.botId !== selected) return 'filtered'
      const trigger = bot ? scopeManagedFeishuTrigger(input, bot.id, { legacy: !!bot.legacy, brand: bot.brand, name: bot.name }) : input
      const thread = trigger.threads[0]?.id
      if (!thread) return 'filtered'
      // A durable receipt remains an idempotent success after an operator changes membership or pauses intake.
      if (this.db.prepare('SELECT id FROM inbox WHERE id=? AND bot=?').get(trigger.id, selected ?? '')) return 'duplicate'
      if (bot && !bot.enabled) return 'filtered'
      const binding = this.bindings().find(item => item.chatId === chat && this.bindingBotId(item) === selected)
      if (!binding?.enabled) return 'filtered'
      const pinned = this.db.prepare('SELECT repository FROM routes WHERE thread=? AND bot=?').get(thread, selected ?? '')
      const repositoryId = pinned ? String(pinned.repository) : binding.repositoryId
      const repository = this.repositories().find(item => item.id === repositoryId)
      if (!repository?.enabled) return 'filtered'
      if (bot && !this.allowed(repository, bot, trigger.actor.id)) return 'filtered'
      // An existing topic remains eligible after a binding change; new topics start at activation time.
      if (!pinned && (Date.parse(trigger.at) < Date.parse(binding.effectiveAt) || trigger.addressed !== 'mention')) return 'filtered'
      this.db.prepare('INSERT OR IGNORE INTO routes (thread,repository,chat,bot) VALUES (?,?,?,?)').run(thread, repositoryId, chat, selected ?? '')
      this.db.prepare('INSERT INTO inbox (id,repository,value,thread,chat,bot) VALUES (?,?,?,?,?,?)').run(trigger.id, repositoryId, JSON.stringify({ ...trigger, meta: { ...trigger.meta, managerBindingRevision: this.revision() } }), thread, chat, selected ?? '')
      return 'stored'
    })
  }
  /** Select the oldest due message of each deliverable topic before applying the batch limit. */
  pending(limit = 100, due = true, eligible?: Pick<ReadonlySet<string>, 'has'>,
    eligibleBots?: Pick<ReadonlySet<string>, 'has'>): JournalItem[] {
    if (limit <= 0) return []
    const routes = this.routes(), items: JournalItem[] = []
    // Filter holds before applying the batch limit, so a disabled bot or revoked user cannot starve other topics.
    const rows = this.db.prepare(`SELECT * FROM inbox i WHERE delivered=0 AND next_at<=?
      AND NOT EXISTS (SELECT 1 FROM inbox p WHERE p.delivered=0 AND p.bot=i.bot AND p.thread=i.thread AND p.rowid<i.rowid)
      ORDER BY rowid`).iterate(due ? Date.now() : Number.MAX_SAFE_INTEGER)
    for (const row of rows) {
      const item = this.item(row)
      if ((!eligible || eligible.has(item.repositoryId)) && (!eligibleBots || !item.botId || eligibleBots.has(item.botId))
        && !this.holdOf(item, routes)) items.push(item)
      if (items.length >= limit) break
    }
    return items
  }
  /** Every undelivered message with its hold reason; the management view explains work that waits in a paused group. */
  outstanding(limit = 200): QueuedItem[] {
    const routes = this.routes()
    return this.db.prepare('SELECT * FROM inbox WHERE delivered=0 ORDER BY rowid LIMIT ?').all(limit).map(row => {
      const item = this.item(row), hold = this.holdOf(item, routes)
      return hold ? { ...item, hold } : item
    })
  }
  /** Undelivered message counts per repository and group. */
  queueCounts(): QueueCount[] {
    return this.db.prepare('SELECT bot,repository,chat,COUNT(*) AS count FROM inbox WHERE delivered=0 GROUP BY bot,repository,chat ORDER BY bot,repository,chat')
      .all().map(row => ({ ...(row.bot ? { botId: String(row.bot) } : {}), repositoryId: String(row.repository), chatId: String(row.chat), count: Number(row.count) }))
  }
  delivered(id: string): void { this.db.prepare('UPDATE inbox SET delivered=1,error=NULL WHERE id=?').run(id) }
  failed(id: string, error: string): void { this.db.prepare('UPDATE inbox SET attempts=attempts+1,error=?,next_at=? WHERE id=?').run(error.slice(0, 1000), Date.now() + Math.min(60000, 2000 * 2 ** Math.min(5, Number(this.db.prepare('SELECT attempts FROM inbox WHERE id=?').get(id)?.attempts ?? 0))), id) }
  owns(repositoryId: string, messageId: string, botId?: string): boolean {
    const rows = botId === undefined ? this.db.prepare('SELECT value FROM inbox WHERE repository=?').all(repositoryId)
      : this.db.prepare('SELECT value FROM inbox WHERE repository=? AND bot=?').all(repositoryId, botId)
    return rows.some(row => (JSON.parse(String(row.value)) as Trigger).meta.messageId === messageId)
  }
  chats(repositoryId: string, botId?: string): string[] {
    const routes = botId === undefined ? this.db.prepare('SELECT DISTINCT chat FROM routes WHERE repository=?').all(repositoryId)
      : this.db.prepare('SELECT DISTINCT chat FROM routes WHERE repository=? AND bot=?').all(repositoryId, botId)
    return [...new Set([...this.bindings().filter(item => item.repositoryId === repositoryId && (botId === undefined || this.bindingBotId(item) === botId)).map(item => item.chatId),
      ...routes.map(row => String(row.chat))])]
  }
  routeOwner(thread: string, botId?: string): string | undefined {
    const rows = botId === undefined ? this.db.prepare('SELECT repository FROM routes WHERE thread=?').all(thread)
      : this.db.prepare('SELECT repository FROM routes WHERE thread=? AND bot=?').all(thread, botId)
    return rows.length === 1 ? String(rows[0]!.repository) : undefined
  }
  messageBotIds(repositoryId: string, messageId: string): string[] {
    return this.referenceBotIds(repositoryId, trigger => [trigger.meta.messageId, trigger.meta.rootId, trigger.meta.parentId].includes(messageId))
  }
  threadBotIds(repositoryId: string, threadId: string): string[] {
    return this.referenceBotIds(repositoryId, trigger => trigger.meta.threadId === threadId || trigger.threads.some(thread => thread.id === threadId))
  }
  repositoryBotIds(repositoryId: string): string[] {
    return [...new Set([...this.bindings().filter(binding => binding.repositoryId === repositoryId).map(binding => this.bindingBotId(binding)),
      ...this.db.prepare('SELECT DISTINCT bot FROM routes WHERE repository=?').all(repositoryId).map(row => String(row.bot))].filter((id): id is string => !!id))]
  }
  private referenceBotIds(repositoryId: string, matches: (trigger: Trigger) => boolean): string[] {
    return [...new Set(this.db.prepare('SELECT bot,value FROM inbox WHERE repository=?').all(repositoryId)
      .filter(row => matches(JSON.parse(String(row.value)) as Trigger)).map(row => String(row.bot)).filter(Boolean))]
  }
  private allowed(repository: Repository, bot: BotConnection, actorId: string): boolean {
    return (repository.allowedFeishuByBot?.[bot.id] ?? []).includes(actorId) || (!!bot.legacy && repository.allowedFeishu.includes(actorId))
  }
  static identity(): Pick<Repository, 'id' | 'token' | 'profile'> {
    const id = randomUUID()
    return { id, token: randomBytes(32).toString('hex'), profile: `superagent-${id.slice(0, 8)}` }
  }
  private item(row: Record<string, unknown>): JournalItem {
    const trigger = JSON.parse(String(row.value)) as Trigger
    return { id: String(row.id), ...(row.bot ? { botId: String(row.bot) } : {}), repositoryId: String(row.repository), chatId: String(row.chat ?? trigger.meta.chatId ?? ''),
      thread: String(row.thread ?? trigger.threads[0]?.id ?? ''), trigger, attempts: Number(row.attempts), nextAt: Number(row.next_at),
      ...(row.error ? { error: String(row.error) } : {}) }
  }
  private routes(): { chats: Map<string, string | undefined>; repositories: Map<string, Repository>; pins: Map<string, string>; bots: Map<string, BotConnection>; legacyExpected: boolean } {
    const chats = new Map<string, string | undefined>()
    for (const binding of this.bindings()) chats.set(bindingKey(this.bindingBotId(binding), binding.chatId), binding.enabled ? binding.repositoryId : undefined)
    const repositories = new Map(this.repositories().map(item => [item.id, item]))
    // Historical routes remain durable, but queue checks need only pins belonging to outstanding messages.
    const pins = new Map(this.db.prepare(`SELECT DISTINCT i.thread,r.repository,i.bot FROM inbox i
      JOIN routes r ON r.thread=i.thread AND r.bot=i.bot WHERE i.delivered=0`).all()
      .map(row => [bindingKey(String(row.bot), String(row.thread)), String(row.repository)]))
    return { chats, repositories, pins, bots: new Map(this.bots().map(bot => [bot.id, bot])),
      legacyExpected: !!this.get('bot-cli') || !!this.get('bot-id') }
  }
  private holdOf(item: JournalItem, routes: ReturnType<ManagerStore['routes']>): HoldReason | undefined {
    const bot = item.botId ? routes.bots.get(item.botId) : undefined
    if ((item.botId || routes.bots.size || routes.legacyExpected) && !bot) return 'bot-missing'
    if (bot && !bot.enabled) return 'bot-disabled'
    const group = bindingKey(item.botId, item.chatId)
    if (!routes.chats.has(group)) return 'binding-missing'
    if (routes.chats.get(group) === undefined) return 'group-disabled'
    const repository = routes.repositories.get(item.repositoryId)
    if (!repository?.enabled) return 'repository-disabled'
    if (bot && !this.allowed(repository, bot, item.trigger.actor.id)) return 'unauthorized'
    const pinned = routes.pins.get(bindingKey(item.botId, item.thread))
    if (pinned && pinned !== item.repositoryId) return 'thread-reassigned'
    return undefined
  }
}
