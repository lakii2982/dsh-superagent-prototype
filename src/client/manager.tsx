/**
 * Manager control plane inside the unified panel: repositories, group bindings, deliveries and the Feishu bot use the same
 * left rail and detail column as a standalone deployment. Selecting a repository opens that repository's own panel areas,
 * whose API calls the manager forwards to the isolated instance with the credential the browser never sees.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { usePoll } from './api.ts'
import { usePanelMode } from './mode.ts'
import { Content, Header, NavRail, Rail, ShellFrame, titleOf, type NavGroup } from './app.tsx'
import { Button, Icon, Input, Modal, Tag } from './controls.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { MANAGER_HOME, MANAGER_NAV_EVENT, initialLocation, lastSettingsGroup, remember, routeLabel, type Location, type ManagerArea, type RepoRoute,
  type Route } from './route.ts'
import { Field, Fields } from './settings-kit.tsx'
import { errorText, type T } from './text.ts'
import { Hint, LabelValue, Section } from './widgets.tsx'
import type { RepositoryReadiness, RepositoryView, ManagerView } from './manager-view.ts'
import type { DshSuperagentKey } from './locales.ts'
import STYLES from './client.css?raw'

export type { ManagerView, RepositoryView } from './manager-view.ts'
interface TaskRow { id: string; title: string; stage?: string }
interface FeishuMember { member_id: string; name: string }
const DIMENSIONS = [
  ['instance', '实例', 'Instance'],
  ['repository', '仓库', 'Repository'],
  ['agent', '执行 Agent', 'Agent'],
  ['feishu', '飞书', 'Feishu'],
  ['delivery', '待投递', 'Deliveries'],
] as const satisfies readonly (readonly [keyof RepositoryReadiness, string, string])[]
const HOLD_TEXT: Record<string, [string, string]> = {
  'group-disabled': ['群已停用，消息保留待恢复', 'group paused; message kept'],
  'binding-missing': ['群绑定已移除，消息保留', 'binding removed; message kept'],
  'repository-disabled': ['原仓库已停用，消息保留', 'original repository disabled; message kept'],
  'thread-reassigned': ['话题已归属其他仓库，消息保留', 'topic moved to another repository; message kept'],
}
const MANAGER_KEY = 'dsh-superagent/manager/route'
const MANAGER_LABEL: Record<ManagerArea, DshSuperagentKey> = {
  repositories: 'manager.manageRepositories', deliveries: 'manager.deliveries', bindings: 'manager.bindings', feishu: 'manager.bot',
}
type ManagerRequest = <T>(path: string, body?: unknown, method?: string) => Promise<T>
type ManagerModeAction = (view: ManagerView) => ReactNode
const managerRoute = (area: ManagerArea, bindingRepositoryId?: string): Route => ({ page: 'manager', query: { area, bindingRepositoryId } })
/** Signals that the operator must unlock the shared manager before requests can resume. */
class OperatorAuthRequired extends Error {}
/** One same-origin manager request; its `x-orchestrator-request` header is what the loopback guard checks. */
async function managerRequest<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token?: string): Promise<T> {
  const response = await fetch(`/orchestrator/manager/${path}`, { method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000), ...(token ? { redirect: 'error' } : {}) })
  const value = await response.json() as T & { error?: string; code?: string }
  if (response.status === 401 && value.code === 'operator_auth_required') throw new OperatorAuthRequired(value.error)
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`)
  return value
}
const scoped = (route: Route, repo: string | undefined): Route => {
  if (!repo || route.page === 'manager' || route.repo) return route
  return { ...route, repo } as Route
}
/** The manager's shared control elements and state, available to every control page. */
interface ManagerApi {
  t: T; tr: (zh: string, en: string) => string; view: ManagerView; busy: boolean; error: string; stateError: string
  request: ManagerRequest; lock?: () => void
  navigate: (route: Route, replace?: boolean) => void
  run: (work: () => Promise<unknown>) => Promise<boolean>
  reload: () => Promise<void>
}
const Manager = createContext<ManagerApi | undefined>(undefined)
const useManager = (): ManagerApi => {
  const value = useContext(Manager)
  if (!value) throw new Error('A manager page rendered outside the manager')
  return value
}
const tagTone = (state: string): 'success' | 'warning' | 'danger' | 'quiet' => (state === 'ok' || state === 'ready') ? 'success' : state === 'pending'
  ? 'warning' : state === 'error' ? 'danger' : 'quiet'

/** Control groups listed above the selected repository's own work areas in the same rail. */
function managerGroups(view: ManagerView, repoId: string | undefined, area: ManagerArea | undefined,
  navigate: (route: Route, replace?: boolean) => void, tr: (zh: string, en: string) => string, t: T): NavGroup[] {
  return [
    { title: t('manager.control'), items: [
      { key: 'repositories', label: t('manager.manageRepositories'), icon: 'hash', active: area === 'repositories',
        count: view.repositories.length, onSelect: () => navigate(managerRoute('repositories')) },
      { key: 'deliveries', label: t('manager.deliveries'), icon: 'queue', active: area === 'deliveries', count: view.queues?.total,
        onSelect: () => navigate(managerRoute('deliveries')) },
      { key: 'bindings', label: t('manager.bindings'), icon: 'message', active: area === 'bindings',
        count: view.bindings.filter(binding => binding.enabled).length, onSelect: () => navigate(managerRoute('bindings')) },
      { key: 'bot', label: t('manager.bot'), icon: 'user', active: area === 'feishu', dot: view.bot ? 'done' : 'warning',
        onSelect: () => navigate(managerRoute('feishu')) },
    ] },
    { title: tr('已登记仓库', 'Repositories'), items: view.repositories.map(repository => ({
      key: repository.id, label: repository.name, icon: 'hash', active: false, selected: repository.id === repoId,
      count: repository.pending?.total, dot: repository.status.error ? 'error' : !repository.status.online ? 'idle'
        : repository.status.configured === true ? 'done' : 'warning',
      onSelect: () => navigate({ page: 'overview', repo: repository.id }),
    })) },
  ]
}

/** The manager's control pages inside the shared shell: one rail, one detail column, no page tabs. */
function ManagerControlShell({ query, manager, modeAction }: { query: Extract<Route, { page: 'manager' }>['query']; manager: ManagerApi
  modeAction?: ManagerModeAction }) {
  const { area, bindingRepositoryId } = query
  const groups = managerGroups(manager.view, undefined, area, manager.navigate, manager.tr, manager.t)
  return <ShellFrame rail={<NavRail brand={{ name: manager.t('panel'), subtitle: manager.tr('统一研发底座', 'Shared development workspace') }} groups={groups}
    label={manager.t('pagesLabel')} />}>
    <style>{STYLES}</style>
    <header className="dt-head">
      <h1 className="dt-title">{manager.t(MANAGER_LABEL[area])}</h1>
      <div className="dt-toolbar"><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} disabled={manager.busy}
        onClick={() => { void manager.reload() }}>{manager.t('manager.refresh')}</Button>
        {modeAction && <details className="dt-header-options"><summary>{manager.tr('工作台选项', 'Workspace options')}</summary><div>{modeAction(manager.view)}</div></details>}
        {manager.lock && <Button variant="ghost" size="sm" onClick={manager.lock}>{manager.tr('锁定面板', 'Lock panel')}</Button>}
      </div>
    </header>
    {manager.stateError && <p className="dt-error" role="status">{manager.stateError}</p>}
    {manager.error && <p className="dt-error" role="alert">{manager.error}</p>}
    <Manager.Provider value={manager}><ManagerPage area={area} bindingRepositoryId={bindingRepositoryId} /></Manager.Provider>
  </ShellFrame>
}

function ManagerPage({ area, bindingRepositoryId }: { area: ManagerArea; bindingRepositoryId?: string }) {
  switch (area) {
    case 'repositories': return <RepositoriesPage />
    case 'deliveries': return <DeliveriesPage />
    case 'bindings': return <BindingsPage key={bindingRepositoryId ?? ''} bindingRepositoryId={bindingRepositoryId} />
    case 'feishu': return <FeishuPage />
  }
}

/** The selected repository keeps the standalone panel's nine work areas, with the manager groups still in the rail. */
function ManagerRepoShell({ location, route, repo, manager }: { location: Location; route: RepoRoute; repo: RepositoryView
  manager: ManagerApi }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  const groups = managerGroups(manager.view, repo.id, undefined, manager.navigate, manager.tr, t)
  return <ShellFrame rail={<Rail route={route} settingsGroup={lastSettingsGroup(location)} extraGroups={groups}
    subtitle={[repo.teamName, repo.name].filter(Boolean).join(' · ')} />}>
    <Header title={titleOf(t, route)} masterId={state?.masterId} actions={manager.lock &&
      <Button variant="ghost" size="sm" onClick={manager.lock}>{manager.tr('锁定面板', 'Lock panel')}</Button>} />
    {manager.stateError && <p className="dt-error" role="status">{manager.stateError}</p>}
    {manager.error && <p className="dt-error" role="alert">{manager.error}</p>}
    {error && state && <p className="dt-error" role="status">{error.message}</p>}
    <Content route={route} deploymentForm={undefined} />
  </ShellFrame>
}

const managerText = (t: T, zh: string, en: string) => t('yes') === 'Yes' ? en : zh

function OperatorLogin({ t, rejected, onSubmit }: { t: T; rejected: boolean; onSubmit: (token: string) => void }) {
  const tr = (zh: string, en: string) => managerText(t, zh, en)
  const [token, setToken] = useState('')
  const [invalid, setInvalid] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = token.trim()
    if (!/^[0-9a-f]{64}$/.test(value)) { setInvalid(true); return }
    setToken(''); onSubmit(value)
  }
  return <ShellFrame rail={<NavRail brand={{ name: t('panel'), subtitle: tr('管理', 'Manager') }} groups={[]} label={t('pagesLabel')} />}>
    <style>{STYLES}</style>
    <header className="dt-head"><h1 className="dt-title">{tr('登录管理面板', 'Sign in to the manager')}</h1></header>
    <form className="dt-form dt-block" autoComplete="off" onSubmit={submit}>
      <Field label={tr('运维令牌', 'Operator token')}><Input type="password" autoComplete="off" spellCheck={false} required value={token}
        onChange={event => { setInvalid(false); setToken(event.target.value) }} /></Field>
      {invalid ? <p className="dt-error" role="alert">{tr('令牌应为 64 位小写十六进制字符。', 'Enter a 64-character lowercase hexadecimal token.')}</p>
        : rejected && <p className="dt-error" role="alert">{tr('令牌未获授权，请输入当前运维令牌。', 'The token was rejected. Enter the current operator token.')}</p>}
      <div className="dt-actions"><Button type="submit" variant="primary">{tr('解锁面板', 'Unlock manager')}</Button></div>
    </form>
  </ShellFrame>
}

/** Keep the operator credential in memory for this panel and discard its view whenever access is denied. */
export function ManagerPanel({ t, modeAction }: { t: T; modeAction?: ManagerModeAction }) {
  const [access, setAccess] = useState<{ token?: string; prompt?: 'required' | 'rejected' }>({})
  const reject = useCallback(() => setAccess(current => current !== access ? current : { prompt: access.token ? 'rejected' : 'required' }), [access])
  const lock = useCallback(() => setAccess({ prompt: 'required' }), [])
  if (access.prompt) return <OperatorLogin t={t} rejected={access.prompt === 'rejected'} onSubmit={token => setAccess({ token })} />
  return <ManagerWorkspace t={t} token={access.token} onUnauthorized={reject} lock={access.token ? lock : undefined} modeAction={modeAction} />
}

/** Manager mode: the control plane and each registered repository's panel, in one product shell. */
function ManagerWorkspace({ t, token, onUnauthorized, lock, modeAction }: { t: T; token?: string; onUnauthorized: () => void; lock?: () => void
  modeAction?: ManagerModeAction }) {
  const request: ManagerRequest = useCallback(async <T,>(path: string, body?: unknown, method?: string): Promise<T> => {
    try { return await managerRequest<T>(path, body, method, token) }
    catch (error) { if (error instanceof OperatorAuthRequired) onUnauthorized(); throw error }
  }, [token, onUnauthorized])
  const { data: view, error, reload } = usePoll(() => request<ManagerView>('state'), [request], 10_000)
  const [location, setLocation] = useState<Location>(() => {
    const stored = initialLocation(MANAGER_KEY)
    return stored.route.page === 'manager' || stored.route.repo ? stored : { route: MANAGER_HOME, stack: [] }
  })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  useEffect(() => { remember(location, MANAGER_KEY) }, [location])
  const move = useCallback((next: (current: Location) => Pick<Location, 'route' | 'stack'>) =>
    setLocation(current => ({ ...next(current), group: lastSettingsGroup(current) })), [])
  const navigate = useCallback((route: Route, replace = false) => move(current => {
    const currentRepo = current.route.page === 'manager' ? undefined : current.route.repo
    return { route: scoped(route, currentRepo), stack: replace ? current.stack : [...current.stack, current.route].slice(-20) }
  }), [move])
  const back = useCallback(() => move(current => ({ route: current.stack.at(-1) ?? MANAGER_HOME, stack: current.stack.slice(0, -1) })), [move])
  useEffect(() => {
    const receive = (event: Event) => { const route = (event as CustomEvent<Route>).detail; if (route?.page === 'manager') navigate(route) }
    window.addEventListener(MANAGER_NAV_EVENT, receive)
    return () => window.removeEventListener(MANAGER_NAV_EVENT, receive)
  }, [navigate])
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true); setActionError('')
    try { await work(); await reload(); return true }
    catch (failure) { setActionError(errorText(failure)); return false }
    finally { setBusy(false) }
  }, [reload])
  const tr = useCallback((zh: string, en: string) => managerText(t, zh, en), [t])
  const currentRepo = location.route.page === 'manager' ? undefined : location.route.repo
  const repo = currentRepo && view ? view.repositories.find(item => item.id === currentRepo) : undefined
  // A remembered repository that is no longer registered falls back to the repository list.
  useEffect(() => {
    if (view && currentRepo && !view.repositories.some(item => item.id === currentRepo)) navigate(MANAGER_HOME, true)
  }, [view, currentRepo, navigate])
  const openWorkspace = useCallback(async (repository: RepositoryView) => {
    try {
      const launch = await request<{ url: string }>(`repositories/${repository.id}/open`, {})
      window.open(launch.url, '_blank', 'noopener,noreferrer')
    } catch (failure) { setActionError(errorText(failure)) }
  }, [request])
  if (!view) return <ShellFrame rail={<NavRail brand={{ name: t('panel'), subtitle: tr('管理', 'Manager') }} groups={[]}
    label={t('pagesLabel')} />}>
    <style>{STYLES}</style>
    <header className="dt-head"><h1 className="dt-title">{t('manager.manageRepositories')}</h1></header>
    <p className={error ? 'dt-error' : 'dt-hint'} role={error ? 'alert' : undefined}>{error ? errorText(error) : t('loading')}</p>
  </ShellFrame>
  const manager: ManagerApi = { t, tr, view, busy, error: actionError, stateError: error ? errorText(error) : '', navigate, run, reload, request, lock }
  if (location.route.page === 'manager') return <ManagerControlShell query={location.route.query} manager={manager} modeAction={modeAction} />
  if (!repo) return <ShellFrame rail={<NavRail brand={{ name: t('panel'), subtitle: tr('管理', 'Manager') }} groups={[]}
    label={t('pagesLabel')} />}>
    <style>{STYLES}</style>
    <header className="dt-head"><h1 className="dt-title">{t('manager.manageRepositories')}</h1></header>
    <p className="dt-hint">{t('loading')}</p>
  </ShellFrame>
  if (!repo.status.online) return <ShellFrame rail={<NavRail brand={{ name: t('panel'), subtitle: tr('统一研发底座', 'Shared development workspace') }}
    groups={managerGroups(view, repo.id, undefined, navigate, tr, t)} label={t('pagesLabel')} />}>
    <style>{STYLES}</style><header className="dt-head"><h1 className="dt-title">{repo.name}</h1>
      <div className="dt-toolbar"><Button variant="ghost" size="sm" disabled={busy} onClick={() => { void reload() }}>{tr('刷新状态', 'Refresh status')}</Button></div></header>
    <Manager.Provider value={manager}><div className="dt-manager-hero"><div><p className="dt-manager-eyebrow">{repo.remote}</p>
      <h2>{repo.starting ? tr('正在启动仓库服务', 'Starting repository service') : tr('仓库已接入，服务尚未运行', 'Repository connected; service is stopped')}</h2>
      <p>{repo.starting ? tr('服务启动后将自动进入仓库工作台。', 'The repository workspace opens automatically when the service is ready.')
        : tr('启动后可接收已授权的 GitHub 与飞书任务，并在这里查看交付进度。', 'Start the service to receive authorized GitHub and Feishu tasks and track delivery here.')}</p></div>
      <Tag tone={repo.starting ? 'info' : 'quiet'}>{repo.starting ? tr('启动中', 'Starting') : tr('未运行', 'Stopped')}</Tag></div>
      {actionError && <p className="dt-error" role="alert">{actionError}</p>}
      {error && <p className="dt-error" role="status">{errorText(error)}</p>}
      <RepositoryCard repo={repo} editLabel={tr('返回仓库管理', 'Back to repositories')} onEdit={() => navigate(managerRoute('repositories'))} />
    </Manager.Provider>
  </ShellFrame>
  return <PanelProvider key={repo.id} t={t} apiBase={`/orchestrator/manager/repositories/${encodeURIComponent(repo.id)}/api/`}
    apiAuthorization={token ? `Bearer ${token}` : undefined} onApiUnauthorized={onUnauthorized}
    remote openSession={token ? null : () => openWorkspace(repo)} navigate={navigate} back={back}
    backLabel={routeLabel(t, location.stack.at(-1) ?? MANAGER_HOME)}>
    <ManagerRepoShell location={location} route={location.route} repo={repo} manager={manager} />
  </PanelProvider>
}

function RepositoryMetadata({ repo }: { repo: RepositoryView }) {
  const { tr } = useManager()
  if (!repo.teamName && !repo.productLines?.length) return null
  return <div className="dt-row-meta">
    {repo.teamName && <LabelValue label={tr('研发团队', 'Team')} value={repo.teamName} />}
    {!!repo.productLines?.length && <LabelValue label={tr('产品线', 'Product lines')} value={repo.productLines.join(tr('、', ', '))} />}
  </div>
}

function SetupGuide({ addRepository }: { addRepository: () => void }) {
  const { tr, view, busy, navigate } = useManager()
  const bound = view.bindings.filter(binding => binding.enabled).length
  const running = view.repositories.filter(repo => repo.status.online && repo.status.configured).length
  const steps = [
    { title: tr('添加团队仓库', 'Add team repositories'), done: view.repositories.length > 0,
      detail: tr('用团队和产品线组织仓库，所有团队共用同一套 DSH。', 'Organize repositories by team and product line in one DSH.'),
      action: tr('添加仓库', 'Add repository'), onClick: addRepository },
    { title: tr('连接飞书机器人', 'Connect the Feishu bot'), done: !!view.bot,
      detail: view.bot ? view.bot.name || view.bot.id : tr('GitHub 接单可跳过；飞书接单只需连接一次。', 'Optional for GitHub. Connect once for Feishu intake.'),
      action: view.bot ? tr('查看机器人', 'View bot') : tr('连接机器人', 'Connect bot'), onClick: () => navigate(managerRoute('feishu')) },
    { title: tr('把群聊绑定到仓库', 'Bind groups to repositories'), done: bound > 0,
      detail: bound ? tr(`已启用 ${bound} 个群绑定。`, `${bound} group bindings enabled.`)
        : tr('选择群、目标仓库和可提交任务的成员。', 'Choose a group, its repository and authorized requesters.'),
      action: tr('配置群聊绑定', 'Set up group bindings'), onClick: () => navigate(managerRoute('bindings')) },
    { title: tr('启动仓库服务', 'Start repository services'), done: running > 0,
      detail: tr('在仓库卡片启动服务，再通过 GitHub 或群内 @机器人提交需求。', 'Start a repository service, then submit a task through GitHub or mention the bot.'),
      action: tr('查看运行状态', 'View service status'), onClick: () => navigate(managerRoute('deliveries')) },
  ]
  return <details className="dt-manager-setup" open={!view.repositories.length}>
    <summary><span>{tr('接入进度', 'Setup progress')}</span><span className="dt-hint">
      {tr(`${steps.filter(step => step.done).length} / 4 步已完成`, `${steps.filter(step => step.done).length} / 4 steps complete`)}</span>
      <Icon name="chevron-down" size={14} /></summary>
    <ol className="dt-manager-steps">{steps.map((step, index) => <li key={step.title} data-complete={step.done || undefined}>
      <span className="dt-manager-step-number">{step.done ? <Icon name="decision" size={18} /> : index + 1}</span>
      <div className="dt-row-main"><div className="dt-row-title">{step.title}</div><p className="dt-hint">{step.detail}</p></div>
      <Button variant="ghost" size="sm" disabled={busy} onClick={step.onClick}>{step.action}</Button>
    </li>)}</ol>
  </details>
}

function RepositoryCard({ repo, onEdit, editLabel }: { repo: RepositoryView; onEdit: (repo: RepositoryView) => void; editLabel?: string }) {
  const { t, tr, view, busy, run, request, navigate, lock } = useManager()
  const groups = view.bindings.filter(binding => binding.repositoryId === repo.id && binding.enabled)
  const dimensions = repo.readiness ? DIMENSIONS.map(([key, zh, en]) => ({ key, label: tr(zh, en), item: repo.readiness![key] }))
    .filter(row => row.item.state !== 'ok') : []
  const start = () => run(() => request(`repositories/${repo.id}/${repo.status.online ? 'stop' : 'start'}`, {}))
  const open = () => {
    void run(async () => {
      const launch = await request<{ url: string }>(`repositories/${repo.id}/open`, {})
      window.open(launch.url, '_blank', 'noopener,noreferrer')
    })
  }
  return <article className="dt-card dt-repository-card" data-state={repo.status.error ? 'error' : repo.status.online ? 'ready' : 'stopped'}>
    <div className="dt-card-head">
      <div className="dt-row-main"><div className="dt-row-title">{repo.name}</div>
        <div className="dt-row-meta dt-mono">{repo.remote}</div></div>
      <Tag tone={repo.status.error ? 'danger' : !repo.status.online ? 'quiet' : repo.status.configured === true ? 'success' : 'warning'}>
        {repo.starting ? tr('启动中', 'Starting') : repo.status.error ? tr('需要处理', 'Needs attention')
          : repo.status.online ? repo.status.configured === true ? tr('已就绪', 'Ready') : tr('需要完成设置', 'Setup needed') : tr('未运行', 'Stopped')}</Tag>
    </div>
    <div className="dt-repository-meta"><RepositoryMetadata repo={repo} />
      {!repo.teamName && <p className="dt-hint">{tr('尚未分配团队', 'No team assigned')}</p>}
      <div className="dt-row-meta"><Icon name="message" size={14} /><LabelValue label={tr('接单群聊', 'Intake groups')} value={groups.length
        ? groups.map(group => view.chats[group.chatId] || group.chatId).join(tr('、', ', ')) : tr('尚未绑定', 'None bound')} /></div>
      <div className="dt-row-meta"><Icon name="shield" size={14} /><span>{tr(
        `GitHub ${repo.allowedGithub.length} 人 · 飞书 ${repo.allowedFeishu.length} 人已授权`,
        `${repo.allowedGithub.length} GitHub · ${repo.allowedFeishu.length} Feishu identities authorized`)}</span></div>
    </div>
    {repo.status.error && <p className="dt-error" role="alert">{repo.status.error}</p>}
    {dimensions.length > 0 && <details className="dt-manager-checks"><summary>{tr('查看运行检查', 'Service checks')}
      <span className="dt-count">{dimensions.length}</span></summary>
      <ul className="dt-list">{dimensions.map(row => <li className="dt-row" key={row.key}>
        <div className="dt-row-main"><div className="dt-row-title">{row.label}</div>
          <div className="dt-row-meta">{row.item.detail}</div>
          {row.item.repair === 'feishu' && <div className="dt-actions"><Button size="sm" disabled={busy}
            onClick={() => navigate(managerRoute(view.bot ? 'bindings' : 'feishu', view.bot ? repo.id : undefined))}>
            {view.bot ? tr('配置群聊绑定', 'Set up group bindings') : tr('连接机器人', 'Connect bot')}</Button></div>}
          {row.item.repair === 'agent' && <div className="dt-actions">{repo.status.online
            ? <Button size="sm" disabled={busy} onClick={() => navigate({ page: 'settings', repo: repo.id, query: { group: 'execution' } })}>
              {tr('检查执行设置', 'Review execution settings')}</Button>
            : <span>{tr('启动仓库后检查执行工具。', 'Start this repository to check execution tools.')}</span>}</div>}
        </div>
        <Tag tone={tagTone(row.item.state)}>{row.item.state === 'pending' ? tr('待处理', 'Pending')
          : row.item.state === 'error' ? tr('异常', 'Error') : tr('待检查', 'Check required')}</Tag>
      </li>)}</ul></details>}
    {!!repo.pending?.total && <p className="dt-hint">{tr(`${repo.pending.total} 条待投递`, `${repo.pending.total} queued`)}</p>}
    <div className="dt-actions">
      <Button variant={repo.status.online ? 'outline' : 'primary'} size="sm" icon={<Icon name={repo.status.online ? 'pause' : 'play'} size={14} />}
        disabled={busy || repo.starting} onClick={() => { void start() }}>
        {repo.starting ? tr('启动中', 'Starting') : repo.status.online ? tr('停止服务', 'Stop service') : tr('启动服务', 'Start service')}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onEdit(repo)}>{editLabel ?? tr('仓库设置', 'Repository settings')}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => navigate(managerRoute('bindings', repo.id))}>
        {tr('绑定飞书群', 'Bind a Feishu group')}</Button>
      {repo.status.online && <Button variant="ghost" size="sm" disabled={busy}
        onClick={() => navigate({ page: 'overview', repo: repo.id })}>{tr('打开仓库详情', 'Open repository details')}</Button>}
      {repo.status.online && !lock && <Button variant="ghost" size="sm" icon={<Icon name="external" size={14} />} disabled={busy}
        onClick={open}>{t('manager.openWorkspace')}</Button>}
    </div>
  </article>
}

const EMPTY_REPOSITORY_FORM = { name: '', directory: '', remote: '', githubCli: '', allowedGithub: '', allowedFeishu: '', teamName: '', productLines: '', requiredChecks: '' }
const teamKey = (name: string | undefined) => name ? `team:${name}` : 'unassigned'
const normalizeRemote = (value: string) => value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/, '').replace(/\/$/, '')

function RepositoriesPage() {
  const { tr, view, busy, run, request, error } = useManager()
  const [editingId, setEditingId] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [form, setForm] = useState(EMPTY_REPOSITORY_FORM)
  const initialForm = useRef(EMPTY_REPOSITORY_FORM)
  const editingRevision = useRef<number>()
  const [selectedTeam, setSelectedTeam] = useState('')
  const [selectedProduct, setSelectedProduct] = useState('')
  const [selectedStatus, setSelectedStatus] = useState('')
  const [search, setSearch] = useState('')
  const [memberChat, setMemberChat] = useState('')
  const [members, setMembers] = useState<FeishuMember[]>([])
  const [notice, setNotice] = useState('')
  const [validation, setValidation] = useState('')
  const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))]
  const teams = [...new Set(view.repositories.flatMap(repo => repo.teamName ? [repo.teamName] : []))].sort((left, right) => left.localeCompare(right))
  const allProducts = [...new Set(view.repositories.flatMap(repo => repo.productLines ?? []))].sort((left, right) => left.localeCompare(right))
  const unassigned = view.repositories.some(repo => !repo.teamName)
  const available = teams.map(teamKey).concat(unassigned ? [teamKey(undefined)] : [])
  const filter = available.includes(selectedTeam) ? selectedTeam : ''
  const productFilter = allProducts.includes(selectedProduct) ? selectedProduct : ''
  const visible = view.repositories.filter(repo => (!filter || teamKey(repo.teamName) === filter)
    && (!productFilter || repo.productLines?.includes(productFilter))
    && (!selectedStatus || (selectedStatus === 'running' ? repo.status.online || repo.starting
      : selectedStatus === 'attention' ? !!repo.status.error || (repo.status.online && !repo.status.configured)
      : !repo.status.online && !repo.starting))
    && (!search.trim() || [repo.name, repo.remote, repo.teamName, ...(repo.productLines ?? [])].join(' ').toLowerCase().includes(search.trim().toLowerCase())))
  const products = new Set(visible.flatMap(repo => repo.productLines ?? [])).size
  const running = view.repositories.filter(repo => repo.status.online || repo.starting).length
  const pending = visible.reduce((count, repo) => count + (view.queues?.byRepository[repo.id] ?? repo.pending?.total ?? 0), 0)
  const github = new Set(visible.flatMap(repo => repo.allowedGithub.map(id => id.toLowerCase()))).size
  const feishu = new Set(visible.flatMap(repo => repo.allowedFeishu)).size
  const clearFilters = () => { setSelectedTeam(''); setSelectedProduct(''); setSelectedStatus(''); setSearch('') }
  const reset = () => { setEditingId(''); setMemberChat(''); setMembers([]); setEditorOpen(false); setDiscard(false); setValidation(''); setForm(EMPTY_REPOSITORY_FORM) }
  const closeEditor = () => {
    if (busy) return
    if (JSON.stringify(initialForm.current) !== JSON.stringify(form)) setDiscard(true)
    else reset()
  }
  const addRepository = () => {
    const next = { ...EMPTY_REPOSITORY_FORM, githubCli: view.repositories[0]?.githubCli || 'gh',
      teamName: filter.startsWith('team:') ? filter.slice(5) : '' }
    setEditingId(''); setMemberChat(''); setMembers([]); setValidation(''); setDiscard(false); setAdvanced(!view.enterprisePilot)
    setForm(next); initialForm.current = next; setEditorOpen(true)
  }
  const edit = (repo: RepositoryView) => {
    const next = { name: repo.name, directory: repo.directory, remote: repo.remote, githubCli: repo.githubCli,
      allowedGithub: repo.allowedGithub.join(' '), allowedFeishu: repo.allowedFeishu.join(' '),
      teamName: repo.teamName ?? '', productLines: repo.productLines?.join('\n') ?? '', requiredChecks: repo.requiredChecks?.join('\n') ?? '' }
    setEditingId(repo.id); setMemberChat(''); setMembers([]); setValidation(''); setDiscard(false); setAdvanced(false)
    setForm(next); initialForm.current = next; editingRevision.current = view.revision; setEditorOpen(true)
  }
  const loadMembers = async (chat: string) => {
    setMemberChat(chat); setMembers([])
    if (chat) await run(async () => {
      const result = await request<{ users: FeishuMember[] }>(`chats/${encodeURIComponent(chat)}/members`)
      setMembers(result.users)
    })
  }
  const revealAdvanced = (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const details = input.closest('details')
    if (details) details.open = true
    setAdvanced(true)
    setValidation(tr('请补全高级连接设置中的必填项。', 'Complete the required advanced connection settings.'))
    requestAnimationFrame(() => input.focus())
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setValidation('')
    if (editingId && editingRevision.current !== view.revision) {
      setValidation(tr('配置已被其他操作更新。请重新读取后编辑，当前草稿尚未提交。', 'Configuration changed elsewhere. Reload the repository before editing; your draft has not been submitted.')); return
    }
    const remote = normalizeRemote(form.remote)
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote)) {
      setValidation(tr('请输入 GitHub 仓库链接或「组织名/仓库名」。', 'Enter a GitHub URL or owner/repository.')); return
    }
    const { teamName: team, productLines: lines, requiredChecks: checks, ...names } = form
    const teamName = team.trim()
    const productLines = [...new Set(lines.split(/\r?\n/).map(line => line.trim()).filter(Boolean))]
    const requiredChecks = [...new Set(checks.split(/\r?\n/).map(check => check.trim()).filter(Boolean))]
    const enabled = view.repositories.find(repo => repo.id === editingId)?.enabled ?? true
    const done = await run(() => request(editingId ? `repositories/${editingId}` : 'repositories', { ...names,
      name: names.name.trim() || remote.split('/')[1], remote, githubCli: names.githubCli.trim(), revision: editingId ? editingRevision.current : view.revision,
      ...(teamName ? { teamName } : editingId ? { teamName: null } : {}), productLines, requiredChecks,
      allowedGithub: ids(form.allowedGithub), allowedFeishu: ids(form.allowedFeishu), enabled }, editingId ? 'PUT' : 'POST'))
    if (done) {
      setNotice(editingId ? tr('仓库设置已保存。', 'Repository settings saved.')
        : tr(`已添加 ${form.name || remote}，可继续绑定飞书群或启动服务。`, `${form.name || remote} was added. Bind a group or start its service next.`))
      reset()
    }
  }
  return <>
    <div className="dt-manager-hero">
      <div><p className="dt-manager-eyebrow">DSH · {tr('企业研发协作', 'Enterprise development')}</p>
        <h2>{tr('统一研发工作台', 'One workspace for every team')}</h2>
        <p>{tr('在一处管理团队、产品仓库和飞书接单。把需求交给 AI，把交付握在手里。',
          'Manage teams, product repositories and Feishu intake in one place. Keep every delivery in view.')}</p></div>
      <Button variant="primary" icon={<Icon name="plus" />} disabled={busy} onClick={addRepository}>{tr('添加仓库', 'Add repository')}</Button>
    </div>
    <div className="dt-manager-metrics" aria-label={tr('全局概览', 'Workspace overview')}>
      {[
        [tr('已登记团队', 'Registered teams'), teams.length, tr(`${allProducts.length} 条产品线`, `${allProducts.length} product lines`)],
        [tr('仓库总数', 'Repositories'), view.repositories.length, tr('共用一个 DSH 底座', 'One shared DSH foundation')],
        [tr('运行中的仓库', 'Running repositories'), running, view.capacity
          ? tr(`运行名额 ${view.capacity.runningRepositories} / ${view.capacity.maxRunningRepositories}`, `${view.capacity.runningRepositories} / ${view.capacity.maxRunningRepositories} slots used`)
          : tr('包含启动中的服务', 'Including services starting')],
        [tr('飞书接单群', 'Feishu intake groups'), view.bindings.filter(binding => binding.enabled).length,
          view.bot ? tr('机器人已连接', 'Bot connected') : tr('待连接机器人', 'Bot not connected')],
      ].map(([label, value, detail]) => <div className="dt-manager-metric" key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}
    </div>
    <SetupGuide addRepository={addRepository} />
    {notice && <p className="dt-success-note" role="status"><Icon name="decision" size={16} />{notice}</p>}
    <Section title={tr('团队仓库', 'Team repositories')} count={visible.length}>
      <div className="dt-manager-filters">
        <Input type="search" icon={<Icon name="search" />} value={search} aria-label={tr('搜索仓库', 'Search repositories')}
          placeholder={tr('搜索仓库、团队或产品线', 'Search repositories, teams or products')} onChange={event => setSearch(event.target.value)} />
        <select className="dt-select" aria-label={tr('按研发团队筛选', 'Filter by team')} value={filter} onChange={event => setSelectedTeam(event.target.value)}>
          <option value="">{tr('全部团队', 'All teams')}</option>{teams.map(team => <option key={team} value={teamKey(team)}>{team}</option>)}
          {unassigned && <option value="unassigned">{tr('未分配团队', 'No team assigned')}</option>}
        </select>
        <select className="dt-select" aria-label={tr('按产品线筛选', 'Filter by product line')} value={productFilter} onChange={event => setSelectedProduct(event.target.value)}>
          <option value="">{tr('全部产品线', 'All product lines')}</option>{allProducts.map(product => <option key={product} value={product}>{product}</option>)}
        </select>
        <select className="dt-select" aria-label={tr('按运行状态筛选', 'Filter by service status')} value={selectedStatus} onChange={event => setSelectedStatus(event.target.value)}>
          <option value="">{tr('全部状态', 'All statuses')}</option><option value="running">{tr('运行或启动中', 'Running or starting')}</option>
          <option value="stopped">{tr('未运行', 'Stopped')}</option><option value="attention">{tr('需要处理', 'Needs attention')}</option>
        </select>
      </div>
      <div className="dt-stats" aria-live="polite"><LabelValue label={tr('仓库', 'Repositories')} value={visible.length} />
        <LabelValue label={tr('产品线', 'Product lines')} value={products} /><LabelValue label={tr('待投递消息', 'Queued deliveries')} value={pending} />
        <LabelValue label={tr('GitHub 授权身份', 'Authorized GitHub identities')} value={github} />
        <LabelValue label={tr('飞书授权身份', 'Authorized Feishu identities')} value={feishu} />
        {(filter || productFilter || selectedStatus || search) && <Button variant="ghost" size="sm" onClick={clearFilters}>{tr('清除筛选', 'Clear filters')}</Button>}
      </div>
      {visible.length ? <div className="dt-list dt-cards dt-repository-grid">{visible.map(repo => <RepositoryCard key={repo.id} repo={repo} onEdit={edit} />)}</div>
        : <div className="dt-manager-empty"><Icon name="hash" size={28} /><h3>{view.repositories.length
          ? tr('没有匹配的仓库', 'No matching repositories') : tr('接入第一个团队仓库', 'Connect your first team repository')}</h3>
          <p>{view.repositories.length ? tr('调整筛选条件，或搜索其他仓库名称。', 'Adjust filters or search for another repository.')
            : tr('粘贴 GitHub 仓库地址，指定团队和接单人，即可开始。', 'Paste a GitHub repository URL, choose a team and authorize requesters.')}</p>
          <Button variant="primary" onClick={view.repositories.length ? clearFilters : addRepository}>{view.repositories.length
            ? tr('清除筛选', 'Clear filters') : tr('添加仓库', 'Add repository')}</Button></div>}
    </Section>
    <Modal open={editorOpen} onClose={closeEditor} className="dt-repository-modal" closeLabel={tr('关闭', 'Close')}
      title={editingId ? tr('仓库设置', 'Repository settings') : tr('添加团队仓库', 'Add a team repository')}
      description={editingId ? tr('管理团队归属和接单权限，保存后生效。', 'Manage team ownership and requester access.')
        : tr('先接入仓库，再绑定群聊。保存时会检查执行账号的 GitHub 推送权限。', 'Connect a repository, then bind its groups. Saving verifies GitHub push access.')}
      footer={discard ? <><span className="dt-hint">{tr('有未保存的修改。', 'You have unsaved changes.')}</span>
        <Button onClick={() => setDiscard(false)}>{tr('继续编辑', 'Keep editing')}</Button><Button variant="outline" onClick={reset}>{tr('放弃修改', 'Discard changes')}</Button></>
        : <><Button disabled={busy} onClick={closeEditor}>{tr('取消', 'Cancel')}</Button>
          <Button form="dt-repository-editor" variant="primary" type="submit" disabled={busy}>
            {busy ? tr('正在检查并保存…', 'Verifying and saving…') : editingId ? tr('保存仓库设置', 'Save repository settings')
              : tr('检查并添加仓库', 'Verify and add repository')}</Button></>}>
      <form id="dt-repository-editor" className="dt-form" onSubmit={event => { void submit(event) }}>
        <Fields disabled={busy}>
          <section className="dt-form-section"><h3>{tr('基本信息', 'Repository details')}</h3>
            <Field label={tr('GitHub 仓库', 'GitHub repository')} note={tr('支持完整 GitHub 地址或 owner/repository。', 'Accepts a GitHub URL or owner/repository.')}>
              <Input required value={form.remote} disabled={!!editingId} placeholder="https://github.com/owner/repository"
                onChange={event => { const remote = event.target.value; setForm({ ...form, remote,
                  name: !form.name || form.name === normalizeRemote(form.remote).split('/')[1] ? normalizeRemote(remote).split('/')[1] || '' : form.name }) }} /></Field>
            <div className="dt-grid2"><Field label={tr('名称', 'Name')}><Input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
              <Field label={tr('研发团队', 'Team')}><Input maxLength={100} list="dt-manager-teams" value={form.teamName}
                placeholder={tr('选择已有团队或填写新团队', 'Select or enter a team')} onChange={event => setForm({ ...form, teamName: event.target.value })} /></Field></div>
            <datalist id="dt-manager-teams">{teams.map(team => <option key={team} value={team} />)}</datalist>
            <Field label={tr('产品线', 'Product lines')} note={tr('每行一条，可关联多条产品线。', 'One product line per row; multiple lines are supported.')}>
              <textarea rows={2} className="dt-textarea" value={form.productLines} onChange={event => setForm({ ...form, productLines: event.target.value })} /></Field>
          </section>
          <section className="dt-form-section"><h3>{tr('谁可以提交任务', 'Who can submit tasks')}</h3>
            <Field label={tr('允许接单的 GitHub 用户名，以空格分隔', 'Allowed GitHub usernames, separated by spaces')}
              note={tr('仅这些身份可以从 GitHub 发起新任务。', 'Only these identities can start new tasks from GitHub.')}>
              <Input value={form.allowedGithub} placeholder="alice bob" onChange={event => setForm({ ...form, allowedGithub: event.target.value })} /></Field>
            <details className="dt-manager-checks"><summary>{tr('飞书成员权限', 'Feishu member access')}
              <span className="dt-count">{ids(form.allowedFeishu).length}</span></summary>
              <p className="dt-hint">{tr('也可以在「群聊绑定」时按成员姓名授权。', 'You can also authorize members by name while binding a group.')}</p>
              <Field label={tr('选择群以读取成员', 'Choose a group to load members')}>
                <select className="dt-select" value={memberChat} disabled={!view.bot} onChange={event => { void loadMembers(event.target.value) }}>
                  <option value="">{tr('请选择', 'Choose')}</option>{Object.entries(view.chats).map(([id, name]) => <option key={id} value={id}>{name || id}</option>)}
                </select></Field>
              {members.length > 0 && <div className="dt-checks">{members.map(member => <label className="dt-check" key={member.member_id}>
                <input type="checkbox" checked={ids(form.allowedFeishu).includes(member.member_id)} onChange={event => {
                  const selected = ids(form.allowedFeishu).filter(id => id !== member.member_id)
                  if (event.target.checked) selected.push(member.member_id)
                  setForm({ ...form, allowedFeishu: selected.join(' ') })
                }} /> {member.name}</label>)}</div>}
              <Field label={tr('已授权的飞书用户 ID', 'Authorized Feishu user IDs')} note={tr('可在这里移除已有授权，多个 ID 用空格分隔。', 'Remove existing grants here; separate IDs with spaces.')}>
                <Input value={form.allowedFeishu} onChange={event => setForm({ ...form, allowedFeishu: event.target.value })} /></Field>
            </details>
            {!ids(form.allowedGithub).length && !ids(form.allowedFeishu).length && <p className="dt-hint">{tr(
              '尚未授权接单人。仓库可以先保存，授权后才能开始新任务。', 'No requesters are authorized. Save now and grant access before starting new tasks.')}</p>}
          </section>
          <details className="dt-form-section" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
            <summary>{tr('高级连接设置', 'Advanced connection settings')}<span className="dt-hint">{tr('执行账号与本地目录', 'Execution account and checkout')}</span></summary>
            <Field label={tr('执行账号的 GitHub CLI', 'Agent GitHub CLI')} note={tr('使用已登录且有仓库写权限的命令。默认沿用已接入仓库的执行账号。', 'Use a signed-in CLI with repository write access. Existing execution credentials are reused by default.')}>
              <Input required value={form.githubCli} onInvalid={revealAdvanced} disabled={!!editingId} onChange={event => setForm({ ...form, githubCli: event.target.value })} placeholder="gh" /></Field>
            <Field label={tr('本地仓库根目录', 'Local repository root')} note={view.enterprisePilot
              ? tr('选填绝对路径。留空时由服务创建工作副本。', 'Optional absolute path. The service provisions a working copy if blank.')
              : tr('必填绝对路径。保存时检查 Git 远端。', 'Required absolute path. Saving checks the Git remote.')}>
              <Input required={!view.enterprisePilot} onInvalid={revealAdvanced} value={form.directory} disabled={!!editingId} list="dt-manager-workspaces"
                onChange={event => setForm({ ...form, directory: event.target.value })} placeholder="/projects/my-repo" /></Field>
            <datalist id="dt-manager-workspaces">{view.workspaces.map(path => <option key={path} value={path} />)}</datalist>
            <Field label={tr('必需的 CI 检查', 'Required CI checks')} note={tr(
              '每行一个 GitHub 检查名称。企业模式启动时会核对默认分支规则；留空仍要求至少一个必需的 CI 检查。此项不会修改 GitHub 规则。',
              'One GitHub check name per line. Enterprise startup verifies default-branch rules; an empty list still requires at least one CI check. This does not change GitHub rules.')}>
              <textarea rows={3} className="dt-textarea" value={form.requiredChecks} placeholder={'ci/test\nci/typecheck'}
                onChange={event => setForm({ ...form, requiredChecks: event.target.value })} /></Field>
          </details>
        </Fields>
        {(validation || error) && <p className="dt-error" role="alert">{validation || error}</p>}
        {editingId && editingRevision.current !== view.revision && <div className="dt-actions"><p className="dt-hint">{tr(
          '保存版本已变化，重新读取会替换当前草稿。', 'The saved version has changed. Reloading replaces your current draft.')}</p>
          <Button variant="outline" disabled={busy} onClick={() => {
            const latest = view.repositories.find(repo => repo.id === editingId)
            if (latest) edit(latest)
          }}>{tr('重新读取仓库设置', 'Reload repository settings')}</Button></div>}
      </form>
    </Modal>
  </>
}

function BindingsPage({ bindingRepositoryId }: { bindingRepositoryId?: string }) {
  const { tr, view, busy, run, request, navigate } = useManager()
  const [selectedChat, setSelectedChat] = useState('')
  const [selectedRepo, setSelectedRepo] = useState(() => view.repositories.find(repo => repo.id === bindingRepositoryId && repo.enabled)?.id ?? '')
  const [members, setMembers] = useState<FeishuMember[]>()
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [saved, setSaved] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const repository = view.repositories.find(repo => repo.id === selectedRepo && repo.enabled)
  const chats = Object.entries(view.chats)
  const knownChat = selectedChat && Object.hasOwn(view.chats, selectedChat)
  const hasRequester = memberIds.length > 0 || members?.some(member => repository?.allowedFeishu.includes(member.member_id))
  const refresh = () => run(() => request('chats/refresh', {}))
  const loadMembers = (chatId: string) => run(async () => {
    const result = await request<{ users: FeishuMember[] }>(`chats/${encodeURIComponent(chatId)}/members`)
    setMembers(result.users)
  })
  const chooseChat = (chatId: string) => {
    setSelectedChat(chatId); setMembers(undefined); setMemberIds([]); setSaved(''); setMemberSearch('')
    const binding = view.bindings.find(item => item.chatId === chatId)
    if (binding && view.repositories.some(repo => repo.id === binding.repositoryId && repo.enabled)) setSelectedRepo(binding.repositoryId)
    if (chatId) void loadMembers(chatId)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!knownChat || !repository || !view.bot) return
    const bindings = view.bindings.filter(item => item.chatId !== selectedChat).map(({ effectiveAt, ...binding }) => binding)
    bindings.push({ chatId: selectedChat, repositoryId: repository.id, enabled: true })
    const grant = memberIds.length ? { chatId: selectedChat, repositoryId: repository.id, memberIds } : undefined
    const done = await run(() => request('bindings', { revision: view.revision, bindings, grant }, 'PUT'))
    if (done) {
      const chatName = view.chats[selectedChat] || selectedChat
      setSaved(tr(`已将 ${chatName} 绑定到 ${repository.name}。`, `${chatName} is now bound to ${repository.name}.`))
      setSelectedChat(''); setSelectedRepo(''); setMembers(undefined); setMemberIds([])
    }
  }
  const toggle = (chatId: string) => run(() => request('bindings', { revision: view.revision,
    bindings: view.bindings.map(({ effectiveAt, ...item }) => item.chatId === chatId ? { ...item, enabled: !item.enabled } : item) }, 'PUT'))
  return <>
    <div className="dt-manager-hero"><div><p className="dt-manager-eyebrow">{tr('飞书接单', 'Feishu intake')}</p>
      <h2>{tr('把需求送到正确的仓库', 'Route every request to the right repository')}</h2>
      <p>{tr('为每个研发群指定目标仓库，并按成员授权。一个仓库可以连接多个群。',
        'Assign a repository to each development group and authorize its members. One repository can serve multiple groups.')}</p></div>
      <Tag tone={view.bindings.some(binding => binding.enabled) ? 'success' : 'quiet'}>{tr(
        `${view.bindings.filter(binding => binding.enabled).length} 个群接单中`, `${view.bindings.filter(binding => binding.enabled).length} groups enabled`)}</Tag>
    </div>
    <Section title={tr('机器人已加入的群', 'Groups the bot has joined')} action={<Button variant="outline" size="sm"
      icon={<Icon name="refresh" size={14} />} disabled={busy || !view.bot} onClick={() => { void refresh() }}>
      {tr('刷新群列表', 'Refresh groups')}</Button>} hint={tr('只接收 @机器人的新需求；群停用后暂停接单与自动回复，队列保留。',
      'Only new requests mentioning the bot are accepted. Disabling a group pauses intake and replies but keeps its queue.')}>
      {view.bot ? <Hint>{tr(`机器人 ${view.bot.name || view.bot.id} · 已找到 ${chats.length} 个群。加群后请刷新群列表。`,
        `Bot ${view.bot.name || view.bot.id} · ${chats.length} groups found. Refresh after adding the bot to a group.`)}</Hint>
        : <div className="dt-actions"><Hint>{tr('先连接机器人，再把它加入要接单的群。', 'Connect a bot and add it to the groups that will submit tasks.')}</Hint>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => navigate(managerRoute('feishu'))}>
            {tr('连接机器人', 'Connect bot')}</Button></div>}
      {!view.repositories.some(repo => repo.enabled) && <div className="dt-actions">
        <Hint>{tr('先添加至少一个可用的目标仓库。', 'Register at least one enabled target repository first.')}</Hint>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => navigate(managerRoute('repositories'))}>
          {tr('添加团队仓库', 'Register a team repository')}</Button>
      </div>}
    </Section>
    <Section title={tr('把群聊绑定到仓库', 'Bind a group to a repository')} hint={tr('一个群只能绑定一个仓库；一个仓库可以绑定多个群。',
      'A group binds to one repository; a repository may have several groups.')}>
      <form className="dt-form dt-block" onSubmit={event => { void save(event) }}>
        <Fields disabled={busy || !view.bot || !chats.length}>
          <Field label={tr('飞书群', 'Feishu group')}><select className="dt-select" required value={selectedChat}
            onChange={event => chooseChat(event.target.value)}><option value="">{tr('请选择', 'Choose')}</option>
            {chats.map(([id, name]) => <option key={id} value={id}>{name || id}</option>)}</select></Field>
          <Field label={tr('目标仓库', 'Target repository')}><select className="dt-select" required value={selectedRepo}
            onChange={event => { setSelectedRepo(event.target.value); setMemberIds([]); setSaved('') }}>
            <option value="">{tr('请选择', 'Choose')}</option>
            {view.repositories.filter(repo => repo.enabled).map(repo => <option key={repo.id} value={repo.id}>
              {[repo.teamName, repo.name].filter(Boolean).join(' · ')}</option>)}
          </select></Field>
        </Fields>
        {repository && <div className="dt-binding-preview"><Icon name="message" size={18} /><div>
          <strong>{knownChat ? view.chats[selectedChat] || selectedChat : tr('选择一个飞书群', 'Choose a Feishu group')}</strong>
          <span> → {repository.name}</span><p className="dt-hint">{[repository.teamName, ...(repository.productLines ?? [])].filter(Boolean).join(' · ') || repository.remote}</p>
          <p className="dt-hint">{repository.status.online ? tr('目标仓库运行中', 'The target repository is running')
            : tr('目标仓库尚未运行，保存绑定后需要启动服务。', 'The target repository is stopped. Start its service after saving the binding.')}</p>
        </div></div>}
        {knownChat && <Section title={tr('允许接单的群成员', 'Group members allowed to submit tasks')}>
          <Hint>{tr('只授权勾选的成员，已有的仓库授权会保留。可在「仓库设置」中撤销。',
            'Only selected members receive new access. Existing repository grants are kept and can be revoked in Repository settings.')}</Hint>
          {members?.length ? <fieldset className="dt-fieldset" disabled={busy || !repository}>
            <Input type="search" icon={<Icon name="search" />} aria-label={tr('搜索群成员', 'Search group members')}
              placeholder={tr('按姓名搜索成员', 'Search members by name')} value={memberSearch} onChange={event => setMemberSearch(event.target.value)} />
            <p className="dt-hint">{tr(`本次新增授权 ${memberIds.length} 人`, `${memberIds.length} new access grants selected`)}</p>
            <div className="dt-checks">{members.filter(member => !memberSearch.trim()
              || member.name.toLowerCase().includes(memberSearch.trim().toLowerCase())).map(member => {
              const alreadyAllowed = repository?.allowedFeishu.includes(member.member_id) ?? false
              return <label className="dt-check" key={member.member_id}>
                <input type="checkbox" checked={alreadyAllowed || memberIds.includes(member.member_id)} disabled={alreadyAllowed}
                  onChange={event => {
                    const { checked } = event.target
                    setMemberIds(ids => checked ? [...ids, member.member_id] : ids.filter(id => id !== member.member_id))
                  }} />
                {member.name || member.member_id}{alreadyAllowed && tr('（已授权）', ' (authorized)')}
              </label>
            })}</div>
          </fieldset> : members ? <Hint>{tr('这个群没有可授权的用户。', 'No eligible users were found in this group.')}</Hint>
            : <Button variant="outline" size="sm" disabled={busy} onClick={() => { void loadMembers(selectedChat) }}>
              {busy ? tr('正在读取群成员', 'Loading group members') : tr('读取群成员', 'Load group members')}
            </Button>}
          {repository && members && !hasRequester && <Hint>{tr('这个群还没有获得接单权限的成员。勾选至少一人后可从群里试单。',
            'Nobody in this group can submit tasks yet. Select at least one person to try a request from the group.')}</Hint>}
        </Section>}
        <p className="dt-hint">{tr('换绑只影响新话题，旧话题继续回到原仓库；有未送达消息或开放工单时不能换绑。',
          'Rebinding affects new topics only; old topics stay with their original repository. Queued messages or open tickets block rebinding.')}</p>
        <div className="dt-actions"><Button variant="primary" type="submit" disabled={busy || !view.bot || !knownChat || !repository}>
          {memberIds.length ? tr('保存绑定与授权', 'Save binding and access') : tr('保存绑定', 'Save binding')}</Button></div>
        {saved && <div className="dt-actions"><p className="dt-hint" role="status">{saved}</p>
          <Button variant="outline" size="sm" onClick={() => navigate(managerRoute('repositories'))}>
            {tr('回仓库管理启动服务', 'Return to repositories to start service')}</Button></div>}
      </form>
    </Section>
    <Section title={tr('当前绑定', 'Current bindings')} count={view.bindings.length}>
      {view.bindings.length ? <div className="dt-list dt-cards dt-binding-grid">{view.bindings.map(binding => <div className="dt-card" key={binding.chatId}>
        <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">{view.chats[binding.chatId] || binding.chatId}</div>
          <div className="dt-row-meta">→ {view.repositories.find(repository => repository.id === binding.repositoryId)?.name
            ?? binding.repositoryId}</div></div><Tag tone={binding.enabled ? 'success' : 'quiet'}>{binding.enabled
              ? tr('接单中', 'Enabled') : tr('已暂停', 'Paused')}</Tag>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void toggle(binding.chatId) }}>{binding.enabled
            ? tr('停用群接单与回复', 'Disable group intake and replies') : tr('恢复群接单与回复', 'Enable group intake and replies')}</Button>
        </div>
      </div>)}</div> : <Hint>{tr('还没有绑定。', 'No binding yet.')}</Hint>}
    </Section>
    <Hint>{tr('试单：启动目标仓库后，在绑定群中 @机器人并提出一个小需求。保存配置不会自动向群发消息。',
      'Try a task: start the repository, then mention the bot in its bound group with a small request. Saving configuration sends no group messages.')}</Hint>
  </>
}

function DeliveriesPage() {
  const { tr, view, busy, run, request, navigate } = useManager()
  const [tasks, setTasks] = useState<Record<string, { items?: TaskRow[]; error?: string }>>({})
  const health = Object.entries(view.health)
  const healthName = (name: string) => ({ feishu: tr('飞书消息接入', 'Feishu intake'), delivery: tr('消息投递', 'Message delivery'),
    github: tr('GitHub 接入', 'GitHub intake') })[name] ?? name
  const healthLabel = (state: string) => ({ ready: tr('正常', 'Ready'), ok: tr('正常', 'Ready'), paused: tr('已暂停', 'Paused'),
    error: tr('需要处理', 'Needs attention'), pending: tr('等待中', 'Pending'), starting: tr('启动中', 'Starting') })[state]
    ?? tr('待检查', 'Check required')
  const stageLabel = (stage: string | undefined) => ({ queued: tr('排队中', 'Queued'), running: tr('执行中', 'Running'),
    executing: tr('执行中', 'Running'), person: tr('等待人工处理', 'Needs a person'), delivered: tr('已交付', 'Delivered'),
    ended: tr('已结束', 'Ended') })[stage ?? ''] ?? stage ?? tr('进行中', 'In progress')
  const refreshTasks = () => run(async () => {
    const entries = await Promise.all(view.repositories.filter(repository => repository.status.online).map(async repository => {
      try { return [repository.id, await request<{ items: TaskRow[] }>(`repositories/${repository.id}/tasks`)] as const }
      catch (failure) { return [repository.id, { error: errorText(failure) }] as const }
    }))
    setTasks(Object.fromEntries(entries))
  })
  const pause = (repositoryId: string, paused: boolean) => run(() => request(`repositories/${repositoryId}/pause`, { paused }))
  const open = (repositoryId: string) => navigate({ page: 'execution', repo: repositoryId })
  return <>
    <div className="dt-manager-hero"><div><p className="dt-manager-eyebrow">{tr('运行中心', 'Operations')}</p>
      <h2>{tr('交付进度与运行状态', 'Delivery and service status')}</h2>
      <p>{tr('集中检查接单、任务和消息投递。暂停调度只影响新任务，进行中的工作继续执行。',
        'Monitor intake, tasks and delivery together. Pausing dispatch affects new work while active tasks continue.')}</p></div></div>
    <Section title={tr('系统状态', 'System health')} count={health.length}>
      {health.length ? <div className="dt-list dt-cards">{health.map(([name, value]) => <div className="dt-card" key={name}>
        <div className="dt-card-head"><div className="dt-row-title">{healthName(name)}</div>
          <Tag tone={tagTone(value.state)}>{healthLabel(value.state)}</Tag></div>
        <p className="dt-hint">{value.state === 'ready' || value.state === 'ok' ? tr('服务运行正常。', 'The service is ready.')
          : name === 'feishu' && value.state === 'paused' && !view.bindings.some(binding => binding.enabled)
            ? tr('尚未启用群绑定，飞书接单处于待命状态。', 'No group binding is enabled; Feishu intake is on standby.')
            : value.state === 'error' ? tr('检查连接或配置后，刷新状态重试。', 'Check the connection or configuration, then refresh status.')
              : tr('当前组件尚未开始处理请求。', 'This component is not currently processing requests.')}</p>
        {value.detail && <details className="dt-manager-checks"><summary>{tr('诊断详情', 'Diagnostic details')}</summary><p className="dt-hint dt-mono">{value.detail}</p></details>}
      </div>)}</div> : <Hint>{tr('尚未收到组件状态。', 'No component status has been reported yet.')}</Hint>}
    </Section>
    <Section title={tr('待投递消息', 'Queued deliveries')} count={view.queues?.total ?? view.pending.length}>
      <Hint>{tr(`${view.queues?.total ?? view.pending.length} 条消息待投递。离线消息保持原目标，不会转投。`,
        `${view.queues?.total ?? view.pending.length} queued messages. Offline messages keep their original destination.`)}</Hint>
      {view.queues && Object.keys(view.queues.byChat).length > 0 && <ul className="dt-list">{Object.entries(view.queues.byChat).map(([chat, count]) =>
        <li className="dt-row" key={chat}><div className="dt-row-main"><div className="dt-row-title">{view.chats[chat] || chat}</div></div>
          <span className="dt-row-meta">{count}</span></li>)}</ul>}
      {view.pending.filter(item => item.error || item.hold).map(item => <p key={item.id} role={item.error ? 'alert' : 'status'}
        className={item.error ? 'dt-error' : 'dt-hint'}>
        {view.repositories.find(repository => repository.id === item.repositoryId)?.name ?? item.repositoryId}: {item.error
          ?? tr(HOLD_TEXT[item.hold!]?.[0] ?? item.hold!, HOLD_TEXT[item.hold!]?.[1] ?? item.hold!)}
      </p>)}
    </Section>
    <Section title={tr('各仓库任务与调度', 'Repository tasks and dispatch')} action={<Button variant="outline" size="sm"
      icon={<Icon name="refresh" size={14} />} disabled={busy || !view.repositories.some(repository => repository.status.online)} onClick={() => { void refreshTasks() }}>{tr('刷新任务', 'Refresh tasks')}</Button>}
      hint={tr('任务列表按需读取；暂停只停止新调度，不停止正在运行的工单。', 'Task lists are read on demand; pausing stops new dispatch, not running tickets.')}>
      {view.repositories.map(repository => <div className="dt-card" key={repository.id}>
        <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">{repository.name}</div>
          <div className="dt-row-meta">{repository.status.online ? tr('运行中', 'Running') : tr('未运行', 'Stopped')}</div></div></div>
        <RepositoryMetadata repo={repository} />
        {!repository.status.online ? <Hint>{repository.starting ? tr('服务启动中，启动后可读取任务。', 'The service is starting; tasks become available when it is ready.')
          : tr('服务未运行，启动后可读取该仓库的任务。', 'The service is stopped. Start it to read repository tasks.')}</Hint>
          : tasks[repository.id]?.error ? <p className="dt-error" role="alert">{tasks[repository.id]?.error}</p>
          : tasks[repository.id]?.items ? tasks[repository.id]!.items!.length ? <ul className="dt-list">{tasks[repository.id]!.items!.map(task => <li className="dt-row" key={task.id}>
            <div className="dt-row-main"><div className="dt-row-title">{task.title}</div><div className="dt-row-meta">{stageLabel(task.stage)}</div></div>
          </li>)}</ul> : <Hint>{tr('当前没有开放任务。', 'There are no open tasks.')}</Hint>
          : <Hint>{tr('点击「刷新任务」读取该仓库的开放任务。', 'Select Refresh tasks to read open tasks for this repository.')}</Hint>}
        {repository.status.online && <div className="dt-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => open(repository.id)}>{tr('打开仓库工单', 'Open repository tickets')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void pause(repository.id, true) }}>{tr('暂停新调度', 'Pause dispatch')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void pause(repository.id, false) }}>{tr('恢复调度', 'Resume dispatch')}</Button>
        </div>}
      </div>)}
    </Section>
  </>
}

function FeishuPage() {
  const { tr, view, busy, run, request, navigate, error } = useManager()
  const [botCli, setBotCli] = useState('')
  const [editing, setEditing] = useState(!view.bot)
  const [saved, setSaved] = useState(false)
  const health = view.health.feishu
  const bound = view.bindings.filter(binding => binding.enabled).length
  const connect = async (event: FormEvent) => {
    event.preventDefault(); setSaved(false)
    const done = await run(() => request('bot', { cli: botCli.trim() }, 'PUT'))
    if (done) { setBotCli(''); setEditing(false); setSaved(true) }
  }
  return <>
    <div className="dt-manager-hero"><div><p className="dt-manager-eyebrow">{tr('共享集成', 'Shared integration')}</p>
      <h2>{tr('一个机器人，连接所有团队', 'One bot, every team')}</h2>
      <p>{tr('机器人连接在整个工作台共享，群聊按仓库独立路由，成员按权限提交任务。',
        'Share one bot across the workspace. Route each group to its repository and authorize requesters explicitly.')}</p></div></div>
    <Section title={tr('当前机器人', 'Current bot')}>
      {view.bot ? <div className="dt-connection-card"><span className="dt-connection-icon"><Icon name="message" size={26} /></span>
        <div className="dt-row-main"><h3>{view.bot.name || view.bot.id}</h3><p className="dt-hint">{tr('飞书机器人身份已验证', 'Feishu bot identity verified')}</p>
          <div className="dt-row-meta"><span>{tr(`${Object.keys(view.chats).length} 个已加入的群`, `${Object.keys(view.chats).length} joined groups`)}</span>
            <span>{tr(`${bound} 个已启用的群绑定`, `${bound} active group bindings`)}</span></div></div>
        <Tag tone="success">{tr('已连接', 'Connected')}</Tag></div>
        : <div className="dt-manager-empty"><Icon name="message" size={28} /><h3>{tr('连接飞书，让团队在群里交需求', 'Connect Feishu to receive requests in groups')}</h3>
          <p>{tr('GitHub 接单不依赖飞书。需要群聊协作时，在下方连接机器人。', 'GitHub intake works independently. Connect a bot below for group collaboration.')}</p></div>}
      {saved && <p className="dt-success-note" role="status">{tr('机器人连接已更新。', 'Bot connection updated.')}</p>}
      {view.bot && <>
        {health && <p className={health.state === 'error' ? 'dt-error' : 'dt-hint'} role={health.state === 'error' ? 'alert' : undefined}>
          {bound === 0 && health.state !== 'error' ? tr('连接已就绪。绑定研发群后开始接收需求。', 'Connected. Bind a development group to receive requests.') : health.detail}</p>}
        <div className="dt-actions"><Button variant="primary" disabled={busy} icon={<Icon name="plus" size={14} />}
          onClick={() => navigate(managerRoute('bindings'))}>{tr('继续绑定群聊', 'Continue to group bindings')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { setEditing(!editing); setBotCli(view.botCli); setSaved(false) }}>
            {editing ? tr('收起连接设置', 'Hide connection settings') : tr('修改机器人连接', 'Change bot connection')}</Button></div>
        <details className="dt-manager-checks"><summary>{tr('连接详情', 'Connection details')}</summary>
          <div className="dt-kv"><span>{tr('机器人标识', 'Bot ID')}</span><code>{view.bot.id}</code>
            <span>{tr('执行命令', 'CLI command')}</span><code>{view.botCli}</code></div></details>
      </>}
    </Section>
    {editing && <Section title={view.bot ? tr('修改机器人连接', 'Change bot connection') : tr('连接飞书机器人', 'Connect the Feishu bot')}>
      <form className="dt-form dt-block" onSubmit={event => { void connect(event) }}>
        <p className="dt-hint">{tr('填写已登录的机器人 CLI。连接时验证机器人身份，验证成功才会保存。',
          'Enter a signed-in bot CLI. The connection is saved only after its bot identity is verified.')}</p>
        <Fields disabled={busy}><Field label={tr('机器人 CLI 路径或命令', 'Bot CLI path or command')} note={tr(
          '该命令必须仅使用机器人身份，不使用个人身份发送消息。', 'The command must act as the bot, without sending as a personal account.')}>
          <Input required value={botCli} onChange={event => setBotCli(event.target.value)} placeholder="lark-bot" /></Field></Fields>
        <div className="dt-actions"><Button variant="primary" type="submit" disabled={busy || !botCli.trim()}>
          {busy ? tr('正在验证连接…', 'Verifying connection…') : tr('检查并连接', 'Verify and connect')}</Button>
          {view.bot && <Button disabled={busy} onClick={() => setEditing(false)}>{tr('取消', 'Cancel')}</Button>}</div>
        {error && <p className="dt-error" role="alert">{error}</p>}
      </form>
    </Section>}
    <Section title={tr('接下来', 'Next steps')}><ol className="dt-manager-next">
      <li>{tr('将上方机器人加入需要接单的飞书群。', 'Add the bot above to your development groups.')}</li>
      <li>{tr('打开「群聊绑定」，刷新群列表并指定目标仓库和成员。', 'Open Group bindings, refresh groups, and choose the repository and members.')}</li>
      <li>{tr('启动仓库服务后，已授权的成员在群中 @机器人提交需求。', 'Start the repository service. Authorized members can then mention the bot with a request.')}</li>
    </ol></Section>
  </>
}

/** Fetches the deployment mode once; manager mode replaces the standalone panel with the manager's control plane. */
export function ModePanel({ t, children, modeAction }: { t: T; children: ReactNode; modeAction?: ManagerModeAction }) {
  const { mode, error } = usePanelMode()
  if (error) return <p role="alert">{error}</p>
  if (!mode) return <p role="status">{t('loading')}</p>
  return mode === 'manager' ? <ManagerPanel t={t} modeAction={modeAction} /> : <>{children}</>
}
