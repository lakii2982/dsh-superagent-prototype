/**
 * Host-executed GitHub delivery for an Executor Session: record a plan first, verify the remote head before pushing,
 * open at most one pull request, and recover an unknown result by querying the repository instead of repeating a write.
 */
import { z } from 'zod'
import { liveTicket, type Ticket } from '../../core/model.ts'
import { CliError, type Commands } from '../../infra/commands.ts'
import { KV, type DeliveryPlan } from '../../kv.ts'
import { claimPull, readPull, ticketBranch } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

export interface DeliveryToolsHost {
  /** Ticket records and the executor KV family: the delivery plan and the scope overrun that blocks delivery. */
  readonly store: Pick<Store, 'get' | 'set' | 'tickets' | 'settings'>
  /** Git and the agent's GitHub CLI, run through the deployment's injected identity and isolated git configuration. */
  readonly commands: Pick<Commands, 'git' | 'run' | 'gh' | 'withSignal'>
  /** GitHub Source context, whose claim rules decide whether an opened pull request may bind to this Ticket. */
  readonly github: SourceContext
}

/** One pull request as `gh pr list` reports it. */
const PullSummary = z.looseObject({ number: z.number().int().positive(), state: z.string(), url: z.string(),
  headRefOid: z.string().optional(), baseRefName: z.string().optional() })
const DefaultBranch = z.looseObject({ defaultBranchRef: z.looseObject({ name: z.string() }).nullish() })

const Action = z.enum(['plan', 'push', 'open', 'recover', 'status'])
const Args = z.object({
  action: Action,
  branch: z.string().trim().min(1).optional().describe('Branch to deliver, ending in the ticket\'s short name; defaults to the worktree branch.'),
  base: z.string().trim().min(1).optional().describe('Base branch of the pull request; defaults to the worktree base or the repository default.'),
  expected: z.string().trim().min(1).optional().describe('Remote head sha you expect, or for a branch that does not exist yet, the base commit it must descend from; a different head means another writer got there first, so the push is refused.'),
  title: z.string().trim().min(1).optional().describe('Pull request title; defaults to the ticket title.'),
  body: z.string().optional().describe('Pull request body.'),
  pr: z.number().int().positive().optional().describe('An existing pull request number.'),
}).strict()

type Args = z.infer<typeof Args>
/** Facts every answer carries so the worker can continue reconciling instead of guessing. */
type Answer = Record<string, unknown> & { ok: boolean; action: string }

const FAILED = (action: string, reason: string, detail: string, extra: Record<string, unknown> = {}): Answer =>
  ({ ok: false, action, reason, detail, ...extra })
const failure = (error: unknown) => {
  if (error instanceof CliError) return { reason: 'cli_failed' as const, detail: error.message.slice(0, 600),
    ...error.code !== undefined ? { http_status: error.code } : {}, ...error.exitCode !== undefined ? { exit_code: error.exitCode } : {} }
  return { reason: 'failed' as const, detail: (error instanceof Error ? error.message : String(error)).slice(0, 600) }
}
const planOf = (host: DeliveryToolsHost, ticketId: string): DeliveryPlan | undefined => host.store.get(KV.executor.delivery(ticketId))
const savePlan = (host: DeliveryToolsHost, ticketId: string, plan: DeliveryPlan): void => host.store.set(KV.executor.delivery(ticketId), plan)
const baseName = (ref: string): string => ref.replace(/^refs\/remotes\/origin\//, '').replace(/^origin\//, '')
/** The worktree's branch, or the conventional branch for a ticket that works in a checkout without one. */
const defaultBranch = (ticket: Ticket): string | undefined =>
  ticket.execution?.worktree?.branch ?? (ticket.execution?.name ? `agent/${ticket.execution.name}` : undefined)
const workspaceOf = (host: DeliveryToolsHost, ticket: Ticket): string | undefined =>
  ticket.execution?.directory || host.store.settings().executor.repositoryPath || undefined
const shaLike = (value: string): boolean => /^[0-9a-f]{40,64}$/.test(value)

/** Reads the remote head of `branch`, or undefined when the branch does not exist yet. */
async function remoteHead(host: DeliveryToolsHost, cwd: string, branch: string, signal: AbortSignal): Promise<string | undefined> {
  const output = await host.commands.withSignal(signal).git(['ls-remote', 'origin', `refs/heads/${branch}`], cwd)
  const line = output.split('\n').map(item => item.trim()).find(Boolean)
  return line?.split(/\s+/)[0] || undefined
}
/** The last commits on the remote branch, read after a fetch so a moved head can be shown as evidence. */
async function recentCommits(host: DeliveryToolsHost, cwd: string, branch: string, signal: AbortSignal): Promise<string[]> {
  const commands = host.commands.withSignal(signal)
  const fetched = await commands.git(['fetch', '--quiet', 'origin', `refs/heads/${branch}`], cwd).then(() => true).catch(() => false)
  if (!fetched) return []
  const output = await commands.git(['log', '--format=%h %s', '-5', 'FETCH_HEAD'], cwd).catch(() => '')
  return output.split('\n').map(item => item.trim()).filter(Boolean)
}
/** The local commit the push would publish. */
async function localHead(host: DeliveryToolsHost, cwd: string, branch: string, signal: AbortSignal): Promise<string | undefined> {
  const commands = host.commands.withSignal(signal)
  const sha = await commands.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd).catch(() => '')
  return sha.trim() || undefined
}
/** Whether `ancestor` is already contained in the local branch, so a plain push is a fast-forward. */
async function contains(host: DeliveryToolsHost, cwd: string, ancestor: string, branch: string, signal: AbortSignal): Promise<boolean> {
  try {
    await host.commands.withSignal(signal).git(['merge-base', '--is-ancestor', ancestor, `refs/heads/${branch}`], cwd)
    return true
  } catch { return false }
}

/**
 * The delivery tool. Every answer is structured JSON (never a thrown bare error) so a worker whose delivery result is
 * unknown can call `recover` and reconcile the branch, its sha and the pull request before retrying.
 */
export function deliveryTools(host: DeliveryToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [tool({
    name: 'orchestrator_delivery',
    description: 'Deliver this ticket through the host: plan, push, open (or reuse) one pull request, and recover a lost result by query. The host records the plan before writing, refuses to overwrite a moved remote branch, and blocks push/open while a scope overrun waits for approval.',
    schema: Args,
    execute: async (args: Args, signal: AbortSignal): Promise<Answer> => {
      // Every failure becomes a structured answer, so a worker can reconcile instead of seeing a bare tool error.
      try {
        const current = host.store.tickets.get(ticketId)
        if (!current) return FAILED(args.action, 'ticket_missing', 'This ticket no longer exists; stop delivering and report to the main Session.')
        const plan = planOf(host, ticketId)
        const branch = args.branch ?? plan?.branch ?? defaultBranch(current)
        if (args.action === 'status') {
          return { ok: true, action: 'status', ...branch ? { branch } : {}, plan: plan ?? null, result: plan?.result ?? null,
            ...overrunOf(host, ticketId) }
        }
        if (args.action === 'recover') {
          if (!branch) return FAILED('recover', 'no_branch', 'No branch is recorded for this ticket yet; write a plan first.', { plan: plan ?? null })
          return recover(host, ticketId, current, branch, plan, signal)
        }
        if (!liveTicket(current)) return FAILED(args.action, 'ticket_ended', 'This ticket ended; only recover and status can reconcile it now.', { plan: plan ?? null })
        const cwd = workspaceOf(host, current)
        if (!cwd) return FAILED(args.action, 'no_workspace', 'This ticket has no workspace directory to run git in.', { plan: plan ?? null })
        if (!branch) return FAILED(args.action, 'no_branch', 'Pass branch (or record a plan) before delivering.', { plan: plan ?? null })
        if (!ticketBranch(current, branch)) {
          return FAILED(args.action, 'branch_not_ticket', `Choose a branch whose last path segment is ${current.execution?.name ?? 'the ticket short name'}; the host will not push or open a pull request from another branch.`,
            { branch, plan: plan ?? null })
        }
        if (args.action === 'plan') return recordPlan(host, ticketId, current, args, branch, plan)
        const overrun = overrunOf(host, ticketId)
        if (overrun.overrun) {
          return FAILED(args.action, 'overrun_pending_approval', 'This ticket changed paths outside its declared scope; a person must approve them before anything reaches GitHub.',
            { ...overrun, plan: plan ?? null })
        }
        if (args.action === 'push') return push(host, ticketId, current, args, branch, cwd, plan, signal)
        return open(host, ticketId, current, args, branch, cwd, plan, signal)
      } catch (error) {
        const facts = failure(error)
        return FAILED(args.action, facts.reason, `The delivery action stopped before finishing: ${facts.detail}`, facts)
      }
    },
  })]
}

/** The scope overrun facts, present only while the delivery is blocked and no person approved the extra paths. */
function overrunOf(host: DeliveryToolsHost, ticketId: string): { overrun?: { paths: string[]; at: string }; paths?: string[] } {
  const overrun = host.store.get(KV.executor.overrun(ticketId))
  if (!overrun || overrun.approval) return {}
  return { overrun: { paths: overrun.paths, at: overrun.at }, paths: overrun.paths }
}

function recordPlan(host: DeliveryToolsHost, ticketId: string, ticket: Ticket, args: Args, branch: string, previous: DeliveryPlan | undefined): Answer {
  const expected = args.expected ?? previous?.expected ?? ticket.execution?.worktree?.baseSha ?? ''
  const base = args.base ?? previous?.base ?? baseName(ticket.execution?.worktree?.baseRef ?? '')
  const next: DeliveryPlan = { action: args.title !== undefined || args.body !== undefined ? 'pr' : previous?.action ?? 'push',
    branch, base, expected, at: previous?.at ?? new Date().toISOString(),
    ...args.title !== undefined ? { title: args.title } : previous?.title !== undefined ? { title: previous.title } : {},
    ...args.body !== undefined ? { body: args.body } : previous?.body !== undefined ? { body: previous.body } : {},
    ...args.pr !== undefined ? { pr: args.pr } : previous?.pr !== undefined ? { pr: previous.pr } : {},
    ...previous?.result ? { result: previous.result } : {} }
  savePlan(host, ticketId, next)
  return { ok: true, action: 'plan', plan: next, recorded: true }
}

async function push(host: DeliveryToolsHost, ticketId: string, ticket: Ticket, args: Args, branch: string, cwd: string,
  previous: DeliveryPlan | undefined, signal: AbortSignal): Promise<Answer> {
  const expected = args.expected ?? previous?.expected ?? ''
  if (!expected) {
    return FAILED('push', 'expected_required', 'Record the remote head you expect first: call action=plan with expected (the remote head, or the base commit when the branch does not exist yet), or pass expected. The host will not push without a head to check.',
      { branch, plan: previous ?? null })
  }
  if (!shaLike(expected)) return FAILED('push', 'invalid_expected', 'expected must be a full commit sha, as `git ls-remote` prints it.', { branch, expected })
  // §5.2: record the plan before the first write, even when the worker skipped action=plan. A retry names a new expected
  // head (a moved remote head, or the base commit of a branch that does not exist yet), which the plan must carry too.
  const planned: DeliveryPlan = previous
    ? { ...previous, action: 'push', branch, expected }
    : { action: 'push', branch, base: '', expected, at: new Date().toISOString() }
  savePlan(host, ticketId, planned)
  let remote: string | undefined
  try { remote = await remoteHead(host, cwd, branch, signal) }
  catch (error) { return FAILED('push', 'remote_unavailable', `Could not read the remote head, so nothing was pushed: ${failure(error).detail}`,
    { branch, expected, ...failure(error) }) }
  const local = await localHead(host, cwd, branch, signal)
  if (!local) return FAILED('push', 'no_local_branch', `Local branch ${branch} does not exist; nothing was pushed.`, { branch, expected })
  // A retry of a push that already landed returns the same applied result instead of refusing its own commit as "moved".
  if (remote === local) {
    const at = new Date().toISOString()
    const next: DeliveryPlan = { ...planned, result: { at, outcome: 'applied', branchSha: local, detail: 'The remote head already equals the local branch; nothing was pushed.' } }
    savePlan(host, ticketId, next)
    return { ok: true, action: 'push', branch, branch_sha: local, remote_head: local, expected, forced: false, already: true, plan: next }
  }
  // A first push: the remote branch does not exist yet, so `expected` is the base commit the ticket branch was cut from.
  // Require it to be an ancestor of the local branch, so creating the branch is a plain fast-forward rather than a
  // replacement of unknown history, and never force a branch that is not there.
  if (!remote) {
    if (!(await contains(host, cwd, expected, branch, signal))) {
      return FAILED('push', 'base_mismatch',
        `The remote branch ${branch} does not exist, and ${expected} is not an ancestor of the local branch; refusing to create it from an unexpected base.`,
        { branch, expected, remote_head: null })
    }
    try {
      await host.commands.withSignal(signal).git(['push', 'origin', branch], cwd)
    } catch (error) {
      return FAILED('push', 'push_rejected', `The remote refused the new branch; nothing changed: ${failure(error).detail}`,
        { branch, expected, remote_head: null, ...failure(error) })
    }
    const at = new Date().toISOString()
    const next: DeliveryPlan = { ...planned, result: { at, outcome: 'applied', branchSha: local,
      detail: 'Created the remote branch from its recorded base commit.' } }
    savePlan(host, ticketId, next)
    return { ok: true, action: 'push', branch, branch_sha: local, remote_head: local, expected, forced: false, created: true, plan: next }
  }
  if (remote !== expected) {
    const recent = await recentCommits(host, cwd, branch, signal)
    const at = new Date().toISOString()
    const detail = remote
      ? `The remote head is ${remote}, not the expected ${expected}: another writer pushed to ${branch}. The host refused to overwrite it.`
      : `The remote branch ${branch} does not exist (expected ${expected}). The host refused to push over a deleted or never-created branch.`
    savePlan(host, ticketId, { ...planned, result: { at, outcome: 'failed', branchSha: remote, detail } })
    return FAILED('push', remote ? 'remote_head_moved' : 'remote_branch_missing', detail, { branch, expected, remote_head: remote ?? null,
      recent_commits: recent, suggestion: remote
        ? `Fetch and review ${remote}: reconcile your branch with the remote commits (or record ${remote} as expected after confirming with a person), then report blocked or retry.`
        : 'Recreate the branch from the intended base, then plan again with the head you expect.', plan: planned })
  }
  // Fetch quietly so a rewritten local history can be compared; a failure is reported by the push itself.
  await host.commands.withSignal(signal).git(['fetch', '--quiet', 'origin', `refs/heads/${branch}`], cwd).catch(() => undefined)
  const forced = !!remote && !(await contains(host, cwd, remote, branch, signal))
  const lease = `--force-with-lease=refs/heads/${branch}:${remote}`
  try {
    await host.commands.withSignal(signal).git(['push', ...forced ? [lease] : [], 'origin', branch], cwd)
  } catch (error) {
    const detail = failure(error).detail
    const rejected = /rejected|non-fast-forward|stale info|failed to push/i.test(detail)
    const at = new Date().toISOString()
    savePlan(host, ticketId, { ...planned, result: { at, outcome: rejected ? 'failed' : 'unknown', branchSha: remote, detail } })
    return FAILED('push', rejected ? 'push_rejected' : 'push_unknown',
      rejected ? `The remote refused the push; nothing changed: ${detail}` : `The push result is unknown; query before retrying: ${detail}`,
      { branch, expected, remote_head: remote, forced, ...failure(error),
        ...rejected ? {} : { suggestion: 'Call action=recover to compare the remote head with the commit you meant to push before retrying.' } })
  }
  const at = new Date().toISOString()
  const nextPlan: DeliveryPlan = { ...planned,
    result: { at, outcome: 'applied', branchSha: local, detail: forced ? 'Pushed with --force-with-lease after verifying the remote head.' : 'Pushed as a fast-forward.' } }
  savePlan(host, ticketId, nextPlan)
  return { ok: true, action: 'push', branch, branch_sha: local, remote_head: local, expected, forced, plan: nextPlan }
}

async function open(host: DeliveryToolsHost, ticketId: string, ticket: Ticket, args: Args, branch: string, cwd: string,
  previous: DeliveryPlan | undefined, signal: AbortSignal): Promise<Answer> {
  const repository = host.github.deployment.repository
  const base = args.base ?? previous?.base
    ?? (baseName(ticket.execution?.worktree?.baseRef ?? '') || await defaultBase(host, signal).catch(() => undefined))
  if (!base) return FAILED('open', 'base_required', 'Pass base (the branch the pull request targets).', { branch, plan: previous ?? null })
  const title = args.title ?? previous?.title ?? ticket.title
  const body = args.body ?? previous?.body ?? ''
  // §5.2: record the plan before creating the pull request, even when the worker skipped action=plan.
  let plan = previous
  if (!plan) {
    const expected = args.expected ?? ticket.execution?.worktree?.baseSha ?? ''
    plan = { action: 'pr', branch, base, expected, title, body, at: new Date().toISOString() }
    savePlan(host, ticketId, plan)
  }
  const listed = await listPulls(host, branch, signal).catch(error => {
    throw new Error(`Could not list the pull requests of ${branch}: ${failure(error).detail}`)
  })
  const existing = pickPull(listed, args.pr)
  if (existing) return reuse(host, ticketId, plan, branch, existing, signal)
  try {
    await host.commands.withSignal(signal).run(host.github.deployment.github.cli,
      ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body, ...repository ? ['--repo', repository] : []], cwd)
  } catch (error) {
    // The create may have succeeded even though the CLI failed (for example a network drop after the write): query first.
    const after = await listPulls(host, branch, signal).catch(() => [])
    const created = pickPull(after, args.pr)
    if (created) return reuse(host, ticketId, plan, branch, created, signal)
    const at = new Date().toISOString()
    const next: DeliveryPlan = { ...plan, result: { at, outcome: 'unknown', detail: failure(error).detail } }
    savePlan(host, ticketId, next)
    return FAILED('open', 'create_unknown', `The pull request creation result is unknown: ${failure(error).detail}`,
      { branch, base, plan: next, suggestion: 'Call action=recover; if no pull request exists for this branch, retry open.' })
  }
  const after = await listPulls(host, branch, signal)
  const created = pickPull(after, args.pr)
  if (!created) {
    const at = new Date().toISOString()
    const next: DeliveryPlan = { ...plan, result: { at, outcome: 'unknown', detail: 'gh pr create reported success but the pull request was not listed' } }
    savePlan(host, ticketId, next)
    return FAILED('open', 'created_not_listed', 'The pull request was created but could not be read back; do not create another one.',
      { branch, base, plan: next, suggestion: 'Call action=recover and use the pull request it finds.' })
  }
  return reuse(host, ticketId, plan, branch, created, signal, true)
}

/** Lists the pull requests whose head is `branch`, oldest page first; `state: all` keeps a merged or closed one from becoming a second PR. */
async function listPulls(host: DeliveryToolsHost, branch: string, signal: AbortSignal): Promise<z.infer<typeof PullSummary>[]> {
  const repository = host.github.deployment.repository
  const raw = await host.commands.withSignal(signal).gh<unknown>(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10',
    '--json', 'number,state,url,headRefOid,baseRefName', ...repository ? ['--repo', repository] : []])
  return z.array(PullSummary).parse(raw)
}
/** Prefers the open pull request, else the newest one: a merged or closed PR is reused rather than duplicated. */
function pickPull(pulls: z.infer<typeof PullSummary>[], prefer?: number): z.infer<typeof PullSummary> | undefined {
  if (prefer !== undefined) return pulls.find(pull => pull.number === prefer) ?? pulls[0]
  return pulls.filter(pull => pull.state === 'open').sort((a, b) => b.number - a.number)[0]
    ?? pulls.sort((a, b) => b.number - a.number)[0]
}
async function defaultBase(host: DeliveryToolsHost, signal: AbortSignal): Promise<string | undefined> {
  const repository = host.github.deployment.repository
  const raw = await host.commands.withSignal(signal).gh<unknown>(['repo', 'view', ...repository ? [repository] : [],
    '--json', 'defaultBranchRef'])
  return DefaultBranch.parse(raw).defaultBranchRef?.name || undefined
}

/** Binds an existing or just-created PR to the ticket and records it on the plan; calling it twice returns the same PR. */
async function reuse(host: DeliveryToolsHost, ticketId: string, plan: DeliveryPlan, branch: string,
  summary: z.infer<typeof PullSummary>, signal: AbortSignal, created = false): Promise<Answer> {
  const pull = await readPull(host.github, summary.number, signal)
  const refused = claimPull(host.github, ticketId, pull)
  if (refused) return FAILED('open', 'claim_refused', refused, { branch, pr: { number: pull.number, state: pull.state, url: pull.html_url }, created })
  const at = new Date().toISOString()
  const next: DeliveryPlan = { ...plan, action: 'pr', branch, pr: pull.number,
    result: { at, outcome: 'applied', branchSha: pull.head.sha, pr: pull.number, state: pull.state, detail: created ? 'Created the pull request.' : 'Reused the existing pull request.' } }
  savePlan(host, ticketId, next)
  return { ok: true, action: 'open', created, reused: !created, branch,
    pr: { number: pull.number, state: pull.state, url: pull.html_url, head_sha: pull.head.sha, base: summary.baseRefName }, plan: next }
}

async function recover(host: DeliveryToolsHost, ticketId: string, ticket: Ticket, branch: string,
  plan: DeliveryPlan | undefined, signal: AbortSignal): Promise<Answer> {
  const cwd = workspaceOf(host, ticket)
  const errors: string[] = []
  const remote = cwd ? await remoteHead(host, cwd, branch, signal).catch(error => { errors.push(failure(error).detail); return undefined }) : undefined
  const pulls = await listPulls(host, branch, signal).catch(error => { errors.push(failure(error).detail); return [] })
  const pr = pickPull(pulls, plan?.result?.pr)
  const next = !remote ? 'push' : pr?.state === 'open' ? 'none' : pr ? 'inspect' : 'open'
  return { ok: true, action: 'recover', branch, plan: plan ?? null, result: plan?.result ?? null,
    remote_head: remote ?? null, expected: plan?.expected ?? null,
    ...plan?.expected && remote && plan.expected !== remote ? { remote_moved: true } : {},
    pulls: pulls.map(pull => ({ number: pull.number, state: pull.state, url: pull.url, head_sha: pull.headRefOid, base: pull.baseRefName })),
    branch_exists: !!remote, next,
    suggestion: next === 'push' ? 'Push the branch first, then open the pull request.'
      : next === 'open' ? 'The branch is pushed and has no pull request yet; call action=open.'
        : next === 'inspect' ? 'The pull request exists but is not open; inspect it and report the state rather than creating another one.'
          : 'The branch and its pull request exist; no write is needed.',
    ...errors.length ? { errors } : {}, ...overrunOf(host, ticketId) }
}
