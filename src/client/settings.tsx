/** Settings tab shell routing between stage settings (Sources, Eval, Execution), Prompts, and Deployment. */
import { useState } from 'react'
import type { StateView } from './api.ts'
import { SegmentedControl } from './controls.tsx'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
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

const STAGE_GROUPS: readonly SettingsGroup[] = ['source', 'eval', 'execution']
export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    switch (group) {
      case 'source': return <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      case 'execution': return <SettingsProvider><DefaultAgentField /><ExecutionSettings /></SettingsProvider>
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
    }
  })()
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {SETTINGS_GROUPS.map(value => <button key={value} type="button" className="dt-settings-link" data-stage={STAGE_GROUPS.includes(value)
        || undefined}
        aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value),
          true)}>{t(`settingsGroup.${value}`)}</button>)}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
      {content}
    </div>
  </div>
}
