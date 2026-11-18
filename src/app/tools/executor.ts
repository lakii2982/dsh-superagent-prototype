/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import type { AgentDelegation, AgentRun } from '../../executor/agents.ts'
import { probeAgents } from '../../executor/agents.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic' | 'settings'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** The Executor's local agent CLI delegation, when the deployment supports it. */
  readonly agents?: AgentDelegation
  sendReplies(): Promise<void>
}

/** Cap on the agent result text a tool answer carries. */
const AGENT_VIEW_CHARS = 4000
/** The model-facing view of a run: its identity, status, failure, result summary, and captured workspace difference. */
const agentRunView = (run: AgentRun) => ({
  run_id: run.id,
  ticket_id: run.ticketId,
  assignment_id: run.assignmentId,
  agent: run.agent,
  permission: run.permission,
  status: run.status,
  prompt: run.prompt.slice(0, 500),
  directory: run.directory,
  started_at: run.startedAt,
  ended_at: run.endedAt,
  session_id: run.externalId,
  resume_of: run.resumeOf,
  exit_code: run.exitCode,
  stop_requested_at: run.stopRequestedAt,
  stop_unconfirmed: run.stopUnconfirmed,
  error: run.error,
  error_kind: run.errorKind,
  result: run.result ? { text: run.result.text.slice(0, AGENT_VIEW_CHARS), cost_usd: run.result.costUsd, usage: run.result.usage } : undefined,
  changes: run.changes,
})

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
        checks: z.array(z.object({
          name: z.string().min(1).describe('The check that ran, such as a test file, a typecheck or a manual inspection.'),
          state: z.enum(['pass', 'fail', 'unknown']).describe('Whether it passed, failed, or could not be determined.'),
          detail: z.string().optional().describe('What was run or observed, such as the failing test name or why no test covers this path.'),
        }).strict()).max(50).optional().describe('The checks behind this report; the run detail shows them as evidence.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
            ...(args.checks?.length ? { checks: args.checks } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
    tool({
      name: 'orchestrator_agent',
      description: 'Delegate to the local Codex or Claude Code CLI in this ticket\'s workspace. Runs are asynchronous: this returns a run id at once, and the result arrives later as an injected message in this Session. With action=run, agent defaults to the repository\'s configured execution agent; the agent you name explicitly must be available on this host. Use action=continue with it to resume its agent session and action=stop to stop it. A write run is refused while another ticket holds the repository\'s write slot, so ask for read while only inspecting. A run belongs to the current Assignment; its result is delivered only while that Assignment still runs the ticket, and a late result of an older Assignment is recorded but never delivered.',
      schema: z.object({
        action: z.enum(['run', 'continue', 'stop', 'status']),
        agent: z.enum(['codex', 'claude']).optional().describe('With action=run: the CLI to run; omit to use the configured default execution agent.'),
        prompt: z.string().min(1).optional().describe('With action=run: the task. With action=continue: what to do next; omitted means carry on from where the session stopped.'),
        permission: z.enum(['read', 'write']).optional().describe("With action=run: 'read' (default) inspects only; 'write' edits the workspace and needs the repository's write slot."),
        run_id: z.string().optional().describe('With action=continue or stop: the run to resume or stop. With action=status: the run to read; omit to list recent runs.'),
      }).strict(),
      execute: async args => {
        const agents = host.agents
        if (!agents) throw new Error('Local agent delegation is not available in this deployment.')
        if (args.action === 'run') {
          const agent = args.agent ?? host.store.settings().executor.agent
          if (!agent) throw new Error('No execution agent was chosen: pass agent "codex" or "claude", or set the default execution agent in Settings → Execution.')
          if (!args.prompt) throw new Error('Give the agent a prompt.')
          const probe = (agents.probe?.() ?? probeAgents()).find(entry => entry.kind === agent)
          if (probe && !probe.available) throw new Error(`${probe.detail ?? `The ${agent} agent is not available on this host.`}${probe.repair ? ` ${probe.repair}` : ''}`)
          const run = agents.start(ticket, { agent, prompt: args.prompt, permission: args.permission ?? 'read' })
          return { action: 'run', run: agentRunView(run) }
        }
        if (args.action === 'continue') {
          if (!args.run_id) throw new Error('action=continue needs the run_id of the run to resume.')
          const run = agents.resume(ticket, args.run_id, args.prompt ?? 'Continue from where you left off.')
          return { action: 'continue', run: agentRunView(run) }
        }
        if (args.action === 'stop') {
          if (!args.run_id) throw new Error('action=stop needs the run_id of the run to stop.')
          const { run, confirmed } = await agents.stop(ticketId, args.run_id, 'Stopped by the worker')
          return { action: 'stop', run: agentRunView(run), confirmed }
        }
        if (args.run_id) {
          const found = agents.status(ticketId, args.run_id)
          const run = Array.isArray(found) ? found[0] : found
          return { action: 'status', run: run ? agentRunView(run) : null }
        }
        const runs = agents.status(ticketId)
        return { action: 'status', runs: Array.isArray(runs) ? runs.map(agentRunView) : [] }
      },
    }),
  ]
}
