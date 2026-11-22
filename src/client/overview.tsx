/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
import type { ReactNode } from 'react'
import { usePoll, type Problem } from './api.ts'
import { Button, Icon, Tag, type TagTone } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { healthText, localized, reasonLabel, valueLabel, readableMarkers } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LoadState, Section, SetupMessage } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

export function OverviewPage() {
  const { t, call, navigate } = usePanel()
  const { setup, state } = usePanelData()
  const tr = (zh: string, en: string) => t('lang') === 'en' ? en : zh
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  if (!data) return <LoadState error={error} loading />
  const paused = !!state?.paused
  const status: { tone: TagTone; label: string; message: string } = error
    ? { tone: 'warning', label: tr('更新失败', 'Update failed'), message: tr('当前展示上次读取的数据，请刷新重试。', 'Showing the last available data. Refresh to try again.') }
    : setup?.problem ? { tone: 'warning', label: tr('待完成接入', 'Setup required'), message: tr('先完成接入检查，再开始处理研发需求。', 'Complete the setup checks before processing development requests.') }
    : paused ? { tone: 'warning', label: tr('接单已暂停', 'Processing paused'), message: tr('新的任务暂不执行，已有记录与待办会继续保留。', 'New work is paused. Existing records and pending actions are preserved.') }
    : data.problems.length ? { tone: 'warning', label: tr('需要关注', 'Needs attention'), message: tr(`有 ${data.problems.length} 项运行问题，请查看下方处理入口。`, `${data.problems.length} operational issues have actions below.`) }
    : { tone: 'success', label: tr('运行正常', 'Operational'), message: data.executor.running
      ? tr('AI 正在处理研发任务，需人工决策的事项会显示在下方。', 'AI is working on development tasks. Human decisions appear below.')
      : tr('从已接入的 GitHub 或飞书提交需求，任务进度会汇总到这里。', 'Submit requests through connected GitHub or Feishu channels. Progress appears here.') }
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  return <>
    <section className="dt-overview-hero" aria-label={tr('工作台概况', 'Workspace summary')}>
      <div className="dt-overview-intro">
        <div className="dt-overview-eyebrow"><Icon name="inbox" size={16} /><span>{setup?.accounts?.repository ?? tr('研发工作台', 'Development workspace')}</span>
          <Tag tone={status.tone}>{status.label}</Tag></div>
        <h2>{data.person.length ? tr(`${data.person.length} 项任务需要你处理`, `${data.person.length} tasks need your input`)
          : tr('任务进度，尽在掌握', 'Keep your work in view')}</h2>
        <p>{status.message}</p>
      </div>
      <div className="dt-overview-actions">
        <Button variant="primary" icon={<Icon name="queue" size={16} />} onClick={() => navigate({ page: 'execution' })}>
          {tr('查看全部任务', 'View all tasks')}</Button>
        {error ? <Button variant="outline" icon={<Icon name="refresh" size={14} />} onClick={() => { void reload() }}>{tr('刷新状态', 'Refresh status')}</Button>
          : <Button variant="outline" icon={<Icon name="hash" size={14} />} onClick={() => navigate({ page: 'source' })}>
            {tr('查看接单入口', 'View intake channels')}</Button>}
      </div>
    </section>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('pendingTickets')} count={data.person.length}>
      {data.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <div className="dt-empty-state dt-inbox-empty"><Icon name="decision" size={28} />
          <strong>{tr('当前没有需要你处理的工单', 'No tasks need your input')}</strong>
          <p className="dt-hint">{data.problems.length ? tr('运行问题仍需关注，请继续查看下方提示。', 'Operational issues still need attention. Review the notices below.')
            : data.executor.running ? tr('执行中的任务会持续推进；遇到问题或需要确认时会在这里提醒。', 'Active tasks are progressing. Questions and failures will appear here.')
            : tr('在已授权的 GitHub 或飞书入口提交研发需求，AI 会按接单规则处理。', 'Submit development requests in authorized GitHub or Feishu channels. AI will follow your intake rules.')}</p>
        </div>}

    </Section>
    {data.problems.length > 0 && <Section title={t('problems')} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
  </>
}
