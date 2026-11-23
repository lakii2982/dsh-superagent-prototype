/** Shared, credential-free manager view contract for the workspace and native plugin settings. */
import type { Repository, Binding } from '../manager/store.ts'

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
  enabled: boolean; connected: boolean; legacy?: boolean
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
