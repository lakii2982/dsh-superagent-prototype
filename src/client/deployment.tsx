/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { confirmPanelMode, usePanelMode, type PanelMode } from './mode.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SetupView } from './api.ts'
import { Button, Icon, InfoTip, Input, Modal, Tag } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { errorText, setupText, type T } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets.tsx'
import { bindingBot, managerBots, type ManagerBotView, type ManagerView } from './manager-view.ts'
import type { ManagerArea } from './route.ts'
import STYLES from './client.css?raw'

export type DeploymentForm = ConfigPageForm | undefined
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const LIMIT_DEFAULTS = { promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/** Changes the local desktop deployment through DSH's own persistent configuration form. */
export function DesktopModeSwitch({ t, form, mode, running = 0 }: { t: T; form: DeploymentForm; mode: PanelMode; running?: number }) {
  const live = usePanelMode()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => request.current?.abort(), [])
  const snapshot = form?.state
  // Some installed Desktop hosts report writability without a persistence-mode field.
  if (!snapshot || snapshot.mode === 'memory' || live.mode !== mode || typeof live.desktopMultiRepository !== 'boolean') return null
  const tr = (zh: string, en: string) => t('yes') === 'Yes' ? en : zh
  const activating = mode === 'standalone'
  const blocked = running > 0
  const label = activating ? tr('启用多仓管理', 'Enable multi-repository management') : tr('返回单仓模式', 'Return to single repository')
  const hint = blocked
    ? tr('等工单结束或停止仓库服务后再切换。', 'Wait for active work to finish or stop the repository services before switching.')
    : activating
      ? tr('单仓接入暂停，原记录保留。', 'Single-repository intake pauses and its records are retained.')
      : tr('多仓配置保留，下次启用后可继续使用。', 'Multi-repository settings are retained for the next time you enable them.')
  const transition = async () => {
    if (!form || !snapshot.writable || snapshot.status !== 'ready' || request.current || blocked) return
    const controller = new AbortController()
    request.current = controller; setBusy(true); setError('')
    try {
      if (!await form.mutate([{ op: 'set', path: ['desktopMultiRepository'], value: activating }], snapshot.revision)) {
        throw new Error(t('deploymentRefused'))
      }
      if (!await confirmPanelMode(activating ? 'manager' : 'standalone', controller.signal)) {
        throw new Error(tr('服务尚未完成切换。确认没有正在运行的仓库或工单后重试。',
          'The service has not switched modes yet. Verify no repositories or work are active and retry.'))
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorText(failure))
    } finally {
      request.current = undefined
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <div className="dt-mode-switch">
    <Button variant={activating ? 'primary' : 'ghost'} size="sm" disabled={busy || blocked || !snapshot.writable || snapshot.status !== 'ready'}
      title={hint} onClick={() => { void transition() }}>{busy ? tr('正在切换…', 'Switching…') : label}</Button>
    {error && <p className="dt-error" role="alert">{error}</p>}
  </div>
}

/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
export function DeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  const { t, notify } = usePanel()
  const tr = (zh: string, en: string) => t('yes') === 'Yes' ? en : zh
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      for (const key of MACHINE_LIMITS) {
        const number = Number(value[key])
        if (value[key].trim() && (!Number.isInteger(number) || number < LIMITS[key].min || number > LIMITS[key].max)) {
          throw new Error(tr('请输入各项允许范围内的整数。', 'Enter a whole number within each allowed range.'))
        }
      }
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: revision + 1, restarting: false }
    } })
  const accounts = setup.accounts
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-superagent` is still starting.
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}
    note={tr(`允许 ${LIMITS[key].min.toLocaleString()}–${LIMITS[key].max.toLocaleString()}，留空使用默认值 ${LIMIT_DEFAULTS[key].toLocaleString()}。`,
      `Range ${LIMITS[key].min.toLocaleString()}–${LIMITS[key].max.toLocaleString()}. Leave blank for ${LIMIT_DEFAULTS[key].toLocaleString()}.`)}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} placeholder={String(LIMIT_DEFAULTS[key])} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  return <form className="dt-form dt-deployment-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-settings-notice"><Icon name="settings" /><Hint>{t('deploymentIntro')}</Hint></div>
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      <Section title={t('deploymentMachine')}>
        {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
        <div className="dt-field">
          <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
          <span className="dt-mono">{setup.machine.stateDir}</span>
        </div>
      </Section>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        <div className="dt-settings-fields-grid">{limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}</div>
      </Section>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

/** Plugin settings use the manager's live API and never treat missing data as zero configured resources. */
async function readManager(): Promise<ManagerView> {
  const response = await fetch('/orchestrator/manager/state', { headers: { 'x-orchestrator-request': '1' },
    signal: AbortSignal.timeout(15_000), cache: 'no-store' })
  const value = await response.json() as ManagerView & { error?: string; code?: string }
  if (!response.ok) throw new Error(value.code === 'operator_auth_required' ? 'operator_auth_required' : value.error || `HTTP ${response.status}`)
  return value
}

function ManagerPluginPage({ t, form, onOpenManager }: { t: T; form: DeploymentForm; onOpenManager?: (area: ManagerArea) => void }) {
  const { data: view, error, reload } = usePoll(readManager, [], 10_000)
  const tr = (zh: string, en: string) => t('yes') === 'Yes' ? en : zh
  const [editing, setEditing] = useState<string>()
  const editRevision = useRef<number>()
  const initialConnection = useRef({ cli: '', profile: '' })
  const [discard, setDiscard] = useState(false)
  const [cli, setCli] = useState('')
  const [profile, setProfile] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string }>()
  const connect = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !cli.trim() || !view) return
    setBusy(true); setNotice(undefined)
    try {
      const legacy = !view.bots
      const path = legacy || editing === 'legacy' ? 'bot' : editing === 'new' ? 'bots' : `bots/${encodeURIComponent(editing!)}`
      const response = await fetch(`/orchestrator/manager/${path}`, { method: legacy || editing !== 'new' ? 'PUT' : 'POST',
        headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cli: cli.trim(), ...(!legacy || profile.trim() ? { profile: profile.trim() } : {}), ...(!legacy ? { revision: editRevision.current } : {}) }),
        signal: AbortSignal.timeout(90_000) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      await reload(); setEditing(undefined)
      setNotice({ error: false, text: tr('机器人连接已验证并保存。', 'Bot connection verified and saved.') })
    } catch (failure) { setNotice({ error: true, text: errorText(failure) }) }
    finally { setBusy(false) }
  }
  const bots = view ? managerBots(view) : []
  const beginConnection = (bot?: ManagerBotView) => { initialConnection.current = { cli: bot?.cli ?? '', profile: bot?.profile ?? '' }; setCli(bot?.cli ?? ''); setProfile(bot?.profile ?? ''); setEditing(bot?.id ?? 'new'); editRevision.current = view?.revision; setNotice(undefined) }
  const teams = new Set(view?.repositories.map(repo => repo.teamName?.trim()).filter(Boolean)).size
  const products = new Set(view?.repositories.flatMap(repo => repo.productLines ?? [])).size
  const online = view?.repositories.filter(repo => repo.status.online).length ?? 0
  const bound = view?.bindings.filter(binding => binding.enabled).length ?? 0
  const running = view ? Math.max(view.capacity?.runningRepositories ?? 0,
    view.repositories.filter(repo => repo.status.online || repo.starting).length) : 1
  const shortcuts: { area: ManagerArea; title: string; detail: string; icon: 'hash' | 'message' | 'queue' }[] = [
    { area: 'repositories', title: tr('团队与仓库', 'Teams and repositories'), icon: 'hash',
      detail: tr('添加仓库，分配团队与产品线，管理服务状态。', 'Register repositories, assign teams and product lines, and manage services.') },
    { area: 'bindings', title: tr('群聊与工作入口', 'Groups and work intake'), icon: 'message',
      detail: tr('把研发群关联到对应仓库，配置可以发起工作的人。', 'Map development groups to repositories and choose who can request work.') },
    { area: 'deliveries', title: tr('运行与消息投递', 'Operations and delivery'), icon: 'queue',
      detail: tr('查看待处理消息、运行状态和需要处理的异常。', 'Review pending messages, service health and issues that need attention.') },
  ]
  return <>
    <div className="dt-plugin-hero">
      <div className="dt-plugin-emblem"><Icon name="shield" size={26} /></div>
      <div><p className="dt-eyebrow">DSH SUPERAGENT</p><h2>{tr('企业研发工作台', 'Engineering workspace')}</h2>
        <p>{tr('一套底座连接团队、仓库与飞书协作。', 'One shared foundation for teams, repositories and Feishu collaboration.')}</p></div>
      <Tag tone="info">{tr('多仓管理', 'Multi-repository')}</Tag>
    </div>
    {view && error?.message !== 'operator_auth_required' ? <>
      {error && <div className="dt-settings-notice"><p className="dt-error" role="alert">{tr('状态刷新失败，以下为上次读取的配置。', 'Refresh failed. The configuration below was read previously.')} {errorText(error)}</p>
        <Button size="sm" onClick={() => { void reload() }}>{tr('重试', 'Retry')}</Button></div>}
      <div className="dt-plugin-metrics">
        {[[tr('研发团队', 'Teams'), teams], [tr('产品线', 'Product lines'), products],
          [tr('已接入仓库', 'Repositories'), view.repositories.length], [tr('运行中的仓库', 'Running repositories'), online]].map(([label, value]) =>
          <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
      <div className="dt-settings-notice"><Icon name="decision" /><p>{error ? tr('当前显示上次成功读取的配置。', 'Showing the last successfully read configuration.') : tr('配置实时读取自当前工作台。', 'Configuration is read live from this workspace.')}
        {view.capacity && <> {tr(`同时运行容量 ${view.capacity.runningRepositories} / ${view.capacity.maxRunningRepositories} 个仓库。`,
          `Concurrent capacity ${view.capacity.runningRepositories} / ${view.capacity.maxRunningRepositories} repositories.`)}</>}</p>
        <Button size="sm" icon={<Icon name="refresh" />} disabled={busy} onClick={() => { void reload() }}>{tr('刷新', 'Refresh')}</Button>
      </div>
      <div className="dt-plugin-shortcuts">
        {shortcuts.map(item => <button key={item.area} type="button" className="dt-plugin-link" disabled={!onOpenManager}
          onClick={() => onOpenManager?.(item.area)}><Icon name={item.icon} size={20} />
          <span><strong>{item.title}</strong><small>{item.detail}</small></span><Icon name="chevron-right" /></button>)}
      </div>
      <section className="dt-plugin-connection">
        <div className="dt-settings-section-head"><div className="dt-row-title"><Icon name="message" size={18} />
          <h3>{tr('飞书机器人连接', 'Feishu bot connections')}</h3></div>
          <Tag tone={bots.some(bot => bot.connected && bot.enabled) ? 'success' : 'warning'}>{tr(`${bots.filter(bot => bot.connected && bot.enabled).length} / ${bots.length} 可用`, `${bots.filter(bot => bot.connected && bot.enabled).length} / ${bots.length} available`)}</Tag></div>
        <p className="dt-settings-caption">{tr('每个机器人可接入多个群，按“机器人 → 群聊 → 仓库”分配工作。', 'Each bot can serve multiple groups. Work follows bot → group → repository bindings.')}</p>
        {view.legacyConnection && <div className="dt-settings-notice"><div><strong>{tr('原有机器人连接待恢复', 'Previous bot connection needs recovery')}</strong>
          <p className="dt-error" role="alert">{view.legacyConnection.error}</p><p className="dt-hint dt-mono">{view.legacyConnection.cli}</p>
          <Button size="sm" disabled={busy || editing !== undefined} onClick={() => { setEditing('legacy'); initialConnection.current = { cli: view.legacyConnection!.cli, profile: '' }; setCli(view.legacyConnection!.cli); setProfile(''); editRevision.current = view.revision; setNotice(undefined) }}>{tr('恢复原有连接', 'Restore previous connection')}</Button></div></div>}
        {bots.length ? <div className="dt-plugin-bot-list">{bots.map(bot => {
          const bindings = view.bindings.filter(binding => bindingBot(view, binding)?.id === bot.id && binding.enabled)
          const failure = Object.values(bot.health).find(health => health.state === 'error')
          return <div className="dt-plugin-bot-row" key={bot.id}><div className="dt-row-main"><p className="dt-plugin-bot-name">{bot.name || bot.id}</p>
            {bot.profile && <p className="dt-settings-caption">{tr('CLI 档案', 'CLI profile')} · {bot.profile}</p>}
            <p className="dt-settings-caption">{tr(`${Object.keys(bot.chats).length} 个已加入的群 · ${bindings.length} 个启用绑定`, `${Object.keys(bot.chats).length} joined groups · ${bindings.length} enabled bindings`)}</p>
            {failure && <p className="dt-error" role="status">{failure.detail || tr('机器人连接需要处理', 'Bot connection needs attention')}</p>}</div>
            <Tag tone={!bot.enabled ? 'quiet' : bot.connected && !failure ? 'success' : 'danger'}>{!bot.enabled ? tr('已停用', 'Disabled') : bot.connected ? tr('已连接', 'Connected') : tr('连接异常', 'Disconnected')}</Tag>
            <Button size="sm" variant="outline" disabled={busy || editing !== undefined} onClick={() => beginConnection(bot)}>{tr('修改连接', 'Edit connection')}</Button></div>
        })}</div> : <p className="dt-plugin-bot-name">{tr('连接第一个机器人，接收研发群中的工作请求。', 'Connect the first bot to receive work from development groups.')}</p>}
        {bots.length > 0 && !bound && <p className="dt-settings-caption">{tr('还没有启用群聊绑定。先把机器人加入研发群，再绑定对应仓库。', 'No group bindings are enabled. Add a bot to a development group, then map it to a repository.')}</p>}
        {notice && <p className={notice.error ? 'dt-error' : 'dt-hint'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
        {editing === undefined && <div className="dt-actions"><Button variant="primary" size="sm" disabled={!!view.legacyConnection || (!view.bots && bots.length > 0)} title={!view.bots && bots.length ? tr('更新管理服务后可添加多个机器人。', 'Update the manager service to add multiple bots.') : undefined} onClick={() => beginConnection()}>{tr('添加机器人', 'Add bot')}</Button>
          <Button variant="outline" size="sm" disabled={!onOpenManager} onClick={() => onOpenManager?.('feishu')}>{tr('管理机器人连接', 'Manage bot connections')}</Button>
          {bots.length > 0 && <Button variant="outline" size="sm" disabled={!onOpenManager} onClick={() => onOpenManager?.('bindings')}>{tr('管理群聊绑定', 'Manage group bindings')}</Button>}</div>}
        {editing !== undefined && <form className="dt-form dt-plugin-bot-form" onSubmit={event => { void connect(event) }}>
          <p className="dt-row-title">{editing === 'legacy' ? tr('恢复原有机器人连接', 'Restore the previous bot connection') : editing === 'new' ? tr('新增机器人连接', 'New bot connection') : tr('修改当前机器人连接', 'Edit this bot connection')}</p>
          <Fields disabled={busy}><Field label={tr('机器人 CLI 路径或命令', 'Bot CLI path or command')}
            note={tr('验证通过后保存。每个连接使用对应的机器人 CLI，账号凭据由 CLI 管理。', 'Saved after verification. Each connection uses its own bot CLI; credentials remain managed by the CLI.')}>
            <Input autoFocus required value={cli} spellCheck={false} placeholder="lark-bot" onChange={event => setCli(event.target.value)} />
          </Field><Field label={tr('CLI 配置档案（Profile）', 'CLI profile')} note={tr('可选。填写该 CLI 中已配置的档案名；同一 CLI 的不同档案可连接不同机器人。留空使用默认档案。', 'Optional. Use a configured CLI profile. Different profiles can connect different bots; leave empty for the default profile.')}>
            <Input value={profile} spellCheck={false} onChange={event => setProfile(event.target.value)} placeholder="platform-team" />
          </Field></Fields>
          <div className="dt-actions"><Button type="submit" variant="primary" disabled={busy || !cli.trim()}>{busy ? tr('正在验证…', 'Verifying…') : tr('验证并保存', 'Verify and save')}</Button>
            <Button disabled={busy} onClick={() => { if (cli !== initialConnection.current.cli || profile !== initialConnection.current.profile) setDiscard(true); else { setEditing(undefined); setNotice(undefined) } }}>{tr('取消', 'Cancel')}</Button></div>
        </form>}
      </section>
      <Modal open={discard} closeLabel={tr('关闭', 'Close')} title={tr('放弃未保存的连接修改？', 'Discard connection changes?')} onClose={() => setDiscard(false)}>
        <p>{tr('CLI 命令或配置档案的修改尚未保存。', 'Changes to the CLI command or profile have not been saved.')}</p>
        <div className="dt-actions"><Button onClick={() => setDiscard(false)}>{tr('继续编辑', 'Continue editing')}</Button>
          <Button variant="primary" onClick={() => { setDiscard(false); setEditing(undefined); setCli(''); setProfile(''); setNotice(undefined) }}>{tr('放弃修改', 'Discard changes')}</Button></div>
      </Modal>
      <details className="dt-advanced-settings">
        <summary><Icon name="settings" /><span>{tr('高级部署设置', 'Advanced deployment settings')}</span></summary>
        <div><KeyValues rows={[[tr('运行方式', 'Deployment mode'), tr('统一多仓工作台', 'Shared multi-repository workspace')],
          [tr('交付策略', 'Delivery policy'), view.enterprisePilot ? tr('企业交付约束已启用', 'Enterprise delivery controls enabled') : tr('按仓库配置', 'Configured per repository')]]} />
          <p className="dt-hint">{tr('切换运行模式前需要停止全部仓库服务。已有仓库、团队和群聊配置会保留。',
            'Stop every repository service before switching modes. Repository, team and group configuration is retained.')}</p>
          <DesktopModeSwitch t={t} form={form} mode="manager" running={running} />
        </div>
      </details>
    </> : error ? <div className="dt-plugin-connection"><p className="dt-error" role="alert">
      {error.message === 'operator_auth_required' ? tr('此连接需要管理权限，请打开工作台解锁后查看与配置。', 'Manager access is required. Open the workspace to unlock, view and configure it.') : errorText(error)}</p>
      <div className="dt-actions"><Button variant="outline" onClick={() => { void reload() }}>{tr('重试', 'Retry')}</Button>
        {onOpenManager && <Button variant="primary" onClick={() => onOpenManager('repositories')}>{tr('打开工作台', 'Open workspace')}</Button>}</div>
    </div> : <p className="dt-hint" role="status">{t('loading')}</p>}
  </>
}

/** Plugin Manager config page for an existing single-repository installation. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  const tr = (zh: string, en: string) => t('yes') === 'Yes' ? en : zh
  return <>
    <div className="dt-plugin-hero"><div className="dt-plugin-emblem"><Icon name="settings" size={26} /></div>
      <div><p className="dt-eyebrow">DSH SUPERAGENT</p><h2>{tr('工作台设置', 'Workspace settings')}</h2>
        <p>{tr('管理当前仓库的连接与本机运行参数。', 'Manage connections and host settings for this repository.')}</p></div>
      <Tag tone="quiet">{tr('单仓模式', 'Single repository')}</Tag></div>
    {state && <div className="dt-settings-notice"><Icon name="hash" /><p>{tr('多个团队共用一套底座时，启用统一的多仓管理。',
      'Enable shared multi-repository management when several teams use this foundation.')}</p>
      <DesktopModeSwitch t={t} form={form} mode="standalone" running={state.load.running} /></div>}
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint" role="status">{t('loading')}</p>}
  </>
}

/** The native plugin settings remain useful in both deployment modes. */
export function PluginConfig({ t, view, form, onOpenManager }: {
  t: T; view: 'page' | 'summary'; form: DeploymentForm; onOpenManager?: (area: ManagerArea) => void
}) {
  const { mode, error } = usePanelMode()
  if (view !== 'page') return null
  return <div className="dt-embedded dt-plugin-settings"><style>{STYLES}</style>
    {mode === 'manager' ? <ManagerPluginPage t={t} form={form} onOpenManager={onOpenManager} />
      : mode === 'standalone' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider>
      : error ? <p className="dt-error" role="alert">{error}</p> : <p className="dt-hint" role="status">{t('loading')}</p>}
  </div>
}
