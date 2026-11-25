/** Managed worktrees and write scopes: real temporary Git repositories prove parallel tickets, resume, conflicts, and cleanup. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ScopeQueue, normalizeScopePath, overlaps } from '../src/core/scope.ts'
import { WORKTREE_BRANCH_PREFIX, WorktreeConflict, canonicalRemote, inspectWorktree, mirrorPath, prepareWorktree, removeWorktree, repositoryId,
  verifyRemoteBeforeRemoval, worktreeBranch, worktreePath, worktreeRemote } from '../src/infra/worktree.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
const subprocess = { spawn: ({ argv, cwd, signal }: { argv: string[]; cwd: string; signal: AbortSignal }) => {
  let stdout = '', stderr = ''
  const done = exec(argv[0]!, argv.slice(1), { cwd, signal, env: gitEnv() }).then(result => {
    stdout = result.stdout; stderr = result.stderr; return { exitCode: 0 }
  }, error => { stderr = error.stderr; return { exitCode: error.code } })
  return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
} } as unknown as SubprocessRuntime
const signal = new AbortController().signal
const git = (args: string[], cwd: string) => exec('git', args, { cwd, env: gitEnv() })

let root: string, remote: string, checkout: string, execution: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
  remote = join(root, 'remote.git')
  await git(['init', '--bare', '--initial-branch=main', remote], root)
  checkout = join(root, 'checkout')
  await git(['init', '--initial-branch=main', checkout], root)
  await git(['config', 'user.email', 'dev@example.com'], checkout)
  await git(['config', 'user.name', 'Dev'], checkout)
  await writeFile(join(checkout, 'README.md'), 'base\n')
  await git(['add', '.'], checkout)
  await git(['commit', '-m', 'base'], checkout)
  await git(['remote', 'add', 'origin', remote], checkout)
  await git(['push', 'origin', 'main'], checkout)
  execution = join(root, 'execution')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** The worktree plan of a ticket name, with the local bare repository as its remote so nothing touches the network. */
const plan = (name: string) => ({ repository: remote, remote, root: execution, name })
const pathOf = (name: string) => worktreePath(execution, repositoryId(remote), name)
const exists = (path: string) => stat(path).then(item => item.isDirectory(), () => false)
const identity = ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev']
const commitAll = async (directory: string, message: string) => {
  await git(['add', '.'], directory)
  // A worktree carries the managed mirror's configuration, which has no identity of its own.
  await git([...identity, 'commit', '-m', message], directory)
}

it('prepares independent worktrees for two tickets of one repository, side by side', async () => {
  const [a, b] = await Promise.all([prepareWorktree(subprocess, signal, plan('fix-a-abc123456789')),
    prepareWorktree(subprocess, signal, plan('fix-b-def456789012'))])
  expect(a.path).toBe(pathOf('fix-a-abc123456789'))
  expect(a.path).not.toBe(b.path)
  expect(a.branch).toBe(`${WORKTREE_BRANCH_PREFIX}fix-a-abc123456789`)
  expect(a.baseRef).toBe('refs/remotes/origin/main')
  expect(a.baseSha).toMatch(/^[0-9a-f]{40}$/)
  // Each ticket writes and commits in its own worktree; neither the other worktree nor the checkout sees it.
  await writeFile(join(a.path, 'a.txt'), 'a\n'); await commitAll(a.path, 'a')
  await writeFile(join(b.path, 'b.txt'), 'b\n'); await commitAll(b.path, 'b')
  expect(await exists(join(b.path, 'a.txt'))).toBe(false)
  expect(await exists(join(a.path, 'b.txt'))).toBe(false)
  expect(await exists(join(checkout, 'a.txt'))).toBe(false)
  expect((await git(['rev-parse', 'HEAD'], a.path)).stdout.trim()).not.toBe((await git(['rev-parse', 'HEAD'], b.path)).stdout.trim())
  for (const name of ['fix-a-abc123456789', 'fix-b-def456789012']) {
    expect(await inspectWorktree(subprocess, signal, plan(name))).toMatchObject({ registered: true, directoryExists: true,
      pointerExists: true, branchExists: true })
  }
  expect(worktreeBranch('fix-a-abc123456789')).toBe(a.branch)
  expect(worktreeRemote('acme/widgets')).toBe('git@github.com:acme/widgets.git')
  expect(worktreeRemote(remote)).toBe(remote)
  // A worker's `insteadOf` rewrites ssh origins to https, so a mirror cloned over ssh still matches the planned remote.
  expect(canonicalRemote('https://github.com/acme/widgets.git')).toBe('github.com/acme/widgets')
  expect(canonicalRemote(worktreeRemote('acme/widgets'))).toBe('github.com/acme/widgets')
  expect(canonicalRemote('git@github.com:acme/widgets.git')).toBe(canonicalRemote('https://github.com/acme/widgets'))
})

it('follows the advertised default after the origin moves it away from main', async () => {
  await prepareWorktree(subprocess, signal, plan('old-default-abc123456789'))
  await git(['checkout', '-b', 'release/default'], checkout)
  await writeFile(join(checkout, 'README.md'), 'release base\n')
  await commitAll(checkout, 'separate default branch')
  await git(['push', 'origin', 'release/default'], checkout)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/release/default'], remote)
  const scene = await prepareWorktree(subprocess, signal, { ...plan('new-default-def456789012'), requireRemoteDefault: true })
  expect(scene.baseRef).toBe('refs/remotes/origin/release/default')
  expect(await readFile(join(scene.path, 'README.md'), 'utf8')).toBe('release base\n')
  const explicit = await prepareWorktree(subprocess, signal, { ...plan('explicit-main-abc456789012'), baseBranch: 'main' })
  expect(explicit.baseRef).toBe('refs/remotes/origin/main')
})

it('requires an advertised symbolic default in enterprise mode and retains legacy fallback', async () => {
  const commit = (await git(['rev-parse', 'refs/heads/main'], remote)).stdout.trim()
  await git(['update-ref', '--no-deref', 'HEAD', commit], remote)
  await expect(prepareWorktree(subprocess, signal, { ...plan('required-default-abc123456789'), requireRemoteDefault: true }))
    .rejects.toThrow('Could not establish the default branch advertised by')
  const scene = await prepareWorktree(subprocess, signal, plan('legacy-default-def456789012'))
  expect(scene.baseRef).toBe('refs/remotes/origin/main')
})

it('follows the advertised default after the origin moves it away from main', async () => {
  await prepareWorktree(subprocess, signal, plan('old-default-abc123456789'))
  await git(['checkout', '-b', 'release/default'], checkout)
  await writeFile(join(checkout, 'README.md'), 'release base\n')
  await commitAll(checkout, 'separate default branch')
  await git(['push', 'origin', 'release/default'], checkout)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/release/default'], remote)
  const scene = await prepareWorktree(subprocess, signal, { ...plan('new-default-def456789012'), requireRemoteDefault: true })
  expect(scene.baseRef).toBe('refs/remotes/origin/release/default')
  expect(await readFile(join(scene.path, 'README.md'), 'utf8')).toBe('release base\n')
  const explicit = await prepareWorktree(subprocess, signal, { ...plan('explicit-main-abc456789012'), baseBranch: 'main' })
  expect(explicit.baseRef).toBe('refs/remotes/origin/main')
})

it('requires an advertised symbolic default in enterprise mode and retains legacy fallback', async () => {
  const commit = (await git(['rev-parse', 'refs/heads/main'], remote)).stdout.trim()
  await git(['update-ref', '--no-deref', 'HEAD', commit], remote)
  await expect(prepareWorktree(subprocess, signal, { ...plan('required-default-abc123456789'), requireRemoteDefault: true }))
    .rejects.toThrow('Could not establish the default branch advertised by')
  const scene = await prepareWorktree(subprocess, signal, plan('legacy-default-def456789012'))
  expect(scene.baseRef).toBe('refs/remotes/origin/main')
})

it('queues overlapping write scopes of one repository while different files run in their own worktrees', async () => {
  const one = await prepareWorktree(subprocess, signal, plan('fix-one-abc123456789'))
  const two = await prepareWorktree(subprocess, signal, plan('fix-two-def456789012'))
  const repository = repositoryId(remote)
  const queue = new ScopeQueue()
  queue.claim({ ticketId: 'one', title: 'Fix one', repositoryId: repository, scope: ['src/a.ts', 'docs/'] })
  queue.claim({ ticketId: 'two', title: 'Fix two', repositoryId: repository, scope: ['src/b.ts'] })
  // Both write their own files without waiting for each other.
  await mkdir(join(one.path, 'src'), { recursive: true }); await writeFile(join(one.path, 'src/a.ts'), 'a\n')
  await mkdir(join(two.path, 'src'), { recursive: true }); await writeFile(join(two.path, 'src/b.ts'), 'b\n')
  await commitAll(one.path, 'a'); await commitAll(two.path, 'b')
  // A ticket of the same file waits for its holder, and the blocking source names the holder and the overlapping path.
  expect(queue.blockers('three', repository, ['src/b.ts'])).toEqual([{ ticketId: 'two', title: 'Fix two',
    repositoryId: repository, scope: ['src/b.ts'], paths: ['src/b.ts'] }])
  // A directory in one scope covers the files below it, a different path does not overlap, and no scope is the whole repository.
  expect(queue.blockers('three', repository, ['docs/readme.md']).map(blocker => blocker.ticketId)).toEqual(['one'])
  expect(queue.blockers('three', repository, ['src/c.ts'])).toEqual([])
  expect(queue.blockers('three', repository, []).map(blocker => blocker.ticketId).sort()).toEqual(['one', 'two'])
  expect(queue.blockers('four', repositoryId('acme/other'), ['src/a.ts'])).toEqual([])
  expect(normalizeScopePath('./SRC//a.ts')).toBe('src/a.ts')
  expect(normalizeScopePath('src/../lib/x.ts')).toBe('lib/x.ts')
  expect(overlaps(['src'], ['src/deep/file.ts'])).toBe(true)
  expect(overlaps(['src/a.ts'], ['src/b.ts'])).toBe(false)
  queue.release('two')
  expect(queue.blockers('three', repository, ['src/b.ts'])).toEqual([])
})

it('reuses the verified scene of an interrupted preparation instead of preparing it again', async () => {
  const scene = await prepareWorktree(subprocess, signal, plan('fix-resume-abc123456789'))
  const head = (await git(['rev-parse', 'HEAD'], scene.path)).stdout.trim()
  // A restart that recorded the scene before its last step reuses it as it is.
  await expect(prepareWorktree(subprocess, signal, plan('fix-resume-abc123456789'), scene)).resolves.toEqual(scene)
  expect((await git(['rev-parse', 'HEAD'], scene.path)).stdout.trim()).toBe(head)
  // An attempt that created the branch but not its directory is completed in place, at the recorded commit.
  await git(['worktree', 'remove', scene.path], mirrorPath(execution, repositoryId(remote)))
  expect(await exists(scene.path)).toBe(false)
  const repaired = await prepareWorktree(subprocess, signal, plan('fix-resume-abc123456789'), scene)
  expect(repaired).toEqual(scene)
  expect((await git(['rev-parse', 'HEAD'], scene.path)).stdout.trim()).toBe(head)
  // An attempt that created nothing continues from the recorded base commit.
  await git(['worktree', 'remove', scene.path], mirrorPath(execution, repositoryId(remote)))
  await git(['branch', '-D', scene.branch], mirrorPath(execution, repositoryId(remote)))
  const restarted = await prepareWorktree(subprocess, signal, plan('fix-resume-abc123456789'), scene)
  expect(restarted.baseSha).toBe(scene.baseSha)
  expect((await git(['rev-parse', 'HEAD'], scene.path)).stdout.trim()).toBe(scene.baseSha)
})

it('keeps a scene that no longer matches its record, and a directory or branch someone else created, and reports it', async () => {
  const scene = await prepareWorktree(subprocess, signal, plan('fix-drift-abc123456789'))
  await writeFile(join(scene.path, 'manual.txt'), 'kept\n')
  await commitAll(scene.path, 'manual')
  const manual = (await git(['rev-parse', 'HEAD'], scene.path)).stdout.trim()
  await expect(prepareWorktree(subprocess, signal, plan('fix-drift-abc123456789'), scene)).rejects.toThrow(WorktreeConflict)
  // Nothing was reset, cleaned, or removed: the manual commit and its file stay where they are.
  expect(await readFile(join(scene.path, 'manual.txt'), 'utf8')).toBe('kept\n')
  expect((await git(['rev-parse', 'HEAD'], scene.path)).stdout.trim()).toBe(manual)
  expect(manual).not.toBe(scene.baseSha)
  // A directory a person created is reported and kept.
  const stranger = pathOf('fix-stranger-abc123456789')
  await mkdir(stranger, { recursive: true })
  await writeFile(join(stranger, 'mine.txt'), 'mine\n')
  await expect(prepareWorktree(subprocess, signal, plan('fix-stranger-abc123456789'))).rejects.toThrow(WorktreeConflict)
  expect(await readFile(join(stranger, 'mine.txt'), 'utf8')).toBe('mine\n')
  // A registered worktree whose HEAD moved past the recorded base commit is reported as well, with its commit kept.
  const other = await prepareWorktree(subprocess, signal, plan('fix-branch-abc123456789'))
  await writeFile(join(other.path, 'other.txt'), 'other\n'); await commitAll(other.path, 'other')
  const moved = (await git(['rev-parse', 'HEAD'], other.path)).stdout.trim()
  await expect(prepareWorktree(subprocess, signal, plan('fix-branch-abc123456789'), other)).rejects.toThrow(WorktreeConflict)
  expect((await git(['rev-parse', 'HEAD'], other.path)).stdout.trim()).toBe(moved)
  expect((await git(['branch', '--list', other.branch], mirrorPath(execution, repositoryId(remote)))).stdout).toContain(other.branch)
})

it('refuses to remove a worktree with uncommitted or untracked changes and keeps its branch after a clean cleanup', async () => {
  const scene = await prepareWorktree(subprocess, signal, plan('fix-clean-abc123456789'))
  await writeFile(join(scene.path, 'wip.txt'), 'wip\n')
  await expect(removeWorktree(subprocess, signal, plan('fix-clean-abc123456789'), scene)).rejects.toThrow('uncommitted')
  expect(await exists(scene.path)).toBe(true)
  expect(await readFile(join(scene.path, 'wip.txt'), 'utf8')).toBe('wip\n')
  await rm(join(scene.path, 'wip.txt'))
  await removeWorktree(subprocess, signal, plan('fix-clean-abc123456789'), scene)
  expect(await exists(scene.path)).toBe(false)
  // The ticket branch stays reachable unless the caller asks for its removal, and only product branches are removed at all.
  const branches = (await git(['branch', '--list', scene.branch], mirrorPath(execution, repositoryId(remote)))).stdout
  expect(branches).toContain(scene.branch)
  await expect(removeWorktree(subprocess, signal, plan('fix-clean-abc123456789'), { ...scene, branch: 'main' }))
    .rejects.toThrow('not a product branch')
  const again = await prepareWorktree(subprocess, signal, plan('fix-clean-abc123456789'), scene)
  await removeWorktree(subprocess, signal, plan('fix-clean-abc123456789'), again, { branch: true })
  expect((await git(['branch', '--list', scene.branch], mirrorPath(execution, repositoryId(remote)))).stdout.trim()).toBe('')
})

it('never touches the person\'s checkout, including its uncommitted changes', async () => {
  await writeFile(join(checkout, 'README.md'), 'edited by hand\n')
  const before = (await git(['status', '--porcelain'], checkout)).stdout
  const head = (await git(['rev-parse', 'HEAD'], checkout)).stdout.trim()
  const scene = await prepareWorktree(subprocess, signal, plan('fix-readonly-abc123456789'))
  expect(scene.baseSha).toBe(head)
  expect((await git(['status', '--porcelain'], checkout)).stdout).toBe(before)
  expect((await git(['rev-parse', 'HEAD'], checkout)).stdout.trim()).toBe(head)
  expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('edited by hand\n')
  // The worktree was created from the pushed commit, not from the person's uncommitted change.
  expect(await readFile(join(scene.path, 'README.md'), 'utf8')).toBe('base\n')
})

it('removes a worktree only when the remote holds its branch at the local head or no longer holds it', async () => {
  // A branch that never reached the remote was delivered by definition, so its worktree may go: nothing is lost.
  const unpushed = await prepareWorktree(subprocess, signal, plan('fix-remote-abc123456789'))
  expect(await removeWorktree(subprocess, signal, plan('fix-remote-abc123456789'), unpushed)).toMatchObject({ branch: 'gone' })
  expect(await exists(unpushed.path)).toBe(false)
  // A branch the remote holds at the local head was delivered: removal is allowed and reports that head.
  const delivered = await prepareWorktree(subprocess, signal, plan('fix-remote-def456789012'))
  await writeFile(join(delivered.path, 'delivered.txt'), 'delivered\n'); await commitAll(delivered.path, 'delivered')
  const head = (await git(['rev-parse', 'HEAD'], delivered.path)).stdout.trim()
  await git(['push', 'origin', `${delivered.branch}:refs/heads/${delivered.branch}`], delivered.path)
  expect(await removeWorktree(subprocess, signal, plan('fix-remote-def456789012'), delivered)).toEqual({ branch: 'merged',
    remoteHead: head })
  expect(await exists(delivered.path)).toBe(false)
  // A remote branch at another commit means the delivery is pending or unknown: nothing is removed, and the local work stays.
  const pending = await prepareWorktree(subprocess, signal, plan('fix-remote-ghi789012345'))
  await writeFile(join(pending.path, 'pending.txt'), 'pending\n'); await commitAll(pending.path, 'pending')
  await git(['push', 'origin', `${pending.branch}:refs/heads/${pending.branch}`], pending.path)
  // Another writer moves the remote branch back to the base commit, as an overwritten or reverted delivery would.
  await git(['push', '--force', 'origin', `main:refs/heads/${pending.branch}`], checkout)
  const localHead = (await git(['rev-parse', 'HEAD'], pending.path)).stdout.trim()
  await expect(removeWorktree(subprocess, signal, plan('fix-remote-ghi789012345'), pending)).rejects.toThrow('delivery is still pending')
  expect(await exists(pending.path)).toBe(true)
  expect(await readFile(join(pending.path, 'pending.txt'), 'utf8')).toBe('pending\n')
  expect((await git(['rev-parse', 'HEAD'], pending.path)).stdout.trim()).toBe(localHead)
  expect((await git(['branch', '--list', pending.branch], mirrorPath(execution, repositoryId(remote)))).stdout).toContain(pending.branch)
})

it('decides from the recorded and the remote head whether a branch was delivered', () => {
  expect(verifyRemoteBeforeRemoval('abc123', undefined)).toEqual({ allowed: true, branch: 'gone' })
  expect(verifyRemoteBeforeRemoval('abc123', 'abc123')).toEqual({ allowed: true, branch: 'merged', remoteHead: 'abc123' })
  expect(verifyRemoteBeforeRemoval(undefined, 'abc123')).toMatchObject({ allowed: false, branch: 'present' })
  expect(verifyRemoteBeforeRemoval('abc123', 'def456')).toMatchObject({ allowed: false, branch: 'present', remoteHead: 'def456' })
})
