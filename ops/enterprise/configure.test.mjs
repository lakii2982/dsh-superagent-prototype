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
  manifest.feishuBots = []
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

function managerFixture(multiple = false) {
  const state = { enterprisePilot: true, requireProtectedBranches: true, revision: 0, capacity: { maxRunningRepositories: 12, runningRepositories: 0 },
    repositories: [], bindings: [], chats: {}, bot: null, botCli: '', health: {} }
  if (multiple) state.bots = []
  const botChats = new Map(), botMembers = new Map()
  const calls = []
  const models = { default: { provider: 'approved-provider', model: 'approved-model' }, routableProviders: ['approved-provider'] }
  const request = async (route, method = 'GET', body) => {
    calls.push({ route, method, body })
    const [resource, id, action, child] = route.split('/')
    if (resource === 'state' && method === 'GET') return structuredClone(state)
    if (resource === 'bots') {
      if (!id && method === 'POST') {
        assert.equal(body.revision, state.revision)
        state.revision++
        state.bots.push({ id: randomUUID(), cli: body.cli, ...body.profile ? { profile: body.profile } : {}, botId: `bot-${state.bots.length}`, appId: `app-${state.bots.length}`,
          name: `Bot ${state.bots.length}`, connected: true, enabled: true, legacy: false, chats: {}, health: {} })
      } else if (action === 'chats' && child === 'refresh' && method === 'POST') {
        const bot = state.bots.find(bot => bot.id === id)
        bot.chats = botChats.get(bot.profile ? JSON.stringify([bot.cli, bot.profile]) : bot.cli) ?? {}
      } else if (action === 'chats' && route.endsWith('/members') && method === 'GET') {
        const bot = state.bots.find(bot => bot.id === id)
        return { users: (botMembers.get(bot.profile ? JSON.stringify([bot.cli, bot.profile]) : bot.cli)?.[child] ?? []).map(member_id => ({ member_id })) }
      } else assert.fail(`Unexpected bot request ${method} ${route}`)
      return structuredClone(state)
    }
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
  return { state, calls, request, models, botChats, botMembers }
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

function multipleBots() {
  const manifest = small(), team = manifest.teams[0]
  manifest.feishuBots = [{ key: 'alpha', cli: '/opt/dsh/alpha-bot' }, { key: 'beta', cli: '/opt/dsh/beta-bot' }]
  team.members[0].feishuByBot = { alpha: 'ou_Alpha', beta: 'ou_Beta' }
  const repo = team.repositories[0]
  repo.groups = [{ botKey: 'alpha', chatId: 'oc_Shared' }, { botKey: 'alpha', chatId: 'oc_Another' }, { botKey: 'beta', chatId: 'oc_Third' }]
  team.productLines.push({ id: 'product-second', name: 'Second' })
  team.repositories.push({ ...structuredClone(repo), id: 'repo-second', name: 'Second', remote: 'acme/second', directory: '/srv/worktrees/second',
    productLineIds: ['product-second'], groups: [{ botKey: 'beta', chatId: 'oc_Shared' }] })
  manifest.expectedCounts.productLines = 2
  return manifest
}
function botFixture() {
  const fixture = managerFixture(true)
  fixture.botChats.set('/opt/dsh/alpha-bot', { oc_Shared: 'Shared', oc_Another: 'Another' })
  fixture.botChats.set('/opt/dsh/beta-bot', { oc_Shared: 'Shared', oc_Third: 'Third' })
  fixture.botMembers.set('/opt/dsh/alpha-bot', { oc_Shared: ['ou_Alpha'], oc_Another: ['ou_Alpha'] })
  fixture.botMembers.set('/opt/dsh/beta-bot', { oc_Shared: ['ou_Beta'], oc_Third: ['ou_Beta'] })
  return fixture
}

test('validates bot/group uniqueness, explicit identity ownership, and unambiguous legacy shorthand', () => {
  const manifest = multipleBots()
  const company = validateCompany(manifest)
  assert.equal(company.repositories[0].groups.length, 3)
  assert.deepEqual(company.repositories[0].allowedFeishuByKey, { alpha: ['ou_Alpha'], beta: ['ou_Beta'] })
  const duplicated = structuredClone(manifest)
  duplicated.teams[0].repositories[1].groups.push({ botKey: 'alpha', chatId: 'oc_Shared' })
  assert.throws(() => validateCompany(duplicated), /Duplicate Feishu bot\/group binding/)
  const ambiguous = structuredClone(manifest)
  ambiguous.teams[0].repositories[0].chatIds = ['oc_Extra']
  assert.throws(() => validateCompany(ambiguous), /one unambiguous bot/)
  const unknown = structuredClone(manifest)
  unknown.teams[0].repositories[0].groups[0].botKey = 'missing'
  assert.throws(() => validateCompany(unknown), /unknown Feishu bot key/)
  const implicitIdentity = structuredClone(manifest)
  implicitIdentity.teams[0].members[0].feishu = 'ou_Implicit'
  assert.throws(() => validateCompany(implicitIdentity), /feishu is ambiguous/)
  const single = small()
  single.feishuBots = [{ key: 'only', cli: '/opt/dsh/only-bot' }]
  single.teams[0].members[0].feishu = 'ou_One'
  single.teams[0].repositories[0].chatIds = ['oc_One']
  assert.deepEqual(validateCompany(single).repositories[0].groups, [{ botKey: 'only', chatId: 'oc_One' }])
})

test('applies multiple bot/group/repository mappings with scoped grants and is idempotent', async () => {
  const company = validateCompany(multipleBots()), fixture = botFixture()
  const plan = planCompany(company, fixture.state)
  assert.equal(plan[0].bindings[0].botId, null)
  assert.equal(plan[0].bindings[0].botKey, 'alpha')
  const applied = await applyCompany(company, fixture.request)
  const alpha = fixture.state.bots.find(bot => bot.cli.endsWith('alpha-bot'))
  const beta = fixture.state.bots.find(bot => bot.cli.endsWith('beta-bot'))
  const first = fixture.state.repositories[0], second = fixture.state.repositories[1]
  assert.deepEqual(first.allowedFeishu, [])
  assert.deepEqual(first.allowedFeishuByBot, { [alpha.id]: ['ou_Alpha'], [beta.id]: ['ou_Beta'] })
  assert.deepEqual(second.allowedFeishuByBot, { [beta.id]: ['ou_Beta'] })
  assert.deepEqual(fixture.state.bindings.filter(binding => binding.chatId === 'oc_Shared').map(binding => [binding.botId, binding.repositoryId]),
    [[alpha.id, first.id], [beta.id, second.id]])
  assert.equal(applied.bots.length, 2)
  assert.equal(applied.repositories[0].groups.length, 3)
  assert.equal(fixture.calls.filter(call => call.route === 'bots' && call.method === 'POST').length, 2)
  fixture.calls.length = 0
  await applyCompany(company, fixture.request)
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET'])
  assert.equal(fixture.state.bindings.length, 4)
})

test('does not use another bots membership or cached group names to grant access', async () => {
  const company = validateCompany(multipleBots()), fixture = botFixture()
  fixture.botMembers.set('/opt/dsh/beta-bot', { oc_Shared: ['ou_Alpha'], oc_Third: ['ou_Alpha'] })
  await assert.rejects(applyCompany(company, fixture.request), /open_id\(s\) missing from bot beta/)
  assert.equal(fixture.state.repositories.length, 0)
  assert.equal(fixture.state.bindings.length, 0)
  const missingChat = botFixture()
  missingChat.botChats.set('/opt/dsh/beta-bot', { oc_Third: 'Third' })
  await assert.rejects(applyCompany(company, missingChat.request), /bot beta has not joined: oc_Shared/)
  assert.equal(missingChat.state.repositories.length, 0)
})

test('preserves paused bots and reports their readiness separately from other bots', async () => {
  const company = validateCompany(multipleBots()), fixture = botFixture()
  await applyCompany(company, fixture.request, true, async () => [])
  assert.equal((await statusCompany(company, fixture.request)).readiness, true)
  const alpha = fixture.state.bots.find(bot => bot.cli.endsWith('alpha-bot'))
  alpha.enabled = false; alpha.connected = false
  fixture.calls.length = 0
  const applied = await applyCompany(company, fixture.request, true, async () => [])
  assert.equal(applied.bots.find(bot => bot.key === 'alpha').enabled, false)
  assert(!fixture.calls.some(call => call.route.startsWith(`bots/${alpha.id}/`) || call.method === 'PUT'))
  const status = await statusCompany(company, fixture.request)
  assert.deepEqual(status.managerErrors, ['feishu-bot-unavailable:alpha'])
  assert.equal(status.repositories[0].ready, false)
  assert.equal(status.repositories[1].ready, true)
  company.repositories[0].name = 'Renamed while its bot is paused'
  fixture.calls.length = 0
  await applyCompany(company, fixture.request)
  assert.equal(fixture.state.repositories[0].name, company.repositories[0].name)
  assert(!fixture.calls.some(call => call.route.startsWith(`bots/${alpha.id}/`)))
})

test('converts legacy manifest input to scoped grants on a new multiple-bot manager', async () => {
  const manifest = small()
  manifest.feishuCli = '/opt/dsh/alpha-bot'
  manifest.teams[0].members[0].feishu = 'ou_Alpha'
  manifest.teams[0].repositories[0].chatIds = ['oc_Shared']
  const fixture = botFixture()
  await applyCompany(validateCompany(manifest), fixture.request)
  const bot = fixture.state.bots[0]
  assert.deepEqual(fixture.state.repositories[0].allowedFeishu, [])
  assert.deepEqual(fixture.state.repositories[0].allowedFeishuByBot, { [bot.id]: ['ou_Alpha'] })
  assert.equal(fixture.state.bindings[0].botId, bot.id)
})

test('keeps legacy roster-only Feishu IDs ungranted and preserves grants outside the manifest bot scope', async () => {
  const legacy = small()
  legacy.teams[0].members[0].feishu = 'ou_Unused'
  assert.deepEqual(validateCompany(legacy).repositories[0].allowedFeishuByKey, {})
  const fixture = botFixture(), company = validateCompany(multipleBots())
  await applyCompany(company, fixture.request)
  fixture.state.repositories[0].allowedFeishu = ['ou_Legacy']
  fixture.state.repositories[0].allowedFeishuByBot.unmentioned = ['ou_Unmentioned']
  fixture.calls.length = 0
  await applyCompany(company, fixture.request)
  assert.deepEqual(fixture.state.repositories[0].allowedFeishu, ['ou_Legacy'])
  assert.deepEqual(fixture.state.repositories[0].allowedFeishuByBot.unmentioned, ['ou_Unmentioned'])
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET'])
  const reserved = small()
  reserved.feishuBots = [{ key: 'constructor', cli: '/opt/dsh/constructor-bot' }]
  reserved.teams[0].repositories[0].groups = [{ botKey: 'constructor', chatId: 'oc_Example' }]
  assert.throws(() => validateCompany(reserved), /without authorized Feishu members/)
})

test('extends an existing legacy bot with a second bot while retaining its binding and registry identity', async () => {
  const manifest = small(), team = manifest.teams[0]
  manifest.feishuCli = '/opt/dsh/alpha-bot'
  manifest.feishuBots = [{ key: 'beta', cli: '/opt/dsh/beta-bot' }]
  team.members[0].feishu = 'ou_Alpha'
  team.members[0].feishuByBot = { beta: 'ou_Beta' }
  team.repositories[0].chatIds = ['oc_Shared']
  team.repositories[0].groups = [{ botKey: 'beta', chatId: 'oc_Third' }]
  const fixture = botFixture(), legacyId = randomUUID()
  fixture.state.bots.push({ id: legacyId, cli: manifest.feishuCli, botId: 'legacy-open-id', appId: 'legacy-app', name: 'Legacy',
    connected: true, enabled: true, legacy: true, chats: { oc_Shared: 'Shared' }, health: {} })
  const company = validateCompany(manifest)
  await applyCompany(company, fixture.request)
  assert.equal(fixture.state.bots.length, 2)
  assert.equal(fixture.calls.filter(call => call.route === 'bots' && call.method === 'POST').length, 1)
  const repo = fixture.state.repositories[0]
  assert.deepEqual(repo.allowedFeishu, ['ou_Alpha'])
  assert.deepEqual(repo.allowedFeishuByBot[legacyId], ['ou_Alpha'])
  assert.equal(fixture.state.bindings.find(binding => binding.chatId === 'oc_Shared').botId, legacyId)
  assert(fixture.state.bindings.every(binding => binding.repositoryId === repo.id))
  fixture.calls.length = 0
  await applyCompany(company, fixture.request)
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET'])
})


test('connects separate profiles on the same CLI and reuses their registry IDs on retry', async () => {
  const manifest = multipleBots(), fixture = managerFixture(true), cli = '/usr/local/bin/lark-cli'
  manifest.feishuBots = [{ key: 'alpha', cli, profile: 'platform' }, { key: 'beta', cli, profile: 'apps' }]
  fixture.botChats.set(JSON.stringify([cli, 'platform']), { oc_Shared: 'Shared', oc_Another: 'Another' })
  fixture.botChats.set(JSON.stringify([cli, 'apps']), { oc_Shared: 'Shared', oc_Third: 'Third' })
  fixture.botMembers.set(JSON.stringify([cli, 'platform']), { oc_Shared: ['ou_Alpha'], oc_Another: ['ou_Alpha'] })
  fixture.botMembers.set(JSON.stringify([cli, 'apps']), { oc_Shared: ['ou_Beta'], oc_Third: ['ou_Beta'] })
  const company = validateCompany(manifest)
  assert.deepEqual(company.feishuBots.map(bot => bot.profile), ['platform', 'apps'])
  const applied = await applyCompany(company, fixture.request)
  assert.deepEqual(fixture.calls.filter(call => call.route === 'bots' && call.method === 'POST').map(call => call.body.profile), ['platform', 'apps'])
  const platform = fixture.state.bots.find(bot => bot.profile === 'platform'), apps = fixture.state.bots.find(bot => bot.profile === 'apps')
  assert.notEqual(platform.id, apps.id)
  assert.equal(applied.repositories[0].groups.find(group => group.botKey === 'alpha').botId, platform.id)
  assert.equal(applied.repositories[1].groups[0].botId, apps.id)
  fixture.calls.length = 0
  await applyCompany(company, fixture.request)
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET'])
  assert.equal(fixture.state.bots.length, 2)
  const duplicate = structuredClone(manifest)
  duplicate.feishuBots[1].profile = 'platform'
  assert.throws(() => validateCompany(duplicate), /Duplicate Feishu bot connection/)
  const defaultProfile = structuredClone(manifest)
  delete defaultProfile.feishuBots[0].profile
  defaultProfile.feishuCli = cli
  assert.throws(() => validateCompany(defaultProfile), /Duplicate Feishu bot connection/)
})
