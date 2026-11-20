/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'
import type { ScopeStatus } from './core/scope.ts'
import type { WorktreePreparation } from './infra/worktree.ts'
import type { AgentRun } from './executor/agents.ts'

/**
 * A write run whose real workspace change left the ticket's declared scope. The ticket's delivery is blocked until a
 * person approves the extension, which merges the approved paths into the ticket's scope.
 */
export interface ScopeOverrun {
  runId: string
  /** The changed paths outside the declared scope, as `git status` reports them. */
  paths: string[]
  at: string
  approval?: { at: string; by: string; paths: string[] }
}
/**
 * What the worker intends to deliver, recorded before the host acts so an unknown result can be recovered by querying
 * the repository instead of repeating a push or a pull request.
 */
export interface DeliveryPlan {
  action: 'push' | 'pr'
  branch: string
  base: string
  /** The remote head the worker expects before it pushes; a different remote head means another writer got there first. */
  expected: string
  title?: string
  body?: string
  /** The pull request this plan opens or updates, when known in advance. */
  pr?: number
  at: string
  result?: { at: string; outcome: 'applied' | 'unknown' | 'failed'; branchSha?: string; pr?: number; state?: string; detail?: string }
}
/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Executor: durable preparation state, so a failed command cannot leave a falsely ready directory. */
  executor: { preparation: family<'preparing' | 'ready', [ticket: string]>('executor-preparation:'),
    /** Durable worktree preparation phase of a ticket (`pending`, `preparing`, `ready`, `failed`), resumed after a restart. */
    worktree: family<WorktreePreparation, [ticket: string]>('executor-worktree:'),
    /** Durable write occupancy of a ticket, with the tickets it waits for, as the task page shows it. */
    scope: family<ScopeStatus, [ticket: string]>('executor-scope:'),
    /** Durable delegation run of a ticket to a local agent CLI, by run id. */
    agentRun: family<AgentRun, [ticket: string, run: string]>('executor-agent-run:'),
    /** A ticket's recent delegation runs, oldest first, bounded to its last 20. */
    agentRuns: family<string[], [ticket: string]>('executor-agent-runs:'),
    /** A write run that changed paths outside the ticket's scope, blocking delivery until a person approves. */
    overrun: family<ScopeOverrun, [ticket: string]>('executor-overrun:'),
    /** The delivery the worker intends and what the host observed, so an unknown result can be recovered. */
    delivery: family<DeliveryPlan, [ticket: string]>('executor-delivery:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}
