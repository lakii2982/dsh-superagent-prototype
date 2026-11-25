/** Repository workspace summary, connection state and actionable diagnostics. */
import { Button, Icon, Tag, type IconName, type TagTone } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { settingsRoute, setupPage, type Route } from './route.ts'
import { healthText, valueLabel } from './text.ts'
import { Section, SetupMessage, When } from './widgets.tsx'

export function RepositoryPage() {
  const { t, navigate } = usePanel()
  const { state, error, reload } = usePanelData()
  const tr = (zh: string, en: string) => t('lang') === 'en' ? en : zh
  if (!state) return <div className="dt-empty-state" role={error ? 'alert' : 'status'}>
    <Icon name={error ? 'alert' : 'running'} size={28} />
    <strong>{error ? tr('暂时无法读取仓库状态', 'Repository status is unavailable') : t('loading')}</strong>
    {error && <><p className="dt-hint">{error.message}</p><Button variant="outline" icon={<Icon name="refresh" />}
      onClick={() => { void reload() }}>{tr('重新读取', 'Retry')}</Button></>}
  </div>
  const accounts = state.setup.accounts
  const problem = state.setup.problem
  const health = Object.entries(state.health)
  const errors = health.filter(([, value]) => value.state === 'error').length
  const starting = health.some(([, value]) => value.state === 'starting')
  const attention = health.filter(([, value]) => value.state !== 'ready').length
  const status: { tone: TagTone; label: string } = error ? { tone: 'warning', label: tr('状态更新失败', 'Status update failed') }
    : problem || !accounts ? { tone: 'warning', label: tr('待完成接入', 'Setup required') }
    : state.paused ? { tone: 'warning', label: tr('接单已暂停', 'Processing paused') }
    : errors ? { tone: 'danger', label: tr('有服务异常', 'Service needs attention') }
    : starting ? { tone: 'info', label: tr('正在准备', 'Preparing') }
    : { tone: 'success', label: tr('仓库已就绪', 'Repository ready') }
  const healthLabel = (value: string) => ({ ready: tr('正常', 'Ready'), starting: tr('启动中', 'Starting'),
    paused: tr('已暂停', 'Paused'), error: tr('异常', 'Error') })[value] ?? tr('待确认', 'Unknown')
  const healthTone = (value: string): TagTone => value === 'ready' ? 'success' : value === 'error' ? 'danger'
    : value === 'paused' ? 'warning' : value === 'starting' ? 'info' : 'quiet'
  const links: { page: string; route: Route; icon: IconName; label: string; hint: string }[] = [
    { page: 'execution', route: { page: 'execution' }, icon: 'queue', label: t('nav.tasks'),
      hint: tr('跟进任务进度，查看执行结果', 'Track work in progress and delivery results') },
    { page: 'source', route: { page: 'source' }, icon: 'hash', label: tr('接单入口', 'Intake channels'),
      hint: tr('查看 GitHub 与飞书的连接状态', 'Check GitHub and Feishu connections') },
    { page: 'trigger', route: { page: 'trigger', query: { filter: 'subscribed' } }, icon: 'message', label: tr('需求与讨论', 'Requests & discussions'),
      hint: tr('查看消息上下文与跟进中的话题', 'Review messages and subscribed discussions') },
    { page: 'eval', route: { page: 'eval' }, icon: 'decision', label: tr('接单记录', 'Intake decisions'),
      hint: tr('了解需求为何接单、忽略或等待', 'Understand accepted, ignored and pending requests') },
    { page: 'prompts', route: settingsRoute('prompts'), icon: 'review', label: tr('团队工作规范', 'Working instructions'),
      hint: tr('维护 AI 的工作范围与交付要求', 'Define AI scope and delivery expectations') },
    { page: 'settings', route: settingsRoute('source'), icon: 'settings', label: t('tab.settings'),
      hint: tr('配置接单权限、执行方式与模型', 'Configure access, execution and models') },
  ]
  return <div className="dt-repo-page">
    <section className="dt-repo-hero" aria-label={tr('仓库概况', 'Repository summary')}>
      <div className="dt-repo-hero-main">
        <span className="dt-repo-kicker">{tr('仓库工作空间', 'REPOSITORY WORKSPACE')}</span>
        <h2>{accounts?.repository ?? tr('仓库尚未连接', 'Repository not connected')}</h2>
        <p>{tr('在这里跟进研发任务、检查接单入口，并维护本仓库的工作规范。',
          'Track development work, check intake channels and manage instructions for this repository.')}</p>
        <div className="dt-repo-tags"><Tag tone={status.tone}>{status.label}</Tag>
          {accounts?.agent && <Tag tone="quiet">GitHub · {accounts.agent}</Tag>}
          {accounts?.feishu && <Tag tone="quiet">{tr('飞书', 'Feishu')} · {accounts.feishu.name}</Tag>}
        </div>
      </div>
      <div className="dt-repo-actions">
        <Button variant="primary" icon={<Icon name="inbox" size={14} />} onClick={() => navigate({ page: 'overview' })}>{tr('进入工作台', 'Open inbox')}</Button>
      </div>
    </section>

    {problem && <section className="dt-repo-problem">
      <div><strong>{tr('完成这一项后继续使用', 'Complete setup to continue')}</strong>
        <p className="dt-error"><SetupMessage problem={problem} /></p></div>
      <Button variant="outline" size="sm" onClick={() => navigate(setupPage(problem.place))}>{t('repository.fixSetup')}</Button>
    </section>}

    <div className="dt-repo-metrics" aria-label={tr('任务负载', 'Task load')}>
      <div><span>{t('executingLabel')}</span><strong>{state.load.running}</strong></div>
      <div><span>{t('queuedLabel')}</span><strong>{state.load.queued}</strong></div>
      <div><span>{tr('执行并发上限', 'Concurrency limit')}</span><strong>{state.load.maxWorkers}</strong></div>
      <div><span>{tr('待关注服务', 'Services to review')}</span><strong>{attention}</strong></div>
    </div>

    <div className="dt-repo-grid">
      {links.map(({ page, route, icon, label, hint }) => <button key={page} type="button" className="dt-repo-link" onClick={() => navigate(route)}>
        <span className="dt-repo-link-icon"><Icon name={icon} size={18} /></span>
        <span className="dt-repo-link-main"><strong>{label}</strong><span>{hint}</span></span>
        <Icon name="chevron-right" size={14} />
      </button>)}
    </div>

    <Section title={tr('服务健康', 'Service health')} count={health.length}>
      <p className="dt-hint">{tr('展开服务可查看诊断详情。暂停与启动中的服务会单独标记。',
        'Expand a service for diagnostics. Paused and starting services have their own status.')}</p>
      {health.length ? <div className="dt-health-list">{health.map(([name, value]) => <details key={name} className="dt-health-item">
        <summary><span className="dt-health-name">{valueLabel(t, 'health', name)}</span>
          <Tag tone={healthTone(value.state)}>{healthLabel(value.state)}</Tag><Icon name="chevron-down" size={14} /></summary>
        <div className="dt-health-detail"><p>{healthText(t, value) || tr('暂无诊断信息', 'No diagnostics available')}</p>
          {value.at && <span className="dt-hint">{tr('最近更新', 'Last update')} <When at={value.at} /></span>}</div>
      </details>)}</div> : <p className="dt-hint">{tr('服务尚未报告运行状态。', 'Services have not reported their status yet.')}</p>}
    </Section>

    <details className="dt-advanced"><summary>{tr('运行环境与诊断信息', 'Runtime environment & diagnostics')}</summary>
      <dl className="dt-kv"><dt>{tr('数据目录', 'Data directory')}</dt><dd className="dt-mono">{state.setup.machine.stateDir}</dd>
        <dt>{tr('GitHub 身份', 'GitHub identity')}</dt><dd>{accounts?.agent ?? t('unsetValue')}</dd>
        <dt>{tr('飞书机器人', 'Feishu bot')}</dt><dd>{accounts?.feishu?.name ?? t('unsetValue')}</dd></dl>
    </details>
  </div>
}
