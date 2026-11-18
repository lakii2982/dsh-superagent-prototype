import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { githubRepository, verifyRepository } from '../src/infra/repository.ts'
import { gitEnv } from './fixtures/git.ts'
import { SettingsSchema } from '../src/policy.ts'
import { WorkerSlots, ticketExecution } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'

const exec = promisify(execFile)
const subprocess = { spawn: ({ argv, cwd, signal }: { argv: string[]; cwd: string; signal: AbortSignal }) => {
  let stdout = '', stderr = ''
  const done = exec(argv[0]!, argv.slice(1), { cwd, signal, env: gitEnv() }).then(result => {
    stdout = result.stdout; stderr = result.stderr; return { exitCode: 0 }
  }, error => { stderr = error.stderr; return { exitCode: error.code } })
  return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
} } as unknown as SubprocessRuntime
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-checkout-'))
  await exec('git', ['init', directory], { env: gitEnv() })
  await exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: directory, env: gitEnv() })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const check = (path = directory, clean = true) => verifyRepository(path, 'acme/widgets', subprocess, new AbortController().signal, clean)

it('canonicalizes the root and verifies repository identity without requiring network access', async () => {
  await symlink(directory, join(directory, 'alias'))
  await expect(check(join(directory, 'alias'), false)).resolves.toBe(await check(directory, false))
  await expect(verifyRepository(directory, 'other/repo', subprocess, new AbortController().signal)).rejects.toThrow('does not match')
  expect(githubRepository('https://github.com/Acme/Widgets.git')).toBe('acme/widgets')
  expect(githubRepository('https://example.com/acme/widgets')).toBeUndefined()
})
it('refuses a subdirectory and existing changes without modifying the checkout', async () => {
  await mkdir(join(directory, 'nested'))
  await expect(check(join(directory, 'nested'))).rejects.toThrow('repository root')
  await writeFile(join(directory, 'user.txt'), 'preserve me')
  await expect(check()).rejects.toThrow('existing changes')
  await expect(check(directory, false)).resolves.toBeTruthy()
})
it('refuses an unfinished Git operation even while resuming a ticket', async () => {
  await mkdir(join(directory, '.git', 'rebase-merge'))
  await expect(check(directory, false)).rejects.toThrow('Finish the Git operation')
})
it('requires a path for current mode and preserves isolated defaults for old configurations', () => {
  expect(SettingsSchema.parse({}).executor.workspaceMode).toBe('isolated')
  expect(() => SettingsSchema.parse({ executor: { workspaceMode: 'current' } })).toThrow()
  const settings = SettingsSchema.parse({ executor: { workspaceMode: 'current', repositoryPath: directory }, sources: { github: { config: { repository: 'acme/widgets' } } } })
  const ticket = { id: 'abc123456789000', origin: { triggerId: 'msg' }, mandate: { strength: 'explicit', basis: {} } } as Ticket
  const result = ticketExecution(ticket, { kind: 'accept', name: 'fix', scope: 'fix' } as never, settings, '/state')
  expect(result).toMatchObject({ directory, workspaceMode: 'current', repository: 'acme/widgets' })
  settings.executor.repositoryPath = '/another'
  expect(result.directory).toBe(directory)
})
it('maps worktree mode to a managed worktree per ticket and requires a repository for it', () => {
  const settings = SettingsSchema.parse({ executor: { workspaceMode: 'worktree' },
    sources: { github: { config: { repository: 'acme/widgets' } } } })
  const ticket = { id: 'abc123456789000', origin: { triggerId: 'msg' }, mandate: { strength: 'explicit', basis: {} } } as Ticket
  const accept = { kind: 'accept', name: 'fix', scope: 'fix' } as never
  const path = join('/state/work/worktrees/acme--widgets', 'fix-abc123456789')
  expect(ticketExecution(ticket, accept, settings, '/state')).toEqual({ name: 'fix-abc123456789', directory: path,
    assignment: expect.any(String), workspaceMode: 'worktree', repository: 'acme/widgets',
    worktree: { path, branch: 'dsh-superagent/fix-abc123456789', baseRef: '', baseSha: '', repositoryId: 'acme--widgets' } })
  expect(() => SettingsSchema.parse({ executor: { workspaceMode: 'worktree' } })).toThrow('GitHub repository')
  // Old tickets are never rewritten: an isolated execution records no workspace mode and keeps its own directory.
  expect(ticketExecution(ticket, accept, SettingsSchema.parse({}), '/state')).toEqual({ name: 'fix-abc123456789',
    directory: join('/state/work', 'fix-abc123456789'), assignment: expect.any(String) })
})
it('allows no extra human slot in shared checkout mode', () => {
  const running = ['first']
  const slots = new WorkerSlots(() => running, () => 1, () => false)
  expect(() => slots.reserve('second', 'person')).toThrow('No worker slot')
  running.pop()
  slots.reserve('second', 'launch')
  expect(() => slots.reserve('third', 'wake')).toThrow('No worker slot')
})
