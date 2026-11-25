/** Shared, credential-free manager view contract for the workspace and native plugin settings. */
import { lacksAppScope } from '../feishu-permission.ts'
import type { Repository, Binding } from '../manager/store.ts'

export interface DirectoryListing { path: string; parent: string | null; directories: string[]; checkout: boolean; hasMore: boolean }

interface ReadinessItem { state: string; detail?: string; repair?: string }
type DeliveryReadiness = ReadinessItem & { pending: number; byChat: Record<string, number> }
export interface RepositoryReadiness {
  instance: ReadinessItem; repository: ReadinessItem; agent: ReadinessItem; feishu: ReadinessItem; delivery: DeliveryReadiness
}
export interface RepositoryView extends Omit<Repository, 'token'> {
  allowedFeishuByBot?: Record<string, string[]>
  status: { online: boolean; configured?: boolean; paused?: boolean; error?: string }; starting: boolean; url: string
  pending?: { total: number; byChat: Record<string, number> }
  readiness?: RepositoryReadiness
}
export interface ManagerBotView {
  id: string; botId: string; appId: string; brand: 'feishu' | 'lark'; name: string; cli: string; profile?: string
  account?: string; enabled: boolean; connected: boolean; legacy?: boolean
  chats: Record<string, string>; health: Record<string, { state: string; detail?: string }>
}
export interface ManagerView {
  revision: number; bot: { name?: string; id: string } | null; botCli: string; workspaces: string[]
  bots?: ManagerBotView[]
  legacyConnection?: { cli: string; error: string }
  requireProtectedBranches?: boolean
  enterprisePilot?: boolean
  capacity?: { maxRunningRepositories: number; runningRepositories: number }
  repositories: RepositoryView[]; bindings: Binding[]; chats: Record<string, string>
  health: Record<string, { state: string; detail: string }>
  pending: { id: string; repositoryId: string; botId?: string; chatId?: string; error?: string; hold?: string }[]
  queues?: { total: number; byRepository: Record<string, number>; byChat: Record<string, number>;
    byBinding?: { repositoryId: string; botId: string; chatId: string; count: number }[] }
}

/** Older manager hosts expose a single connection; its identity is preserved until the host migrates it. */
export function managerBots(view: ManagerView): ManagerBotView[] {
  return view.bots ?? (view.bot ? [{ id: view.bot.id, botId: view.bot.id, appId: '', brand: 'feishu', name: view.bot.name ?? '',
    cli: view.botCli, enabled: true, connected: true, legacy: true, chats: view.chats, health: view.health }] : [])
}
export function bindingBot(view: ManagerView, binding: { botId?: string }): ManagerBotView | undefined {
  const bots = managerBots(view)
  return binding.botId ? bots.find(bot => bot.id === binding.botId) : bots.find(bot => bot.legacy) ?? (bots.length === 1 ? bots[0] : undefined)
}
export function allowedFeishuForBot(repository: RepositoryView, bot: ManagerBotView | undefined): string[] {
  if (!bot) return []
  return [...new Set([...(bot.legacy ? repository.allowedFeishu : []), ...(repository.allowedFeishuByBot?.[bot.id] ?? [])])]
}
export function feishuIdentityCount(repository: RepositoryView): number {
  return repository.allowedFeishu.length + Object.values(repository.allowedFeishuByBot ?? {}).reduce((count, ids) => count + ids.length, 0)
}

/** Identity verification, live intake and history recovery are independent checks. */
export function botHealthView(bot: ManagerBotView, tr: (zh: string, en: string) => string) {
  const live = bot.health.feishu
  const liveReady = live?.state === 'ready' || live?.state === 'ok'
  const issues = Object.entries(bot.health).filter(([, value]) => value.state === 'error').map(([key, value]) => {
    const groupInfo = ['chats', 'groups', 'chatNames', 'chat-names'].includes(key)
    const label = key === 'feishu' ? tr('实时消息接入', 'Live message intake') : key === 'history'
      ? tr('历史消息补收', 'History recovery') : groupInfo ? tr('群信息读取', 'Group information') : key === 'reply' ? tr('回复消息', 'Reply to messages')
      : key === 'attachment' ? tr('读取消息图片', 'Read message images') : key === 'messageRead' ? tr('读取消息', 'Read messages')
      : key === 'members' ? tr('读取群成员', 'Read group members') : key
    const limited = lacksAppScope(value.detail ?? '') || /\b230027\b/.test(value.detail ?? '')
    const summary = limited ? tr('应用权限不足，请检查该机器人应用的相关权限与群访问范围。', 'The app lacks permission for this operation. Check this bot app’s permissions and group access.')
      : key === 'history' ? tr('暂时无法补收历史消息，请检查应用权限和群访问范围。', 'History recovery is unavailable. Check app permissions and group access.')
      : key === 'feishu' ? tr('实时消息接收异常，请检查机器人连接与事件配置。', 'Live message intake needs attention. Check the bot connection and event configuration.')
      : groupInfo ? tr('暂时无法读取群信息，请检查机器人权限。', 'Group information is unavailable. Check the bot’s permissions.')
      : tr('此项检查需要处理，请查看原始详情。', 'This check needs attention. Review the original details.')
    return { key, label, summary, detail: value.detail, tone: key === 'feishu' ? 'danger' as const : 'warning' as const }
  })
  const historyOnly = issues.length > 0 && issues.every(issue => issue.key === 'history')
  const tone = !bot.enabled ? 'quiet' as const : !bot.connected || live?.state === 'error' ? 'danger' as const
    : issues.length ? 'warning' as const : liveReady ? 'success' as const : 'quiet' as const
  const label = !bot.enabled ? tr('已停用', 'Disabled') : !bot.connected ? tr('连接异常', 'Disconnected')
    : live?.state === 'error' ? tr('实时接入异常', 'Live intake issue') : historyOnly ? tr('历史补收受限', 'History limited')
    : issues.length ? tr('部分功能受限', 'Some features limited') : liveReady ? tr('实时消息已连接', 'Live messages connected')
    : tr('身份已验证', 'Identity verified')
  const liveSummary = bot.enabled && bot.connected && liveReady && issues.length
    ? historyOnly ? tr('实时消息已连接；历史补收受限。', 'Live messages are connected; history recovery is limited.')
      : tr('实时消息已连接；其他受限项见下方。', 'Live messages are connected; limited features are listed below.') : undefined
  return { issues, tone, label, liveSummary }
}
