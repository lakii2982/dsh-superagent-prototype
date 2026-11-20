/** Trusted local bridge protocol, distinct from browser management requests. */
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(header ?? '')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
export const FeishuTriggerSchema = z.object({
  id: z.string().min(1), source: z.literal('feishu'),
  threads: z.array(z.object({ source: z.literal('feishu'), id: z.string().min(1) })).min(1).max(1),
  actor: z.object({ source: z.literal('feishu'), id: z.string().min(1) }), human: z.boolean(),
  addressed: z.enum(['mention', 'direct']).optional(), at: z.string().datetime(), text: z.string(),
  channel: z.object({ source: z.literal('feishu'), thread: z.string(), address: z.record(z.string(), z.string()) }),
  url: z.string().optional(), meta: z.record(z.string(), z.unknown()),
})
export function managerUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('The manager bridge must use a loopback HTTP origin')
  }
  return parsed.origin
}

/** Rejects arbitrary CLI flags before a repository can use the shared bot transport. */
export function bridgeOptions(args: string[]): Map<string, string | true> {
  const options: Record<string, readonly string[]> = {
    '+messages-reply': ['--message-id', '--markdown', '--reply-in-thread', '--idempotency-key'],
    '+chat-members-list': ['--chat-id', '--member-types', '--page-all', '--page-limit'],
    '+chat-list': ['--page-all', '--page-size'],
    '+messages-mget': ['--message-ids', '--no-reactions'],
    '+threads-messages-list': ['--thread', '--order', '--page-size', '--no-reactions', '--page-token'],
    '+messages-resources-download': ['--message-id', '--file-key', '--type', '--output'],
  }
  const api = args[0] === 'api' && args[1] === 'GET'
  const allowed = api ? ['--params'] : args[0] === 'im' ? options[args[1] ?? ''] : undefined
  if (!allowed || (api && !['/open-apis/im/v1/messages', '/open-apis/im/v1/messages/mget'].includes(args[2] ?? ''))) throw new Error('Unsupported Feishu bridge command')
  const flags = new Set(['--page-all', '--no-reactions', '--reply-in-thread']), found = new Map<string, string | true>()
  for (let index = api ? 3 : 2; index < args.length; index++) {
    const name = args[index]!
    if (!allowed.includes(name) || found.has(name)) throw new Error('Unsupported or duplicate Feishu bridge option')
    if (flags.has(name)) found.set(name, true)
    else { const value = args[++index]; if (value === undefined) throw new Error('Missing Feishu bridge option value'); found.set(name, value) }
  }
  return found
}
