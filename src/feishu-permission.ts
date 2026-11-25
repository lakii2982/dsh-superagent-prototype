/** Application permission pages are tied to the verified bot, including its Feishu/Lark region. */
export function permissionPage(bot: { appId: string; brand: string }, scope?: string): string | undefined {
  if (!/^cli_[A-Za-z0-9]+$/.test(bot.appId)) return undefined
  const host = bot.brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'
  const url = new URL(`https://${host}/app/${bot.appId}/auth`)
  if (scope && /^[a-z][a-z0-9_]*:[a-z0-9_.:]+$/.test(scope)) url.searchParams.set('q', scope)
  url.searchParams.set('op_from', 'openapi')
  url.searchParams.set('token_type', 'tenant')
  return url.href
}

export const lacksAppScope = (detail: string) => /\b(?:99991672|missing_scope|action_scope_required)\b/i.test(detail)

/** A group list or member grant has one narrow scope. Other calls can report several alternatives. */
export function operationScope(operation: string, detail: string): string | undefined {
  const known: Record<string, string> = { members: 'im:chat.members:read', chats: 'im:chat:read', reply: 'im:message:send_as_bot' }
  const reported = [...new Set(detail.match(/\bim:[a-z0-9_.]+(?::[a-z_]+)?\b/g))]
  return known[operation] ?? (reported.length === 1 ? reported[0] : undefined)
}
