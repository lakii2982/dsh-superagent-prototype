import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyCompany, managerClient, managerOrigin, operatorToken, planCompany, preflightLocal, statusCompany, validateCompany } from './configure.mjs'

const sample = JSON.parse(await readFile(new URL('company.example.json', import.meta.url), 'utf8'))

function full() {
  const manifest = structuredClone(sample)
  for (const team of manifest.teams) {
    team.members = Array.from({ length: 24 }, (_, index) => ({ id: `${team.id}-member-${index}`, github: `${team.id}-${index}` }))
    for (const repo of team.repositories) repo.memberIds = team.members.map(member => member.id)
  }
  return manifest
}

function small() {
  const manifest = full()
  const team = manifest.teams[0]
  team.members = team.members.slice(0, 1)
  team.productLines = team.productLines.slice(0, 1)
  team.repositories = team.repositories.slice(0, 1)
  team.repositories[0].memberIds = [team.members[0].id]
  return { ...manifest, expectedCounts: { teams: 1, productLines: 1, members: 1 }, teams: [team] }
}

function managerFixture() {
  const state = { enterprisePilot: true, requireProtectedBranches: true, revision: 0, capacity: { maxRunningRepositories: 12, runningRepositories: 0 },
    repositories: [], bindings: [], chats: {}, bot: null, botCli: '', health: {} }
  const calls = []
  const models = { default: { provider: 'approved-provider', model: 'approved-model' }, routableProviders: ['approved-provider'] }
  const request = async (route, method = 'GET', body) => {
    calls.push({ route, method, body })
    const [resource, id, action, child] = route.split('/')
    if (resource === 'state' && method === 'GET') return structuredClone(state)
    if (route === 'bot' && method === 'PUT') { state.bot = { id: 'test-bot' }; state.botCli = body.cli }
    else if (route === 'chats/refresh' && method === 'POST') state.chats.oc_Alpha = 'Alpha'
    else if (route === 'chats/oc_Alpha/members' && method === 'GET') return { users: [{ member_id: 'ou_Alpha', name: 'Test Member' }] }
    else if (action === 'api' && child === 'state') return { paused: false, setup: { problem: null }, health: {} }
    else if (action === 'api' && child === 'settings') return { blocks: {} }
    else if (action === 'api' && child === 'models') return models
    else if (action === 'start' && method === 'POST') {
      state.capacity.runningRepositories++
      state.repositories.find(repo => repo.id === id).status = { online: true, configured: true, state: 'ready' }
    } else {
      assert.equal(body.revision, state.revision)
      state.revision++
      const { revision: _revision, ...value } = body
      if (resource === 'repositories' && method === 'POST') state.repositories.push({ ...value, id: randomUUID(), status: { online: false } })
      else if (resource === 'repositories' && method === 'PUT') Object.assign(state.repositories.find(repo => repo.id === id), value)
      else if (resource === 'bindings' && method === 'PUT') state.bindings = value.bindings
      else assert.fail(`Unexpected request ${method} ${route}`)
    }
    return structuredClone(state)
  }
  return { state, calls, request, models }
}

test('validates the single-panel 5-team 12-product 120-person inventory and accepts monorepo mappings', () => {
  const manifest = full()
  assert.deepEqual(validateCompany(manifest).counts, { teams: 5, productLines: 12, members: 120, repositories: 12 })
  const team = manifest.teams[0]
  team.repositories[0].productLineIds.push(...team.repositories.pop().productLineIds)
  const company = validateCompany(manifest)
  assert.equal(company.repositories[0].productLines.length, 2)
  assert.equal(company.counts.repositories, 11)
  assert.throws(() => validateCompany(sample), /Expected 120 members but found 5/)
})

test('rejects a cross-team permission grant and duplicates of GitHub accounts', () => {
  const manifest = full()
  manifest.teams[0].repositories[0].memberIds = [manifest.teams[1].members[0].id]
  assert.throws(() => validateCompany(manifest), /member outside platform/)
  const duplicate = full()
  duplicate.teams[1].members[0].github = duplicate.teams[0].members[0].github.toUpperCase()
  assert.throws(() => validateCompany(duplicate), /Duplicate GitHub identity/)
})

test('requires token only in same-origin headers and refuses loopback target escapes', async () => {
  const token = '4'.repeat(64)
  const call = managerClient('http://127.0.0.1:3082', token, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3082/orchestrator/manager/state')
    assert.equal(options.headers.authorization, `Bearer ${token}`)
    assert.equal(options.headers['x-orchestrator-request'], '1')
    assert.equal(options.headers.origin, 'http://127.0.0.1:3082')
    assert.equal(options.redirect, 'error')
    return Response.json({ ready: true })
  })
  assert.deepEqual(await call('state'), { ready: true })
  for (const url of ['http://127.1:3082', 'https://127.0.0.1:3082', 'http://localhost:3082', 'http://127.0.0.1:3082/x', 'http://user@127.0.0.1:3082', 'http://127.0.0.1:3082#']) {
    assert.throws(() => managerOrigin(url), /local HTTP origin/)
  }
})

test('spot-checks local Git and CLI inputs before any API changes', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-configure-git-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const manifest = small()
  const repo = manifest.teams[0].repositories[0]
  execFileSync('git', ['init', '-q', temp])
  execFileSync('git', ['-C', temp, 'remote', 'add', 'origin', `https://github.com/${repo.remote}.git`])
  repo.directory = temp
  repo.githubCli = process.execPath
  const company = await preflightLocal(validateCompany(manifest))
  assert.equal(company.repositories[0].directory, await realpath(temp))
  repo.remote = 'different/repo'
  await assert.rejects(preflightLocal(validateCompany(manifest)), /origin does not match/)
})

test('registers all twelve repositories with stable revisions, then makes no changes on retry', async () => {
  const company = validateCompany(full())
  const fixture = managerFixture()
  assert.throws(() => planCompany(company, { ...fixture.state, requireProtectedBranches: false }), /does not enforce production branch protections/)
  fixture.state.capacity.maxRunningRepositories = 11
  assert.throws(() => planCompany(company, fixture.state), /cannot cover 12 repositories/)
  fixture.state.capacity.maxRunningRepositories = 12
  const first = await applyCompany(company, fixture.request)
  assert.equal(first.repositories.length, 12)
  assert.equal(fixture.state.revision, 12)
  assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 12)
  assert.equal(fixture.state.repositories[0].teamName, '平台研发')
  assert.deepEqual(fixture.state.repositories[0].productLines, ['身份服务'])
  assert.deepEqual(fixture.state.repositories[0].requiredChecks, ['build-and-test'])
  fixture.calls.length = 0
  await applyCompany(company, fixture.request)
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET'])
})

test('refuses start before any mutation when the branch gate fails, and checks model readiness after start', async () => {
  const company = validateCompany(small())
  const fixture = managerFixture()
  await assert.rejects(applyCompany(company, fixture.request, true, async () => { throw new Error('required checks missing') }), /required checks missing/)
  assert(fixture.calls.every(call => call.method === 'GET'))
  assert.equal(fixture.state.repositories.length, 0)
  const applied = await applyCompany(company, fixture.request, true, async rows => {
    assert.equal(rows.length, 1)
    return [{ repository: rows[0].remote, branch: 'main' }]
  })
  assert.deepEqual(applied.started, ['repo-01'])
  assert.equal((await statusCompany(company, fixture.request)).readiness, true)
  fixture.models.routableProviders = []
  const health = await statusCompany(company, fixture.request)
  assert.equal(health.readiness, false)
  assert.match(health.repositories[0].blockers.join(' '), /model has no routable provider/)
})

test('binds through the shared Feishu bot and does not undo existing pauses', async () => {
  const manifest = small()
  manifest.feishuCli = '/opt/dsh/lark-cli'
  manifest.teams[0].members[0].feishu = 'ou_Alpha'
  manifest.teams[0].repositories[0].chatIds = ['oc_Alpha']
  const company = validateCompany(manifest)
  const fixture = managerFixture()
  await applyCompany(company, fixture.request)
  assert.deepEqual(fixture.state.repositories[0].allowedFeishu, ['ou_Alpha'])
  assert.equal(fixture.state.bindings[0].enabled, true)
  fixture.state.repositories[0].enabled = false
  fixture.state.bindings[0].enabled = false
  fixture.calls.length = 0
  const applied = await applyCompany(company, fixture.request, true, async rows => { assert.deepEqual(rows, []); return [] })
  assert.deepEqual(applied.started, [])
  assert.equal(applied.repositories[0].enabled, false)
  assert.equal(fixture.state.bindings[0].enabled, false)
  assert(fixture.calls.every(call => call.method === 'GET'))
  fixture.state.bindings[0].repositoryId = randomUUID()
  await assert.rejects(applyCompany(company, fixture.request), /already bound to another repository/)
})

test('verifies Feishu open IDs before adding repository access', async () => {
  const manifest = small()
  manifest.feishuCli = '/opt/dsh/lark-cli'
  manifest.teams[0].members[0].feishu = 'ou_Missing'
  manifest.teams[0].repositories[0].chatIds = ['oc_Alpha']
  const fixture = managerFixture()
  await assert.rejects(applyCompany(validateCompany(manifest), fixture.request), /open_id\(s\) missing/)
  assert.equal(fixture.state.repositories.length, 0)
  assert.equal(fixture.state.bindings.length, 0)
})

test('stages private model credentials without API disclosure and refuses unsafe paths or replacement', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-configure-secret-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const secret = join(temp, 'model.yaml'), badRoot = join(temp, 'other')
  await mkdir(badRoot, { mode: 0o700 })
  await writeFile(secret, 'synthetic secret\n', { mode: 0o600 })
  const manifest = small()
  manifest.teams[0].repositories[0].modelCredentialsFile = secret
  const company = validateCompany(manifest)
  const fixture = managerFixture()
  fixture.state.stateDir = temp
  await assert.rejects(applyCompany(company, fixture.request, false, undefined, badRoot), /does not match/)
  assert(fixture.calls.every(call => call.method === 'GET'))
  const applied = await applyCompany(company, fixture.request, false, undefined, temp)
  assert.deepEqual(applied.modelCredentialsStaged, [{ id: 'repo-01', outcome: 'staged' }])
  const destination = join(temp, 'repositories', applied.repositories[0].registrationId, 'dsh-home', '.credentials.yaml')
  assert.equal((await stat(destination)).mode & 0o777, 0o600)
  assert.equal(await readFile(destination, 'utf8'), 'synthetic secret\n')
  assert(!JSON.stringify(fixture.calls).includes('synthetic secret'))
  const retry = await applyCompany(company, fixture.request, false, undefined, temp)
  assert.equal(retry.modelCredentialsStaged[0].outcome, 'unchanged')
  await writeFile(secret, 'different synthetic secret\n')
  await assert.rejects(applyCompany(company, fixture.request, false, undefined, temp), /already has different model credentials/)
  assert.equal(await readFile(destination, 'utf8'), 'synthetic secret\n')
})

test('does not read an exposed or symlinked operator token', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-configure-token-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const path = join(temp, 'token'), alias = join(temp, 'link')
  await writeFile(path, `${'a'.repeat(64)}\n`, { mode: 0o600 })
  assert.equal(await operatorToken(path), 'a'.repeat(64))
  await symlink(path, alias)
  await assert.rejects(operatorToken(alias), { code: 'ELOOP' })
  await chmod(path, 0o644)
  await assert.rejects(operatorToken(path), /private regular file/)
})
