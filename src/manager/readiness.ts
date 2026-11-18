/** Readiness dimensions for one repository: instance, checkout, agent, Feishu and queued deliveries. */
import type { Repository } from './store.ts'

export type ReadinessState = 'ok' | 'pending' | 'error' | 'unknown'
/** Where an operator repairs a dimension: the repository setup, the Feishu bot, or the execution agent. */
export type RepairEntry = 'repository' | 'feishu' | 'agent'
export interface ReadinessItem { state: ReadinessState; detail?: string; repair?: RepairEntry }
export interface DeliveryReadiness extends ReadinessItem { pending: number; byChat: Record<string, number> }
export interface RepositoryReadiness {
  instance: ReadinessItem
  repository: ReadinessItem
  agent: ReadinessItem
  feishu: ReadinessItem
  delivery: DeliveryReadiness
}
export type InstanceView = { online: boolean; configured?: boolean; error?: string; state?: string }

/** Compose the five readiness dimensions without touching the network or the database. */
export function readiness(input: { repository: Repository; status?: InstanceView; bot: boolean; groups: number; pending: { total: number; byChat: Record<string, number> } }): RepositoryReadiness {
  const { repository, status, bot, groups, pending } = input
  const online = status?.online === true
  return {
    instance: !online
      ? { state: 'pending', detail: '仓库实例未运行', repair: 'repository' }
      : status?.state === 'error'
        ? { state: 'error', detail: '仓库实例报告错误，请查看实例日志', repair: 'repository' }
        : { state: 'ok' },
    repository: !repository.enabled
      ? { state: 'error', detail: '仓库已在管理器中停用', repair: 'repository' }
      : !online
        ? { state: 'pending', detail: '仓库实例未运行', repair: 'repository' }
        : status?.error
          ? { state: 'error', detail: status.error, repair: 'repository' }
          : status?.configured === true
            ? { state: 'ok' }
            : { state: 'pending', detail: '仓库设置尚未完成（仓库或 GitHub 账号缺失）', repair: 'repository' },
    // The instance does not yet report whether its execution Agent can run; say so instead of guessing.
    agent: { state: 'unknown', detail: '仓库实例尚未报告执行 Agent 状态', repair: 'agent' },
    feishu: !bot
      ? { state: 'pending', detail: '尚未连接飞书机器人；仓库仍可通过 GitHub 交付', repair: 'feishu' }
      : groups === 0
        ? { state: 'pending', detail: '该仓库没有启用的飞书群绑定', repair: 'feishu' }
        : { state: 'ok', detail: `${groups} 个飞书群` },
    delivery: pending.total > 0
      ? { state: 'pending', detail: `${pending.total} 条消息待投递`, repair: 'repository', pending: pending.total, byChat: pending.byChat }
      : { state: 'ok', pending: 0, byChat: {} },
  }
}
