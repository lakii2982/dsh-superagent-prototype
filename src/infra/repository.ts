/** Validates an existing checkout without changing its files, index, branch or credentials. */
import { access, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker } from './environment.ts'

export function githubRepository(remote: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())?.[1]?.toLowerCase()
}

export async function verifyRepository(directory: string, repository: string, subprocess: SubprocessRuntime,
  signal: AbortSignal, clean = false): Promise<string> {
  const path = await realpath(directory)
  const git = (...args: string[]) => runAsWorker(subprocess, ['git', ...args], path,
    AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
  const root = await realpath((await git('rev-parse', '--show-toplevel')).trim())
  if (path !== root) throw new Error(`Choose the repository root: ${root}`)
  const remote = githubRepository(await git('remote', 'get-url', 'origin'))
  if (!repository || remote !== repository.toLowerCase()) throw new Error(`The checkout at ${path} does not match ${repository}`)
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const pending = (await git('rev-parse', '--git-path', name)).trim()
    if (await access(resolve(path, pending)).then(() => true, () => false)) throw new Error(`Finish the Git operation (${name}) in ${path} before continuing`)
  }
  if (clean && (await git('status', '--porcelain', '--untracked-files=normal')).trim()) {
    throw new Error(`The repository at ${path} has existing changes. Commit or move them before starting a new ticket; no files were changed`)
  }
  return path
}
