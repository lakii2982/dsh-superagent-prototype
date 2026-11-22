/** Shared, credential-free manager view contract for the workspace and native plugin settings. */
import type { Repository, Binding } from '../manager/store.ts'

interface ReadinessItem { state: string; detail?: string; repair?: string }
type DeliveryReadiness = ReadinessItem & { pending: number; byChat: Record<string, number> }
export interface RepositoryReadiness {
  instance: ReadinessItem; repository: ReadinessItem; agent: ReadinessItem; feishu: ReadinessItem; delivery: DeliveryReadiness
}
export interface RepositoryView extends Omit<Repository, 'token'> {
  status: { online: boolean; configured?: boolean; error?: string }; starting: boolean; url: string
  pending?: { total: number; byChat: Record<string, number> }
  readiness?: RepositoryReadiness
}
export interface ManagerView {
  revision: number; bot: { name?: string; id: string } | null; botCli: string; workspaces: string[]
  enterprisePilot?: boolean
  capacity?: { maxRunningRepositories: number; runningRepositories: number }
  repositories: RepositoryView[]; bindings: Binding[]; chats: Record<string, string>
  health: Record<string, { state: string; detail: string }>
  pending: { id: string; repositoryId: string; chatId?: string; error?: string; hold?: string }[]
  queues?: { total: number; byRepository: Record<string, number>; byChat: Record<string, number> }
}
