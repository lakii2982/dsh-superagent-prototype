import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

type Register = Context['webServer']['register']

it.each([
  { label: 'default', configuration: {}, enterprisePilot: false, maxRunningRepositories: 3, operatorAuth: false },
  { label: 'enterprise pilot', configuration: { enterprisePilot: true, maxRunningRepositories: 12 }, enterprisePilot: true, maxRunningRepositories: 12, operatorAuth: false },
  { label: 'authenticated enterprise pilot', configuration: { enterprisePilot: true, maxRunningRepositories: 12 }, enterprisePilot: true, maxRunningRepositories: 12, operatorAuth: true },
])('mounts the $label manager through the Cordis plugin entry without binding a port', async ({ configuration, enterprisePilot, maxRunningRepositories, operatorAuth }) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'manager-bootstrap-'))
  const context = new Context()
  const port = 3082
  let route: Parameters<Register>[0] | undefined
  const register: Register = value => {
    route = value
    return () => { route = undefined }
  }
  for (const service of plugin.inject) context.reflect.provide(service, {})
  context.set('webServer', { host: '127.0.0.1', port, register } as Context['webServer'])
  context.set('workspaceRegistry', { list: () => [] } as unknown as Context['workspaceRegistry'])

  async function request(url: string, headers: Record<string, string> = {}) {
    let status = 0
    let body: unknown
    await route!.handler({ method: 'GET', url, headers: { host: `127.0.0.1:${port}`, ...headers } } as IncomingMessage, {
      writeHead(code: number) { status = code },
      end(contents: string) { body = JSON.parse(contents) },
    } as ServerResponse)
    return { status, body }
  }

  try {
    const operatorToken = 'a'.repeat(64)
    const operatorTokenFile = join(stateDir, 'manager-operator-token')
    if (operatorAuth) writeFileSync(operatorTokenFile, operatorToken, { mode: 0o600 })
    const fiber = await context.plugin(plugin, { mode: 'manager', stateDir, ...configuration, ...(operatorAuth ? { operatorTokenFile } : {}) })
    expect(existsSync(join(stateDir, 'manager.sqlite'))).toBe(true)
    expect(route).toMatchObject({ kind: 'prefix', path: '/orchestrator' })
    expect(await request('/orchestrator/mode')).toEqual({ status: 200, body: { mode: 'manager' } })
    expect(await request('/orchestrator/manager/state')).toMatchObject({ status: 403 })
    const sameOrigin = { 'x-orchestrator-request': '1' }
    const trusted = { ...sameOrigin, ...(operatorAuth ? { authorization: `Bearer ${operatorToken}` } : {}) }
    if (operatorAuth) {
      const unauthorized = { status: 401, body: { code: 'operator_auth_required' } }
      expect(await request('/orchestrator/manager/state', sameOrigin)).toMatchObject(unauthorized)
      expect(await request('/orchestrator/manager/state', { ...sameOrigin, authorization: 'Bearer invalid' })).toMatchObject(unauthorized)
      expect(await request('/orchestrator/manager/repositories/repo/api/settings', sameOrigin)).toMatchObject(unauthorized)
      expect(await request('/orchestrator/manager/state', { ...trusted, origin: 'http://example.invalid' })).toMatchObject({ status: 403 })
    }
    const answer = await request('/orchestrator/manager/state', trusted)
    expect(answer).toMatchObject({
      status: 200,
      body: { enterprisePilot, capacity: { maxRunningRepositories, runningRepositories: 0 }, bot: null, repositories: [], queues: { total: 0 } },
    })
    expect(JSON.stringify(answer)).not.toContain(operatorToken)
    await fiber.dispose()
    expect(route).toBeUndefined()
  } finally {
    await context.fiber.dispose()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

it('takes a local DSH settings change across a restart without migrating standalone data or watchers', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'desktop-mode-'))
  const context = new Context()
  const port = 3082
  let route: Parameters<Register>[0] | undefined
  let sourceMounted = false
  for (const service of plugin.inject) context.reflect.provide(service, {})
  context.set('webServer', { host: '127.0.0.1', port, register: value => {
    route = value
    return () => { route = undefined }
  } } as Context['webServer'])
  context.set('agents', { get: () => undefined } as unknown as Context['agents'])
  context.set('sessionPersistence', { flush: async () => {} } as Context['sessionPersistence'])
  context.set('workspaceRegistry', { list: () => [] } as unknown as Context['workspaceRegistry'])
  const request = async (url: string) => {
    let result: unknown
    await route?.handler({ method: 'GET', url, headers: { host: `127.0.0.1:${port}`, 'x-orchestrator-request': '1' } } as unknown as IncomingMessage, {
      writeHead() {}, end(contents: string) { result = JSON.parse(contents) },
    } as unknown as ServerResponse)
    return result
  }
  try {
    const fiber = await context.plugin(plugin, { stateDir })
    await context.plugin({ inject: ['orchestrator'], apply(ctx: Context) {
      ctx.effect(() => {
        sourceMounted = true
        return () => { sourceMounted = false }
      })
    } })
    expect(await request('/orchestrator/mode')).toMatchObject({ mode: 'standalone', desktopMultiRepository: false })
    expect(sourceMounted).toBe(true)
    expect(existsSync(join(stateDir, 'orchestrator.sqlite'))).toBe(true)

    function changeMode(value: boolean) {
      // Reproduce the loader's volatile update order: update raw config, publish the reference, then emit to the owner.
      fiber._config = { stateDir, desktopMultiRepository: value }
      fiber.config.desktopMultiRepository = { get: () => value }
      fiber.ctx.emit('loader/volatile-update', [['desktopMultiRepository']])
    }

    changeMode(true)
    await expect.poll(() => request('/orchestrator/mode')).toMatchObject({ mode: 'manager', desktopMultiRepository: true })
    await expect.poll(() => sourceMounted).toBe(false)
    expect(await request('/orchestrator/manager/state')).toMatchObject({ enterprisePilot: true, requireProtectedBranches: false,
      capacity: { maxRunningRepositories: 12, runningRepositories: 0 }, repositories: [] })
    expect(existsSync(join(stateDir, 'enterprise-manager', 'manager.sqlite'))).toBe(true)
    expect(existsSync(join(stateDir, 'manager.sqlite'))).toBe(false)

    changeMode(false)
    await expect.poll(() => request('/orchestrator/mode')).toMatchObject({ mode: 'standalone', desktopMultiRepository: false })
    await expect.poll(() => sourceMounted).toBe(true)
    expect(existsSync(join(stateDir, 'orchestrator.sqlite'))).toBe(true)
    expect(existsSync(join(stateDir, 'enterprise-manager', 'manager.sqlite'))).toBe(true)
  } finally {
    await context.fiber.dispose()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
