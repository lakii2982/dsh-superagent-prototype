// @vitest-environment jsdom
// The Deployment settings and the Plugin Manager page.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginConfig } from '../src/client/deployment.tsx'
import type { ManagerView } from '../src/client/manager.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, rail, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm } from './fixtures/panel-server.ts'

usePanel()

it('opens the shared manager from the single-repository desktop panel after the host confirms the switch', async () => {
  const { form, mutations, publish } = fakeForm()
  // Desktop rc.5 does not include the newer snapshot.mode field.
  publish({ mode: undefined })
  let mode: 'standalone' | 'manager' = 'standalone'
  server.form = { ...form, mutate: async (...args) => {
    const changed = await form.mutate(...args)
    if (changed) mode = 'manager'
    return changed
  } }
  const fetchFromFixture = fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url === '/orchestrator/mode') return Promise.resolve(Response.json({ mode, desktopMultiRepository: mode === 'manager' }))
    if (url === '/orchestrator/manager/state') return Promise.resolve(Response.json({ revision: 1, bot: null, botCli: '',
      workspaces: [], repositories: [], bindings: [], chats: {}, health: {}, pending: [], enterprisePilot: true,
      capacity: { maxRunningRepositories: 12, runningRepositories: 0 } }))
    return fetchFromFixture(url, init)
  })
  await mount()
  expect(find('启用多仓管理')).toHaveProperty('disabled', true)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await remount()
  await click('启用多仓管理')
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['desktopMultiRepository'], value: true }] }])
  expect(rail(zh['manager.bindings'])).toBeTruthy()
  expect(text()).toContain('0 / 12')
})

it('saves this machine\'s settings in the Deployment settings through DSH\'s configuration form, without a restart', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  await mount()
  await click(rail(zh['tab.settings']))
  const deployment = () => document.querySelector('[data-group="deployment"]')!
  expect(deployment().textContent).toContain('/srv/dsh-superagent')
  // Accounts are on the Source settings; the Plugin Manager page, where those are not at hand, shows them here.
  expect(deployment().textContent).not.toContain('@agent-bot')
  for (const moved of ['仓库克隆', '工单 worktree 目录', '禁用的命令']) expect(deployment().textContent).not.toContain(moved)
  expect(text()).toContain(zh.deploymentIntro)
  // A limit applies at once, so a draft of one says only that it is unsaved, even while Assignments run.
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${zh.draftKept}${zh.discard}${zh.save}`)
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
  expect(text()).not.toContain(zh.savedRestarting)
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('20000')
})

it('keeps a refused Deployment change as a draft, and shows the settings read-only without a writable form', async () => {
  const refusing = fakeForm(true, false)
  server.form = refusing.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '200000')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentRefused)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  server.form = fakeForm(false).form
  await remount()
  expect(text()).toContain(zh.deploymentReadOnly)
  server.form = undefined
  await remount()
  expect(text()).toContain('这个 DSH 版本不提供配置表单')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === '保存')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  // The Plugin Manager page saves another field of the same entry meanwhile.
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  expect(text()).toContain('设置已在别处修改，你的修改已合并到最新版本')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('50000')
  await click(zh.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('renders the Deployment page with the derived accounts in the Plugin Manager, and no summary', async () => {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  // Remount from scratch on each render to match Plugin Manager page navigation.
  const render = async (view: 'page' | 'summary') => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    const form = server.form
    await act(async () => { root.render(<PluginConfig t={translator(zh)} view={view} form={form && { state: form.getSnapshot(),
      mutate: form.mutate }} />) })
    await settle()
  }
  await render('summary')
  expect(container.textContent).toBe('')
  server.form = fakeForm().form
  await render('page')
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot', '账号在 dsh-superagent 面板的来源设置里修改。']) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render('page')
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
  server.down = true
  await render('page')
  expect(text()).toContain(zh.hostNotRunning)
})

it('tells a dsh-superagent that is starting from a browser that cannot write on the Deployment page', async () => {
  const { form: shared, publish } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const limit = () => field<HTMLInputElement>(zh.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // While dsh-superagent restarts, DSH stops serving its entry; the values come back editable once it is served again.
  await act(async () => { publish({ status: 'unavailable' }) })
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ mode: 'memory', status: 'unavailable', writable: false }) })
  expect(text()).toContain(zh.deploymentReadOnly)
})

it('reads the state every second after a setup check, until dsh-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})


it('shows live enterprise plugin settings, routes to management, and verifies only an explicitly saved bot connection', async () => {
  const { form, mutations } = fakeForm()
  const open = vi.fn()
  const writes: unknown[] = []
  let rejectBot = false
  let manager: ManagerView = { revision: 1, bot: { id: 'ou_bot', name: '研发助手' }, botCli: '/bin/lark-bot',
    workspaces: [], repositories: [{ id: 'repo-1', name: 'ai-workspace', remote: 'acme/ai-workspace', directory: '',
      githubCli: 'gh', allowedGithub: ['alice'], allowedFeishu: [], teamName: '研发一组', productLines: ['AI 工作台'],
      enabled: true, profile: 'repo-1', port: 4500, status: { online: false }, starting: false, url: 'http://127.0.0.1:4500' }],
    bindings: [], chats: {}, health: {}, pending: [], enterprisePilot: true,
    capacity: { maxRunningRepositories: 12, runningRepositories: 0 } }
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url === '/orchestrator/mode') return Promise.resolve(Response.json({ mode: 'manager', desktopMultiRepository: true }))
    if (url === '/orchestrator/manager/state') return Promise.resolve(Response.json(manager))
    if (url === '/orchestrator/manager/bot' && init?.method === 'PUT') {
      if (rejectBot) return Promise.resolve(Response.json({ error: 'Bot identity is unavailable' }, { status: 400 }))
      const body = JSON.parse(String(init.body)) as { cli: string }
      writes.push(body); manager = { ...manager, botCli: body.cli, bot: { id: 'ou_bot', name: '已验证机器人' } }
      return Promise.resolve(Response.json(manager))
    }
    throw new Error(`Unexpected request ${url}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  await act(async () => { root.render(<PluginConfig t={translator(zh)} view="page" form={{ state: form.getSnapshot(),
    mutate: form.mutate }} onOpenManager={open} />) }); await settle()
  expect(container.querySelector('.dt-plugin-metrics')?.textContent).toBe('1研发团队1产品线1已接入仓库0运行中的仓库')
  expect(text()).toContain('研发助手')
  expect(text()).toContain('还没有启用群聊绑定')
  expect(writes).toHaveLength(0)
  expect(mutations).toHaveLength(0)
  await click(container.querySelector('.dt-plugin-link') as HTMLElement)
  expect(open).toHaveBeenCalledWith('repositories')
  await click('修改连接')
  expect(field<HTMLInputElement>('机器人 CLI 路径或命令').value).toBe('/bin/lark-bot')
  await type(field<HTMLInputElement>('机器人 CLI 路径或命令'), '/bin/new-lark-bot')
  expect(writes).toHaveLength(0)
  rejectBot = true
  await click('验证并保存')
  expect(text()).toContain('Bot identity is unavailable')
  expect(text()).toContain('研发助手')
  expect(text()).not.toContain('机器人连接已验证并保存。')
  expect(field<HTMLInputElement>('机器人 CLI 路径或命令').value).toBe('/bin/new-lark-bot')
  rejectBot = false
  await click('验证并保存')
  expect(writes).toEqual([{ cli: '/bin/new-lark-bot' }])
  expect(text()).toContain('机器人连接已验证并保存。')
  expect(text()).toContain('已验证机器人')
  expect(mutations).toHaveLength(0)
})

it('does not display empty enterprise metrics when manager access is locked', async () => {
  const open = vi.fn()
  vi.stubGlobal('fetch', (url: string) => Promise.resolve(url === '/orchestrator/mode'
    ? Response.json({ mode: 'manager' })
    : Response.json({ code: 'operator_auth_required' }, { status: 401 })))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  await act(async () => { root.render(<PluginConfig t={translator(zh)} view="page" form={undefined} onOpenManager={open} />) })
  await settle()
  expect(container.querySelector('.dt-plugin-metrics')).toBeNull()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('管理权限')
  await click('打开工作台')
  expect(open).toHaveBeenCalledWith('repositories')
})

it('manages multiple verified connections from native settings without replacing another bot', async () => {
  const { form } = fakeForm(), open = vi.fn(), writes: { path: string; body: unknown }[] = []
  let state: ManagerView = { revision: 4, bot: null, botCli: '', workspaces: [], repositories: [], bindings: [], chats: {}, health: {}, pending: [], bots: [
    { id: 'bot-a', botId: 'ou_a', appId: 'cli_a', brand: 'feishu', name: '平台助手', cli: '/bin/lark', profile: 'platform', enabled: true, connected: true, chats: { oc_a: '平台群' }, health: {} },
    { id: 'bot-b', botId: 'ou_b', appId: 'cli_b', brand: 'feishu', name: '设备助手', cli: '/bin/lark', profile: 'device', enabled: true, connected: true, chats: { oc_b: '设备群' }, health: {} },
  ] }
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url === '/orchestrator/mode') return Promise.resolve(Response.json({ mode: 'manager', desktopMultiRepository: true }))
    if (url === '/orchestrator/manager/state') return Promise.resolve(Response.json(state))
    if (url === '/orchestrator/manager/bots' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push({ path: url, body })
      state = { ...state, revision: 5, bots: [...state.bots!, { ...state.bots![0]!, id: 'bot-c', botId: 'ou_c', appId: 'cli_c', name: '测试助手', cli: body.cli, profile: body.profile, chats: {} }] }
      return Promise.resolve(Response.json(state))
    }
    if (url === '/orchestrator/manager/bots/bot-b' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push({ path: url, body })
      state = { ...state, revision: 6, bots: state.bots!.map(bot => bot.id === 'bot-b' ? { ...bot, cli: body.cli, profile: body.profile } : bot) }
      return Promise.resolve(Response.json(state))
    }
    throw new Error(`Unexpected request ${url}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  await act(async () => { root.render(<PluginConfig t={translator(zh)} view="page" form={{ state: form.getSnapshot(), mutate: form.mutate }} onOpenManager={open} />) })
  await settle()
  expect(container.querySelectorAll('.dt-plugin-bot-row')).toHaveLength(2)
  expect(text()).toContain('2 / 2 连接已验证')
  await click('添加机器人'); await type(field<HTMLInputElement>('机器人 CLI 路径或命令'), '/bin/lark'); await type(field<HTMLInputElement>('CLI 配置档案（Profile）'), 'qa'); await click('验证并保存')
  expect(writes[0]).toEqual({ path: '/orchestrator/manager/bots', body: { cli: '/bin/lark', profile: 'qa', revision: 4 } })
  expect(container.querySelectorAll('.dt-plugin-bot-row')).toHaveLength(3)
  expect(text()).toContain('平台助手'); expect(text()).toContain('设备助手'); expect(text()).toContain('测试助手')
  const beta = [...container.querySelectorAll('.dt-plugin-bot-row')].find(row => row.textContent?.includes('设备助手'))!
  await click(beta.querySelector('button')!); await type(field<HTMLInputElement>('CLI 配置档案（Profile）'), 'device-v2'); await click('取消')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('放弃未保存的连接修改')
  await click('继续编辑'); await click('验证并保存')
  expect(writes[1]).toEqual({ path: '/orchestrator/manager/bots/bot-b', body: { cli: '/bin/lark', profile: 'device-v2', revision: 5 } })
  expect(state.bots!.map(bot => [bot.cli, bot.profile])).toEqual([['/bin/lark', 'platform'], ['/bin/lark', 'device-v2'], ['/bin/lark', 'qa']])
  await click('管理机器人连接'); expect(open).toHaveBeenCalledWith('feishu')
  await click('管理群聊绑定'); expect(open).toHaveBeenCalledWith('bindings')
})

it('explains restricted history in native settings while retaining the healthy live connection', async () => {
  const { form } = fakeForm()
  const diagnostic = 'oc_team: Error: access denied for this bot operation (230027)'
  const state: ManagerView = { revision: 1, bot: null, botCli: '', workspaces: [], repositories: [], bindings: [], chats: {}, health: {}, pending: [], bots: [
    { id: 'bot-a', botId: 'ou_a', appId: 'cli_a', brand: 'feishu', name: '研发助手', cli: '/bin/lark', enabled: true, connected: true,
      chats: { oc_team: '研发群' }, health: { feishu: { state: 'ready', detail: 'Listening' }, history: { state: 'error', detail: diagnostic } } },
  ] }
  vi.stubGlobal('fetch', (url: string) => Promise.resolve(url === '/orchestrator/mode' ? Response.json({ mode: 'manager' }) : Response.json(state)))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  await act(async () => { root.render(<PluginConfig t={translator(zh)} view="page" form={{ state: form.getSnapshot(), mutate: form.mutate }} />) })
  await settle()
  const bot = container.querySelector('.dt-plugin-bot-row')!
  expect(bot.textContent).toContain('实时消息已连接；历史补收受限')
  expect(bot.textContent).toContain('历史消息补收：应用权限不足')
  expect(bot.textContent).not.toContain('连接异常')
  expect(bot.querySelector('.dt-tag')?.getAttribute('data-tone')).toBe('warning')
  const details = bot.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain(diagnostic)
})
