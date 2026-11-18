/** Repository page: the single repository this standalone deployment serves, its health, and the ways into each work area. */
import { Button, Icon, Tag, type IconName } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { settingsRoute, setupPage, type Route } from './route.ts'
import { valueLabel } from './text.ts'
import { Section, SetupMessage } from './widgets.tsx'

const linkHint: Partial<Record<string, string>> = {
  source: 'GitHub 与飞书，连接状态与账号',
  trigger: '收到的消息、线程与订阅',
  eval: '接单与过滤的判断依据',
  execution: '工单、执行会话与结果',
  settings: '来源、评估、执行、提示词与部署',
}

export function RepositoryPage() {
  const { t, navigate } = usePanel()
  const { state } = usePanelData()
  if (!state) return <p className="dt-hint">{t('loading')}</p>
  const accounts = state.setup.accounts
  const problem = state.setup.problem
  const health = Object.entries(state.health)
  const links: { page: string; route: Route; icon: IconName; label: string }[] = [
    { page: 'source', route: { page: 'source' }, icon: 'hash', label: t('tab.source') },
    { page: 'trigger', route: { page: 'trigger', query: { filter: 'subscribed' } }, icon: 'message', label: t('tab.trigger') },
    { page: 'eval', route: { page: 'eval' }, icon: 'decision', label: t('tab.eval') },
    { page: 'execution', route: { page: 'execution' }, icon: 'queue', label: t('tab.execution') },
    { page: 'prompts', route: settingsRoute('prompts'), icon: 'review', label: t('nav.prompts') },
    { page: 'settings', route: settingsRoute('deployment'), icon: 'settings', label: t('tab.settings') },
  ]
  return <div className="dt-repo-page">
    <div className="dt-page-head">
      <p>{t('repository.subtitle')}</p>
    </div>

    <section className="dt-repo-hero">
      <div className="dt-repo-hero-main">
        <span className="dt-repo-kicker">{t('repository.current')}</span>
        <h3>{accounts?.repository ?? t('repository.notSetUp')}</h3>
        <p>{accounts ? `${accounts.agent} · ${accounts.feishu ? `${accounts.feishu.name}（${accounts.feishu.brand}）` : t('unsetValue')}` : t('repository.promptsHint')}</p>
        <div className="dt-repo-tags">
          <Tag tone={problem ? 'warning' : accounts ? 'success' : 'danger'}>{problem ? t('repository.notSetUp') : accounts ? t('repository.ready') : t('repository.notSetUp')}</Tag>
          <Tag tone="quiet">{state.setup.machine.stateDir}</Tag>
        </div>
      </div>
      <div className="dt-repo-actions">
        <Button variant="primary" icon={<Icon name="inbox" size={14} />} onClick={() => navigate({ page: 'overview' })}>{t('nav.inbox')}</Button>
        <Button variant="outline" icon={<Icon name="review" size={14} />} onClick={() => navigate(settingsRoute('prompts'))}>{t('nav.prompts')}</Button>
      </div>
    </section>

    {problem && <section className="dt-repo-problem">
      <div>
        <strong>{t('repository.notSetUp')}</strong>
        <p className="dt-error"><SetupMessage problem={problem} /></p>
      </div>
      <Button variant="outline" size="sm" onClick={() => navigate(setupPage(problem.place))}>{t('repository.fixSetup')}</Button>
    </section>}

    <div className="dt-repo-grid">
      {links.map(({ page, route, icon, label }) => <button key={page} type="button" className="dt-repo-link" onClick={() => navigate(route)}>
        <span className="dt-repo-link-icon"><Icon name={icon} size={16} /></span>
        <span className="dt-repo-link-main"><strong>{label}</strong><span>{linkHint[page] ?? ''}</span></span>
        <Icon name="chevron-right" size={14} />
      </button>)}
    </div>

    <Section title={t('repository.health')} count={health.length}>
      {health.length ? <ul className="dt-list dt-repo-health">{health.map(([name, value]) => <li key={name}>
        <span className="dt-repo-health-name">{valueLabel(t, 'health', name)}</span>
        <span className="dt-repo-health-detail">{value.detail || value.state}</span>
        <Tag tone={value.state === 'error' ? 'danger' : value.state === 'paused' ? 'warning' : 'success'}>{value.state}</Tag>
      </li>)}</ul> : <p className="dt-hint">{t('repository.promptsHint')}</p>}
    </Section>

    <Section title={t('repository.load')} count={`${state.load.running} / ${state.load.maxWorkers}`}>
      <p className="dt-hint">{t('executingLabel')} {state.load.running} / {state.load.maxWorkers} · {t('queuedLabel')} {state.load.queued}</p>
    </Section>
  </div>
}
