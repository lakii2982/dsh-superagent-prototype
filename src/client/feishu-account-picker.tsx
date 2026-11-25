import { useEffect, useRef, useState } from 'react'
import { Button } from './controls.tsx'
import { Field } from './settings-kit.tsx'
import type { ManagerBotView } from './manager-view.ts'
import { errorText } from './text.ts'

interface Candidate { profile: string; appId: string; brand: string; account?: string; name?: string }
interface Session { id: string; profile: string; status: 'waiting' | 'ready' | 'failed'; url?: string; image?: string; error?: string }
const registrationKey = 'dsh-superagent/feishu-registration'
type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>
export function FeishuAccountPicker({ request, bots, editing, busy, tr, connect, cancel, retryOriginal }: {
  request: Request; bots: ManagerBotView[]; editing: string; busy: boolean
  tr: (zh: string, en: string) => string; connect: (candidate: Candidate) => Promise<void>; cancel: () => void
  retryOriginal?: () => Promise<void>
}) {
  const [rows, setRows] = useState<Candidate[]>([])
  const [revision, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [issue, setIssue] = useState('')
  const [selected, select] = useState('')
  const [starting, setStarting] = useState(false)
  const [sessionId, setSessionId] = useState(() => editing === 'new' ? sessionStorage.getItem(registrationKey) : null)
  const [session, setSession] = useState<Session>()
  const [sessionError, setSessionError] = useState('')
  const [poll, retryPoll] = useState(0)
  const preferred = useRef('')
  const current = bots.find(bot => bot.id === editing)
  useEffect(() => {
    let active = true
    setLoading(true); setIssue(''); setRows([]); select('')
    void request<{ items: Candidate[] }>('feishu/accounts').then(({ items }) => {
      if (!active) return
      setRows(items)
      if (items.some(row => row.profile === preferred.current)) select(preferred.current)
    }).catch(error => { if (active) setIssue(errorText(error)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [request, revision])
  useEffect(() => {
    if (!sessionId) return
    let active = true, timer: ReturnType<typeof setTimeout>
    setSessionError('')
    const read = async () => {
      try {
        const job = await request<Session>('feishu/registration/' + sessionId)
        if (!active) return
        setSession(job)
        if (job.status === 'waiting') { timer = setTimeout(read, 1600); return }
        sessionStorage.removeItem(registrationKey); setSessionId(null)
        if (job.status === 'ready') { preferred.current = job.profile; refresh(n => n + 1) }
        else setSessionError(job.error ?? tr('扫码未完成，请重试。', 'Authorization did not finish. Try again.'))
      } catch (error) { if (active) setSessionError(errorText(error)) }
    }
    void read()
    return () => { active = false; clearTimeout(timer) }
  }, [sessionId, request, poll, tr])
  const start = async () => {
    setStarting(true); setSessionError('')
    try {
      const job = await request<Session>('feishu/registration', {})
      sessionStorage.setItem(registrationKey, job.id); setSession(job); setSessionId(job.id)
    } catch (error) { setSessionError(errorText(error)) }
    finally { setStarting(false) }
  }
  const endScan = async () => {
    try { await request('feishu/registration/' + sessionId, {}, 'DELETE') }
    catch (error) { if (!errorText(error).includes('扫码已结束')) { setSessionError(errorText(error)); return } }
    sessionStorage.removeItem(registrationKey); setSessionId(null); setSession(undefined); setSessionError('')
  }
  const options = current?.appId ? rows.filter(row => row.appId === current.appId) : rows
  const accounts = [...new Set(options.map(row => row.account || ''))]
  const candidate = options.find(row => row.profile === selected)
  return <div className="dt-form dt-block">
    <p className="dt-hint">{tr('选择本机已配置的飞书机器人。要用另一个账号创建机器人，请用该账号扫码。', 'Choose a bot configured on this host, or scan with another account to create a bot.')}</p>
    {loading && <p role="status">{tr('正在发现飞书账号和机器人…', 'Finding Feishu accounts and bots…')}</p>}
    {issue && <p role="alert" className="dt-error">{issue}</p>}
    {!loading && !issue && (options.length ? <Field label={tr('账号与机器人', 'Account and bot')}><select className="dt-select" value={selected}
      disabled={busy || !!sessionId} onChange={e => select(e.target.value)}><option value="">{tr('请选择机器人', 'Choose a bot')}</option>
      {accounts.map(account => <optgroup key={account} label={account || tr('未提供账号名称', 'Account name unavailable')}>
        {options.filter(row => (row.account || '') === account).map(row => {
          const registered = bots.some(bot => bot.id !== editing && bot.appId === row.appId)
          return <option key={row.profile} value={row.profile} disabled={registered}>{[row.account, row.name || row.profile, (row.name || row.profile) !== row.appId ? row.appId : '', registered && tr('已连接', 'Connected')].filter(Boolean).join(' · ')}</option>
        })}</optgroup>)}</select></Field> : <p role="status">{tr('没有发现可选的机器人。', 'No matching bot was found.')}</p>)}
    {sessionId && <section className="dt-feishu-permission">
      {session?.image && <img width="144" height="144" src={session.image} alt={tr('飞书机器人创建二维码', 'QR code to create a Feishu bot')} />}
      <div><strong>{tr('用目标飞书账号确认创建机器人', 'Confirm bot creation with the intended account')}</strong>
        {session?.url ? <p><a href={session.url} target="_blank" rel="noopener noreferrer">{tr('打开飞书确认页', 'Open Feishu confirmation')}</a></p>
          : <p role="status">{tr('正在向飞书获取授权链接…', 'Requesting a confirmation link…')}</p>}
        {sessionError && <Button onClick={() => retryPoll(n => n + 1)}>{tr('重新检查', 'Check again')}</Button>}
        <Button onClick={() => { void endScan() }}>{tr('取消扫码', 'Cancel scan')}</Button></div></section>}
    {sessionError && <p className="dt-error" role="alert">{sessionError}</p>}
    {session?.status === 'ready' && <p role="status">{tr('飞书已完成创建，请确认下方连接。', 'The bot was created. Confirm the connection below.')}</p>}
    <div className="dt-actions">
      <Button variant="primary" disabled={busy || !candidate || !!sessionId || loading} onClick={() => { if (candidate) void connect(candidate) }}>{tr('验证并连接所选机器人', 'Verify and connect selected bot')}</Button>
      {editing === 'new' && <Button variant="outline" disabled={busy || starting || !!sessionId} onClick={() => { void start() }}>{tr('扫码创建新机器人', 'Scan to create a bot')}</Button>}
      {retryOriginal && <Button disabled={busy} onClick={() => { void retryOriginal() }}>{tr('重新验证原连接', 'Recheck original connection')}</Button>}
      <Button disabled={busy || loading || !!sessionId} onClick={() => refresh(n => n + 1)}>{tr('重新发现', 'Discover again')}</Button>
      <Button disabled={busy || starting || !!sessionId} onClick={cancel}>{tr('关闭', 'Close')}</Button>
    </div>
  </div>
}
