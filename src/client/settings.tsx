/**
 * Settings area: Source, Eval, Execution, Prompts and Deployment are one column of sections separated by small headings, so
 * the panel keeps a single left rail and one scrolling detail instead of a second navigation bar.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { StateView } from './api.ts'
import { SegmentedControl } from './controls.tsx'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import type { SettingsGroup } from './route.ts'
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
    zh: 'Worker 调用 orchestrator_agent 未指定 agent 时使用这里的选择；单个任务仍可明确选择另一个已接通的 Agent。无法建立文件访问约束的 Agent 会显示为不可用。',
    en: 'Used when a worker calls orchestrator_agent without an agent; a single run may still choose the other connected agent. An agent this host cannot constrain is shown as unavailable.' })}
  >
    <div>
      <SegmentedControl label={label} value={executor.value.agent ?? ''} disabled={busy} onChange={next => { void save(next) }}
        options={[{ value: '', label: localized(t, { zh: '不指定', en: 'Not set' }) }, { value: 'codex', label: 'Codex' },
          { value: 'claude', label: 'Claude Code' }]}
      />
    </div>
  </Field>
}

/** One configuration section: a small heading names it and every option it owns follows in the same column. */
function SettingsSection({ group, title, children }: { group: SettingsGroup; title: string; children: ReactNode }) {
  return <section className="dt-group" data-group={group} aria-labelledby={`dt-group-${group}`}>
    <h2 className="dt-group-title" id={`dt-group-${group}`}>{title}</h2>
    {children}
  </section>
}

export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t } = usePanel()
  const page = useRef<HTMLDivElement>(null)
  // A link that names a group (a stage's Settings button, a setup problem) opens the page at that section; the first one
  // means the top of the page, which is where the rail's Settings entry lands.
  useEffect(() => {
    if (group === 'source') { page.current?.closest<HTMLElement>('.dt-workspace')?.scrollTo?.({ top: 0 }); return }
    const section = page.current?.querySelector<HTMLElement>(`[data-group="${group}"]`)
    section?.scrollIntoView?.({ block: 'start' })
  }, [group])
  return <div className="dt-settings" data-active={group} ref={page}>
    <SettingsProvider>
      <SettingsSection group="source" title={t('settingsGroup.source')}>
        <SourceSettings {...query.source ? { focus: query.source } : {}} />
      </SettingsSection>
      <SettingsSection group="eval" title={t('settingsGroup.eval')}>
        <EvalSettings version={query.version} />
      </SettingsSection>
      <SettingsSection group="execution" title={t('settingsGroup.execution')}>
        <DefaultAgentField />
        <ExecutionSettings />
      </SettingsSection>
    </SettingsProvider>
    <SettingsSection group="prompts" title={t('settingsGroup.prompts')}>
      <PromptsPage />
    </SettingsSection>
    <SettingsSection group="deployment" title={t('settingsGroup.deployment')}>
      <DeploymentPage setup={state.setup} form={deploymentForm} />
    </SettingsSection>
  </div>
}
