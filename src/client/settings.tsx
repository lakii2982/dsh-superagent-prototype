/**
 * Settings area: Source, Eval, Execution, Prompts and Deployment are one column of sections separated by small headings, so
 * the panel keeps a single left rail and one scrolling detail instead of a second navigation bar.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { StateView } from './api.ts'
import { Icon, SegmentedControl, type IconName } from './controls.tsx'
import { DraftStatusContext } from './draft.tsx'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import { settingsRoute, type SettingsGroup } from './route.ts'
import { Field, SettingsProvider, useSettings } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'
import { errorText, localized } from './text.ts'

/**
 * The repository-wide default execution agent (§4.1): saved here, used when a worker's `orchestrator_agent` run names no
 * agent, and never a replacement for the per-run choice — a run may still name the other connected agent.
 */
function DefaultAgentField() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const [busy, setBusy] = useState(false)
  const executor = settings.blocks.executor
  const save = async (next: '' | 'codex' | 'claude') => {
    setBusy(true)
    try {
      // The executor block is replaced whole; a changed default agent therefore saves against the revision just read.
      const value = { ...executor.value }
      if (next) value.agent = next
      else delete value.agent
      const result = await call('PUT settings/:block', { block: 'executor', body: { value, revision: executor.revision } })
      notify(t(result.restarting ? 'savedRestarting' : 'saved'))
      await reload()
    } catch (error) { notify(errorText(error)) } finally { setBusy(false) }
  }
  const label = localized(t, { zh: '默认执行 Agent', en: 'Default execution agent' })
  return <Field label={label} hint={localized(t, {
    zh: '未指定执行工具的任务使用此设置。单个任务仍可选择其他已连接的工具。选择后立即保存。',
    en: 'Used by tasks that do not select an execution tool. Individual tasks may use another connected tool. Changes save immediately.' })}
  >
    <div>
      <SegmentedControl label={label} value={executor.value.agent ?? ''} disabled={busy} onChange={next => { void save(next) }}
        options={[{ value: '', label: localized(t, { zh: '不指定', en: 'Not set' }) }, { value: 'codex', label: 'Codex' },
          { value: 'claude', label: 'Claude Code' }]}
      />
    </div>
  </Field>
}

/** Keep inactive groups mounted so changing categories does not discard an in-progress draft. */
function SettingsSection({ group, title, description, active, children, onDraftStatus }: {
  group: SettingsGroup; title: string; description: string; active: boolean; children: ReactNode
  onDraftStatus: (group: SettingsGroup, id: string, pending: boolean) => void
}) {
  const report = useCallback((id: string, pending: boolean) => onDraftStatus(group, id, pending), [group, onDraftStatus])
  return <section className="dt-group" data-group={group} hidden={!active} aria-labelledby={`dt-group-${group}`}>
    <div className="dt-settings-section-head">
      <h2 className="dt-group-title" id={`dt-group-${group}`}>{title}</h2>
      <p className="dt-settings-caption">{description}</p>
    </div>
    <DraftStatusContext.Provider value={report}>{children}</DraftStatusContext.Provider>
  </section>
}

export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const page = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<Record<string, SettingsGroup>>({})
  const onDraftStatus = useCallback((group: SettingsGroup, id: string, dirty: boolean) => {
    setPending(current => {
      if (dirty ? current[id] === group : !(id in current)) return current
      const next = { ...current }
      if (dirty) next[id] = group
      else delete next[id]
      return next
    })
  }, [])
  const pendingGroups = new Set(Object.values(pending))
  const tr = (zh: string, en: string) => localized(t, { zh, en })
  const groups: { group: SettingsGroup; title: string; description: string; icon: IconName }[] = [
    { group: 'source', title: t('settingsGroup.source'), icon: 'hash',
      description: tr('连接 GitHub 与飞书，确定工作从哪里进入。', 'Connect GitHub and Feishu and choose where work enters.') },
    { group: 'eval', title: t('settingsGroup.eval'), icon: 'shield',
      description: tr('确定谁能发起工作、哪些请求可以执行。', 'Define who can request work and which requests may run.') },
    { group: 'execution', title: t('settingsGroup.execution'), icon: 'session',
      description: tr('选择执行工具、并发数量和任务工作区。', 'Choose execution tools, concurrency and task workspaces.') },
    { group: 'prompts', title: t('settingsGroup.prompts'), icon: 'review',
      description: tr('维护团队工作规范与各角色的任务说明。', 'Maintain team instructions and guidance for each role.') },
    { group: 'deployment', title: t('settingsGroup.deployment'), icon: 'settings',
      description: tr('检查部署状态，调整本机资源与读取上限。', 'Inspect deployment health and tune local resource limits.') },
  ]
  useEffect(() => { page.current?.closest<HTMLElement>('.dt-workspace')?.scrollTo?.({ top: 0 }) }, [group])
  const section = (key: SettingsGroup, children: ReactNode) => {
    const item = groups.find(item => item.group === key)!
    return <SettingsSection {...item} active={group === key} onDraftStatus={onDraftStatus}>{children}</SettingsSection>
  }
  return <div className="dt-settings" data-active={group} ref={page}>
    <div className="dt-settings-intro">
      <Icon name="settings" size={20} />
      <p>{tr('每类配置独立保存。切换分类会保留当前编辑内容。',
        'Save each category independently. Switching categories keeps your current edits.')}</p>
    </div>
    <nav className="dt-settings-nav" aria-label={tr('设置分类', 'Settings categories')}>
      {groups.map(item => <button type="button" key={item.group} aria-current={group === item.group ? 'page' : undefined}
        onClick={() => navigate(settingsRoute(item.group))}>
        <Icon name={item.icon} size={17} /><span>{item.title}</span>
        {pendingGroups.has(item.group) && <span className="dt-settings-dirty" aria-label={tr('未保存', 'Unsaved changes')} />}
      </button>)}
    </nav>
    {pendingGroups.size > 0 && <p className="dt-settings-pending" role="status">
      {tr('以下分类有待保存的修改', 'Unsaved changes in')}
      {groups.filter(item => pendingGroups.has(item.group)).map(item => <button key={item.group} type="button" className="dt-textlink"
        onClick={() => navigate(settingsRoute(item.group))}>{item.title}</button>)}
    </p>}
    <SettingsProvider>
      {section('source', <SourceSettings {...query.source ? { focus: query.source } : {}} />)}
      {section('eval', <EvalSettings version={query.version} />)}
      {section('execution', <><div className="dt-form dt-block"><DefaultAgentField /></div><ExecutionSettings /></>)}
    </SettingsProvider>
    {section('prompts', <PromptsPage />)}
    {section('deployment', <DeploymentPage setup={state.setup} form={deploymentForm} />)}
  </div>
}
