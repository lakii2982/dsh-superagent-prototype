/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { currentManagerOrigin, managerUrl } from './manager/protocol.ts'
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
interface ManagedRepositoryConfig { repositoryId: string; url: string; token: string; enterprisePilot?: boolean }
const ManagedConfig: s<ManagedRepositoryConfig | null> = s.union([s.object({
  repositoryId: s.string().required(), url: s.string().required(), token: s.string().required(),
  enterprisePilot: s.boolean(),
}), s.const(null)]).default(null)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  mode: s.union(['standalone', 'manager']).default('standalone'),
  desktopMultiRepository: s.boolean().default(false)
    .description('Switch this local standalone installation to the shared enterprise workspace. Its existing data is kept.').volatile(),
  maxRunningRepositories: s.number().min(LIMITS.maxRunningRepositories.min).max(LIMITS.maxRunningRepositories.max).step(1)
    .default(LIMITS.maxRunningRepositories.default).description('Maximum running or starting repository instances in manager mode.'),
  enterprisePilot: s.boolean().default(false).description('Apply enterprise pilot delivery controls to managed repositories.'),
  requireProtectedBranches: s.boolean().default(false).description('Require enforced GitHub rules on the default branch before a managed repository starts.'),
  operatorTokenFile: absolute('Optional owner-only credential file for manager API access.'),
  managed: ManagedConfig.description('Internal repository bridge; configured by the manager.'),
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
/** Non-sensitive mode-switch status for locally managed DSH installations. */
export interface DesktopModeView {
  desktopMultiRepository: boolean
  modeSwitchBlocked?: 'standalone_busy' | 'manager_busy'
  modeSwitchError?: string
}
export interface Machine {
  managed?: ManagedRepositoryConfig
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, managed } = config
  const machine = { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
  if (!managed) return machine
  const registeredOrigin = managerUrl(managed.url)
  return { ...machine, managed: {
    ...managed,
    get url() { return currentManagerOrigin(stateDir, managed.repositoryId, registeredOrigin) },
  } }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default(''), profile: z.string().trim().min(1).max(200).optional() })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
/** Credential-free bot identity exposed by the manager only to its associated repository. */
export const ManagedFeishuBotSchema = z.object({
  id: z.string().min(1).max(200), botId: z.string().regex(/^ou_[A-Za-z0-9]+$/),
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), name: z.string().default(''),
  brand: z.enum(['feishu', 'lark']).default('feishu'), legacy: z.boolean().default(false),
})
export type ManagedFeishuBot = z.infer<typeof ManagedFeishuBotSchema>
export const ManagedFeishuBotsSchema = z.object({ bots: z.array(ManagedFeishuBotSchema).max(100)
  .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate managed bot identities') })
export const MANAGED_FEISHU_CLI = 'dsh-manager-bridge'
export interface FeishuBot {
  cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string
  profile?: string
  registryId?: string; legacy?: boolean
  /** Startup snapshot for display compatibility only; operations must select a live, scoped manager identity. */
  managedBots?: ManagedFeishuBot[]
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Managed repositories obtain only credential-free identities from their authenticated manager bridge.
 * Standalone deployments verify that their CLI is authenticated and restricted to strict mode `bot`.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  if (machine.managed) {
    try {
      const bridge = machine.managed, origin = managerUrl(bridge.url)
      const response = await fetch(`${origin}/orchestrator/internal/${encodeURIComponent(bridge.repositoryId)}/feishu-bots`, {
        headers: { authorization: `Bearer ${bridge.token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Feishu manager identity check returned HTTP ${response.status}`)
      const { bots } = ManagedFeishuBotsSchema.parse(await response.json())
      const first = bots.find(bot => bot.legacy) ?? bots[0]
      if (!first) return undefined
      return { cli: MANAGED_FEISHU_CLI, botId: first.botId, appId: first.appId, brand: first.brand,
        name: bots.length > 1 ? `管理器按绑定路由（${bots.length} 个机器人）` : first.name,
        registryId: first.id, legacy: first.legacy, managedBots: bots }
    } catch (error) { return fail(error) }
  }
  const { cli: name, profile } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1',
    cli, ...args, ...(profile ? [`--profile=${profile}`] : [])]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name, ...(profile ? { profile } : {}) }
}
