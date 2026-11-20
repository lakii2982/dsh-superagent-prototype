// @vitest-environment jsdom
// Manager mode inside the unified panel: one rail, one detail column, and each repository's own pages through the proxy.
import { expect, it } from 'vitest'
import type { ManagerView, RepositoryView } from '../src/client/manager.tsx'
import { zh } from '../src/client/locales.ts'
import { activeRail, all, click, field, mount, rail, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

const repository = (id: string, name: string, remote: string, pending: number, online = true): RepositoryView => ({
  id, name, remote, directory: `/projects/${name}`, githubCli: '/bin/gh-agent', allowedGithub: ['lakii2982'], allowedFeishu: [],
  enabled: true, port: 4500, profile: `superagent-${id.slice(0, 8)}`,
  status: { online, configured: online }, starting: false, url: 'http://127.0.0.1:4500',
  pending: { total: pending, byChat: pending ? { oc_team: pending } : {} },
  readiness: { instance: { state: 'ok' }, repository: { state: 'ok' }, agent: { state: 'ok' }, feishu: { state: 'ok' },
    delivery: { state: pending ? 'pending' : 'ok', pending, byChat: pending ? { oc_team: pending } : {} } },
})
const manager = (): ManagerView => ({
  revision: 2, bot: { name: 'Paimon', id: 'ou_bot' }, botCli: '/bin/lark-bot', workspaces: ['/projects'],
  repositories: [repository('repo-a', 'acme/widgets', 'acme/widgets', 2), repository('repo-b', 'acme/other', 'acme/other', 0)],
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
  expect(text()).toContain('添加本地仓库')
  expect(field<HTMLInputElement>('名称')).toBeTruthy()
  expect(text()).toContain('工作方式：当前仓库')
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
  expect(text()).toContain('已添加的仓库')
  expect(field<HTMLInputElement>('名称')).toBeTruthy()
})
