/** Creates dedicated DSH profiles and controls only authenticated repository instances. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { access, chmod, lstat, mkdir, readFile, writeFile, open, symlink, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AgentKind, AgentProbe } from '../executor/agents.ts'
import { Store } from '../app/store.ts'
import { SettingsSchema } from '../policy.ts'
import { MANAGED_FEISHU_CLI } from '../deployment.ts'
import { packageRoot } from '../infra/paths.ts'
import type { Repository } from './store.ts'

const exec = promisify(execFile)
export const instanceHome = (directory: string, repositoryId: string): string => join(directory, 'repositories', repositoryId, 'dsh-home')
interface InstanceOptions { enterprisePilot?: boolean }
const PILOT_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'SystemRoot', 'ComSpec', 'PATHEXT']
function instanceEnvironment(repository: Repository, directory: string, options: InstanceOptions): NodeJS.ProcessEnv {
  const environment = options.enterprisePilot
    ? Object.fromEntries(PILOT_ENV_NAMES.map(name => [name, process.env[name]]))
    : process.env
  return { ...environment, DSH_HOME: instanceHome(directory, repository.id) }
}
export async function instanceRequest(repository: Repository, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${repository.port}/orchestrator/instance/${path}`, {
    method, headers: { authorization: `Bearer ${repository.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000), redirect: 'error',
  })
  const result = await response.json() as { error?: string }
  if (!response.ok) throw new Error(result.error ?? `Repository instance returned ${response.status}`)
  return result
}
export interface InstanceHealth { pid: number; configured: boolean; paused?: boolean; state?: string; agent?: AgentProbe[]; enterprisePilot?: boolean }
/** The shape a probe entry from an instance may have; anything else it reports is ignored rather than trusted. */
const agentProbeOf = (value: unknown): AgentProbe | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const probe = value as Record<string, unknown>
  if (probe.kind !== 'codex' && probe.kind !== 'claude') return undefined
  if (typeof probe.available !== 'boolean') return undefined
  return { kind: probe.kind as AgentKind, available: probe.available,
    ...typeof probe.detail === 'string' ? { detail: probe.detail } : {}, ...typeof probe.repair === 'string' ? { repair: probe.repair } : {} }
}
/**
 * Reads the instance's authenticated health, including the probe of the agent CLIs its host can run. The probe is optional
 * so an older instance still reports health; readiness then says the agent state is unknown instead of inventing one.
 */
export async function instanceHealth(repository: Repository): Promise<InstanceHealth> {
  const health = await instanceRequest(repository, 'health') as InstanceHealth & { repositoryId: string }
  if (health.repositoryId !== repository.id || !Number.isInteger(health.pid) || health.pid < 1) throw new Error('Unexpected repository instance')
  const agent = Array.isArray(health.agent) ? health.agent.map(agentProbeOf).filter((probe): probe is AgentProbe => !!probe) : undefined
  return { pid: health.pid, configured: health.configured, ...(typeof health.paused === 'boolean' ? { paused: health.paused } : {}), ...health.state !== undefined ? { state: health.state } : {},
    ...agent?.length ? { agent } : {}, ...(health.enterprisePilot === true ? { enterprisePilot: true } : {}) }
}

interface BundleLink { root: string; phase: 'updating' | 'ready' }
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT'
/** Persist the install outcome atomically; interrupted installs must remain retryable even if pnpm changed the link. */
async function recordBundle(file: string, value: BundleLink): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
/** Refresh only this owned profile's package link, without rewriting its patch or opening its application database. */
async function ensureBundle(profileDirectory: string, repository: Repository, env: NodeJS.ProcessEnv, offline: boolean): Promise<void> {
  const root = await realpath(packageRoot())
  const installed = join(profileDirectory, 'node_modules', 'dsh-superagent')
  const marker = join(profileDirectory, '.superagent-bundle.json')
  const previous = await readFile(marker, 'utf8').catch(cause => { if (missing(cause)) return undefined; throw cause })
  let recorded: BundleLink | undefined
  if (previous) {
    try { recorded = JSON.parse(previous) as BundleLink } catch { /* A legacy or damaged record is verified against the real link. */ }
  }
  const currentRoot = () => realpath(installed).catch(cause => { if (missing(cause)) return undefined; throw cause })
  const needsInstall = await currentRoot() !== root || recorded?.phase === 'updating'
  if (needsInstall) {
    await recordBundle(marker, { root, phase: 'updating' })
    await exec('dsh', ['plugin', '--profile', repository.profile, 'add', ...offline ? ['--offline'] : [], `link:${root}`],
      { env, timeout: 60_000, maxBuffer: 4 << 20 })
    if (await currentRoot() !== root) throw new Error('Repository plugin installation did not link the current Superagent bundle; retry before starting the service')
  }
  if (needsInstall || recorded?.root !== root || recorded.phase !== 'ready') await recordBundle(marker, { root, phase: 'ready' })
}

export async function provision(repository: Repository, directory: string, managerOrigin: string, botCli: string, chats: string[], options: InstanceOptions = {}): Promise<void> {
  const { enterprisePilot = false } = options
  const home = instanceHome(directory, repository.id), env = instanceEnvironment(repository, directory, options)
  const profileDirectory = join(home, 'profiles', repository.profile)
  await mkdir(home, { recursive: true, mode: 0o700 })
  if (enterprisePilot && !(await lstat(home)).isDirectory()) throw new Error('Enterprise pilot requires a dedicated repository DSH_HOME directory')
  const stateDir = join(directory, 'repositories', repository.id)
  const profileExists = await access(profileDirectory).then(() => true, () => false)
  const marker = join(profileDirectory, '.superagent-repository')
  const markerValue = enterprisePilot ? `${repository.id}:enterprise-pilot` : repository.id
  const ready = join(profileDirectory, '.superagent-ready')
  let alreadyProvisioned = false
  if (profileExists) {
    const owner = await readFile(marker, 'utf8').catch(() => '')
    if (owner !== repository.id) throw new Error('Refusing to replace an existing DSH profile')
    const provisioned = await readFile(ready, 'utf8').catch(cause => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw cause
    })
    if (provisioned !== undefined && provisioned !== markerValue) {
      throw new Error('Repository rollout mode cannot change after provisioning; use a separate manager and state directory')
    }
    alreadyProvisioned = provisioned !== undefined
  }
  const destination = join(home, '.credentials.yaml')
  if (enterprisePilot) {
    const modelCredentials = await lstat(destination).catch(cause => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw cause
    })
    if (modelCredentials && !modelCredentials.isFile()) throw new Error('Enterprise pilot model credentials must be a dedicated file in the repository DSH_HOME')
  } else {
    // Compatibility mode may reuse the operator's model credentials, but never their sessions or workspace stores.
    const sharedCredentials = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
    if (await access(sharedCredentials).then(() => true, () => false) && !await access(destination).then(() => true, () => false)) await symlink(sharedCredentials, destination)
  }
  if (alreadyProvisioned) {
    await ensureBundle(profileDirectory, repository, env, true)
    return
  }
  // A generated profile belongs only to this repository; never overwrite the operator's profile.
  if (!profileExists) {
    await exec('dsh', [repository.profile, '--from-default-profile', 'web', '--dump-config'], { env, timeout: 60_000, maxBuffer: 4 << 20 })
    await writeFile(marker, repository.id, { mode: 0o600 })
  }
  await ensureBundle(profileDirectory, repository, env, enterprisePilot)
  const rows = [
    { id: 'webserver', config: { host: '127.0.0.1', port: repository.port } },
    { id: 'dsh-superagent', config: { stateDir, mode: 'standalone', managed: { repositoryId: repository.id, url: managerOrigin, token: repository.token,
      ...(enterprisePilot ? { enterprisePilot } : {}) } } },
    { id: 'dsh-superagent-feishu', disabled: false },
  ]
  // JSON is valid YAML. DSH's patch file accepts the same row sequence as the documented YAML example.
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), JSON.stringify(rows, null, 2), { mode: 0o600 })
  await chmod(join(profileDirectory, 'cordis.patch.yml'), 0o600)
  const database = join(stateDir, 'orchestrator.sqlite')
  const existingState = await access(database).then(() => true, () => false)
  const store = new Store(database, () => {})
  try {
    if (existingState && store.tickets.list().length) throw new Error('Existing work needs an explicit session migration before enabling isolated DSH storage')
    if (enterprisePilot && existingState && store.settings().executor.workspaceMode !== 'worktree') {
      throw new Error('Existing repository settings need an explicit migration before enabling the enterprise pilot')
    }
    if (!existingState) store.saveSettings(SettingsSchema.parse({
      executor: { workspaceMode: enterprisePilot ? 'worktree' : 'current', repositoryPath: enterprisePilot ? '' : repository.directory, maxWorkers: 1 },
      ...(enterprisePilot ? { eval: { mode: 'off' } } : {}),
      sources: { github: { enabled: true, config: { repository: repository.remote, cli: repository.githubCli } },
        feishu: { enabled: true, config: { cli: botCli ? MANAGED_FEISHU_CLI : '', chats: chats.map(chatId => ({ chatId, listen: 'mentions' })), directMessages: false, otherChats: 'none' } } },
      policy: { sources: { github: { allowed: repository.allowedGithub.map(id => ({ id })) }, feishu: { allowed: repository.allowedFeishu.map(id => ({ id })) } } },
    }))
  } finally { store.close() }
  await writeFile(ready, markerValue, { mode: 0o600 })
}
export async function startInstance(repository: Repository, directory: string, options: InstanceOptions = {}): Promise<ChildProcess> {
  const logs = join(directory, 'logs'); await mkdir(logs, { recursive: true, mode: 0o700 })
  const log = await open(join(logs, `${repository.id}.log`), 'a', 0o600)
  try {
    const child = spawn('dsh', ['--profile', repository.profile, '--no-open'], { detached: true, env: instanceEnvironment(repository, directory, options), stdio: ['ignore', log.fd, log.fd] })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    return child
  } finally { await log.close() }
}

/** Returns the host's browser launch URL only after an explicit open action; never exposes the bridge credential. */
export async function instanceUiUrl(repository: Repository, directory: string): Promise<string> {
  const log = await open(join(directory, 'logs', `${repository.id}.log`), 'r')
  let text: string
  try {
    const size = (await log.stat()).size, bytes = Buffer.alloc(Math.min(size, 65536))
    await log.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length)); text = bytes.toString('utf8')
  } finally { await log.close() }
  const value = [...text.matchAll(/dsh web: (http:\/\/[^\s]+)/g)].at(-1)?.[1]
  if (!value) throw new Error('The DSH browser launch URL is not available; check the repository startup log')
  const url = new URL(value)
  if (url.origin !== `http://127.0.0.1:${repository.port}` || url.username || url.password) throw new Error('Unexpected repository browser origin')
  return url.href
}
