/**
 * Managed git worktrees: one directory and ticket branch per ticket, created from a managed mirror of the repository, so a
 * ticket never writes in the person's checkout and two tickets of one repository can run at the same time.
 *
 * Preparation is resumable and never repairs by force: it inspects the scene first (registration, branch, directory, HEAD),
 * reuses what it can verify, and on any mismatch or manual change keeps everything in place and reports what it found, so no
 * commit, uncommitted change, or file of a person is ever reset, cleaned, or deleted.
 */
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorktreeScene } from '../core/model.ts'
import { runAsWorker } from './environment.ts'

/** Product prefix of every ticket branch, which also marks the branches this module owns. */
export const WORKTREE_BRANCH_PREFIX = 'dsh-superagent/'
/** Time limits for the Git commands preparation and cleanup run. */
const GIT_TIMEOUT_MS = 60_000, FETCH_TIMEOUT_MS = 5 * 60_000, CLONE_TIMEOUT_MS = 10 * 60_000
/** Thrown when the scene on disk does not match the recorded one; the scene is left untouched. */
export class WorktreeConflict extends Error {}
/** What a scene looks like right now: the three facts of preparation, kept apart. */
export interface WorktreeFacts {
  path: string
  directoryExists: boolean
  /** The directory carries a `.git` pointer file, as a linked worktree does. */
  pointerExists: boolean
  branchExists: boolean
  branchSha?: string
  /** Whether the mirror registers this directory as a worktree. */
  registered: boolean
  headSha?: string
  clean: boolean
}
/** Durable phase of a ticket's worktree preparation, so a restart resumes the same scene instead of guessing from the disk. */
export interface WorktreePreparation { state: 'pending' | 'preparing' | 'ready' | 'failed'; error?: string; at: string; scene?: WorktreeScene }
/** A ticket's worktree: the repository it belongs to, the remote its mirror is made from, and where it lives. */
export interface WorktreePlan {
  /** Repository identity, such as `acme/widgets`, or the origin URL itself. */
  repository: string
  /** Origin URL or local path the managed mirror is cloned from and fetched from. */
  remote: string
  /** Execution root: `repositories/` and `worktrees/` live under it. */
  root: string
  /** Validated worktree name: the ticket's short English name and ticket ID, which names its directory and branch. */
  name: string
  /** Branch the ticket branches from; absent means the remote's default branch. */
  baseBranch?: string
  /** Enterprise work must establish the remote default instead of falling back to a local guess. */
  requireRemoteDefault?: boolean
}

/** The directory-safe form of a repository identity, used for the mirror's and the worktrees' directories. */
export function repositoryId(repository: string): string {
  return repository.trim().replace(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/i, '')
    .replace(/\.git\/?$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '--').replace(/^--|--$/g, '')
}
/** The remote URL a repository identity is cloned from: a URL or path as it is, else its GitHub SSH address. */
export const worktreeRemote = (repository: string): string =>
  /^(?:[a-z]+:\/\/|git@|\/)/i.test(repository.trim()) ? repository.trim() : `git@github.com:${repository.trim()}.git`
/** The ticket branch a worktree name maps to; every branch this module creates carries `WORKTREE_BRANCH_PREFIX`. */
export const worktreeBranch = (name: string): string => `${WORKTREE_BRANCH_PREFIX}${name}`
/** The managed mirror of `repositoryId` under `root`; a bare repository, never a checkout a person works in. */
export const mirrorPath = (root: string, repositoryId: string): string => join(root, 'repositories', `${repositoryId}.git`)
/** The directory of a ticket's worktree under `root`. */
export const worktreePath = (root: string, repositoryId: string, name: string): string => join(root, 'worktrees', repositoryId, name)

/** The GitHub repository a remote names, whatever spelling it uses: a worker's `insteadOf` turns `git@github.com:` into an https URL, so the two must compare equal. */
export function canonicalRemote(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/:$/, '')
    .replace(/^(?:[a-z]+:\/\/)?(?:git@)?github\.com[/:]/i, 'github.com/').toLowerCase()
}

/** Whether two origin spellings name the same remote: compared by canonical identity, else as paths when both exist. */
async function sameRemote(one: string, other: string): Promise<boolean> {
  if (canonicalRemote(one) === canonicalRemote(other)) return true
  const [a, b] = await Promise.all([realpath(one).catch(() => undefined), realpath(other).catch(() => undefined)])
  return a !== undefined && a === b
}

/**
 * Inspect the scene `plan` names without changing anything: whether the branch exists and where it points, whether the mirror
 * registers the directory, whether the directory exists and carries the worktree's `.git` pointer, and whether it is clean.
 */
export async function inspectWorktree(subprocess: SubprocessRuntime, signal: AbortSignal, plan: WorktreePlan): Promise<WorktreeFacts> {
  const id = repositoryId(plan.repository), path = worktreePath(plan.root, id, plan.name), branch = worktreeBranch(plan.name)
  const mirror = mirrorPath(plan.root, id)
  const inMirror = (...args: string[]) => runAsWorker(subprocess, ['git', ...args], mirror,
    AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]))
  const directoryExists = await stat(path).then(item => item.isDirectory(), () => false)
  const pointerExists = directoryExists && await stat(join(path, '.git')).then(item => item.isFile(), () => false)
  // Git resolves symbolic links in paths it records (a temporary directory on macOS is under `/var` and `/private/var`), so
  // the directory it lists is compared in its canonical form.
  const canonical = (value: string) => realpath(value).catch(() => resolve(value))
  const listedPath = await canonical(path)
  let branchSha: string | undefined, registered = false, headSha: string | undefined
  if (await access(join(mirror, 'HEAD')).then(() => true, () => false)) {
    branchSha = await inMirror('-C', mirror, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(output => output.trim(), () => undefined) || undefined
    const listed = await inMirror('-C', mirror, 'worktree', 'list', '--porcelain').catch(() => '')
    for (const block of listed.split(/\n\s*\n/)) {
      const lines = block.split('\n').map(line => line.trim())
      const worktree = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
      if (!worktree || await canonical(worktree) !== listedPath) continue
      const linked = lines.find(line => line.startsWith('branch '))?.slice('branch '.length)
      if (linked && linked !== `refs/heads/${branch}`) {
        throw new WorktreeConflict(`${path} is a worktree of ${linked}, not of ${branch}; it was left as it is`)
      }
      registered = true
      headSha = lines.find(line => line.startsWith('HEAD '))?.slice('HEAD '.length)
    }
  }
  const clean = pointerExists && await runAsWorker(subprocess, ['git', 'status', '--porcelain', '--untracked-files=normal'], path,
    AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)])).then(output => !output.trim(), () => false)
  return { path, directoryExists, pointerExists, branchExists: !!branchSha, branchSha, registered, headSha, clean }
}

/** Ensure the managed bare mirror exists and its origin is the planned remote; a mismatched mirror is kept and reported. */
async function ensureMirror(subprocess: SubprocessRuntime, signal: AbortSignal, plan: WorktreePlan, id: string): Promise<string> {
  const mirror = mirrorPath(plan.root, id)
  const git = (...args: string[]) => runAsWorker(subprocess, ['git', ...args], dirname(mirror),
    AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]))
  if (!await access(join(mirror, 'HEAD')).then(() => true, () => false)) {
    await mkdir(dirname(mirror), { recursive: true })
    await runAsWorker(subprocess, ['git', 'clone', '--bare', '--no-single-branch', plan.remote, mirror], dirname(mirror),
      AbortSignal.any([signal, AbortSignal.timeout(CLONE_TIMEOUT_MS)])).catch((error: unknown) => {
      throw new Error(`Clone ${plan.remote} into ${mirror} failed: ${String(error)}; nothing was changed in ${plan.root}`)
    })
  }
  const origin = (await git('-C', mirror, 'remote', 'get-url', 'origin').catch(() => '')).trim()
  if (!await sameRemote(origin, plan.remote)) throw new WorktreeConflict(`The managed repository ${mirror} belongs to ${origin || 'no remote'}, not to ${plan.remote}; it was left as it is`)
  const bare = (await git('-C', mirror, 'rev-parse', '--is-bare-repository').catch(() => 'false')).trim()
  if (bare !== 'true') throw new WorktreeConflict(`${mirror} is not a bare repository; it was left as it is`)
  return mirror
}

/** Fetch the mirror's branches into `refs/remotes/origin/*` and resolve the base the ticket branches from. */
async function resolveBase(subprocess: SubprocessRuntime, signal: AbortSignal, plan: WorktreePlan, mirror: string):
  Promise<{ baseRef: string; baseSha: string }> {
  const git = (...args: string[]) => runAsWorker(subprocess, ['git', ...args], mirror,
    AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]))
  await runAsWorker(subprocess, ['git', '-C', mirror, 'fetch', '--prune', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
    mirror, AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])).catch((error: unknown) => {
    throw new Error(`Fetch ${plan.remote} failed: ${String(error)}; the mirror at ${mirror} was left as it is`)
  })
  let branch = plan.baseBranch?.trim()
  if (!branch) {
    // Bare clones usually lack a local origin/HEAD even after the fetch above. Ask the origin itself.
    const advertised = await git('ls-remote', '--symref', 'origin', 'HEAD').catch(() => '')
    branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(advertised)?.[1]
    if (!branch && plan.requireRemoteDefault) {
      throw new WorktreeConflict(`Could not establish the default branch advertised by ${plan.remote}; the worktree was not created`)
    }
    if (!branch) {
      const head = (await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')).trim()
      branch = head.replace(/^origin\//, '') || undefined
    }
  }
  for (const name of branch ? [branch] : ['main', 'master']) {
    const baseRef = `refs/remotes/origin/${name}`
    const baseSha = (await git('rev-parse', '--verify', '--quiet', baseRef).catch(() => '')).trim()
    if (baseSha) return { baseRef, baseSha }
  }
  throw new Error(`The branch ${branch ?? 'main'} does not exist in ${plan.remote}; choose the branch the ticket starts from`)
}

/** A scene from recorded and inspected facts, keeping the recorded base commit and remote ref. */
const sceneOf = (plan: WorktreePlan, recorded: Pick<WorktreeScene, 'baseRef' | 'baseSha'>): WorktreeScene =>
  ({ path: worktreePath(plan.root, repositoryId(plan.repository), plan.name), branch: worktreeBranch(plan.name),
    baseRef: recorded.baseRef, baseSha: recorded.baseSha, repositoryId: repositoryId(plan.repository) })

/**
 * Prepare the worktree of one ticket: clone the mirror if it does not exist yet, fetch, resolve the base commit, and add the
 * ticket branch and directory. Given the scene of an interrupted attempt, it verifies and reuses that scene instead of
 * rebuilding it; a scene that does not match, or a directory or branch someone else created, is kept and reported as a
 * `WorktreeConflict`, never reset, cleaned, or removed.
 */
export async function prepareWorktree(subprocess: SubprocessRuntime, signal: AbortSignal, plan: WorktreePlan,
  previous?: WorktreeScene): Promise<WorktreeScene> {
  if (!plan.name || plan.name.includes('/')) throw new Error(`Not a worktree name: ${plan.name}`)
  const id = repositoryId(plan.repository)
  if (!id) throw new Error(`Not a repository identity: ${plan.repository}`)
  const path = worktreePath(plan.root, id, plan.name), branch = worktreeBranch(plan.name)
  const mirror = mirrorPath(plan.root, id)
  await mkdir(dirname(path), { recursive: true })
  // Two tickets of one repository prepare one after the other, so they neither race to create the mirror nor for fetch's ref
  // locks; once prepared, their worktrees and workers run side by side.
  return await serialized(mirror, async () => {
    const previousMirror = await access(join(mirror, 'HEAD')).then(() => true, () => false)
    if (previous) {
      if (!previousMirror) throw new WorktreeConflict(`The managed repository ${mirror} of ${plan.repository} is missing; the worktree at ${previous.path} was left as it is`)
      return await resume(subprocess, signal, plan, previous, mirror, path, branch)
    }
    await ensureMirror(subprocess, signal, plan, id)
    const base = await resolveBase(subprocess, signal, plan, mirror)
    const facts = await inspectWorktree(subprocess, signal, plan)
    if (facts.directoryExists) {
      throw new WorktreeConflict(`${path} already exists but is not the worktree of ${branch}; it was left as it is`)
    }
    const git = (...args: string[]) => runAsWorker(subprocess, ['git', ...args], mirror,
      AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]))
    if (facts.branchExists) {
      if (facts.branchSha !== base.baseSha) {
        throw new WorktreeConflict(`The branch ${branch} exists at ${facts.branchSha}, not at ${base.baseSha}; it was left as it is`)
      }
      await git('worktree', 'add', path, branch)
    }
    else await git('worktree', 'add', '-b', branch, path, base.baseSha)
    return await verified(subprocess, signal, plan, sceneOf(plan, base), facts => facts.headSha === base.baseSha)
  })
}

/** The preparations in flight by mirror, which one repository's tickets pass through one at a time. */
const preparing = new Map<string, Promise<unknown>>()
/** Run `work` after the preparation already queued for `mirror`, keeping the queue going whether it fails or not. */
async function serialized<T>(mirror: string, work: () => Promise<T>): Promise<T> {
  const previous = preparing.get(mirror) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(work)
  preparing.set(mirror, run)
  return await run
}

/** Reuse an interrupted attempt's scene when every fact verifies, completing only a branch without its directory. */
async function resume(subprocess: SubprocessRuntime, signal: AbortSignal, plan: WorktreePlan, previous: WorktreeScene,
  mirror: string, path: string, branch: string): Promise<WorktreeScene> {
  const facts = await inspectWorktree(subprocess, signal, plan)
  const scene = sceneOf(plan, previous)
  const git = (...args: string[]) => runAsWorker(subprocess, ['git', ...args], mirror,
    AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]))
  const sameBase = (sha: string | undefined) => sha === previous.baseSha
  if (facts.registered && facts.directoryExists && facts.branchExists && facts.pointerExists && sameBase(facts.headSha)) {
    return await verified(subprocess, signal, plan, scene, candidate => candidate.headSha === previous.baseSha)
  }
  // A branch created before the directory was added is the one safe repair: the branch is the recorded one, at the recorded commit.
  if (!facts.registered && !facts.directoryExists && facts.branchExists) {
    if (!sameBase(facts.branchSha)) {
      throw new WorktreeConflict(`The branch ${branch} is at ${facts.branchSha}, not at the recorded ${previous.baseSha}; it was left as it is`)
    }
    await git('worktree', 'add', path, branch)
    return await verified(subprocess, signal, plan, scene, candidate => candidate.headSha === previous.baseSha)
  }
  // Nothing was created yet: continue from the recorded commit, which is what the attempt started from.
  if (!facts.registered && !facts.directoryExists && !facts.branchExists) {
    await git('rev-parse', '--verify', `${previous.baseSha}^{commit}`).catch(() => {
      throw new WorktreeConflict(`The recorded base commit ${previous.baseSha} is no longer in ${mirror}; the scene was left as it is`)
    })
    await git('worktree', 'add', '-b', branch, path, previous.baseSha)
    return await verified(subprocess, signal, plan, scene, candidate => candidate.headSha === previous.baseSha)
  }
  throw new WorktreeConflict(`The preparation of ${path} does not match its recorded state (${describe(facts)}); it was left as it is`)
}

/** Verify a prepared scene and return it, or report the facts it found while keeping it. */
async function verified(subprocess: SubprocessRuntime, signal: AbortSignal, plan: WorktreePlan, scene: WorktreeScene,
  accepted: (facts: WorktreeFacts) => boolean): Promise<WorktreeScene> {
  const facts = await inspectWorktree(subprocess, signal, plan)
  if (!facts.registered || !facts.directoryExists || !facts.pointerExists || !facts.branchExists || !accepted(facts)) {
    throw new WorktreeConflict(`The worktree at ${scene.path} is not ready (${describe(facts)}); it was left as it is`)
  }
  return scene
}
/** One line of the facts, for a conflict message. */
const describe = (facts: WorktreeFacts): string => [`directory ${facts.directoryExists ? 'exists' : 'missing'}`,
  `registration ${facts.registered ? 'present' : 'missing'}`, `branch ${facts.branchExists ? `at ${facts.branchSha}` : 'missing'}`,
  `HEAD ${facts.headSha ?? 'unknown'}`].join(', ')

/**
 * Remove the worktree of a ticket, and with `branch` its ticket branch: only a directory inside the managed root that the
 * mirror registers, on a product branch, with no uncommitted or untracked change, and whose remote delivery state was checked
 * is removed; the branch is kept by default so its commits stay reachable after the ticket ended. A branch the remote holds at
 * another commit than the local head is refused, because removing the worktree would hide work that never reached the remote.
 * Anything else is refused and kept as it is.
 */
export async function removeWorktree(subprocess: SubprocessRuntime, signal: AbortSignal, plan: WorktreePlan, scene: WorktreeScene,
  options: { branch?: boolean } = {}): Promise<RemoveWorktreeResult> {
  const id = repositoryId(plan.repository), managed = worktreePath(plan.root, id, plan.name)
  const mirror = mirrorPath(plan.root, id)
  if (!scene.branch.startsWith(WORKTREE_BRANCH_PREFIX)) throw new Error(`${scene.branch} is not a product branch; it was left as it is`)
  const root = await realpath(join(plan.root, 'worktrees')).catch(() => undefined)
  const path = await realpath(scene.path).catch(() => undefined)
  if (!root || !path || !path.startsWith(`${root}/`) || path !== await realpath(managed).catch(() => undefined)) {
    throw new Error(`${scene.path} is not a worktree of ${plan.repository} under ${plan.root}; it was left as it is`)
  }
  const facts = await inspectWorktree(subprocess, signal, plan)
  if (!facts.registered) throw new WorktreeConflict(`${scene.path} is not registered by ${mirror}; it was left as it is`)
  if (!facts.clean) throw new Error(`The worktree at ${scene.path} has uncommitted or untracked changes. Commit or move them before cleanup; no files were changed`)
  // The remote is asked before anything is removed: a branch the remote no longer has, or has at the local head, was delivered;
  // one the remote holds at another commit means a delivery is still pending or unknown, and nothing is removed.
  const remoteHead = await runAsWorker(subprocess, ['git', 'ls-remote', 'origin', `refs/heads/${scene.branch}`], mirror,
    AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])).then(output => output.split('\n')
    .map(line => line.trim()).find(line => line !== '')?.split(/\s+/)[0], (error: unknown) => {
    throw new WorktreeConflict(`The remote state of ${scene.branch} could not be checked (${String(error)}); the worktree at ${scene.path} was left as it is`)
  })
  const check = verifyRemoteBeforeRemoval(facts.headSha ?? facts.branchSha, remoteHead)
  if (!check.allowed) throw new WorktreeConflict(check.reason!)
  const git = (...args: string[]) => runAsWorker(subprocess, ['git', ...args], mirror,
    AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]))
  await git('worktree', 'remove', scene.path)
  if (options.branch) await git('branch', '-D', scene.branch)
  return { branch: check.branch, ...remoteHead ? { remoteHead } : {} }
}

/** The remote state of a ticket branch before its worktree is removed, as `removeWorktree` returns it. */
export interface RemoveWorktreeResult { remoteHead?: string; branch: 'merged' | 'gone' | 'present' }
/** Whether the remote state of a ticket branch allows removing its worktree, and why not. */
export interface RemoteRemovalCheck { allowed: boolean; branch: 'merged' | 'gone' | 'present'; remoteHead?: string; reason?: string }
/**
 * Decide from the recorded local head and the remote's head of the same branch whether the worktree may be removed: a branch
 * the remote does not have (`gone`) or has at the local head (`merged`) is delivered, so removal loses nothing; a branch the
 * remote has at another commit (`present`) is refused, because a delivery is pending or its outcome is unknown.
 */
export function verifyRemoteBeforeRemoval(head: string | undefined, remoteHead: string | undefined): RemoteRemovalCheck {
  if (!remoteHead) return { allowed: true, branch: 'gone' }
  if (head && remoteHead === head) return { allowed: true, branch: 'merged', remoteHead }
  return { allowed: false, branch: 'present', remoteHead,
    reason: `The branch is at ${remoteHead} on the remote, not at the local head ${head ?? 'unknown'}: its delivery is still pending or its outcome unknown, so the worktree was left as it is` }
}

/** Read the `.git` pointer of a worktree, for a caller that needs the mirror's metadata directory. */
export async function worktreePointer(scene: WorktreeScene): Promise<string | undefined> {
  return await readFile(join(scene.path, '.git'), 'utf8').then(text => text.trim(), () => undefined)
}
