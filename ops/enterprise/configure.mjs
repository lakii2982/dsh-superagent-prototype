#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, lstat, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { checkAllBranchRules } from './check-branches.mjs'

const exec = promisify(execFile)
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/
const githubUser = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
const remoteName = /^[\w.-]+\/[\w.-]+$/
const feishuUser = /^ou_[a-zA-Z0-9]+$/
const chat = /^oc_[a-zA-Z0-9]+$/
const repositoryUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const fields = ['name', 'teamName', 'directory', 'remote', 'githubCli', 'productLines', 'allowedGithub', 'allowedFeishu', 'requiredChecks']
function equalArray(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false
  const sorted = [...b].sort()
  return [...a].sort().every((value, index) => value === sorted[index])
}
const nameEqual = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const setEqual = (a, b) => Array.isArray(a) && equalArray(a.map(value => value.toLowerCase()), b.map(value => value.toLowerCase()))

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function object(value, path, allowed) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`)
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  requireValue(!unknown.length, `${path} has unknown fields: ${unknown.join(', ')}`)
  return value
}

function string(value, path, pattern) {
  requireValue(typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 500 && !/[\r\n\0]/.test(value) && (!pattern || pattern.test(value)), `${path} is invalid`)
  return value
}

function absolute(value, path) {
  const result = string(value, path)
  requireValue(isAbsolute(result), `${path} must be an absolute local path`)
  return result
}

function array(value, path) {
  requireValue(Array.isArray(value), `${path} must be an array`)
  return value
}

function unique(seen, key, label) {
  requireValue(!seen.has(key), `Duplicate ${label}: ${key}`)
  seen.add(key)
}

/** Validate the entire company before issuing a management request. */
export function validateCompany(raw) {
  const input = object(raw, 'company', ['expectedCounts', 'feishuCli', 'teams'])
  const expected = object(input.expectedCounts, 'expectedCounts', ['teams', 'productLines', 'members'])
  for (const key of ['teams', 'productLines', 'members']) {
    requireValue(Number.isSafeInteger(expected[key]) && expected[key] > 0, `expectedCounts.${key} must be a positive integer`)
  }
  const feishuCli = input.feishuCli == null ? undefined : absolute(input.feishuCli, 'feishuCli')
  const teams = array(input.teams, 'teams')
  const teamIds = new Set(), teamNames = new Set(), products = new Set(), memberIds = new Set()
  const githubUsers = new Set(), feishuUsers = new Set(), repositoryIds = new Set(), remotes = new Set(), directories = new Set(), chats = new Set()
  const repositories = []
  for (const value of teams) {
    const team = object(value, 'team', ['id', 'name', 'members', 'productLines', 'repositories'])
    const teamId = string(team.id, 'team.id', identifier)
    const teamName = string(team.name, `${teamId}.name`)
    requireValue(teamName.length <= 100, `${teamId}.name exceeds 100 characters`)
    unique(teamIds, teamId.toLowerCase(), 'team ID')
    unique(teamNames, teamName.toLowerCase(), 'team name')
    const members = new Map(), lines = new Map(), lineNames = new Set(), usedMembers = new Set(), usedLines = new Set()
    for (const entry of array(team.members, `${teamId}.members`)) {
      const member = object(entry, `${teamId}.member`, ['id', 'github', 'feishu'])
      const id = string(member.id, `${teamId}.member.id`, identifier)
      unique(memberIds, id.toLowerCase(), 'member ID')
      const github = member.github == null ? undefined : string(member.github, `${id}.github`, githubUser)
      const feishu = member.feishu == null ? undefined : string(member.feishu, `${id}.feishu`, feishuUser)
      requireValue(github || feishu, `${id} needs a GitHub login or Feishu open_id`)
      if (github) unique(githubUsers, github.toLowerCase(), 'GitHub identity')
      if (feishu) unique(feishuUsers, feishu.toLowerCase(), 'Feishu identity')
      members.set(id, { github, feishu })
    }
    for (const entry of array(team.productLines, `${teamId}.productLines`)) {
      const product = object(entry, `${teamId}.productLine`, ['id', 'name'])
      const id = string(product.id, `${teamId}.productLine.id`, identifier)
      const name = string(product.name, `${id}.name`)
      requireValue(name.length <= 100, `${id}.name exceeds 100 characters`)
      unique(products, id.toLowerCase(), 'product-line ID')
      unique(lineNames, name.toLowerCase(), 'product-line name in a team')
      lines.set(id, name)
    }
    const teamRepos = array(team.repositories, `${teamId}.repositories`)
    requireValue(teamRepos.length && lines.size, `${teamId} requires repositories and product lines`)
    for (const entry of teamRepos) {
      const repo = object(entry, `${teamId}.repository`, ['id', 'name', 'remote', 'directory', 'githubCli', 'productLineIds', 'memberIds', 'chatIds', 'requiredChecks', 'modelCredentialsFile'])
      const id = string(repo.id, `${teamId}.repository.id`, identifier)
      const name = string(repo.name, `${id}.name`)
      requireValue(name.length <= 100, `${id}.name exceeds 100 characters`)
      const remote = string(repo.remote, `${id}.remote`, remoteName)
      const directory = absolute(repo.directory, `${id}.directory`)
      const githubCli = absolute(repo.githubCli, `${id}.githubCli`)
      unique(repositoryIds, id.toLowerCase(), 'repository ID')
      unique(remotes, remote.toLowerCase(), 'GitHub repository')
      unique(directories, resolve(directory), 'checkout directory')
      const lineIds = array(repo.productLineIds, `${id}.productLineIds`)
      const allowedIds = array(repo.memberIds, `${id}.memberIds`)
      requireValue(lineIds.length > 0 && lineIds.length <= 100 && new Set(lineIds).size === lineIds.length,
        `${id}.productLineIds must identify 1–100 distinct product lines`)
      requireValue(allowedIds.length > 0 && new Set(allowedIds).size === allowedIds.length, `${id}.memberIds must identify one or more distinct authorized members`)
      const productLines = lineIds.map(lineId => {
        requireValue(lines.has(lineId), `${id} refers to a product line outside ${teamId}: ${lineId}`)
        usedLines.add(lineId)
        return lines.get(lineId)
      })
      const chatIds = array(repo.chatIds ?? [], `${id}.chatIds`).map(chatId => {
        const value = string(chatId, `${id}.chatId`, chat)
        unique(chats, value.toLowerCase(), 'Feishu group')
        return value
      })
      requireValue(!chatIds.length || feishuCli, `${id} uses Feishu groups without a shared bot CLI`)
      const roles = allowedIds.map(memberId => {
        requireValue(members.has(memberId), `${id} refers to a member outside ${teamId}: ${memberId}`)
        const member = members.get(memberId)
        requireValue(member.github || (member.feishu && chatIds.length), `${memberId} has no usable source for ${id}`)
        usedMembers.add(memberId)
        return member
      })
      const allowedGithub = roles.flatMap(member => member.github ? [member.github] : [])
      const allowedFeishu = chatIds.length ? roles.flatMap(member => member.feishu ? [member.feishu] : []) : []
      requireValue(!chatIds.length || allowedFeishu.length, `${id} binds Feishu groups without authorized Feishu members`)
      const requiredChecks = array(repo.requiredChecks ?? [], `${id}.requiredChecks`).map(check => string(check, `${id}.requiredCheck`))
      requireValue(requiredChecks.length <= 100 && requiredChecks.every(check => check.length <= 200)
        && new Set(requiredChecks).size === requiredChecks.length, `${id}.requiredChecks must have at most 100 distinct names of at most 200 characters`)
      const modelCredentialsFile = repo.modelCredentialsFile == null ? undefined : absolute(repo.modelCredentialsFile, `${id}.modelCredentialsFile`)
      repositories.push({ id, name, directory, remote, githubCli, teamName, productLines, allowedGithub, allowedFeishu,
        chatIds, requiredChecks, modelCredentialsFile })
    }
    for (const id of lines.keys()) requireValue(usedLines.has(id), `Product line ${id} needs a repository`)
    for (const id of members.keys()) requireValue(usedMembers.has(id), `Member ${id} needs an explicit repository grant`)
  }
  const counts = { teams: teamIds.size, productLines: products.size, members: memberIds.size, repositories: repositories.length }
  for (const key of ['teams', 'productLines', 'members']) {
    requireValue(counts[key] === expected[key], `Expected ${expected[key]} ${key} but found ${counts[key]}`)
  }
  requireValue(repositories.length <= 12, 'A single shared manager can run at most 12 repository instances')
  return { counts, repositories, feishuCli }
}

const git = async (directory, ...args) => (await exec('git', ['-C', directory, ...args], { timeout: 15_000 })).stdout.trim()

export async function preflightLocal(company) {
  const executables = new Set(company.repositories.map(repo => repo.githubCli))
  if (company.feishuCli) executables.add(company.feishuCli)
  await Promise.all([...executables].map(path => access(path, constants.X_OK).then(async () => {
    requireValue((await stat(path)).isFile(), `CLI must be an executable file: ${path}`)
  }).catch(error => { throw new Error(`CLI is unavailable at ${path}: ${error.code ?? error.message}`) })))
  const repositories = await Promise.all(company.repositories.map(async repo => {
    const directory = await realpath(repo.directory)
    const root = await realpath(await git(directory, 'rev-parse', '--show-toplevel'))
    requireValue(directory === root, `${repo.id} must use its Git checkout root: ${root}`)
    const origin = await git(directory, 'remote', 'get-url', 'origin')
    const remote = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin)?.[1]
    requireValue(remote && nameEqual(remote, repo.remote), `${repo.id} checkout origin does not match ${repo.remote}`)
    const pending = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
    for (const name of pending) {
      const gitPath = await git(directory, 'rev-parse', '--git-path', name)
      requireValue(!await access(resolve(directory, gitPath)).then(() => true, () => false), `${repo.id} has an unfinished Git operation: ${name}`)
    }
    return { ...repo, directory }
  }))
  requireValue(new Set(repositories.map(repo => repo.directory)).size === repositories.length, 'Several repositories refer to the same canonical checkout')
  return { ...company, repositories }
}

export function managerOrigin(raw) {
  const url = new URL(raw)
  requireValue(/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(raw) && url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && Number(url.port) >= 1024,
  'Manager URL must be a local HTTP origin like http://127.0.0.1:3082')
  return url.origin
}

async function readPrivateFile(path, label, maxBytes) {
  const file = await open(absolute(path, label), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    requireValue(info.isFile() && !(info.mode & 0o077) && (!process.geteuid || info.uid === process.geteuid()) && info.size > 0 && info.size <= maxBytes,
      `${label} must be a nonempty private regular file owned by the current user`)
    const bytes = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    requireValue(offset > 0 && offset <= maxBytes, `${label} changed during the read or exceeds the size limit`)
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

export async function operatorToken(path) {
  const value = (await readPrivateFile(path, 'Operator token', 65)).toString('utf8')
  requireValue(/^[0-9a-f]{64}\n?$/.test(value), 'Operator token format is invalid')
  return value.trimEnd()
}

async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  requireValue(info.isDirectory() && !(info.mode & 0o077) && (!process.geteuid || info.uid === process.geteuid()),
    `The state directory must be private and owned by the current operator: ${path}`)
  return path
}

const credentialLimit = 512 * 1024

/** Read all approved files before applying company configuration. A stale or unsafe input changes no manager data. */
async function modelCredentials(company, stateDir, state) {
  const repos = company.repositories.filter(repo => repo.modelCredentialsFile)
  if (!repos.length) return undefined
  requireValue(stateDir, 'Specify --state-dir to stage DSH model credentials for registered repos')
  await privateDirectory(absolute(stateDir, 'state directory'))
  const root = await realpath(stateDir)
  requireValue(typeof state.stateDir === 'string' && root === await realpath(state.stateDir), '--state-dir does not match the authenticated manager')
  const credentials = new Map()
  for (const repo of repos) {
    credentials.set(repo.id, await readPrivateFile(repo.modelCredentialsFile, `${repo.id} model credentials`, credentialLimit))
  }
  return { root, credentials }
}

/** Install once with 0600 permissions and no replace. Secret bytes never appear in output, URLs or request bodies. */
async function stageCredential(root, id, bytes) {
  requireValue(repositoryUuid.test(id), 'Manager returned an invalid repository registration ID')
  const repos = await privateDirectory(join(root, 'repositories'), true)
  const state = await privateDirectory(join(repos, id), true)
  const home = await privateDirectory(join(state, 'dsh-home'), true)
  const destination = join(home, '.credentials.yaml')
  const previous = await readPrivateFile(destination, 'Existing model credentials', credentialLimit).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (previous) {
    requireValue(previous.equals(bytes), 'Repository already has different model credentials. Rotate it through the approved operations flow.')
    return 'unchanged'
  }
  const temp = join(home, `.credentials-stage-${randomUUID()}`)
  const file = await open(temp, 'wx', 0o600)
  try {
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await link(temp, destination)
    return 'staged'
  } finally { await unlink(temp) }
}

export function managerClient(raw, token, fetcher = fetch) {
  const origin = managerOrigin(raw)
  requireValue(/^[0-9a-f]{64}$/.test(token), 'A valid operator token file is required')
  return async (route, method = 'GET', body) => {
    const url = `${origin}/orchestrator/manager/${route}`
    const timeout = method === 'GET' ? 35_000 : 210_000
    let response
    try {
      response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { origin, authorization: `Bearer ${token}`, 'x-orchestrator-request': '1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (error) {
      throw new Error(`${method} ${route} could not reach ${origin}: ${error.cause?.code ?? error.message}`)
    }
    const data = await response.json().catch(() => null)
    requireValue(response.ok && data, `${method} ${route} failed (${response.status}): ${data?.error ?? 'check the manager and its logs'}`)
    return data
  }
}

const repoPath = id => `repositories/${encodeURIComponent(id)}`
const currentRepo = (state, repo) => state.repositories.find(value => nameEqual(value.remote, repo.remote))
const hasChat = (state, id) => Object.hasOwn(state.chats ?? {}, id)

/** Preserve existing pauses and unmentioned registrations. Refuse moves of existing repo or group ownership. */
export function planCompany(company, state) {
  requireValue(state.enterprisePilot === true && Number.isSafeInteger(state.revision) && Array.isArray(state.repositories)
    && Array.isArray(state.bindings), 'Target is not an enterprise-mode DSH manager')
  requireValue(state.requireProtectedBranches === true, 'Target manager does not enforce production branch protections')
  requireValue(state.capacity?.maxRunningRepositories >= company.repositories.length,
    `Manager capacity ${state.capacity?.maxRunningRepositories ?? 'unknown'} cannot cover ${company.repositories.length} repositories`)
  if (company.feishuCli && state.botCli) requireValue(company.feishuCli === state.botCli, 'The manager already has a different Feishu CLI. Keep the existing bot identity or migrate it deliberately.')
  return company.repositories.map(repo => {
    const existing = currentRepo(state, repo)
    const checkout = state.repositories.find(entry => entry.directory === repo.directory && entry.id !== existing?.id)
    requireValue(!checkout, `${repo.id} checkout is already registered to another repository`)
    if (existing) {
      requireValue(existing.directory === repo.directory && existing.githubCli === repo.githubCli,
        `${repo.id} already uses a different checkout or GitHub execution CLI. A migration is required.`)
    }
    const bindings = repo.chatIds.map(id => {
      const bound = state.bindings.find(row => row.chatId === id)
      requireValue(!bound || bound.repositoryId === existing?.id, `Feishu group ${id} is already bound to another repository`)
      return { id, action: !bound ? 'bind' : bound.enabled ? 'unchanged' : 'paused', verified: hasChat(state, id) }
    })
    const changed = !!existing && (existing.name !== repo.name || existing.teamName !== repo.teamName
      || !equalArray(existing.productLines, repo.productLines) || !setEqual(existing.allowedGithub, repo.allowedGithub)
      || !equalArray(existing.allowedFeishu, repo.allowedFeishu) || !equalArray(existing.requiredChecks ?? [], repo.requiredChecks))
    return { repo, existing, action: !existing ? 'register' : changed ? 'update' : 'unchanged', bindings }
  })
}

export const planOutput = plan => plan.map(({ repo, existing, action, bindings }) => ({ id: repo.id, team: repo.teamName,
  products: repo.productLines, repository: repo.remote, action, enabled: existing?.enabled ?? true,
  registrationId: existing?.id ?? null, githubMembers: repo.allowedGithub.length, feishuMembers: repo.allowedFeishu.length, groups: bindings }))

export async function applyCompany(company, request, start = false, checkBranches = checkAllBranchRules, stateDir) {
  let state = await request('state')
  let plan = planCompany(company, state)
  const modelFiles = await modelCredentials(company, stateDir, state)
  let branchRules
  if (start) {
    const active = plan.filter(({ existing }) => existing?.enabled !== false)
    const toStart = active.filter(({ existing }) => !existing?.status?.online && !existing?.starting)
    requireValue(Number.isInteger(state.capacity?.runningRepositories)
      && state.capacity.maxRunningRepositories >= state.capacity.runningRepositories + toStart.length,
    'There are not enough free manager slots for all enabled repositories. Review the current running instances before starting.')
    branchRules = await checkBranches(active.map(({ repo }) => repo))
    state = await request('state')
    plan = planCompany(company, state)
  }
  if (company.feishuCli) {
    const connecting = !state.bot || !state.botCli
    if (connecting) state = await request('bot', 'PUT', { cli: company.feishuCli })
    const activeGroups = plan.filter(({ repo, existing, action, bindings }) => repo.chatIds.length > 0
      && (connecting || (start && existing?.enabled !== false) || action !== 'unchanged' || bindings.some(group => group.action === 'bind' || !group.verified)))
    if (activeGroups.length) state = await request('chats/refresh', 'POST', {})
    for (const { repo } of activeGroups) {
      for (const id of repo.chatIds) requireValue(hasChat(state, id), `${repo.id} uses a Feishu group the configured bot has not joined: ${id}`)
      const members = new Set()
      for (const id of repo.chatIds) {
        const response = await request(`chats/${encodeURIComponent(id)}/members`)
        requireValue(Array.isArray(response.users), `Cannot verify members of Feishu group ${id}`)
        for (const user of response.users) members.add(user.member_id)
      }
      const missing = repo.allowedFeishu.filter(id => !members.has(id)).length
      requireValue(!missing, `${repo.id} has ${missing} allowlisted Feishu open_id(s) missing from its configured groups`)
    }
  }
  const checked = planCompany(company, state)
  for (const { repo, existing, action } of checked) {
    if (action === 'unchanged') continue
    const body = Object.fromEntries(fields.map(name => [name, repo[name]]))
    body.remote = existing?.remote ?? body.remote
    body.enabled = existing?.enabled ?? true
    body.revision = state.revision
    state = await request(existing ? repoPath(existing.id) : 'repositories', existing ? 'PUT' : 'POST', body)
  }
  const modelCredentialsStaged = []
  if (modelFiles) {
    for (const { repo, existing } of planCompany(company, state)) {
      const bytes = modelFiles.credentials.get(repo.id)
      if (bytes) modelCredentialsStaged.push({ id: repo.id, outcome: await stageCredential(modelFiles.root, existing.id, bytes) })
    }
  }
  const plannedBindings = planCompany(company, state).flatMap(({ existing, bindings }) => bindings
    .filter(binding => binding.action === 'bind').map(binding => ({ chatId: binding.id, repositoryId: existing.id, enabled: true })))
  if (plannedBindings.length) {
    const preserved = state.bindings.map(({ chatId, repositoryId, enabled }) => ({ chatId, repositoryId, enabled }))
    state = await request('bindings', 'PUT', { revision: state.revision, bindings: [...preserved, ...plannedBindings] })
  }
  const starts = []
  if (start) {
    for (const { repo, existing } of planCompany(company, state)) {
      if (!existing.enabled || existing.status?.online || existing.starting) continue
      state = await request(`${repoPath(existing.id)}/start`, 'POST', {})
      starts.push(repo.id)
    }
  }
  const output = planOutput(planCompany(company, state))
  requireValue(output.every(row => row.action === 'unchanged' && row.groups.every(group => group.action !== 'bind')), 'Manager did not persist the complete desired configuration; re-run after checking the current state')
  return { action: 'applied', counts: company.counts, capacity: state.capacity, repositories: output, started: starts,
    ...(modelCredentialsStaged.length ? { modelCredentialsStaged } : {}),
    ...(branchRules === undefined ? {} : { branchRules }) }
}

async function repoStatus(request, repo, existing, action, bindings) {
  const blockers = []
  if (action !== 'unchanged') blockers.push(action === 'register' ? 'repository not registered' : 'repository configuration differs from manifest')
  if (existing?.enabled === false) blockers.push('repository paused in manager')
  if (bindings.some(binding => binding.action !== 'unchanged' || !binding.verified)) blockers.push('one or more Feishu groups are unverified or paused')
  if (!existing?.status?.online) blockers.push('repository worker is not running')
  else if (!existing.status.configured || existing.status.error || existing.status.state === 'error') blockers.push('repository worker setup is incomplete or unhealthy')
  else {
    try {
      const path = `${repoPath(existing.id)}/api`
      const worker = await request(`${path}/state`)
      if (worker.paused) blockers.push('repository executor paused')
      if (worker.setup?.problem || (repo.chatIds.length && worker.setup?.feishuProblem)) blockers.push('repository sources report a setup problem')
      if (Object.values(worker.health ?? {}).some(value => value.state === 'error')) blockers.push('repository worker reports an error')
      const settings = await request(`${path}/settings`)
      const models = await request(`${path}/models`)
      for (const role of ['eval', 'executor']) {
        const model = settings.blocks?.[role]?.value?.model ?? models.default
        if (!model?.model || !models.routableProviders?.includes(model.provider)) blockers.push(`${role} model has no routable provider`)
      }
    } catch (error) { blockers.push(error.message) }
  }
  return { id: repo.id, repository: repo.remote, ready: !blockers.length, blockers }
}

export async function statusCompany(company, request) {
  const state = await request('state')
  const plan = planCompany(company, state)
  const repositories = await Promise.all(plan.map(({ repo, existing, action, bindings }) => repoStatus(request, repo, existing, action, bindings)))
  const managerErrors = Object.entries(state.health ?? {}).filter(([, component]) => component.state === 'error').map(([name]) => name)
  if (company.repositories.some(repo => repo.chatIds.length) && !state.bot) managerErrors.push('feishu-bot-unavailable')
  return { action: 'status', readiness: !managerErrors.length && repositories.every(repo => repo.ready), counts: company.counts,
    capacity: state.capacity, managerErrors, repositories, checks: 'Configuration and provider routing only. Complete a real end-to-end ticket before declaring rollout ready.' }
}

const usage = `Usage: node configure.mjs validate company.json
       node configure.mjs plan|apply|status company.json --operator-token-file /absolute/path [--manager http://127.0.0.1:3082]
  validate  Validate roster, product lines and permissions without accessing the server.
  plan      Check local paths and preview changes against the shared manager without editing it.
  apply     Configure repositories, allowlists and optional Feishu routes on the shared manager.
  --state-dir /absolute/path   With apply, stage specified private model credential files before starting workers.
  --start   With apply, check active branch rules and start enabled repository instances. Existing pauses are preserved.
  status    Check manager, workers and model routing. Exit 2 when setup is incomplete.`

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return }
  const [action, file, ...flags] = args
  requireValue(['validate', 'plan', 'apply', 'status'].includes(action) && file && !file.startsWith('-'), usage)
  let manager = 'http://127.0.0.1:3082', managerSet = false, tokenFile, stateDir, start = false
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === '--manager' && flags[index + 1] && !managerSet && action !== 'validate') {
      manager = flags[++index]
      managerSet = true
    } else if (flags[index] === '--operator-token-file' && flags[index + 1] && !tokenFile && action !== 'validate') {
      tokenFile = flags[++index]
    } else if (flags[index] === '--state-dir' && flags[index + 1] && !stateDir && action === 'apply') {
      stateDir = flags[++index]
    } else if (flags[index] === '--start' && !start && action === 'apply') start = true
    else throw new Error(usage)
  }
  const company = validateCompany(JSON.parse(await readFile(file, 'utf8')))
  let output
  if (action === 'validate') output = { action, counts: company.counts }
  else {
    requireValue(tokenFile, 'Specify --operator-token-file using the deployed manager operator token path')
    const request = managerClient(managerOrigin(manager), await operatorToken(tokenFile))
    const local = await preflightLocal(company)
    if (action === 'plan') {
      const state = await request('state')
      output = { action, counts: local.counts, capacity: state.capacity, repositories: planOutput(planCompany(local, state)) }
    } else if (action === 'apply') {
      output = await applyCompany(local, request, start, checkAllBranchRules, stateDir)
      if (start) {
        output.status = await statusCompany(local, request)
        if (!output.status.readiness) process.exitCode = 2
      }
    }
    else {
      output = await statusCompany(local, request)
      if (!output.readiness) process.exitCode = 2
    }
  }
  console.log(JSON.stringify(output, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
