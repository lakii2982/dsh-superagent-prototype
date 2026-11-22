// @vitest-environment jsdom
// The overview.
import { expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, rail, activeRail, click, text } from './fixtures/panel.tsx'
import { server, droppedReply, threadSummary } from './fixtures/panel-server.ts'

usePanel()
it('leads the overview with the pending Tickets, then problems, the last day and the Executor, each linking to its stage', async () => {
  await mount()
  expect(activeRail()).toBe(zh['nav.inbox'])
  expect(all('.dt-rail-label').map(item => item.textContent)).toEqual(['收件箱', '任务', '仓库', '来源', '触发', '评估', '提示词', '设置'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['待处理工单2', '系统问题2', '过去 24 小时详情 ›', '执行器详情 ›'])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['待回答', '待处理失败'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('来源会在每次轮询时自动重试')
  expect(text()).toContain('需要确认按钮颜色')
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['到达12', '被过滤2', '已评估5', '接单或续做1', '执行中2 / 3', '排队0', '等待新触发1'])
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI 失败1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI 失败1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
  await click(all('.dt-more-link').at(-1)!)
  expect(activeRail()).toBe(zh['nav.tasks'])
})

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('follows the last day\'s counts to the status of each stage', async () => {
  await mount()
  // Arrived Triggers include filtered ones, which have no Thread, so no list has that count to link to.
  expect(all('.dt-stat button').map(button => button.textContent)).toEqual(['2', '1'])
  await click(all('.dt-stat button')[0]!)
  expect(activeRail()).toBe(zh['tab.source'])
  await click(zh.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(zh['reason.source_disabled'])
})

it('offers each Ticket that needs a person its actions on the overview: answer in its Channel, retry or open a failed worker, and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  await click(zh.retry)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  await click(all('.dt-ticket-actions button').find(button => button.textContent === '打开 Session')!)
  expect(server.opened).toEqual(['worker-t4'])
  await click(all('.dt-ticket-actions button').filter(button => button.textContent === '停止').at(-1)!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('截图工具')
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(text()).toContain(zh.problemPaused)
  await click(rail(zh['tab.eval']))
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(activeRail()).toBe(zh['nav.tasks'])
  await click(rail(zh['nav.inbox']))
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})

it('offers the step that fixes a settings problem as a button on the overview', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(activeRail()).toBe(zh['tab.settings'])
  expect(document.querySelector('.dt-settings')?.getAttribute('data-active')).toBe('eval')
})

it('counts the messages not sent in the last day, linking to the Source status, and shows nothing when there are none', async () => {
  await mount()
  expect(all('.dt-stat-label').map(label => label.textContent)).not.toContain(zh.flowDroppedLabel)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  const stat = all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === zh.flowDroppedLabel)!
  expect(stat.textContent).toBe(`${zh.flowDroppedLabel}2`)
  await click(stat.querySelector('button')!)
  expect(activeRail()).toBe(zh['tab.source'])
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after the overview loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-ticket-actions button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
  expect(text()).not.toContain('Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed')
})

it('shows the overview in English', async () => {
  await mount(en)
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.pendingTickets}2`, `${en.problems}2`,
    `${en.lastDay}${en.details}`, `${en['term.executor']}${en.details}`])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.flowReceivedLabel, en.flowFilteredLabel, en.flowJudgedLabel,
    en.flowAcceptedLabel, en.executingLabel, en.queuedLabel, en.idleLabel])
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings')?.getAttribute('data-active')).toBe('source')
  await click(rail(zh['nav.inbox']))
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})


it('summarizes real work and exposes the two daily destinations before the detailed lists', async () => {
  await mount()
  const hero = document.querySelector('.dt-overview-hero')!
  expect(hero.textContent).toContain('2 项任务需要你处理')
  expect(hero.textContent).toContain('有 2 项运行问题')
  expect(hero.querySelector('.dt-tag')?.getAttribute('data-tone')).toBe('warning')
  await click('查看全部任务')
  expect(activeRail()).toBe(zh['nav.tasks'])
  await click(rail(zh['nav.inbox']))
  await click('查看接单入口')
  expect(activeRail()).toBe(zh['tab.source'])
})

it('does not claim everything is clear when the inbox is empty but a service needs attention', async () => {
  server.person = []
  await mount()
  expect(document.querySelector('.dt-inbox-empty')?.textContent).toContain('当前没有需要你处理的工单')
  expect(document.querySelector('.dt-inbox-empty')?.textContent).toContain('运行问题仍需关注')
  expect(document.querySelector('.dt-overview-hero .dt-tag')?.textContent).toBe('需要关注')
})

it('keeps diagnostic paths and logs collapsed and labels each repository health state accurately', async () => {
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    const response = await original(url, options)
    if (url !== '/orchestrator/api/state') return response
    const state = JSON.parse(await response.text())
    return Response.json({ ...state, health: {
      github: { state: 'starting', detail: 'starting a command' },
      feishu: { state: 'paused', detail: 'Waiting for a binding' },
      worker: { state: 'ready', detail: 'Worker events are handled' },
      launch: { state: 'error', detail: 'spawn failed' },
    } })
  })
  await mount()
  await click(rail(zh['nav.repository']))
  const hero = document.querySelector('.dt-repo-hero')!
  expect(hero.textContent).not.toContain('/srv/dsh-superagent')
  expect(hero.textContent).not.toContain('当前部署只有一个仓库')
  expect(hero.querySelector('.dt-tag')?.textContent).toBe('有服务异常')
  const health = all('.dt-health-item')
  expect(health.map(item => item.querySelector('summary .dt-tag')?.textContent)).toEqual(['启动中', '已暂停', '正常', '异常'])
  expect(health.map(item => item.querySelector('summary .dt-tag')?.getAttribute('data-tone'))).toEqual(['info', 'warning', 'success', 'danger'])
  expect(health.every(item => !(item as HTMLDetailsElement).open)).toBe(true)
  const advanced = document.querySelector<HTMLDetailsElement>('.dt-advanced')!
  expect(advanced.open).toBe(false)
  expect(advanced.textContent).toContain('/srv/dsh-superagent')
})

it('offers retry instead of an endless repository loading label when state cannot be read', async () => {
  const original = globalThis.fetch
  let unavailable = true
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => url === '/orchestrator/api/state' && unavailable
    ? Promise.resolve(Response.json({ error: 'Temporarily unavailable' }, { status: 503 })) : original(url, options))
  await mount()
  await click(rail(zh['nav.repository']))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('暂时无法读取仓库状态')
  unavailable = false
  await click('重新读取')
  expect(document.querySelector('.dt-repo-hero')).not.toBeNull()
})
