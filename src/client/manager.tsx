/**
 * Manager control plane inside the unified panel: repositories, group bindings, deliveries and the Feishu bot use the same
 * left rail and detail column as a standalone deployment. Selecting a repository opens that repository's own panel areas,
 * whose API calls the manager forwards to the isolated instance with the credential the browser never sees.
 */
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { usePoll } from './api.ts'
import { usePanelMode } from './mode.ts'
import { Content, Header, NavRail, Rail, ShellFrame, titleOf, type NavGroup } from './app.tsx'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { MANAGER_HOME, initialLocation, lastSettingsGroup, remember, routeLabel, type Location, type ManagerArea, type RepoRoute,
  type Route } from './route.ts'
import { Field, Fields } from './settings-kit.tsx'
import { errorText, type T } from './text.ts'
import { Hint, Section } from './widgets.tsx'
import type { Repository, Binding } from '../manager/store.ts'
import type { DshSuperagentKey } from './locales.ts'
import STYLES from './client.css?raw'

interface ReadinessItem { state: string; detail?: string; repair?: string }
type DeliveryReadiness = ReadinessItem & { pending: number; byChat: Record<string, number> }
interface RepositoryReadiness { instance: ReadinessItem; repository: ReadinessItem; agent: ReadinessItem; feishu: ReadinessItem
  delivery: DeliveryReadiness }
export interface RepositoryView extends Omit<Repository, 'token'> {
  status: { online: boolean; configured?: boolean; error?: string }; starting: boolean; url: string
  pending?: { total: number; byChat: Record<string, number> }
  readiness?: RepositoryReadiness
}
export interface ManagerView {
  revision: number; bot: { name?: string; id: string } | null; botCli: string; workspaces: string[]
  repositories: RepositoryView[]; bindings: Binding[]; chats: Record<string, string>
  health: Record<string, { state: string; detail: string }>
  pending: { id: string; repositoryId: string; chatId?: string; error?: string; hold?: string }[]
  queues?: { total: number; byRepository: Record<string, number>; byChat: Record<string, number> }
}
interface TaskRow { id: string; title: string; stage?: string }
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
/** One same-origin manager request; its `x-orchestrator-request` header is what the loopback guard checks. */
async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/orchestrator/manager/${path}`, { method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) })
  const value = await response.json() as T & { error?: string }
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
const tagTone = (state: string): 'success' | 'warning' | 'danger' | 'quiet' => state === 'ok' ? 'success' : state === 'pending'
  ? 'warning' : state === 'error' ? 'danger' : 'quiet'

/** Control groups listed above the selected repository's own work areas in the same rail. */
function managerGroups(view: ManagerView, repoId: string | undefined, area: ManagerArea | undefined,
  navigate: (route: Route, replace?: boolean) => void, tr: (zh: string, en: string) => string, t: T): NavGroup[] {
  const target = (value: ManagerArea) => ({ page: 'manager', query: { area: value } } as const)
  return [
    { title: t('manager.control'), items: [
      { key: 'repositories', label: t('manager.manageRepositories'), icon: 'hash', active: area === 'repositories',
        count: view.repositories.length, onSelect: () => navigate(target('repositories')) },
      { key: 'deliveries', label: t('manager.deliveries'), icon: 'queue', active: area === 'deliveries', count: view.queues?.total,
        onSelect: () => navigate(target('deliveries')) },
      { key: 'bindings', label: t('manager.bindings'), icon: 'message', active: area === 'bindings',
        count: view.bindings.filter(binding => binding.enabled).length, onSelect: () => navigate(target('bindings')) },
      { key: 'bot', label: t('manager.bot'), icon: 'user', active: area === 'feishu', dot: view.bot ? 'done' : 'warning',
        onSelect: () => navigate(target('feishu')) },
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
function ManagerControlShell({ location, manager }: { location: Location; manager: ManagerApi }) {
  const area = location.route.page === 'manager' ? location.route.query.area : 'repositories'
  const groups = managerGroups(manager.view, undefined, area, manager.navigate, manager.tr, manager.t)
  return <ShellFrame rail={<NavRail brand={{ name: manager.t('panel'), subtitle: manager.tr('管理', 'Manager') }} groups={groups}
    label={manager.t('pagesLabel')} />}>
    <style>{STYLES}</style>
    <header className="dt-head">
      <h1 className="dt-title">{manager.t(MANAGER_LABEL[area])}</h1>
      <div className="dt-toolbar"><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} disabled={manager.busy}
        onClick={() => { void manager.reload() }}>{manager.t('manager.refresh')}</Button></div>
    </header>
    {manager.stateError && <p className="dt-error" role="status">{manager.stateError}</p>}
    {manager.error && <p className="dt-error" role="alert">{manager.error}</p>}
    <Manager.Provider value={manager}><ManagerPage area={area} /></Manager.Provider>
  </ShellFrame>
}

function ManagerPage({ area }: { area: ManagerArea }) {
  switch (area) {
    case 'repositories': return <RepositoriesPage />
    case 'deliveries': return <DeliveriesPage />
    case 'bindings': return <BindingsPage />
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
    subtitle={repo.name} />}>
    <Header title={titleOf(t, route)} masterId={state?.masterId} />
    {manager.stateError && <p className="dt-error" role="status">{manager.stateError}</p>}
    {manager.error && <p className="dt-error" role="alert">{manager.error}</p>}
    {error && state && <p className="dt-error" role="status">{error.message}</p>}
    <Content route={route} deploymentForm={undefined} />
  </ShellFrame>
}

/** Manager mode: the control plane and each registered repository's panel, in one product shell. */
export function ManagerPanel({ t }: { t: T }) {
  const { data: view, error, reload } = usePoll(() => request<ManagerView>('state'), [], 10_000)
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
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true); setActionError('')
    try { await work(); await reload(); return true }
    catch (failure) { setActionError(errorText(failure)); return false }
    finally { setBusy(false) }
  }, [reload])
  const tr = useCallback((zh: string, en: string) => t('yes') === 'Yes' ? en : zh, [t])
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
  }, [])
  if (!view) return <ShellFrame rail={<NavRail brand={{ name: t('panel'), subtitle: tr('管理', 'Manager') }} groups={[]}
    label={t('pagesLabel')} />}>
    <style>{STYLES}</style>
    <header className="dt-head"><h1 className="dt-title">{t('manager.manageRepositories')}</h1></header>
    <p className={error ? 'dt-error' : 'dt-hint'} role={error ? 'alert' : undefined}>{error ? errorText(error) : t('loading')}</p>
  </ShellFrame>
  const manager: ManagerApi = { t, tr, view, busy, error: actionError, stateError: error ? errorText(error) : '', navigate, run, reload }
  if (location.route.page === 'manager') return <ManagerControlShell location={location} manager={manager} />
  if (!repo) return <ShellFrame rail={<NavRail brand={{ name: t('panel'), subtitle: tr('管理', 'Manager') }} groups={[]}
    label={t('pagesLabel')} />}>
    <style>{STYLES}</style>
    <header className="dt-head"><h1 className="dt-title">{t('manager.manageRepositories')}</h1></header>
    <p className="dt-hint">{t('loading')}</p>
  </ShellFrame>
  return <PanelProvider key={repo.id} t={t} apiBase={`/orchestrator/manager/repositories/${encodeURIComponent(repo.id)}/api/`}
    remote openSession={() => openWorkspace(repo)} navigate={navigate} back={back}
    backLabel={routeLabel(t, location.stack.at(-1) ?? MANAGER_HOME)}>
    <ManagerRepoShell location={location} route={location.route} repo={repo} manager={manager} />
  </PanelProvider>
}

function RepositoryCard({ repo, onEdit }: { repo: RepositoryView; onEdit: (repo: RepositoryView) => void }) {
  const { t, tr, busy, run } = useManager()
  const dimensions = repo.readiness ? DIMENSIONS.map(([key, zh, en]) => ({ key, label: tr(zh, en), item: repo.readiness![key] }))
    .filter(row => row.item.state !== 'ok') : []
  const start = (repository: RepositoryView, online: boolean) => run(() => request(`repositories/${repository.id}/${online
    ? 'stop' : 'start'}`, {}))
  const open = (repository: RepositoryView) => run(async () => {
    const launch = await request<{ url: string }>(`repositories/${repository.id}/open`, {})
    window.open(launch.url, '_blank', 'noopener,noreferrer')
  })
  return <div className="dt-card">
    <div className="dt-card-head">
      <div className="dt-row-main"><div className="dt-row-title">{repo.name}</div>
        <div className="dt-row-meta">{repo.remote} · {repo.directory}</div></div>
      <Tag tone={!repo.status.online ? 'quiet' : repo.status.configured === true ? 'success' : 'warning'}>
        {repo.starting ? tr('启动中', 'Starting') : repo.status.online ? repo.status.configured === true ? tr('已就绪', 'Ready')
          : tr('需要完成设置', 'Setup needed') : tr('未运行', 'Stopped')}</Tag>
    </div>
    {repo.status.error && <p className="dt-error" role="alert">{repo.status.error}</p>}
    {dimensions.length > 0 && <ul className="dt-list">{dimensions.map(row => <li className="dt-row" key={row.key}>
      <div className="dt-row-main"><div className="dt-row-title">{row.label}</div>
        <div className="dt-row-meta">{row.item.detail}{row.item.repair ? ` · ${tr('修复', 'fix')}: ${row.item.repair}` : ''}</div></div>
      <Tag tone={tagTone(row.item.state)}>{row.item.state}</Tag>
    </li>)}</ul>}
    {!!repo.pending?.total && <p className="dt-hint">{tr(`${repo.pending.total} 条待投递`, `${repo.pending.total} queued`)}</p>}
    <div className="dt-actions">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void start(repo, repo.status.online) }}>
        {repo.status.online ? tr('停止服务', 'Stop service') : tr('启动服务', 'Start service')}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onEdit(repo)}>{tr('编辑接单权限', 'Edit access')}</Button>
      {repo.status.online && <Button variant="ghost" size="sm" icon={<Icon name="external" size={14} />} disabled={busy}
        onClick={() => { void open(repo) }}>{t('manager.openWorkspace')}</Button>}
    </div>
  </div>
}

function RepositoriesPage() {
  const { t, tr, view, busy, run } = useManager()
  const [editingId, setEditingId] = useState('')
  const [form, setForm] = useState({ name: '', directory: '', remote: '', githubCli: '', allowedGithub: '', allowedFeishu: '' })
  const [memberChat, setMemberChat] = useState('')
  const [members, setMembers] = useState<{ member_id: string; name: string }[]>([])
  const ids = (value: string) => value.split(/[\s,]+/).filter(Boolean)
  const reset = () => {
    setEditingId(''); setMemberChat(''); setMembers([])
    setForm({ name: '', directory: '', remote: '', githubCli: '', allowedGithub: '', allowedFeishu: '' })
  }
  const edit = (repo: RepositoryView) => {
    setEditingId(repo.id); setMemberChat(''); setMembers([])
    setForm({ name: repo.name, directory: repo.directory, remote: repo.remote, githubCli: repo.githubCli,
      allowedGithub: repo.allowedGithub.join(' '), allowedFeishu: repo.allowedFeishu.join(' ') })
  }
  const loadMembers = async (chat: string) => {
    setMemberChat(chat); setMembers([])
    if (chat) await run(async () => {
      const result = await request<{ users: { member_id: string; name: string }[] }>(`chats/${encodeURIComponent(chat)}/members`)
      setMembers(result.users)
    })
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const done = await run(() => request(editingId ? `repositories/${editingId}` : 'repositories', { ...form, revision: view.revision,
      allowedGithub: ids(form.allowedGithub), allowedFeishu: ids(form.allowedFeishu), enabled: true }, editingId ? 'PUT' : 'POST'))
    if (done) reset()
  }
  return <>
    <Hint>{tr('一个群对应一个仓库。任务与追问会回到对应仓库的执行会话；这里的仓库会出现在左侧列表，选中后即可管理它的全部面板。',
      'Each group belongs to one repository. Tasks and follow-ups return to that repository, and each repository listed on the left opens its full panel.')}</Hint>
    <Section title={editingId ? tr('编辑接单权限', 'Edit access settings') : tr('添加本地仓库', 'Add a local checkout')}
      hint={tr('保存时检查目录、远端和推送权限；已有工单或修改不会被自动清理。', 'Saving checks the checkout, remote and push access; existing work and changes are never cleaned automatically.')}>
      <form className="dt-form dt-block" onSubmit={event => { void submit(event) }}>
        <Fields disabled={busy}>
          <Field label={tr('名称', 'Name')}><Input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label={tr('本地仓库根目录', 'Local repository root')} hint={tr('绝对路径；保存时检查 Git 远端。', 'An absolute path; the Git remote is checked on save.')}>
            <Input required value={form.directory} disabled={!!editingId} list="dt-manager-workspaces"
              onChange={event => setForm({ ...form, directory: event.target.value })} placeholder="/projects/my-repo" />
          </Field>
          <datalist id="dt-manager-workspaces">{view.workspaces.map(path => <option key={path} value={path} />)}</datalist>
          <Field label={tr('GitHub 仓库', 'GitHub repository')}><Input required value={form.remote} disabled={!!editingId}
            onChange={event => setForm({ ...form, remote: event.target.value })} placeholder="owner/repository" /></Field>
          <Field label={tr('执行账号的 GitHub CLI', 'Agent GitHub CLI')}><Input required value={form.githubCli} disabled={!!editingId}
            onChange={event => setForm({ ...form, githubCli: event.target.value })} placeholder="gh-agent" /></Field>
          <Field label={tr('允许接单的 GitHub 用户名，以空格分隔', 'Allowed GitHub usernames, separated by spaces')}>
            <Input value={form.allowedGithub} onChange={event => setForm({ ...form, allowedGithub: event.target.value })} />
          </Field>
          <Field label={tr('选择群以读取成员', 'Choose a group to load members')} hint={tr('先连接机器人并刷新群列表。', 'Connect the bot and refresh its groups first.')}>
            <select className="dt-select" value={memberChat} onChange={event => { void loadMembers(event.target.value) }}>
              <option value="">{tr('请选择', 'Choose')}</option>
              {Object.entries(view.chats).map(([id, name]) => <option key={id} value={id}>{name || id}</option>)}
            </select>
          </Field>
        </Fields>
        {members.length > 0 && <div className="dt-checks">{members.map(member => <label className="dt-check" key={member.member_id}>
          <input type="checkbox" checked={ids(form.allowedFeishu).includes(member.member_id)} onChange={event => {
            const selected = ids(form.allowedFeishu).filter(id => id !== member.member_id)
            if (event.target.checked) selected.push(member.member_id)
            setForm({ ...form, allowedFeishu: selected.join(' ') })
          }} /> {member.name}</label>)}</div>}
        <p className="dt-hint">{tr(`已选 ${ids(form.allowedFeishu).length} 名飞书接单人。未选择成员时，飞书消息不会获准开始新任务。`,
          `${ids(form.allowedFeishu).length} Feishu requesters selected. Without allowed members, Feishu cannot start new tasks.`)}</p>
        <p className="dt-hint">{tr('工作方式：当前仓库，串行执行。已有修改不会被自动清理。', 'Work mode: current checkout, serial execution. Existing changes are preserved.')}</p>
        <div className="dt-actions">
          <Button variant="primary" type="submit" disabled={busy}>{editingId ? tr('保存接单权限', 'Save access settings')
            : tr('检查并添加仓库', 'Verify and add repository')}</Button>
          {editingId && <Button variant="ghost" disabled={busy} onClick={reset}>{tr('取消编辑', 'Cancel edit')}</Button>}
        </div>
      </form>
    </Section>
    <Section title={tr('已添加的仓库', 'Registered repositories')} count={view.repositories.length}>
      {view.repositories.length ? <div className="dt-list dt-cards">{view.repositories.map(repo => <RepositoryCard key={repo.id}
        repo={repo} onEdit={edit} />)}</div> : <Hint>{tr('还没有仓库。先连接机器人，再添加一个本地仓库。', 'No repository yet. Connect the bot, then add a local checkout.')}</Hint>}
    </Section>
    <Hint>{t('manager.repositoriesHint')}</Hint>
  </>
}

function BindingsPage() {
  const { tr, view, busy, run } = useManager()
  const [selectedChat, setSelectedChat] = useState('')
  const [selectedRepo, setSelectedRepo] = useState('')
  const refresh = () => run(() => request('chats/refresh', {}))
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedChat || !selectedRepo) return
    const bindings = view.bindings.filter(item => item.chatId !== selectedChat).map(({ effectiveAt, ...binding }) => binding)
    bindings.push({ chatId: selectedChat, repositoryId: selectedRepo, enabled: true })
    const done = await run(() => request('bindings', { revision: view.revision, bindings }, 'PUT'))
    if (done) { setSelectedChat(''); setSelectedRepo('') }
  }
  const toggle = (chatId: string) => run(() => request('bindings', { revision: view.revision,
    bindings: view.bindings.map(({ effectiveAt, ...item }) => item.chatId === chatId ? { ...item, enabled: !item.enabled } : item) }, 'PUT'))
  return <>
    <Section title={tr('机器人已加入的群', 'Groups the bot has joined')} action={<Button variant="outline" size="sm"
      icon={<Icon name="refresh" size={14} />} disabled={busy || !view.bot} onClick={() => { void refresh() }}>
      {tr('刷新群列表', 'Refresh groups')}</Button>} hint={tr('只接收 @机器人的新需求；群停用后暂停接单与自动回复，队列保留。',
      'Only new requests mentioning the bot are accepted. Disabling a group pauses intake and replies but keeps its queue.')}>
      <Hint>{view.bot ? tr(`当前机器人：${view.bot.name || view.bot.id}`, `Bot: ${view.bot.name || view.bot.id}`)
        : tr('先连接一个仅使用机器人身份的飞书 CLI。', 'Connect a bot-only Feishu CLI first.')}</Hint>
    </Section>
    <Section title={tr('把群聊绑定到仓库', 'Bind a group to a repository')} hint={tr('一个群只能绑定一个仓库；一个仓库可以绑定多个群。',
      'A group binds to one repository; a repository may have several groups.')}>
      <form className="dt-form dt-block" onSubmit={event => { void save(event) }}>
        <Fields disabled={busy}>
          <Field label={tr('飞书群', 'Feishu group')}><select className="dt-select" required value={selectedChat}
            onChange={event => setSelectedChat(event.target.value)}><option value="">{tr('请选择', 'Choose')}</option>
            {Object.entries(view.chats).map(([id, name]) => <option key={id} value={id}>{name || id}</option>)}</select></Field>
          <Field label={tr('目标仓库', 'Target repository')}><select className="dt-select" required value={selectedRepo}
            onChange={event => setSelectedRepo(event.target.value)}><option value="">{tr('请选择', 'Choose')}</option>
            {view.repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select></Field>
        </Fields>
        <p className="dt-hint">{tr('换绑只影响新话题，旧话题继续回到原仓库；有未送达消息或开放工单时不能换绑。',
          'Rebinding affects new topics only; old topics stay with their original repository. Queued messages or open tickets block rebinding.')}</p>
        <div className="dt-actions"><Button variant="primary" type="submit" disabled={busy || !selectedChat || !selectedRepo}>
          {tr('保存绑定', 'Save binding')}</Button></div>
      </form>
    </Section>
    <Section title={tr('当前绑定', 'Current bindings')} count={view.bindings.length}>
      {view.bindings.length ? <div className="dt-list dt-cards">{view.bindings.map(binding => <div className="dt-card" key={binding.chatId}>
        <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">{view.chats[binding.chatId] || binding.chatId}</div>
          <div className="dt-row-meta">→ {view.repositories.find(repository => repository.id === binding.repositoryId)?.name
            ?? binding.repositoryId}</div></div>
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
  const { t, tr, view, busy, run } = useManager()
  const [tasks, setTasks] = useState<Record<string, { items?: TaskRow[]; error?: string }>>({})
  const health = Object.entries(view.health).filter(([, value]) => value.state !== 'ready')
  const refreshTasks = () => run(async () => {
    const entries = await Promise.all(view.repositories.map(async repository => {
      try { return [repository.id, await request<{ items: TaskRow[] }>(`repositories/${repository.id}/tasks`)] as const }
      catch (failure) { return [repository.id, { error: errorText(failure) }] as const }
    }))
    setTasks(Object.fromEntries(entries))
  })
  const pause = (repositoryId: string, paused: boolean) => run(() => request(`repositories/${repositoryId}/pause`, { paused }))
  const open = (repositoryId: string) => run(async () => {
    const launch = await request<{ url: string }>(`repositories/${repositoryId}/open`, {})
    window.open(launch.url, '_blank', 'noopener,noreferrer')
  })
  return <>
    <Section title={tr('系统状态', 'System health')} count={health.length}>
      {health.length ? <div className="dt-list dt-cards">{health.map(([name, value]) => <div className="dt-card" key={name}>
        <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">{name}</div>
          <div className="dt-row-meta">{value.detail}</div></div><Tag tone={tagTone(value.state)}>{value.state}</Tag></div>
      </div>)}</div> : <Hint>{tr('所有组件正常。', 'All components are ready.')}</Hint>}
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
      icon={<Icon name="refresh" size={14} />} disabled={busy} onClick={() => { void refreshTasks() }}>{t('manager.refresh')}</Button>}
      hint={tr('任务列表按需读取；暂停只停止新调度，不停止正在运行的工单。', 'Task lists are read on demand; pausing stops new dispatch, not running tickets.')}>
      {view.repositories.map(repository => <div className="dt-card" key={repository.id}>
        <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">{repository.name}</div>
          <div className="dt-row-meta">{repository.status.online ? tr('运行中', 'Running') : tr('未运行', 'Stopped')}</div></div></div>
        {tasks[repository.id]?.error && <p className="dt-error" role="alert">{tasks[repository.id]?.error}</p>}
        {tasks[repository.id]?.items?.length ? <ul className="dt-list">{tasks[repository.id]!.items!.map(task => <li className="dt-row" key={task.id}>
          <div className="dt-row-main"><div className="dt-row-title">{task.title}</div><div className="dt-row-meta">{task.stage ?? ''}</div></div>
        </li>)}</ul> : <Hint>{tr('刷新以读取该仓库的开放任务。', 'Refresh to read this repository\'s open tickets.')}</Hint>}
        {repository.status.online && <div className="dt-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void open(repository.id) }}>{tr('打开详情、回答问题或重试',
            'Open details, answer or retry')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void pause(repository.id, true) }}>{tr('暂停新调度', 'Pause dispatch')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void pause(repository.id, false) }}>{tr('恢复调度', 'Resume dispatch')}</Button>
        </div>}
      </div>)}
    </Section>
  </>
}

function FeishuPage() {
  const { tr, view, busy, run } = useManager()
  const [botCli, setBotCli] = useState('')
  const health = view.health.feishu
  const connect = async (event: FormEvent) => {
    event.preventDefault()
    const done = await run(() => request('bot', { cli: botCli }, 'PUT'))
    if (done) setBotCli('')
  }
  return <>
    <Section title={tr('当前机器人', 'Current bot')} hint={tr('供应商只允许机器人身份；状态会随下一次检查更新。',
      'The CLI must use only the bot identity; its state updates on the next check.')}>
      {view.bot ? <div className="dt-card"><div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">
        {view.bot.name || view.bot.id}</div><div className="dt-row-meta">{view.bot.id}{view.botCli ? ` · ${view.botCli}` : ''}</div></div>
        <Tag tone="success">{tr('已连接', 'Connected')}</Tag></div>{health && <p className="dt-hint">{health.detail}</p>}</div>
        : <Hint>{tr('还没有连接机器人；仓库仍可通过 GitHub 交付。', 'No bot is connected; repositories can still deliver through GitHub.')}</Hint>}
    </Section>
    <Section title={tr('连接飞书机器人', 'Connect the Feishu bot')} hint={tr('CLI 必须已完成登录，并且只使用机器人身份。',
      'The CLI must be signed in and allowed to act only as the bot.')}>
      <form className="dt-form dt-block" onSubmit={event => { void connect(event) }}>
        <Fields disabled={busy}><Field label={tr('机器人 CLI 路径或命令', 'Bot CLI path or command')}>
          <Input required value={botCli} onChange={event => setBotCli(event.target.value)} placeholder="lark-bot" /></Field></Fields>
        <div className="dt-actions"><Button variant="primary" type="submit" disabled={busy}>{tr('检查并连接', 'Verify and connect')}</Button></div>
      </form>
    </Section>
    <Hint>{tr('管理入口重启不会停止仓库实例；实例只在点击启动时启动。', 'Restarting the manager does not stop repository instances; an instance starts only when you choose Start.')}</Hint>
  </>
}

/** Fetches the deployment mode once; manager mode replaces the standalone panel with the manager's control plane. */
export function ModePanel({ t, children }: { t: T; children: ReactNode }) {
  const { mode, error } = usePanelMode()
  if (error) return <p role="alert">{error}</p>
  if (!mode) return <p role="status">{t('loading')}</p>
  return mode === 'manager' ? <ManagerPanel t={t} /> : <>{children}</>
}
