import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkAllBranchRules, checkBranchRules } from './check-branches.mjs'

const enforced = [
  { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI / tests' }] } },
  { type: 'non_fast_forward' }, { type: 'deletion' },
]

async function fixture(t, { remote = 'Company/widgets', fullName = remote, rules = enforced, exit = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-github-rules-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const githubCli = join(base, 'gh-fixture')
  const branch = 'release/main'
  const destinations = {
    [`repos/${remote}`]: { full_name: fullName, default_branch: branch },
    [`repos/${remote}/rules/branches/${encodeURIComponent(branch)}`]: rules,
  }
  await writeFile(githubCli, `#!/usr/bin/env node\nconst [command,h,hostname,m,method,v,version,path] = process.argv.slice(2)\nconst destinations = ${JSON.stringify(destinations)}\nif (command !== 'api' || h !== '--hostname' || hostname !== 'github.com' || m !== '--method' || method !== 'GET' || v !== '--header' || !version.startsWith('X-GitHub-Api-Version:') || !(path in destinations)) process.exit(7)\nif (${JSON.stringify(exit)}) { console.error('SECRET_GH_ERROR_FIXTURE'); process.exit(9) }\nprocess.stdout.write(JSON.stringify(destinations[path]))\n`)
  await chmod(githubCli, 0o700)
  return { remote, githubCli }
}

test('reads the canonical default branch and its active review, CI and update controls', async t => {
  const repo = await fixture(t, { fullName: 'Company/Widgets' })
  assert.deepEqual(await checkBranchRules({ ...repo, requiredChecks: ['CI / tests'] }), {
    repository: 'Company/Widgets', branch: 'release/main', approvals: 2, requiredChecks: ['CI / tests'],
  })
})

test('fails closed on missing enforced protections, classic-only protection, and unmatched approved CI names', async t => {
  const partial = await fixture(t, { rules: [...enforced.slice(0, 2), { type: 'pull_request', parameters: { required_approving_review_count: 0 } }] })
  await assert.rejects(checkBranchRules({ ...partial, requiredChecks: ['CI / approval'] }), /CI \/ approval.*force-push prevention.*branch-deletion prevention/u)
  const absent = await fixture(t, { rules: [] })
  await assert.rejects(checkBranchRules(absent), /required approving review.*required CI status check.*Classic-only protection/u)
})

test('fails on an unexpected repository identity or invalid ruleset response', async t => {
  const renamed = await fixture(t, { fullName: 'Different/widgets' })
  await assert.rejects(checkBranchRules(renamed), /did not identify/u)
  const invalid = await fixture(t, { rules: [{ info: 'no rule type' }] })
  await assert.rejects(checkBranchRules(invalid), /invalid active ruleset response/u)
})

test('collects repo-level failures without printing GitHub CLI diagnostics', async t => {
  const failed = await fixture(t, { remote: 'Company/left', exit: true })
  const denied = await fixture(t, { remote: 'Company/right', rules: [] })
  await assert.rejects(checkAllBranchRules([failed, denied]), error => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /Company\/left.*CLI exit 9/u)
    assert.match(error.message, /Company\/right.*required approving review/u)
    assert.doesNotMatch(error.message, /SECRET_GH_ERROR_FIXTURE/u)
    return true
  })
})
