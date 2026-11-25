/** Loads the same GitHub rules check used by deployment, the supervisor and managed worker setup. */
import { pathToFileURL } from 'node:url'
import { packagePath } from '../infra/paths.ts'

type BranchRuleInput = { remote: string; githubCli: string; requiredChecks?: string[] }

export async function verifyBranchRules(input: BranchRuleInput, signal: AbortSignal): Promise<void> {
  const url = pathToFileURL(packagePath('ops', 'enterprise', 'check-branches.mjs')).href
  const { checkBranchRules } = await import(url) as {
    checkBranchRules(input: BranchRuleInput, options: { signal: AbortSignal }): Promise<unknown>
  }
  await checkBranchRules(input, { signal })
}
