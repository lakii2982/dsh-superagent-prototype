/** Durable repository bindings and at-least-once Feishu delivery journal. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'

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
  allowedFeishu: z.array(z.string().min(1)).default([]), enabled: z.boolean().default(true),
  port: z.number().int().min(1024).max(65535), token: z.string().min(32), profile: z.string(),
})
export type Repository = z.infer<typeof RepositorySchema>
export const BindingSchema = z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), repositoryId: z.string().uuid(), enabled: z.boolean(), effectiveAt: z.string().datetime() })
export type Binding = z.infer<typeof BindingSchema>
export interface JournalItem { id: string; repositoryId: string; chatId: string; thread: string; trigger: Trigger; attempts: number; nextAt: number; error?: string }
/** Why a queued message is withheld: its group is paused, its repository is disabled, its binding vanished, or its topic moved. */
export type HoldReason = 'binding-missing' | 'group-disabled' | 'repository-disabled' | 'thread-reassigned'
export interface QueuedItem extends JournalItem { hold?: HoldReason }
export interface QueueCount { repositoryId: string; chatId: string; count: number }

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
    // Rows written earlier kept the topic and group inside the Trigger JSON, so the upgrade never loses their order.
    this.db.exec(`UPDATE inbox SET thread=COALESCE(json_extract(value,'$.threads[0].id'),''),
        chat=COALESCE(json_extract(value,'$.meta.chatId'),'') WHERE thread IS NULL OR chat IS NULL;
      CREATE INDEX IF NOT EXISTS inbox_topic ON inbox(delivered, thread);
      CREATE INDEX IF NOT EXISTS inbox_repository ON inbox(delivered, repository);
      CREATE INDEX IF NOT EXISTS inbox_group ON inbox(delivered, chat);`)
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
  bindings(): Binding[] { return this.get<Binding[]>('bindings') ?? [] }
  revision(): number { return this.get<number>('revision') ?? 0 }
  save(repositories: Repository[], bindings: Binding[], revision: number): void {
    this.atomic(() => {
      if (revision !== this.revision()) throw new Error('Configuration changed; reload before saving')
      if (new Set(bindings.map(item => item.chatId)).size !== bindings.length) throw new Error('A group can bind to only one repository')
      const checkouts = repositories.map(item => item.directory).filter(Boolean)
      if (new Set(checkouts).size !== checkouts.length) throw new Error('This local checkout is already registered')
      if (new Set(repositories.map(item => item.port)).size !== repositories.length) throw new Error('Repository ports must be unique')
      if (bindings.some(item => !repositories.some(repo => repo.id === item.repositoryId))) throw new Error('Unknown repository in group binding')
      this.set('repositories', repositories); this.set('bindings', bindings); this.set('revision', revision + 1)
    })
  }
  route(trigger: Trigger): 'stored' | 'duplicate' | 'filtered' {
    return this.atomic(() => {
      if (this.db.prepare('SELECT id FROM inbox WHERE id=?').get(trigger.id)) return 'duplicate'
      if (trigger.source !== 'feishu' || trigger.meta.direct === true) return 'filtered'
      const chat = String(trigger.meta.chatId ?? ''), thread = trigger.threads[0]?.id
      if (trigger.channel?.address.chatId !== chat || trigger.channel?.address.messageId !== trigger.meta.messageId || !thread?.startsWith(`${chat}:`)) return 'filtered'
      if (!thread) return 'filtered'
      const binding = this.bindings().find(item => item.chatId === chat)
      if (!binding?.enabled) return 'filtered'
      const pinned = this.db.prepare('SELECT repository FROM routes WHERE thread=?').get(thread)
      const repositoryId = pinned ? String(pinned.repository) : binding.repositoryId
      const repository = this.repositories().find(item => item.id === repositoryId)
      if (!repository?.enabled) return 'filtered'
      // An existing topic remains eligible after a binding change; new topics start at activation time.
      if (!pinned && (Date.parse(trigger.at) < Date.parse(binding.effectiveAt) || trigger.addressed !== 'mention')) return 'filtered'
      this.db.prepare('INSERT OR IGNORE INTO routes VALUES (?,?,?)').run(thread, repositoryId, chat)
      this.db.prepare('INSERT INTO inbox (id,repository,value,thread,chat) VALUES (?,?,?,?,?)').run(trigger.id, repositoryId, JSON.stringify({ ...trigger, meta: { ...trigger.meta, managerBindingRevision: this.revision() } }), thread, chat)
      return 'stored'
    })
  }
  /** Select the oldest due message of each deliverable topic before applying the batch limit. */
  pending(limit = 100, due = true, eligible?: Pick<ReadonlySet<string>, 'has'>): JournalItem[] {
    const chats = this.bindings().filter(binding => binding.enabled).map(binding => binding.chatId)
    const repositories = this.repositories().filter(repo => repo.enabled && (!eligible || eligible.has(repo.id))).map(repo => repo.id)
    if (!chats.length || !repositories.length) return []
    const marks = (items: string[]): string => items.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM inbox i WHERE delivered=0 AND next_at<=? AND chat IN (${marks(chats)}) AND repository IN (${marks(repositories)})
      AND NOT EXISTS (SELECT 1 FROM inbox p WHERE p.delivered=0 AND p.thread=i.thread AND p.rowid<i.rowid)
      AND NOT EXISTS (SELECT 1 FROM routes r WHERE r.thread=i.thread AND r.repository<>i.repository)
      ORDER BY rowid LIMIT ?`).all(due ? Date.now() : Number.MAX_SAFE_INTEGER, ...chats, ...repositories, limit)
      .map(row => this.item(row))
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
    return this.db.prepare('SELECT repository,chat,COUNT(*) AS count FROM inbox WHERE delivered=0 GROUP BY repository,chat ORDER BY repository,chat')
      .all().map(row => ({ repositoryId: String(row.repository), chatId: String(row.chat), count: Number(row.count) }))
  }
  delivered(id: string): void { this.db.prepare('UPDATE inbox SET delivered=1,error=NULL WHERE id=?').run(id) }
  failed(id: string, error: string): void { this.db.prepare('UPDATE inbox SET attempts=attempts+1,error=?,next_at=? WHERE id=?').run(error.slice(0, 1000), Date.now() + Math.min(60000, 2000 * 2 ** Math.min(5, Number(this.db.prepare('SELECT attempts FROM inbox WHERE id=?').get(id)?.attempts ?? 0))), id) }
  owns(repositoryId: string, messageId: string): boolean {
    const rows = this.db.prepare('SELECT value FROM inbox WHERE repository=?').all(repositoryId)
    return rows.some(row => (JSON.parse(String(row.value)) as Trigger).meta.messageId === messageId)
  }
  chats(repositoryId: string): string[] {
    return [...new Set([...this.bindings().filter(item => item.repositoryId === repositoryId).map(item => item.chatId),
      ...this.db.prepare('SELECT DISTINCT chat FROM routes WHERE repository=?').all(repositoryId).map(row => String(row.chat))])]
  }
  static identity(): Pick<Repository, 'id' | 'token' | 'profile'> {
    const id = randomUUID()
    return { id, token: randomBytes(32).toString('hex'), profile: `superagent-${id.slice(0, 8)}` }
  }
  private item(row: Record<string, unknown>): JournalItem {
    const trigger = JSON.parse(String(row.value)) as Trigger
    return { id: String(row.id), repositoryId: String(row.repository), chatId: String(row.chat ?? trigger.meta.chatId ?? ''),
      thread: String(row.thread ?? trigger.threads[0]?.id ?? ''), trigger, attempts: Number(row.attempts), nextAt: Number(row.next_at),
      ...(row.error ? { error: String(row.error) } : {}) }
  }
  private routes(): { chats: Map<string, string | undefined>; repositories: Map<string, boolean>; pins: Map<string, string> } {
    const chats = new Map<string, string | undefined>()
    for (const binding of this.bindings()) chats.set(binding.chatId, binding.enabled ? binding.repositoryId : undefined)
    const repositories = new Map(this.repositories().map(item => [item.id, item.enabled]))
    const pins = new Map(this.db.prepare('SELECT thread,repository FROM routes').all().map(row => [String(row.thread), String(row.repository)]))
    return { chats, repositories, pins }
  }
  private holdOf(item: JournalItem, routes: ReturnType<ManagerStore['routes']>): HoldReason | undefined {
    if (!routes.chats.has(item.chatId)) return 'binding-missing'
    if (routes.chats.get(item.chatId) === undefined) return 'group-disabled'
    if (routes.repositories.get(item.repositoryId) === false) return 'repository-disabled'
    const pinned = routes.pins.get(item.thread)
    if (pinned && pinned !== item.repositoryId) return 'thread-reassigned'
    return undefined
  }
}
