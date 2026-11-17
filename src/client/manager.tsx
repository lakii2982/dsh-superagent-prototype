/** Unified repository and Feishu group setup, deliberately separate from the single-repository detail panel. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input, SegmentedTabs } from './controls.tsx'
import type { T } from './text.ts'
import type { Repository, Binding } from '../manager/store.ts'
import STYLES from './client.css?raw'

interface RepositoryView extends Omit<Repository, 'token'> { status: { online: boolean; configured?: boolean; error?: string }; starting: boolean; url: string }
interface ManagerView {
  revision: number; bot: { name?: string; id: string } | null; botCli: string; workspaces: string[]
  repositories: RepositoryView[]; bindings: Binding[]; chats: Record<string, string>
  health: Record<string, { state: string; detail: string }>; pending: { id: string; repositoryId: string; error?: string }[]
}
async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/orchestrator/manager/${path}`, { method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) })
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`)
  return value
}
export function ModePanel({ t, children }: { t: T; children: ReactNode }) {
  const [mode, setMode] = useState<string>(), [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/orchestrator/mode', { signal: abort.signal }).then(async response => {
      if (response.status === 404) { setMode('standalone'); return }
      if (!response.ok) throw new Error(t('requestFailed', { status: response.status }))
      const value = await response.json() as { mode: string }; setMode(value.mode)
    }).catch(error => { if (!abort.signal.aborted) setError(String(error)) })
    return () => { abort.abort() }
  }, [t])
  if (error) return <p role="alert">{error}</p>
  if (!mode) return <p role="status">{t('loading')}</p>
  return mode === 'manager' ? <ManagerPanel t={t} /> : <>{children}</>
}

export function ManagerPanel({ t }: { t: T }) {
  const english = t('yes') === 'Yes', tr = (zh: string, en: string) => english ? en : zh
  const [state, setState] = useState<ManagerView>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'repositories' | 'bindings' | 'tasks'>('repositories')
  const [botCli, setBotCli] = useState(''), [repo, setRepo] = useState({ name: '', directory: '', remote: '', githubCli: '', allowedGithub: '', allowedFeishu: '' })
  const [selectedChat, setSelectedChat] = useState(''), [selectedRepo, setSelectedRepo] = useState('')
  const [editingId, setEditingId] = useState('')
  const [members, setMembers] = useState<{ member_id: string; name: string }[]>([]), [memberChat, setMemberChat] = useState('')
  const [tasks, setTasks] = useState<Record<string, { items?: { id: string; title: string; stage?: string }[]; error?: string }>>({})
  const refresh = useCallback(async () => { setState(await request<ManagerView>('state')) }, [])
  useEffect(() => {
    let active = true
    const poll = async () => { try { const value = await request<ManagerView>('state'); if (active) setState(value) } catch (error) { if (active) setError(String(error)) } }
    void poll(); const timer = setInterval(() => { void poll() }, 10000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work(); await refresh() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const submit = (event: FormEvent, work: () => Promise<void>) => { event.preventDefault(); void run(work) }
  const ids = (value: string) => value.split(/[\s,]+/).filter(Boolean)
  if (!state) return <p role={error ? 'alert' : 'status'}>{error || t('loading')}</p>
  return <div className="dt-root dt-manager">
    <style>{STYLES}</style>
    <style>{`.dt-manager{padding:24px;max-width:1100px;margin:auto}.dt-manager h2{margin-top:24px}.dt-manager label{display:grid;gap:6px;margin:12px 0}.dt-manager select{padding:8px;max-width:100%}.dt-manager table{width:100%;border-collapse:collapse}.dt-manager td,.dt-manager th{padding:10px;text-align:left;border-bottom:1px solid #8883}.dt-manager fieldset{border:1px solid #8884;border-radius:10px;padding:16px;margin-top:16px}.dt-manager .dt-manager-actions{display:flex;gap:8px;flex-wrap:wrap}.dt-manager [role=alert]{white-space:pre-wrap}`}</style>
    <h1>{tr('仓库与飞书群', 'Repositories and Feishu groups')}</h1>
    <p>{tr('一个群对应一个仓库。任务与追问会回到对应仓库的执行会话。', 'Each group belongs to one repository. Tasks and follow-ups return to its repository sessions.')}</p>
    {error && <p className="dt-error" role="alert">{error}</p>}
    <SegmentedTabs label={tr('管理页面', 'Manager pages')} value={tab} onChange={setTab}
      items={[{ value: 'repositories', id: 'manager-tab-repositories', panelId: 'manager-panel-repositories', label: tr('仓库', 'Repositories') }, { value: 'bindings', id: 'manager-tab-bindings', panelId: 'manager-panel-bindings', label: tr('群聊绑定', 'Group bindings') }, { value: 'tasks', id: 'manager-tab-tasks', panelId: 'manager-panel-tasks', label: tr('任务与状态', 'Tasks and status') }]} />
    <div role="tabpanel" id={`manager-panel-${tab}`} aria-labelledby={`manager-tab-${tab}`}>
    {tab === 'repositories' && <>
      <form onSubmit={event => submit(event, async () => { await request('bot', { cli: botCli }, 'PUT'); setBotCli('') })}>
        <fieldset disabled={busy}><legend>{tr('1. 连接飞书机器人', '1. Connect the Feishu bot')}</legend>
          <p>{state.bot ? `${state.bot.name || state.bot.id} · ${state.botCli}` : tr('先连接已完成登录、仅使用机器人身份的飞书 CLI。', 'Connect an authenticated bot-only Feishu CLI first.')}</p>
          <label>{tr('机器人 CLI 路径或命令', 'Bot CLI path or command')}<Input required value={botCli} onChange={event => setBotCli(event.target.value)} placeholder="lark-bot" /></label>
          <Button type="submit">{tr('检查并连接', 'Verify and connect')}</Button>
        </fieldset>
      </form>
      <form onSubmit={event => submit(event, async () => {
        await request(editingId ? `repositories/${editingId}` : 'repositories', { ...repo, revision: state.revision, allowedGithub: ids(repo.allowedGithub), allowedFeishu: ids(repo.allowedFeishu), enabled: true }, editingId ? 'PUT' : 'POST')
        setEditingId('')
        setRepo({ name: '', directory: '', remote: '', githubCli: '', allowedGithub: '', allowedFeishu: '' })
      })}>
        <fieldset disabled={busy}><legend>{tr('2. 添加本地仓库', '2. Add a local checkout')}</legend>
          <label>{tr('名称', 'Name')}<Input required value={repo.name} onChange={event => setRepo({ ...repo, name: event.target.value })} /></label>
          <label>{tr('本地仓库根目录', 'Local repository root')}<Input required list="dt-manager-workspaces" value={repo.directory} disabled={!!editingId} onChange={event => setRepo({ ...repo, directory: event.target.value })} placeholder="/projects/my-repo" /></label>
          <datalist id="dt-manager-workspaces">{state.workspaces.map(path => <option key={path} value={path} />)}</datalist>
          <label>{tr('GitHub 仓库', 'GitHub repository')}<Input required value={repo.remote} disabled={!!editingId} onChange={event => setRepo({ ...repo, remote: event.target.value })} placeholder="owner/repository" /></label>
          <label>{tr('执行账号的 GitHub CLI', 'Agent GitHub CLI')}<Input required value={repo.githubCli} disabled={!!editingId} onChange={event => setRepo({ ...repo, githubCli: event.target.value })} placeholder="gh-agent" /></label>
          <label>{tr('允许接单的 GitHub 用户名，以空格分隔', 'Allowed GitHub usernames, separated by spaces')}<Input value={repo.allowedGithub} onChange={event => setRepo({ ...repo, allowedGithub: event.target.value })} /></label>
          <label>{tr('选择群以读取成员', 'Choose a group to load members')}<select value={memberChat} onChange={event => {
            const chat = event.target.value; setMemberChat(chat); setMembers([])
            if (chat) void run(async () => { const result = await request<{ users: { member_id: string; name: string }[] }>(`chats/${encodeURIComponent(chat)}/members`); setMembers(result.users) })
          }}><option value="">{tr('请选择', 'Choose')}</option>{Object.entries(state.chats).map(([id, name]) => <option key={id} value={id}>{name || id}</option>)}</select></label>
          <div>{members.map(member => <label key={member.member_id}><span><input type="checkbox" checked={ids(repo.allowedFeishu).includes(member.member_id)} onChange={event => {
            const selected = ids(repo.allowedFeishu).filter(id => id !== member.member_id); if (event.target.checked) selected.push(member.member_id)
            setRepo({ ...repo, allowedFeishu: selected.join(' ') })
          }} /> {member.name}</span></label>)}</div>
          <p>{tr(`已选 ${ids(repo.allowedFeishu).length} 名飞书接单人。未选择成员时，飞书消息不会获准开始新任务。`, `${ids(repo.allowedFeishu).length} Feishu requesters selected. Without allowed members, Feishu cannot start new tasks.`)}</p>
          <p>{tr('工作方式：当前仓库，串行执行。已有修改不会被自动清理。', 'Work mode: current checkout, serial execution. Existing changes are preserved.')}</p>
          <Button type="submit">{editingId ? tr('保存接单权限', 'Save access settings') : tr('检查并添加仓库', 'Verify and add repository')}</Button>
        </fieldset>
      </form>
      <h2>{tr('已添加的仓库', 'Registered repositories')}</h2>
      <table><thead><tr><th>{tr('仓库', 'Repository')}</th><th>{tr('工作目录', 'Checkout')}</th><th>{tr('运行状态', 'Status')}</th><th>{tr('操作', 'Actions')}</th></tr></thead><tbody>
        {state.repositories.map(repository => <tr key={repository.id}><td>{repository.name}<br />{repository.remote}</td><td>{repository.directory}</td>
          <td>{repository.starting ? tr('启动中', 'Starting') : repository.status.online ? repository.status.configured ? tr('已就绪', 'Ready') : tr('需要完成设置', 'Setup needed') : tr('未运行', 'Stopped')}{repository.status.error && <p role="alert">{repository.status.error}</p>}</td>
          <td><div className="dt-manager-actions"><Button disabled={busy} onClick={() => { void run(async () => { await request(`repositories/${repository.id}/${repository.status.online ? 'stop' : 'start'}`, {}) }) }}>{repository.status.online ? tr('停止服务', 'Stop service') : tr('启动服务', 'Start service')}</Button>
            <Button disabled={busy} onClick={() => { setEditingId(repository.id); setRepo({ name: repository.name, directory: repository.directory, remote: repository.remote, githubCli: repository.githubCli, allowedGithub: repository.allowedGithub.join(' '), allowedFeishu: repository.allowedFeishu.join(' ') }) }}>{tr('编辑接单权限', 'Edit access')}</Button>
            {repository.status.online && <Button disabled={busy} onClick={() => { void run(async () => { const launch = await request<{ url: string }>(`repositories/${repository.id}/open`, {}); window.open(launch.url, '_blank', 'noopener,noreferrer') }) }}>{tr('打开仓库工作空间', 'Open repository workspace')}</Button>}</div></td></tr>)}
      </tbody></table>
      <p>{tr('每个仓库独立运行；最多同时运行三个仓库。启动日志保存在管理状态目录的 logs 文件夹。', 'Repositories run independently, up to three at once. Startup logs are in the manager state directory under logs.')}</p>
    </>}
    {tab === 'bindings' && <>
      <h2>{tr('将群聊绑定到仓库', 'Bind a group to a repository')}</h2>
      <Button disabled={busy || !state.bot} onClick={() => { void run(async () => { await request('chats/refresh', {}) }) }}>{tr('刷新机器人已加入的群', 'Refresh joined groups')}</Button>
      <form onSubmit={event => submit(event, async () => {
        const bindings = state.bindings.filter(item => item.chatId !== selectedChat).map(({ effectiveAt, ...binding }) => binding)
        bindings.push({ chatId: selectedChat, repositoryId: selectedRepo, enabled: true })
        await request('bindings', { revision: state.revision, bindings }, 'PUT'); setSelectedChat(''); setSelectedRepo('')
      })}>
        <fieldset disabled={busy}><legend>{tr('3. 保存群聊归属', '3. Save group ownership')}</legend>
          <label>{tr('飞书群', 'Feishu group')}<select required value={selectedChat} onChange={event => setSelectedChat(event.target.value)}><option value="">{tr('请选择', 'Choose')}</option>{Object.entries(state.chats).map(([id, name]) => <option key={id} value={id}>{name || id}</option>)}</select></label>
          <label>{tr('目标仓库', 'Target repository')}<select required value={selectedRepo} onChange={event => setSelectedRepo(event.target.value)}><option value="">{tr('请选择', 'Choose')}</option>{state.repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select></label>
          <p>{tr('只接收 @机器人的新需求。换绑只影响新话题，旧话题继续回到原仓库；有待办任务或未送达消息时不能换绑。', 'Only new requests mentioning the bot are accepted. Rebinding affects new topics; old topics stay with their original repository. Open tasks or queued messages block rebinding.')}</p>
          <Button type="submit">{tr('保存绑定', 'Save binding')}</Button>
        </fieldset>
      </form>
      <ul>{state.bindings.map(binding => <li key={binding.chatId}>{state.chats[binding.chatId] || binding.chatId} → {state.repositories.find(repository => repository.id === binding.repositoryId)?.name}
        {' '}<Button disabled={busy} onClick={() => { void run(async () => {
          await request('bindings', { revision: state.revision, bindings: state.bindings.map(({ effectiveAt, ...item }) => item.chatId === binding.chatId ? { ...item, enabled: !item.enabled } : item) }, 'PUT')
        }) }}>{binding.enabled ? tr('停用群接单与回复', 'Disable group intake and replies') : tr('恢复群接单与回复', 'Enable group intake and replies')}</Button>
      </li>)}</ul>
      <p>{tr('4. 试单：启动目标仓库后，在绑定群中 @机器人并提出一个小需求。配置保存不会自动向群发消息。', '4. Try a task: start the repository, then mention the bot in its bound group with a small request. Saving configuration sends no group messages.')}</p>
    </>}
    {tab === 'tasks' && <>
      <h2>{tr('待送达消息与系统状态', 'Pending deliveries and health')}</h2>
      {Object.entries(state.health).filter(([, value]) => value.state !== 'ready').map(([name, health]) => <p key={name}>{name}: {health.detail}</p>)}
      <p>{tr(`${state.pending.length} 个仓库有待送达消息。离线消息保持原目标，不会转投。`, `${state.pending.length} repositories have pending deliveries. Offline messages keep their original destination.`)}</p>
      {state.pending.filter(item => item.error).map(item => <p key={item.id} role="alert">{state.repositories.find(repository => repository.id === item.repositoryId)?.name}: {item.error}</p>)}
      <Button disabled={busy} onClick={() => { void run(async () => {
        const entries = await Promise.all(state.repositories.map(async repository => {
          try { return [repository.id, await request<{ items: { id: string; title: string; stage?: string }[] }>(`repositories/${repository.id}/tasks`)] as const }
          catch (error) { return [repository.id, { error: String(error) }] as const }
        })); setTasks(Object.fromEntries(entries))
      }) }}>{tr('刷新各仓库任务', 'Refresh repository tasks')}</Button>
      {state.repositories.map(repository => <section key={repository.id}><h2>{repository.name}</h2>
        {tasks[repository.id]?.error && <p role="alert">{tasks[repository.id]?.error}</p>}
        <ul>{tasks[repository.id]?.items?.map(task => <li key={`${repository.id}:${task.id}`}>{task.title} · {task.stage}</li>)}</ul>
        {repository.status.online && <><Button disabled={busy} onClick={() => { void run(async () => { const launch = await request<{ url: string }>(`repositories/${repository.id}/open`, {}); window.open(launch.url, '_blank', 'noopener,noreferrer') }) }}>{tr('打开详情、回答问题或重试', 'Open details, answer or retry')}</Button>{' '}
          <Button disabled={busy} onClick={() => { void run(async () => { await request(`repositories/${repository.id}/pause`, { paused: true }) }) }}>{tr('暂停新调度', 'Pause dispatch')}</Button>{' '}
          <Button disabled={busy} onClick={() => { void run(async () => { await request(`repositories/${repository.id}/pause`, { paused: false }) }) }}>{tr('恢复调度', 'Resume dispatch')}</Button></>}
      </section>)}
    </>}
    </div>
  </div>
}
