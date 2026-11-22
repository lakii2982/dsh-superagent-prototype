// @vitest-environment jsdom
// Manager mode inside the unified panel: one rail, one detail column, and each repository's own pages through the proxy.
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { openManagerArea } from '../src/client/route.ts'
import type { ManagerView, RepositoryView } from '../src/client/manager.tsx'
import { zh } from '../src/client/locales.ts'
import { activeRail, all, click, field, mount, rail, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

const repository = (id: string, name: string, remote: string, pending: number, online = true): RepositoryView => ({
  id, name, remote, directory: `/projects/${name}`, githubCli: '/bin/gh-agent', allowedGithub: ['alice'], allowedFeishu: [],
  enabled: true, port: 4500, profile: `superagent-${id.slice(0, 8)}`,
  status: { online, configured: online }, starting: false, url: 'http://127.0.0.1:4500',
  pending: { total: pending, byChat: pending ? { oc_team: pending } : {} },
  readiness: { instance: { state: 'ok' }, repository: { state: 'ok' }, agent: { state: 'ok' }, feishu: { state: 'ok' },
    delivery: { state: pending ? 'pending' : 'ok', pending, byChat: pending ? { oc_team: pending } : {} } },
})
const manager = (): ManagerView => ({
  revision: 2, bot: { name: 'Paimon', id: 'ou_bot' }, botCli: '/bin/lark-bot', workspaces: ['/projects'],
  enterprisePilot: true, capacity: { maxRunningRepositories: 12, runningRepositories: 2 },
  repositories: [
    { ...repository('repo-a', 'acme/widgets', 'acme/widgets', 2), teamName: '平台研发', productLines: ['运营工作台', '数据门户'],
      allowedGithub: ['alice', 'bob'], allowedFeishu: ['ou_alice'] },
    { ...repository('repo-b', 'acme/other', 'acme/other', 0), teamName: '基础设施', productLines: ['数据门户'],
      allowedGithub: ['ALICE', 'charlie'], enabled: false },
  ],
  bindings: [{ chatId: 'oc_team', repositoryId: 'repo-a', enabled: true, effectiveAt: '2026-01-01T00:00:00Z' }],
  chats: { oc_team: 'Team' },
  health: { feishu: { state: 'error', detail: 'Bot CLI needs attention' }, delivery: { state: 'ready', detail: '' } },
  pending: [{ id: 'q1', repositoryId: 'repo-a', chatId: 'oc_team', hold: 'group-disabled' }],
  queues: { total: 2, byRepository: { 'repo-a': 2, 'repo-b': 0 }, byChat: { oc_team: 2 } },
})
usePanel(manager())

it('renders the manager control plane in the shared shell with one rail and no page tabs', async () => {
  await mount()
  expect(document.querySelector('.dt-shell')).not.toBeNull()
  expect(all('[role="tab"]')).toHaveLength(0)
  expect(all('.dt-rail-group-title').map(item => item.textContent)).toEqual(['管理', '已登记仓库'])
  expect(all('.dt-rail-label').map(item => item.textContent)).toEqual(['仓库管理', '投递与状态', '群聊绑定', '飞书机器人', 'acme/widgets',
    'acme/other'])
  expect(activeRail()).toBe('仓库管理')
  expect(text()).toContain('接入进度')
  expect(text()).toContain('统一研发工作台')
  expect(text()).toContain('把群聊绑定到仓库')
  expect(text()).toContain('接单群聊 Team')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click('添加仓库')
  expect(field<HTMLInputElement>('本地仓库根目录').required).toBe(false)
  expect(field<HTMLInputElement>('名称')).toBeTruthy()
  expect(text()).toContain('高级连接设置')
  expect(field<HTMLInputElement>('执行账号的 GitHub CLI').value).toBe('/bin/gh-agent')
  expect(text()).toContain('运行名额 2 / 12')
  expect(rail('acme/widgets').querySelector('.dt-rail-count')?.textContent).toBe('2')
})

it('opens each repository\'s own panel pages through the manager proxy', async () => {
  await mount()
  await click(rail('acme/widgets'))
  expect(activeRail()).toBe('收件箱')
  expect(all('.dt-rail-group-title').map(item => item.textContent)).toEqual(['管理', '已登记仓库', '工作台', '流程', '配置'])
  expect(all('[role="tab"]')).toHaveLength(0)
  expect(server.proxied.some(request => request.repository === 'repo-a' && request.path === 'state')).toBe(true)
  expect(server.proxied.some(request => request.repository === 'repo-a' && request.path === 'overview')).toBe(true)
  expect(all('button').some(button => button.textContent === zh['manager.openWorkspace'])).toBe(true)
  await click(rail('设置'))
  expect(activeRail()).toBe('设置')
  expect(server.proxied.some(request => request.repository === 'repo-a' && request.path === 'settings')).toBe(true)
  // Switching repositories switches the proxy credential and the pages; no standalone data leaks between them.
  await click(rail('acme/other'))
  expect(server.proxied.some(request => request.repository === 'repo-b' && request.path === 'state')).toBe(true)
})

it('keeps every manager control page reachable from a repository without losing its form fields', async () => {
  await mount()
  await click(rail('acme/widgets'))
  await click(rail('群聊绑定'))
  expect(activeRail()).toBe('群聊绑定')
  expect(text()).toContain('把群聊绑定到仓库')
  expect(field<HTMLSelectElement>('飞书群')).toBeTruthy()
  expect(field<HTMLSelectElement>('目标仓库')).toBeTruthy()
  await click(rail('投递与状态'))
  expect(activeRail()).toBe('投递与状态')
  expect(text()).toContain('2 条消息待投递')
  expect(text()).toContain('群已停用，消息保留待恢复')
  await click(rail('飞书机器人'))
  expect(activeRail()).toBe('飞书机器人')
  expect(text()).toContain('当前机器人')
  expect(text()).toContain('Paimon')
  await click(rail('仓库管理'))
  expect(activeRail()).toBe('仓库管理')
  expect(text()).toContain('团队仓库')
  await click('添加仓库')
  expect(field<HTMLInputElement>('名称')).toBeTruthy()
})

it('opens binding from a repository and saves the selected group members with the same request', async () => {
  const fetch = globalThis.fetch
  const write = vi.fn()
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url === '/orchestrator/manager/chats/oc_team/members') {
      return Promise.resolve(Response.json({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_eve', name: 'Eve' }] }))
    }
    if (url === '/orchestrator/manager/bindings' && options?.method === 'PUT') {
      write(JSON.parse(String(options.body)))
      return Promise.resolve(Response.json(manager()))
    }
    return fetch(url, options)
  })
  await mount()
  await click('绑定飞书群')
  expect(activeRail()).toBe('群聊绑定')
  expect(field<HTMLSelectElement>('目标仓库').value).toBe('repo-a')
  await type(field<HTMLSelectElement>('飞书群'), 'oc_team')
  expect(text()).toContain('允许接单的群成员')
  const alice = document.querySelector<HTMLInputElement>('input[type="checkbox"]:disabled')!
  const eve = document.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)')!
  expect(alice.checked).toBe(true)
  expect(eve.checked).toBe(false)
  await click(eve)
  await click('保存绑定与授权')
  expect(write).toHaveBeenCalledWith({ revision: 2, bindings: [{ chatId: 'oc_team', repositoryId: 'repo-a', enabled: true }],
    grant: { chatId: 'oc_team', repositoryId: 'repo-a', memberIds: ['ou_eve'] } })
  expect(text()).toContain('已将 Team 绑定到 acme/widgets')
  await click('回仓库管理启动服务')
  expect(activeRail()).toBe('仓库管理')
})

it('shows all teams in the same manager and filters repository contents and counts by team', async () => {
  await mount()
  expect(all('.dt-manager-metric').map(item => item.textContent).join(' ')).toContain('已登记团队2')
  expect(text()).toContain('产品线 2')
  expect(text()).toContain('GitHub 授权身份 3')
  expect(text()).toContain('飞书授权身份 1')
  const cards = () => all('.dt-card > .dt-card-head .dt-row-title').map(item => item.textContent)
  expect(cards()).toEqual(['acme/widgets', 'acme/other'])
  await type(field<HTMLSelectElement>('按研发团队筛选'), 'team:基础设施')
  expect(activeRail()).toBe('仓库管理')
  expect(text()).toContain('产品线 1')
  expect(text()).toContain('待投递消息 0')
  expect(cards()).toEqual(['acme/other'])
  await type(field<HTMLSelectElement>('按研发团队筛选'), '')
  expect(cards()).toHaveLength(2)
})

it('edits repository team and product lines without enabling a disabled registration', async () => {
  const fetch = globalThis.fetch
  const write = vi.fn()
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url === '/orchestrator/manager/repositories/repo-b' && options?.method === 'PUT') {
      write(JSON.parse(String(options.body)))
      return Promise.resolve(Response.json(manager()))
    }
    return fetch(url, options)
  })
  await mount()
  await click(all('.dt-card')[1]!.querySelector<HTMLButtonElement>('button:nth-of-type(2)')!)
  expect(field<HTMLInputElement>('研发团队').value).toBe('基础设施')
  expect(field<HTMLTextAreaElement>('产品线').value).toBe('数据门户')
  await type(field<HTMLInputElement>('研发团队'), '')
  await type(field<HTMLTextAreaElement>('产品线'), '门户 V2\n 质量,报表 \n门户 V2')
  await click('保存仓库设置')
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ teamName: null, productLines: ['门户 V2', '质量,报表'], enabled: false }))
})

it('holds the shared manager behind a memory-only operator token and forwards it to repository APIs', async () => {
  const fetch = globalThis.fetch
  const token = 'a'.repeat(64)
  const seen: { url: string; authorization: string | null; redirect?: RequestRedirect }[] = []
  let currentToken = token
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url.startsWith('/orchestrator/manager/')) {
      const authorization = new Headers(options?.headers).get('authorization')
      seen.push({ url, authorization, redirect: options?.redirect })
      if (authorization !== `Bearer ${currentToken}`) return Promise.resolve(Response.json({ code: 'operator_auth_required' }, { status: 401 }))
    }
    return fetch(url, options)
  })
  await mount()
  expect(text()).toContain('登录管理面板')
  expect(text()).not.toContain('acme/widgets')
  const login = async (credential: string) => {
    await type(field<HTMLInputElement>('运维令牌'), credential)
    await click('解锁面板')
  }
  await login('b'.repeat(64))
  expect(text()).toContain('令牌未获授权')
  await login(token)
  expect(activeRail()).toBe('仓库管理')
  expect(all('input[type="password"]')).toHaveLength(0)
  await click('打开仓库详情')
  expect(activeRail()).toBe('收件箱')
  expect(seen).toContainEqual({ url: '/orchestrator/manager/repositories/repo-a/api/state', authorization: `Bearer ${token}`, redirect: 'error' })
  expect(seen.some(({ url }) => url.endsWith('/open'))).toBe(false)
  expect(all('button').some(button => button.textContent === zh['manager.openWorkspace'])).toBe(false)
  expect(JSON.stringify(sessionStorage)).not.toContain(token)
  expect(JSON.stringify(localStorage)).not.toContain(token)
  await click('锁定面板')
  expect(text()).toContain('登录管理面板')
  await login(token)
  expect(activeRail()).toBe('收件箱')
  currentToken = 'c'.repeat(64)
  await click(rail('设置'))
  expect(text()).toContain('登录管理面板')
  expect(text()).not.toContain('acme/widgets')
})


it('combines repository search with product and status filters, and recovers from an empty result', async () => {
  await mount()
  const cards = () => all('.dt-repository-card .dt-card-head .dt-row-title').map(item => item.textContent)
  await type(field<HTMLSelectElement>('按产品线筛选'), '运营工作台')
  expect(cards()).toEqual(['acme/widgets'])
  await type(field<HTMLInputElement>('搜索仓库'), 'other')
  expect(cards()).toEqual([])
  expect(text()).toContain('没有匹配的仓库')
  await click('清除筛选')
  expect(cards()).toHaveLength(2)
  await type(field<HTMLSelectElement>('按运行状态筛选'), 'stopped')
  expect(cards()).toHaveLength(0)
})

it('normalizes a GitHub URL and retains the execution account while creating a repository', async () => {
  const fetch = globalThis.fetch
  const write = vi.fn()
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url === '/orchestrator/manager/repositories' && options?.method === 'POST') {
      write(JSON.parse(String(options.body)))
      return Promise.resolve(Response.json(manager()))
    }
    return fetch(url, options)
  })
  await mount()
  await click('添加仓库')
  await type(field<HTMLInputElement>('GitHub 仓库'), 'https://github.com/acme/ai-workspace.git')
  expect(field<HTMLInputElement>('名称').value).toBe('ai-workspace')
  await type(field<HTMLInputElement>('研发团队'), '平台研发')
  await type(field<HTMLInputElement>('允许接单的 GitHub 用户名，以空格分隔'), 'alice alice')
  await click(field<HTMLTextAreaElement>('必需的 CI 检查').closest('details')!.querySelector('summary')!)
  await type(field<HTMLTextAreaElement>('必需的 CI 检查'), ' ci/test \nci/typecheck\nci/test\n')
  await click('检查并添加仓库')
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ remote: 'acme/ai-workspace', name: 'ai-workspace',
    githubCli: '/bin/gh-agent', teamName: '平台研发', allowedGithub: ['alice'], directory: '', requiredChecks: ['ci/test', 'ci/typecheck'] }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(text()).toContain('已添加 ai-workspace')
})

it('keeps unsaved repository settings when closing is cancelled', async () => {
  await mount()
  await click('添加仓库')
  await type(field<HTMLInputElement>('GitHub 仓库'), 'acme/new')
  await click('取消')
  expect(text()).toContain('有未保存的修改')
  await click('继续编辑')
  expect(field<HTMLInputElement>('GitHub 仓库').value).toBe('acme/new')
  await click('取消')
  await click('放弃修改')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('opens a stopped repository without contacting its unavailable panel API', async () => {
  const fetch = globalThis.fetch
  const stopped = manager()
  stopped.repositories[0]!.status.online = false
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => url === '/orchestrator/manager/state'
    ? Promise.resolve(Response.json(stopped)) : fetch(url, options))
  await mount()
  await click(rail('acme/widgets'))
  expect(text()).toContain('仓库已接入，服务尚未运行')
  expect(server.proxied).toHaveLength(0)
  expect(all('button').some(button => button.textContent === '启动服务')).toBe(true)
  await click('绑定飞书群')
  expect(field<HTMLSelectElement>('目标仓库').value).toBe('repo-a')
})

it('responds to settings-page manager navigation events without losing the unified shell', async () => {
  await mount()
  await act(async () => { openManagerArea('feishu') })
  expect(activeRail()).toBe('飞书机器人')
  expect(text()).toContain('一个机器人，连接所有团队')
  expect(document.querySelector('[aria-label="机器人 CLI 路径或命令"]')).toBeNull()
  await click('修改机器人连接')
  expect(field<HTMLInputElement>('机器人 CLI 路径或命令').value).toBe('/bin/lark-bot')
})


it('refreshes tasks only for online repositories and distinguishes stopped from empty', async () => {
  const fetch = globalThis.fetch
  const state = manager()
  state.repositories[1]!.status.online = false
  const requested: string[] = []
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url === '/orchestrator/manager/state') return Promise.resolve(Response.json(state))
    if (url.endsWith('/tasks')) { requested.push(url); return Promise.resolve(Response.json({ items: [] })) }
    return fetch(url, options)
  })
  await mount()
  await click(rail('投递与状态'))
  expect(text()).toContain('点击「刷新任务」')
  expect(text()).toContain('服务未运行，启动后可读取该仓库的任务')
  await click('刷新任务')
  expect(requested).toEqual(['/orchestrator/manager/repositories/repo-a/tasks'])
  expect(text()).toContain('当前没有开放任务')
  expect(text()).not.toContain('点击「刷新任务」')
  const delivery = all('.dt-card').find(card => card.textContent?.includes('消息投递'))!
  expect(delivery.querySelector('.dt-tag')?.getAttribute('data-tone')).toBe('success')
})

it('reveals required advanced fields when native validation rejects a collapsed section', async () => {
  const fetch = globalThis.fetch
  const state = manager()
  state.enterprisePilot = false
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => url === '/orchestrator/manager/state'
    ? Promise.resolve(Response.json(state)) : fetch(url, options))
  await mount()
  await click('添加仓库')
  await type(field<HTMLInputElement>('GitHub 仓库'), 'acme/new')
  const directory = field<HTMLInputElement>('本地仓库根目录')
  const advanced = directory.closest('details')!
  await act(async () => { advanced.open = false; advanced.dispatchEvent(new Event('toggle')) })
  await click('检查并添加仓库')
  expect(advanced.open).toBe(true)
  expect(text()).toContain('请补全高级连接设置中的必填项')
})


it('does not overwrite concurrent access changes with an older repository draft', async () => {
  const fetch = globalThis.fetch
  let current = manager()
  const write = vi.fn()
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url === '/orchestrator/manager/state') return Promise.resolve(Response.json(current))
    if (url === '/orchestrator/manager/repositories/repo-a' && options?.method === 'PUT') {
      write(JSON.parse(String(options.body)))
      return Promise.resolve(Response.json(current))
    }
    return fetch(url, options)
  })
  await mount()
  await click('仓库设置')
  await type(field<HTMLInputElement>('研发团队'), '新团队')
  current = { ...manager(), revision: 3 }
  current.repositories[0]!.allowedGithub = ['bob']
  // A state refresh simulates the same update as the background manager poll.
  await click(zh['manager.refresh'])
  await click('保存仓库设置')
  expect(write).not.toHaveBeenCalled()
  expect(text()).toContain('配置已被其他操作更新')
  expect(field<HTMLInputElement>('研发团队').value).toBe('新团队')
  await click('重新读取仓库设置')
  expect(field<HTMLInputElement>('允许接单的 GitHub 用户名，以空格分隔').value).toBe('bob')
  await click('保存仓库设置')
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ revision: 3, allowedGithub: ['bob'] }))
})


it('preserves required CI checks when editing other repository settings, and can update the check list', async () => {
  const fetch = globalThis.fetch
  const state = manager()
  state.repositories[0]!.requiredChecks = ['build / linux', 'test']
  const write = vi.fn()
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url === '/orchestrator/manager/state') return Promise.resolve(Response.json(state))
    if (url === '/orchestrator/manager/repositories/repo-a' && options?.method === 'PUT') {
      write(JSON.parse(String(options.body)))
      return Promise.resolve(Response.json(state))
    }
    return fetch(url, options)
  })
  await mount()
  await click('仓库设置')
  expect(field<HTMLTextAreaElement>('必需的 CI 检查').value).toBe('build / linux\ntest')
  await type(field<HTMLInputElement>('研发团队'), '研发一队')
  await click('保存仓库设置')
  expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ teamName: '研发一队', requiredChecks: ['build / linux', 'test'] }))
  await click('仓库设置')
  await click(field<HTMLTextAreaElement>('必需的 CI 检查').closest('details')!.querySelector('summary')!)
  await type(field<HTMLTextAreaElement>('必需的 CI 检查'), 'build / linux\n test \nsecurity scan\n test')
  await click('保存仓库设置')
  expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ requiredChecks: ['build / linux', 'test', 'security scan'] }))
})
