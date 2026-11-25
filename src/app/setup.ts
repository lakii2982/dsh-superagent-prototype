/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import { lockSync } from 'proper-lockfile'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { verifyRepository } from '../infra/repository.ts'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import { workspaceMode } from '../policy.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { verifyBranchRules } from '../manager/branch-rules.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { executionRoot } from './execution-environment.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)
  || workspaceMode(before) !== workspaceMode(after) || before.executor.repositoryPath !== after.executor.repositoryPath

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  private releaseRepository?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined; this.releaseRepository?.(); this.releaseRepository = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    if (machine.managed?.enterprisePilot && workspaceMode(settings) !== 'worktree') {
      throw new SetupError('environmentFailed', { output: 'Enterprise pilot repositories require managed Git worktrees.' })
    }
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    if (machine.managed?.enterprisePilot) {
      try {
        await verifyBranchRules({ remote: deployment.repository, githubCli: deployment.github.cli }, lifetime)
      } catch (failure) {
        const rules = failure as { code?: string; branch?: string; missing?: string[] }
        if (rules.code === 'branch_rules_missing' && rules.branch && rules.missing) {
          throw new SetupError('branchRulesMissing', { repository: deployment.repository, branch: rules.branch, missing: rules.missing.join(', ') })
        }
        throw new SetupError('branchRulesUnreadable', { repository: deployment.repository, output: failure instanceof Error ? failure.message : String(failure) })
      }
    }
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    // An unset workspace mode follows the repository: managed worktrees once GitHub is configured, isolated directories otherwise.
    const mode = workspaceMode(settings)
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    if (mode === 'current') {
      const directory = await verifyRepository(settings.executor.repositoryPath, resolved.repository, context.subprocess, lifetime).catch(machineProblem)
      try { this.releaseRepository = lockSync(directory, { stale: 30_000, onCompromised: () => this.host.restart() }) } catch (error) { machineProblem(error) }
    }
    // Worktree tickets never touch the checkout a person works in: each gets a managed worktree under the execution root, whose
    // per-repository mirror is cloned from the configured remote on first use.
    if (mode === 'worktree') {
      if (!String(resolved.repository ?? '')) machineProblem(new Error('Worktree workspace mode needs the repository of the GitHub source.'))
      await mkdir(executionRoot(settings, machine.stateDir), { recursive: true }).catch(machineProblem)
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch((error: unknown) => { this.restore(); machineProblem(error) })
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
