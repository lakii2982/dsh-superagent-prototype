#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repositoryName = /^[\w.-]+\/[\w.-]+$/u
const apiVersion = 'X-GitHub-Api-Version: 2022-11-28'

function cliEnvironment() {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
  // Use the registered wrapper's own authentication, independent of the operator's shell tokens.
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN
  return env
}

async function readApi(cli, remote, operation, path, signal) {
  try {
    const { stdout } = await execute(cli, ['api', '--hostname', 'github.com', '--method', 'GET',
      '--header', apiVersion, path], { env: cliEnvironment(), signal, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
    return JSON.parse(stdout)
  } catch (error) {
    const exit = typeof error.code === 'number' ? ` (CLI exit ${error.code})` : ''
    throw new Error(`${remote}: unable to read ${operation}${exit}. Check the registered GitHub CLI identity and repository Metadata access.`)
  }
}

function configuredChecks(checks) {
  if (!Array.isArray(checks) || checks.some(check => typeof check !== 'string' || !check.trim())) {
    throw new Error('requiredChecks must be a list of nonempty GitHub check context names.')
  }
  return new Set(checks.map(check => check.trim()))
}

/** Inspect enforced GitHub Rulesets for the actual default branch. Classic-only protection is unverified by this API. */
export async function checkBranchRules({ remote, githubCli, requiredChecks = [] }, { signal } = {}) {
  if (typeof remote !== 'string' || !repositoryName.test(remote) || remote.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('A GitHub repository in owner/name form is required.')
  }
  if (typeof githubCli !== 'string' || !isAbsolute(githubCli)) throw new Error(`${remote}: an absolute GitHub CLI path is required.`)
  const approvedChecks = configuredChecks(requiredChecks)
  try { await access(githubCli, constants.X_OK) }
  catch { throw new Error(`${remote}: the registered GitHub CLI is not executable.`) }

  const metadata = await readApi(githubCli, remote, 'repository metadata', `repos/${remote}`, signal)
  const branch = metadata?.default_branch
  if (typeof metadata?.full_name !== 'string' || metadata.full_name.toLowerCase() !== remote.toLowerCase()
    || typeof branch !== 'string' || !branch || branch.length > 1024 || /[\s\x00-\x1f\x7f]/u.test(branch)) {
    throw new Error(`${remote}: GitHub did not identify the registered repository's default branch.`)
  }

  const rules = await readApi(githubCli, remote, 'active default-branch rules', `repos/${remote}/rules/branches/${encodeURIComponent(branch)}`, signal)
  if (!Array.isArray(rules) || rules.some(rule => typeof rule?.type !== 'string')) {
    throw new Error(`${remote} (${branch}): GitHub returned an invalid active ruleset response.`)
  }

  const checks = new Set()
  let approvals = 0
  for (const rule of rules) {
    if (rule.type === 'pull_request' && Number.isInteger(rule.parameters?.required_approving_review_count)) {
      approvals = Math.max(approvals, rule.parameters.required_approving_review_count)
    }
    if (rule.type === 'required_status_checks' && Array.isArray(rule.parameters?.required_status_checks)) {
      for (const check of rule.parameters.required_status_checks) {
        if (typeof check?.context === 'string' && check.context.trim()) checks.add(check.context.trim())
      }
    }
  }

  const protections = new Set(rules.map(rule => rule.type))
  const missing = []
  if (approvals < 1) missing.push('required approving review')
  if (!checks.size) missing.push('required CI status check')
  for (const name of approvedChecks) if (!checks.has(name)) missing.push(`required CI status check ${JSON.stringify(name)}`)
  if (!protections.has('non_fast_forward')) missing.push('force-push prevention')
  if (!protections.has('deletion')) missing.push('branch-deletion prevention')
  if (missing.length) {
    throw Object.assign(new Error(`${remote} (${branch}): active GitHub Rulesets are missing ${missing.join(', ')}. Classic-only protection cannot satisfy this check.`), {
      code: 'branch_rules_missing', branch, missing,
    })
  }

  return { repository: metadata.full_name, branch, approvals, requiredChecks: [...checks].sort() }
}

/** Collect every repository failure before the caller starts or reconfigures anything. */
export async function checkAllBranchRules(repositories) {
  if (!Array.isArray(repositories) || !repositories.length) throw new Error('At least one repository is required.')
  const results = [], failures = []
  for (const repository of repositories) {
    try { results.push(await checkBranchRules(repository)) }
    catch (error) { failures.push(error) }
  }
  if (failures.length) {
    throw new AggregateError(failures, ['Production branch rules check failed.', ...failures.map(error => error.message)].join('\n'))
  }
  return results
}

async function main() {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node check-branches.mjs COMPANY.json')
    const { validateCompany } = await import('./configure.mjs')
    const { repositories } = validateCompany(JSON.parse(await readFile(process.argv[2], 'utf8')))
    const rules = await checkAllBranchRules(repositories)
    console.log(JSON.stringify({ rules, operatorVerificationRequired: ['bot cannot bypass rules', 'only authorized human maintainers can merge'] }, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
