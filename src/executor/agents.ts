/**
 * Delegation runs to the local agent CLIs (`codex`, `claude`), owned by the Executor: a run starts in the background,
 * its record is written to KV, and its result is delivered to the ticket's worker Session only while the run's Assignment
 * still runs the ticket.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { covers, key, normalizeScopePath, runningAssignment, liveTicket } from '../core/index.ts'
import type { Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import { until } from './background.ts'

/** The agent CLIs delegation supports. */
export type AgentKind = 'codex' | 'claude'
/** Whether a run may only read its workspace, or may write it. */
export type AgentPermission = 'read' | 'write'
/** A run that starts (`running`) and ends `done`, `failed`, or `stopped`; `interrupted` is a run a restart cut off. */
export type AgentRunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'
/** Why a run failed, told apart so the worker can repair or retry: an expired login, a limit, a permission, a timeout, a missing CLI, or the agent itself. */
export type AgentFailure = 'login' | 'limit' | 'permission' | 'timeout' | 'unavailable' | 'failed'

/** What the agent said when it ended, with its reported cost and token usage. */
export interface AgentResult { text: string; costUsd?: number; usage?: Record<string, unknown> }
/** The workspace's real difference after a run, captured separately from what the agent said it did. */
export interface AgentChanges { status: string; stat: string }
/** A durable delegation run of one ticket. */
export interface AgentRun {
  id: string
  ticketId: string
  /** The Assignment that submitted the run; a late result of an older Assignment is recorded but not delivered. */
  assignmentId: string
  agent: AgentKind
  permission: AgentPermission
  prompt: string
  status: AgentRunStatus
  /** The agent's own session id, used to continue the conversation. */
  externalId?: string
  /** The run this one continues, when it resumed an external session. */
  resumeOf?: string
  /** The ticket's workspace directory the run started in. */
  directory: string
  startedAt: string
  endedAt?: string
  /** The process exit code, when the process exited (null when a signal ended it). */
  exitCode?: number | null
  result?: AgentResult
  changes?: AgentChanges
  /** When a stop was requested, kept while the process may still be alive. */
  stopRequestedAt?: string
  /** Set when the process survived the stop bound: the run still counts as running and holds its write slot. */
  stopUnconfirmed?: boolean
  error?: string
  errorKind?: AgentFailure
}
/** What a worker asks for: a fresh run, or one continuing the stored external session of `resumeOf`. */
export interface AgentRunRequest {
  agent: AgentKind
  prompt: string
  permission: AgentPermission
  resumeOf?: string
}
/**
 * What a host reports about one agent CLI: whether it is installed, and whether the host can hold the file-access
 * boundary delegation promises. An unavailable agent is shown as unavailable instead of being run unconstrained.
 */
export interface AgentProbe { kind: AgentKind; available: boolean; detail?: string; repair?: string }
/** The result of stopping one run: the recorded run, and whether its process really left within the stop bound. */
export interface AgentStopResult { run: AgentRun; confirmed: boolean }
/** The result of stopping every run of a ticket: whether all left, and their final records. */
export interface AgentStopAllResult { confirmed: boolean; runs: AgentRun[] }
/** The delegation surface of an Executor, which the worker's tool and the stop path use. */
export interface AgentDelegation {
  start(ticket: Ticket, request: AgentRunRequest): AgentRun
  resume(ticket: Ticket, runId: string, prompt: string): AgentRun
  stop(ticketId: string, runId: string, reason?: string): Promise<AgentStopResult>
  status(ticketId: string, runId?: string): AgentRun | AgentRun[] | undefined
  stopAll(ticketId: string, reason: string): Promise<AgentStopAllResult>
  /** This delegation's probe of the agents it can run; absent on a delegation that cannot probe. */
  probe?(): AgentProbe[]
}

/** The parsed end of an agent's output; `error` is set when the agent reported a failure. */
export interface ParsedAgentOutput { text: string; externalId?: string; costUsd?: number; usage?: Record<string, unknown>; error?: string }

/** Cap on the bytes collected from one stream of an agent process. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** Cap on the recorded workspace difference. */
const MAX_CHANGES_CHARS = 4000
/** How many runs a ticket's index keeps, oldest dropped first. */
const MAX_RUNS = 20
/** How long one run may take before it is stopped and reported as a timeout. */
const RUN_LIMIT_MS = 30 * 60_000
/** How long a stop waits for the agent processes to exit. */
const STOP_MS = 10_000
/** Cap on the result text in a delivered note. */
const NOTE_RESULT_CHARS = 3000
/** Cap on the output text kept in a failure record. */
const ERROR_TEXT_CHARS = 2000
/** The default CLI prefix of each agent; tests replace it with a fixture script. */
export const DEFAULT_BINARIES: Readonly<Record<AgentKind, readonly string[]>> = { claude: ['claude'], codex: ['codex'] }
/** Cap on the amount of output parsed for a result. */
const MAX_PARSE_CHARS = 4 * 1024 * 1024

/** The proxy variables an agent process may inherit; the canonical names the CLIs read. */
const PROXY_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const
/** Resolved once on macOS: both CLIs ignore the system proxy, so the host reads it and passes it explicitly. */
let systemProxyCache: Record<string, string> | undefined

/** Parses the fields of `scutil --proxy` into proxy variables; empty when no proxy is enabled. */
export function parseSystemProxy(output: string): Record<string, string> {
  const field = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm').exec(output)?.[1]
  const url = (host: string, port: string): string => `http://${field(host) ?? '127.0.0.1'}:${field(port) ?? '80'}`
  const vars: Record<string, string> = {}
  const http = field('HTTPEnable') === '1' ? url('HTTPProxy', 'HTTPPort') : undefined
  const https = field('HTTPSEnable') === '1' ? url('HTTPSProxy', 'HTTPSPort') : undefined
  if (https ?? http) vars.HTTPS_PROXY = (https ?? http)!
  if (http ?? https) vars.HTTP_PROXY = (http ?? https)!
  if (field('SOCKSEnable') === '1') vars.ALL_PROXY = `socks5://${field('SOCKSProxy') ?? '127.0.0.1'}:${field('SOCKSPort') ?? '1080'}`
  return vars
}
/** The macOS system proxy, resolved once; empty on other platforms or when the host has no proxy enabled. */
const systemProxy = (): Record<string, string> => {
  if (systemProxyCache) return systemProxyCache
  systemProxyCache = {}
  if (process.platform === 'darwin') {
    try { systemProxyCache = parseSystemProxy(execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 5000 })) }
    catch { /* A host that cannot report its proxy runs the CLIs without one, as before. */ }
  }
  return systemProxyCache
}
/**
 * The proxy environment of an agent process, in precedence order: explicit `agentEnv` settings, then the host's proxy
 * variables, then the macOS system proxy. The CLIs ignore the system proxy, so without one of these they cannot connect.
 */
export function agentEnvironment(explicit: Record<string, string> = {}, host: NodeJS.ProcessEnv = process.env,
  system: () => Record<string, string> = systemProxy): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const name of PROXY_NAMES) {
    const value = host[name] ?? host[name.toLowerCase()]
    if (value) vars[name] = value
  }
  if (!Object.keys(vars).length) Object.assign(vars, system())
  return { ...vars, ...explicit }
}

/** The host tools that can hold a file-access boundary around a child process: `sandbox-exec` on macOS, `bwrap` on Linux. */
const SANDBOX_TOOLS: Partial<Record<NodeJS.Platform, { path: string; name: string }>> = {
  darwin: { path: '/usr/bin/sandbox-exec', name: 'sandbox-exec' },
  linux: { path: 'bwrap', name: 'bwrap' },
}
/** Variables an agent process may inherit from the host, besides its proxy variables and its own temporary home. */
const ENV_ALLOW = ['PATH', 'SHELL', 'USER', 'LOGNAME', 'TERM'] as const
/** Credentials an agent process must never inherit: delivery accounts, the Feishu bot, cloud keys, instance management. */
const ENV_DENY = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS'] as const
/** Credential families denied by prefix, whatever variable names they add later. */
const ENV_DENY_PREFIX = ['DSH_', 'FEISHU_', 'LARK_', 'AWS_', 'GH_', 'GITHUB_'] as const
/** Why a host variable is denied to an agent process. */
const deniedName = (name: string): boolean =>
  (ENV_DENY as readonly string[]).includes(name) || ENV_DENY_PREFIX.some(prefix => name.startsWith(prefix))

/** Whether `path` is an executable file; a probe treats a directory on PATH as no CLI. */
const isExecutable = (path: string): boolean => {
  try { return existsSync(path) && statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0 } catch { return false }
}

/** Inputs of `probeAgents`: the CLI prefixes to look for, and the host facts to look them up with; tests replace both. */
export interface AgentProbeOptions {
  binaries?: Partial<Record<AgentKind, readonly string[]>>
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  searchPath?: string
}
/**
 * Probes the agent CLIs this host can run: the binary must be found, and the host must be able to constrain the child's
 * file access (`sandbox-exec` on macOS, `bwrap` on Linux). Without that boundary an agent is reported unavailable rather
 * than run unconstrained, which is what §4.3 requires: a host that cannot hold the boundary says so.
 */
export function probeAgents(options: AgentProbeOptions = {}): AgentProbe[] {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? isExecutable
  const searchPath = options.searchPath ?? process.env.PATH ?? ''
  const locate = (command: string): string | undefined => {
    if (command.includes('/')) return exists(command) ? command : undefined
    for (const dir of searchPath.split(':')) {
      if (!dir) continue
      const candidate = join(dir, command)
      if (exists(candidate)) return candidate
    }
    return undefined
  }
  const tool = SANDBOX_TOOLS[platform]
  const constrained = tool ? exists(tool.path) : false
  return (['claude', 'codex'] as const).map((kind): AgentProbe => {
    const binary = (options.binaries?.[kind] ?? DEFAULT_BINARIES[kind])[0] ?? kind
    const found = locate(binary)
    if (!found) {
      return { kind, available: false, detail: `The ${kind} CLI is not on PATH: ${binary} was not found.`,
        repair: `Install ${kind} and make sure its executable is on PATH.` }
    }
    if (!constrained) {
      return { kind, available: false,
        detail: `This host cannot constrain ${kind}'s file access (no ${tool?.name ?? 'sandbox tool'} is available), so the CLI could read and write outside the ticket's workspace.`,
        repair: `Install ${tool?.name ?? 'a sandbox tool that can constrain file access'} or run dsh-superagent on a host that provides one.` }
    }
    // The boundary each CLI actually gets: Codex's own sandbox keeps its writes in the workspace; Claude gets plan or
    // acceptEdits, this run's private home, and the credential-stripped environment.
    const boundary = kind === 'codex' ? "Codex's own sandbox keeps its writes inside the workspace"
      : 'Claude runs with plan (read) or acceptEdits (write) and a private home'
    return { kind, available: true, detail: `${kind} was found at ${found}; ${boundary}; this host provides ${tool?.name ?? 'a sandbox tool'}.` }
  })
}

/**
 * The environment of one agent process: an allowlist of the host's harmless variables, the proxy variables above, the
 * denied credential families explicitly removed, and a fresh home and temp directory private to this run. The subprocess
 * runtime merges this onto its scrubbed ambient environment, so a name mapped to `undefined` is one it must drop.
 */
export function agentProcessEnvironment(home: string, explicit: Record<string, string> = {}, host: NodeJS.ProcessEnv = process.env,
  system: () => Record<string, string> = systemProxy): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {}
  for (const name of ENV_ALLOW) {
    const value = host[name]
    if (value) vars[name] = value
  }
  if (host.LANG) vars.LANG = host.LANG
  for (const [name, value] of Object.entries(host)) if (name.startsWith('LC_') && value) vars[name] = value
  Object.assign(vars, agentEnvironment(explicit, host, system))
  vars.HOME = home
  vars.TMPDIR = home
  for (const name of Object.keys(host)) if (deniedName(name)) vars[name] = undefined
  return vars
}

/** The paths of a `git status --porcelain` output; a rename is reported by its destination, which is where a write landed. */
export function changedPaths(status: string): string[] {
  const paths: string[] = []
  for (const line of status.split('\n')) {
    if (line.length < 4) continue
    let path = line.slice(3)
    const arrow = path.lastIndexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    path = path.trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')
    if (path) paths.push(path)
  }
  return paths
}

const now = (): string => new Date().toISOString()
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const textOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The environment of the subprocess that reads a workspace's difference: a short bounded `git` run that never throws. */
const gitText = async (subprocess: SubprocessRuntime, argv: string[], cwd: string, lifetime: AbortSignal): Promise<string> => {
  try {
    const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal: AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 12 } } })
    const { exitCode } = await handle.done
    if (exitCode !== 0) return ''
    return (handle.collected.stdout?.readFrom(0).text ?? '').slice(0, MAX_CHANGES_CHARS).trim()
  } catch {
    return ''
  }
}
/**
 * Captures the workspace's real difference after a run: its short status and `git diff --stat`, each bounded. An empty
 * value means the directory is not a repository, or the host stopped before it could read it; the record stays honest.
 */
export const captureChanges = async (subprocess: SubprocessRuntime, directory: string, lifetime: AbortSignal): Promise<AgentChanges> =>
  ({ status: await gitText(subprocess, ['git', 'status', '--short'], directory, lifetime),
    stat: await gitText(subprocess, ['git', 'diff', '--stat'], directory, lifetime) })

/**
 * Builds the argv of one agent run. It comes from the ticket and the caller's agent, permission, prompt and resume choice
 * only; a caller cannot pass a directory or flags. Claude gets `--session-id` for a fresh run and `--resume` for a continued
 * one, with `plan` (no edits) for reading and `acceptEdits` (edits inside the workspace, no wider bypass) for writing; Codex
 * gets `-C` for the directory and a `read-only` or `workspace-write` sandbox, and `resume <id>` when continuing.
 */
export function agentCommand(input: { agent: AgentKind; permission: AgentPermission; directory: string; prompt: string
  resume?: string; sessionId?: string }, binary: readonly string[] = DEFAULT_BINARIES[input.agent]): string[] {
  if (input.agent === 'claude') {
    const argv = [...binary, '-p', input.prompt, '--output-format', 'json', '--permission-mode',
      input.permission === 'read' ? 'plan' : 'acceptEdits']
    if (input.permission === 'read') argv.push('--allowedTools', 'Read,Grep,Glob')
    if (input.resume) argv.push('--resume', input.resume)
    else if (input.sessionId) argv.push('--session-id', input.sessionId)
    else throw new Error('A fresh claude run needs a session id')
    return argv
  }
  const sandbox = input.permission === 'read' ? 'read-only' : 'workspace-write'
  // The flags after the prompt are accepted; `resume` puts the external thread id before the prompt.
  if (input.resume) return [...binary, 'exec', 'resume', input.resume, input.prompt, '--json', '--skip-git-repo-check', '-C', input.directory, '-s', sandbox]
  return [...binary, 'exec', '--json', '--skip-git-repo-check', '-C', input.directory, '-s', sandbox, input.prompt]
}

/** Returns the last JSON object from `text` that `useful` accepts, tolerating extra lines before or after it. */
const lastJson = (text: string, useful: (value: Record<string, unknown>) => boolean): Record<string, unknown> | undefined => {
  const sliced = text.slice(-MAX_PARSE_CHARS)
  const whole: unknown = (() => {
    try { return JSON.parse(sliced) } catch { return undefined }
  })()
  if (isRecord(whole) && useful(whole)) return whole
  let found: Record<string, unknown> | undefined
  for (const line of sliced.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (isRecord(value) && useful(value)) found = value
    } catch {
      // A line that is not JSON on its own is not an event; the CLI may print human text around its JSON.
    }
  }
  return found
}
/** Parses one Claude Code `--output-format json` result: its session id, result text, error flag, usage, and cost. */
export function parseClaude(output: string): ParsedAgentOutput {
  const value = lastJson(output, candidate => 'session_id' in candidate || 'result' in candidate || 'is_error' in candidate)
  if (!value) return { text: '', error: 'The claude run printed no JSON result.' }
  const text = textOf(value.result) ?? ''
  const usage = isRecord(value.usage) ? value.usage : undefined
  const parsed: ParsedAgentOutput = { text, ...textOf(value.session_id) ? { externalId: textOf(value.session_id) } : {},
    ...number(value.total_cost_usd) !== undefined ? { costUsd: number(value.total_cost_usd) } : {}, ...usage ? { usage } : {} }
  if (value.is_error === true) parsed.error = text || 'The claude run reported an error.'
  return parsed
}
/** Parses Codex `--json` JSONL: the last agent message, any thread or session id it reports, and turn usage or an error. */
export function parseCodex(output: string): ParsedAgentOutput {
  const text = output.slice(-MAX_PARSE_CHARS)
  let message = '', externalId: string | undefined, error: string | undefined, usage: Record<string, unknown> | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let value: unknown
    try { value = JSON.parse(trimmed) } catch { continue }
    if (!isRecord(value)) continue
    externalId = textOf(value.thread_id) ?? textOf(value.session_id) ?? externalId
    const item = isRecord(value.item) ? value.item : undefined
    if (item) {
      if (item.type === 'agent_message' && textOf(item.text)) message = textOf(item.text) ?? message
      else if (item.type === 'error') error = textOf(item.message) ?? error
    }
    if (value.type === 'error') error = textOf(value.message) ?? error
    if (isRecord(value.usage)) usage = value.usage
    if (isRecord(value.turn) && isRecord(value.turn.usage)) usage = value.turn.usage
  }
  return { text: message, ...externalId ? { externalId } : {}, ...usage ? { usage } : {}, ...error && !message ? { error } : {} }
}

/** Classifies a failure's text into the repair category the worker should see; `failed` when nothing else fits. */
export function agentErrorKind(text: string): AgentFailure {
  const value = text.toLowerCase()
  if (/not logged in|logged out|log ?in|sign ?in|authenticat|unauthori[sz]ed|invalid api key|api key.*(?:missing|invalid)|token.*expired|401/.test(value)) return 'login'
  if (/rate.?limit|usage limit|quota|too many requests|credit|429/.test(value)) return 'limit'
  if (/permission|denied|forbidden|not allowed|403|sandbox/.test(value)) return 'permission'
  // The CLIs ignore the macOS system proxy, so their reconnection and timeout wording means the host proxy was not passed.
  if (/reconnecting|proxy|network|offline|econn|request timed out|could not resolve/.test(value)) return 'unavailable'
  if (/timed? ?out|timeout/.test(value)) return 'timeout'
  if (/enoent|command not found|not found on path|is not installed|no such file/.test(value)) return 'unavailable'
  return 'failed'
}
/** The one-line repair hint a failure of `kind` carries into the worker's note. */
export function agentRepairHint(kind: AgentFailure): string {
  switch (kind) {
    case 'login': return 'The agent CLI is not signed in. Sign in locally, then run it again.'
    case 'limit': return 'The agent reported a usage or rate limit. Wait for it to reset, or use the other agent.'
    case 'permission': return 'The agent was denied a permission it needs. Check the run permission and the workspace.'
    case 'timeout': return 'The agent ran past its time limit and was stopped. Continue it, or start a narrower run.'
    case 'unavailable': return 'The agent CLI could not reach its service, or is not installed. Check the network and HTTPS_PROXY/HTTP_PROXY, and that the CLI is on PATH, then retry.'
    case 'failed': return 'The agent failed. Read its output and the workspace difference before retrying.'
  }
}

/** Truncates `text` to `limit` characters, marking that it was cut. */
const capped = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit)}…`
/**
 * The one injected note a finished run delivers: its id and status, the failure with its repair hint, a summary of the
 * result, the real workspace difference, any paths written outside the ticket's scope, and the warning that a process exit
 * is not a check.
 */
export function agentNote(run: AgentRun, overrun: readonly string[] = []): string {
  const lines = [`Agent run ${run.id} (${run.agent}, ${run.permission}) ended with status ${run.status}.`]
  if (run.error) lines.push(`Error (${run.errorKind ?? 'failed'}): ${capped(run.error, ERROR_TEXT_CHARS)}`, agentRepairHint(run.errorKind ?? 'failed'))
  if (run.result?.text) lines.push(`Result summary: ${capped(run.result.text, NOTE_RESULT_CHARS)}`)
  const changes = run.changes
  if (changes?.status || changes?.stat) {
    lines.push('Workspace difference:')
    if (changes.status) lines.push(changes.status)
    if (changes.stat) lines.push(changes.stat)
  } else {
    lines.push('Workspace difference: none captured.')
  }
  if (overrun.length) {
    lines.push(`Paths written outside this ticket's scope (delivery stays blocked until a person approves them):`)
    for (const path of overrun.slice(0, 20)) lines.push(`- ${path}`)
  }
  lines.push(`The process exited; that alone is not a check. Read the real difference in ${run.directory} and run the checks before reporting.`)
  return lines.join('\n')
}

/**
 * The read model of a Ticket's runs for the views: the run index in delegation order, oldest first, skipping records
 * that no longer exist. It only reads the KV families `AgentRuns` writes, so no view has to know their layout.
 */
export function agentRunsOf(store: Store, ticketId: string): AgentRun[] {
  const index = store.get(KV.executor.agentRuns(ticketId)) ?? []
  return index.map(id => store.get(KV.executor.agentRun(ticketId, id))).filter((run): run is AgentRun => !!run)
}

/** The host dependencies of `AgentRuns`; DshExecutor supplies them, and tests supply fakes. */
export interface AgentRunsHost {
  readonly subprocess: SubprocessRuntime
  readonly store: Pick<Store, 'get' | 'set' | 'delete' | 'tickets'>
  /** Aborted when dsh-superagent stops, ending every run. */
  readonly lifetime: AbortSignal
  /** Whether `assignmentId` still runs `ticketId`, which decides whether a finished run's note may be delivered. */
  running(ticketId: string, assignmentId: string): boolean
  /** Why a write run is refused now, such as another ticket writing the repository; undefined when it may start. */
  writeRefusal?(ticketId: string): string | undefined
  /** Delivers a note to the worker Session after rechecking the run's Assignment. */
  deliver(ticketId: string, assignmentId: string, requestId: string, text: string): Promise<void>
}

/** Options of `AgentRuns`: the agent CLI prefixes, and the run and stop time limits. */
export interface AgentRunsOptions {
  /** Overrides a CLI's argv prefix, such as a fixture script in tests; see `DEFAULT_BINARIES`. */
  binaries?: Partial<Record<AgentKind, readonly string[]>>
  /** How long one run may take before it is stopped; defaults to 30 minutes. */
  runMs?: number
  /** How long a stop waits for the process to exit; defaults to 10 seconds. */
  stopMs?: number
  /** Extra environment of every agent process, such as a proxy; it wins over the host's own proxy variables. */
  agentEnv?: Record<string, string>
  /** Replaces the probe of the agents this host can run; tests use it where the host has no sandbox tool. */
  probe?: () => AgentProbe[]
}

/** A run whose process this process owns, with the private home directory created for it. */
interface ActiveRun { run: AgentRun; controller: AbortController; handle: SubprocessHandle; finished: Promise<void>
  home: string; stopReason?: string; timedOut?: boolean }

/**
 * Owns the background agent processes of the Executor: it starts them idempotently, records them durably, settles their
 * exits (result, real workspace difference, delivery), stops them in a bounded way, and reconciles runs a restart cut off.
 */
export class AgentRuns implements AgentDelegation {
  private readonly active = new Map<string, ActiveRun>()
  private readonly binaries: Readonly<Record<AgentKind, readonly string[]>>
  private readonly runMs: number
  private readonly stopMs: number
  private readonly env: Record<string, string>
  private readonly probes: AgentProbe[]

  constructor(private readonly host: AgentRunsHost, options: AgentRunsOptions = {}) {
    this.binaries = { claude: options.binaries?.claude ?? DEFAULT_BINARIES.claude, codex: options.binaries?.codex ?? DEFAULT_BINARIES.codex }
    this.runMs = options.runMs ?? RUN_LIMIT_MS
    this.stopMs = options.stopMs ?? STOP_MS
    this.env = agentEnvironment(options.agentEnv)
    this.probes = options.probe?.() ?? probeAgents({ binaries: this.binaries })
    this.reconcile()
    // A host stop ends every run with its worker: the process dies with the host anyway, so record it as stopped rather than
    // leaving a `running` record behind for the next start to reconcile.
    const abort = () => { void this.shutdown('dsh-superagent stopped') }
    if (this.host.lifetime.aborted) abort()
    else this.host.lifetime.addEventListener('abort', abort, { once: true })
  }

  /** Starts a run for the ticket's running Assignment, or returns the stored run of the same submission. */
  start(ticket: Ticket, request: AgentRunRequest): AgentRun {
    return this.launch(ticket, request, undefined)
  }
  /** What this delegation knows about the agents it can run, computed once from the CLIs and the host's sandbox tools. */
  probe(): AgentProbe[] {
    return this.probes.map(entry => ({ ...entry }))
  }
  /** Continues the stored external session of `runId` with `prompt`, when that run belongs to the ticket's running Assignment. */
  resume(ticket: Ticket, runId: string, prompt: string): AgentRun {
    const parent = this.host.store.get(KV.executor.agentRun(ticket.id, runId))
    if (!parent) throw new Error(`No run ${runId} belongs to this ticket.`)
    if (parent.status === 'running') throw new Error(`Run ${runId} is still running; stop it before continuing it.`)
    if (!parent.externalId) throw new Error(`Run ${runId} recorded no external session id, so it cannot be continued. Start a new run instead.`)
    const stored = this.host.store.tickets.get(ticket.id) ?? ticket
    const assignment = runningAssignment(stored)
    if (!liveTicket(stored) || !assignment) throw new Error('A run can only be continued while its ticket has a running Assignment.')
    if (parent.assignmentId !== assignment.id) throw new Error(`Run ${runId} belongs to an earlier Assignment and cannot be continued for this one.`)
    return this.launch(stored, { agent: parent.agent, prompt, permission: parent.permission, resumeOf: parent.id }, parent.externalId)
  }
  /** Stops a run's process, waits (bounded) for it to leave, and reports whether it really did. */
  async stop(ticketId: string, runId: string, reason = 'Stopped by the worker'): Promise<AgentStopResult> {
    const run = this.host.store.get(KV.executor.agentRun(ticketId, runId))
    if (!run) throw new Error(`No run ${runId} belongs to this ticket.`)
    const active = this.active.get(runId)
    if (!active) {
      // A `running` record without a process is a restart leftover (normally already reconciled): settle it here too.
      if (run.status !== 'running') return { run, confirmed: true }
      return { run: this.write({ ...run, status: 'stopped', endedAt: now(), error: `Stopped: ${reason}` }), confirmed: true }
    }
    active.stopReason = reason
    const stopRequestedAt = now()
    this.write({ ...run, stopRequestedAt })
    this.abort(active)
    await until(active.finished, undefined, this.stopMs)
    const settled = this.host.store.get(KV.executor.agentRun(ticketId, runId)) ?? run
    if (settled.status === 'running') {
      // The process survived the bound: keep the run running, keep its write slot, and say the stop is unconfirmed.
      return { run: this.write({ ...settled, stopRequestedAt, stopUnconfirmed: true }), confirmed: false }
    }
    return { run: settled, confirmed: true }
  }
  /** Returns one run of the ticket, or its recent runs (newest first) when `runId` is absent. */
  status(ticketId: string, runId?: string): AgentRun | AgentRun[] | undefined {
    if (runId) return this.host.store.get(KV.executor.agentRun(ticketId, runId))
    return this.index(ticketId).map(id => this.host.store.get(KV.executor.agentRun(ticketId, id))).filter((run): run is AgentRun => !!run)
      .reverse()
  }
  /**
   * Stops every run of the ticket and waits (bounded) for the processes to leave. A run that survives the bound is kept
   * `running` with `stopUnconfirmed`, so the ticket keeps its write slot until the process is really gone.
   */
  async stopAll(ticketId: string, reason: string): Promise<AgentStopAllResult> {
    const active = [...this.active.values()].filter(entry => entry.run.ticketId === ticketId)
    const stopRequestedAt = now()
    for (const entry of active) {
      entry.stopReason = reason
      this.write({ ...(this.host.store.get(KV.executor.agentRun(ticketId, entry.run.id)) ?? entry.run), stopRequestedAt })
      this.abort(entry)
    }
    if (active.length) await until(Promise.allSettled(active.map(entry => entry.finished)), undefined, this.stopMs)
    const runs: AgentRun[] = []
    let confirmed = true
    for (const entry of active) {
      const current = this.host.store.get(KV.executor.agentRun(ticketId, entry.run.id)) ?? entry.run
      if (current.status === 'running') {
        confirmed = false
        runs.push(this.write({ ...current, stopRequestedAt, stopUnconfirmed: true }))
      } else runs.push(current)
    }
    return { confirmed, runs }
  }
  /** Stops every run of every ticket; used when the host stops. */
  async shutdown(reason: string): Promise<void> {
    const active = [...this.active.values()]
    for (const entry of active) { entry.stopReason = reason; this.abort(entry) }
    if (active.length) await until(Promise.allSettled(active.map(entry => entry.finished)), undefined, this.stopMs)
  }

  /** Starts one process, or returns the stored run of an identical submission; the run record exists before the process. */
  private launch(ticket: Ticket, request: AgentRunRequest, resumeExternalId: string | undefined): AgentRun {
    const stored = this.host.store.tickets.get(ticket.id) ?? ticket
    const assignment = runningAssignment(stored)
    if (!liveTicket(stored) || !assignment) throw new Error('Agents can only run for a ticket with a running Assignment.')
    const directory = stored.execution?.directory
    if (!directory) throw new Error('This ticket has no workspace directory yet, so an agent cannot run for it.')
    const prompt = request.prompt.trim()
    if (!prompt) throw new Error('An agent run needs a prompt.')
    const resumeOf = request.resumeOf
    const id = key(stored.id, assignment.id, request.agent, prompt, request.permission, resumeOf ?? '')
    const existing = this.host.store.get(KV.executor.agentRun(stored.id, id))
    if (existing) return existing
    if (request.permission === 'write') {
      const refusal = this.host.writeRefusal?.(stored.id)
      if (refusal) throw new Error(refusal)
    }
    if (this.host.lifetime.aborted) throw new Error('dsh-superagent is stopping; the agent run was not started.')
    const probe = this.probes.find(entry => entry.kind === request.agent)
    if (probe && !probe.available) {
      // An unavailable agent is refused for reading too: §4.3 says a host that cannot constrain it reports that, not runs it.
      throw new Error(`${probe.detail ?? `The ${request.agent} agent is not available on this host.`}${probe.repair ? ` ${probe.repair}` : ''}`)
    }
    const sessionId = randomUUID()
    const startedAt = now()
    const run: AgentRun = { id, ticketId: stored.id, assignmentId: assignment.id, agent: request.agent, permission: request.permission,
      prompt, status: 'running', directory, startedAt, ...resumeOf ? { resumeOf } : {}, ...resumeExternalId ? { externalId: resumeExternalId } : {} }
    this.write(run)
    this.add(run)
    const controller = new AbortController()
    const argv = agentCommand({ agent: request.agent, permission: request.permission, directory, prompt,
      ...resumeExternalId ? { resume: resumeExternalId } : { sessionId } }, this.binaries[request.agent])
    // Every run gets its own private home and temp directory: the CLI writes its state there, and a run cannot read the
    // host user's credentials through `$HOME` or leave state another run inherits.
    const home = mkdtempSync(join(tmpdir(), 'dsh-agent-home-'))
    try { chmodSync(home, 0o700) } catch { /* The host's temp root is already private on most systems. */ }
    let handle: SubprocessHandle
    try {
      // Only the allowlisted variables, the proxy variables and the private home are passed explicitly: the service's base
      // environment already carries PATH, and it is scrubbed of credential-shaped variables, which a spread of `process.env`
      // would put back. The denied names are mapped to `undefined`, which the spawn drops.
      handle = this.host.subprocess.spawn({ argv, cwd: directory, graceMs: 2000, signal: controller.signal,
        env: agentProcessEnvironment(home, this.env),
        stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: MAX_OUTPUT_BYTES } } })
    } catch (error) {
      rmSync(home, { recursive: true, force: true })
      const text = String(error)
      return this.write({ ...run, status: 'failed', endedAt: now(), error: text, errorKind: agentErrorKind(text) })
    }
    let finish = (): void => {}
    const finished = new Promise<void>(resolve => { finish = resolve })
    const active: ActiveRun = { run, controller, handle, finished, home }
    this.active.set(id, active)
    const timer = setTimeout(() => { active.timedOut = true; this.abort(active) }, this.runMs)
    void handle.done.then(exit => this.settle(active, exit.exitCode, finish, timer), error => this.settle(active, null, finish, timer, error))
    return run
  }
  /** Records a finished run, captures the workspace difference, and delivers the note when its Assignment still runs the ticket. */
  private async settle(active: ActiveRun, exitCode: number | null, finish: () => void, timer: ReturnType<typeof setTimeout>,
    failure?: unknown): Promise<void> {
    const { run, handle } = active
    try {
      clearTimeout(timer)
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      const parsed = run.agent === 'claude' ? parseClaude(stdout) : parseCodex(stdout)
      const changes = await captureChanges(this.host.subprocess, run.directory, this.host.lifetime)
      // A write run's real paths are compared with the ticket's scope: a path outside it is recorded for a person to approve
      // before delivery, and the run's own result is kept as it is.
      const overrun = run.permission === 'write' ? this.overrun(run, changes) : []
      const externalId = parsed.externalId ?? run.externalId
      let status: AgentRunStatus = 'done', error: string | undefined, errorKind: AgentFailure | undefined
      if (active.timedOut) {
        status = 'failed'; errorKind = 'timeout'; error = `The run did not finish within ${Math.round(this.runMs / 60_000)} minutes and was stopped.`
      } else if (active.stopReason !== undefined) {
        status = 'stopped'; error = `Stopped: ${active.stopReason}`
      } else if (failure !== undefined) {
        status = 'failed'; error = String(failure); errorKind = agentErrorKind(error)
      } else if (parsed.error !== undefined) {
        status = 'failed'; error = parsed.error; errorKind = agentErrorKind(parsed.error)
      } else if (exitCode !== 0) {
        status = 'failed'; error = capped((stderr || stdout).trim(), ERROR_TEXT_CHARS) || `The agent exited with code ${String(exitCode)}`
        errorKind = agentErrorKind(error)
      }
      // A stop that is still unconfirmed leaves its mark on the record if it raced this exit; the exit settles the run.
      const current = this.host.store.get(KV.executor.agentRun(run.ticketId, run.id))
      const base: AgentRun = { ...(current?.status === 'running' ? current : run) }
      delete base.stopUnconfirmed
      const settled: AgentRun = { ...base, status, endedAt: now(), exitCode, changes,
        ...externalId ? { externalId } : {}, ...parsed.text ? { result: { text: parsed.text, ...parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {},
          ...parsed.usage ? { usage: parsed.usage } : {} } } : {}, ...error ? { error } : {}, ...errorKind ? { errorKind } : {} }
      this.write(settled)
      if (this.host.running(run.ticketId, run.assignmentId)) {
        try { await this.host.deliver(run.ticketId, run.assignmentId, `agent:${run.id}`, agentNote(settled, overrun)) }
        catch { /* A worker Session that cannot take the note is gone or stopping; the record carries the result. */ }
      }
    } finally {
      rmSync(active.home, { recursive: true, force: true })
      this.active.delete(run.id)
      finish()
    }
  }
  /**
   * The paths this write run changed that the ticket's scope does not cover. An absent or empty scope means the whole
   * repository, so it never overruns. A non-empty result is stored in `KV.executor.overrun` for delivery to check and a
   * person to approve; the run itself is not aborted and its result is kept.
   */
  private overrun(run: AgentRun, changes: AgentChanges): string[] {
    const scope = this.host.store.tickets.get(run.ticketId)?.scope
    if (!scope?.length) return []
    const outside = changedPaths(changes.status)
      .filter(path => !scope.some(entry => covers(normalizeScopePath(entry), normalizeScopePath(path))))
    if (outside.length) this.host.store.set(KV.executor.overrun(run.ticketId), { runId: run.id, paths: outside, at: now() })
    return outside
  }
  /** Aborts a run's process; the settle handler records it as stopped or timed out. */
  private abort(active: ActiveRun): void {
    active.controller.abort()
    active.handle.terminate()
  }
  /** Marks the runs a restart cut off as `interrupted`, keeping their external session so a worker can continue them. */
  private reconcile(): void {
    for (const ticket of this.host.store.tickets.list()) {
      for (const id of this.index(ticket.id)) {
        const run = this.host.store.get(KV.executor.agentRun(ticket.id, id))
        if (run?.status !== 'running') continue
        this.write({ ...run, status: 'interrupted', endedAt: now(), error: 'dsh-superagent restarted while this run was running.' })
      }
    }
  }
  /** A ticket's run index, oldest first. */
  private index(ticketId: string): string[] {
    return this.host.store.get(KV.executor.agentRuns(ticketId)) ?? []
  }
  /** Writes a run record and returns it. */
  private write(run: AgentRun): AgentRun {
    this.host.store.set(KV.executor.agentRun(run.ticketId, run.id), run)
    return run
  }
  /** Adds a run to its ticket's index, dropping the oldest run records beyond `MAX_RUNS`. */
  private add(run: AgentRun): void {
    const index = this.index(run.ticketId).filter(id => id !== run.id)
    index.push(run.id)
    const dropped = index.splice(0, Math.max(0, index.length - MAX_RUNS))
    this.host.store.set(KV.executor.agentRuns(run.ticketId), index)
    for (const id of dropped) this.host.store.delete(KV.executor.agentRun(run.ticketId, id))
  }
}
