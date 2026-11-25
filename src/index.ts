/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { join } from 'node:path'
import { Manager } from './manager/runtime.ts'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig, type DesktopModeView } from './deployment.ts'
import { LIMITS } from './limits.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  const desktopAvailable = config.mode === 'standalone' && !config.managed && ctx.webServer?.host === '127.0.0.1'
  const desktopRequested = desktopAvailable && config.desktopMultiRepository.get()
  // The management panel provides its own settings UI in either mode.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = async (): Promise<void> => {
    await ctx.fiber.restart()
    ctx.get('settings')?.describe()
  }
  const reportRestartError = (error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) }
  let modeSwitchError: string | undefined
  const status = (active: boolean, blocked: () => DesktopModeView['modeSwitchBlocked']): DesktopModeView => ({
    desktopMultiRepository: active, modeSwitchBlocked: blocked(), modeSwitchError,
  })
  const resetRequestedMode = async (active: boolean) => {
    if (config.desktopMultiRepository.get() !== active) await ctx.get('settings')?.update(name, { desktopMultiRepository: active })
  }
  const installModeSwitch = (active: boolean, mayRestart: () => boolean, cancel = () => {}) => {
    if (!desktopAvailable) return
    let switching = false
    let timer: ReturnType<typeof setTimeout> | undefined
    ctx.effect(() => () => { if (timer) clearTimeout(timer) })
    const switchMode = async () => {
      try {
        if (config.desktopMultiRepository.get() === active) return
        if (!mayRestart()) {
          modeSwitchError = active ? 'Stop all repository services before returning to standalone mode.' : 'Wait for active assignments to finish before switching modes.'
          await resetRequestedMode(active)
          return
        }
        modeSwitchError = undefined
        await restart()
      } catch (error) {
        cancel()
        modeSwitchError = String(error)
        reportRestartError(error)
        await resetRequestedMode(active).catch(reportRestartError)
      } finally { switching = false }
    }
    ctx.on('loader/volatile-update', paths => {
      if (switching || !paths.some(path => path.length === 1 && path[0] === 'desktopMultiRepository') || config.desktopMultiRepository.get() === active) return
      switching = true
      // Let DSH finish persisting the new value before restarting or reverting this setting.
      timer = setTimeout(() => void switchMode(), 0)
      timer.unref()
    })
  }

  if (config.mode === 'manager' || desktopRequested) {
    let manager: Manager | undefined
    const desktopStatus = desktopRequested ? () => status(true, () => manager?.desktopModeBlocked() ? 'manager_busy' : undefined) : undefined
    try {
      const managerMachine = desktopRequested ? { ...machine, stateDir: join(machine.stateDir, 'enterprise-manager') } : machine
      manager = new Manager(ctx, managerMachine, {
        maxRunningRepositories: desktopRequested ? LIMITS.maxRunningRepositories.max : config.maxRunningRepositories,
        enterprisePilot: desktopRequested || config.enterprisePilot,
        requireProtectedBranches: config.requireProtectedBranches,
        operatorTokenFile: config.operatorTokenFile,
        desktopMode: desktopStatus,
      })
      const running = manager
      ctx.effect(() => () => running.stop())
      await running.start()
      installModeSwitch(true, () => running.prepareDesktopModeSwitch(), () => running.cancelDesktopModeSwitch())
      return
    } catch (error) {
      await manager?.stop()
      if (!desktopRequested) throw error
      // Let the previous local workspace keep working if the independent manager cannot open.
      modeSwitchError = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('dsh-superagent could not activate its enterprise workspace: %s', modeSwitchError)
    }
  }
  const standaloneStatus = desktopAvailable ? () => status(false, () => runtime.executor.activeCount() ? 'standalone_busy' : undefined) : undefined
  const runtime: Runtime = new Runtime(ctx, machine, () => void restart().catch(reportRestartError), standaloneStatus)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  installModeSwitch(false, () => runtime.executor.activeCount() === 0)
  if (desktopRequested) setTimeout(() => void resetRequestedMode(false).catch(reportRestartError), 0).unref()
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
