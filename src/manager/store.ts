/** Durable repository bindings and at-least-once Feishu delivery journal. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'

export const RepositorySchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100),
  remote: z.string().regex(/^[\w.-]+\/[\w.-]+$/), directory: z.string().startsWith('/'),
  githubCli: z.string().min(1), allowedGithub: z.array(z.string().min(1)).default([]),
  allowedFeishu: z.array(z.string().min(1)).default([]), enabled: z.boolean().default(true),
  port: z.number().int().min(1024).max(65535), token: z.string().min(32), profile: z.string(),
})
export type Repository = z.infer<typeof RepositorySchema>
export const BindingSchema = z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), repositoryId: z.string().uuid(), enabled: z.boolean(), effectiveAt: z.string().datetime() })
export type Binding = z.infer<typeof BindingSchema>
export interface JournalItem { id: string; repositoryId: string; trigger: Trigger; attempts: number; error?: string }

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
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, next_at INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, repository TEXT NOT NULL, chat TEXT NOT NULL, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);`)
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
      if (new Set(repositories.map(item => item.directory)).size !== repositories.length) throw new Error('This local checkout is already registered')
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
      this.db.prepare('INSERT INTO inbox (id,repository,value) VALUES (?,?,?)').run(trigger.id, repositoryId, JSON.stringify({ ...trigger, meta: { ...trigger.meta, managerBindingRevision: this.revision() } }))
      return 'stored'
    })
  }
  pending(limit = 100, due = true): JournalItem[] {
    return this.db.prepare(`SELECT * FROM inbox WHERE delivered=0 AND next_at<=${due ? Date.now() : Number.MAX_SAFE_INTEGER} AND id IN
      (SELECT id FROM inbox i WHERE delivered=0 AND NOT EXISTS
        (SELECT 1 FROM inbox p WHERE p.delivered=0 AND p.repository=i.repository AND p.rowid<i.rowid))
      ORDER BY rowid LIMIT ?`).all(limit).map(row => ({ id: String(row.id), repositoryId: String(row.repository),
      trigger: JSON.parse(String(row.value)) as Trigger, attempts: Number(row.attempts), ...(row.error ? { error: String(row.error) } : {}) }))
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
}
