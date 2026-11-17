/** The local facade fixes bot identity without changing a user's global CLI policy. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
const exec = promisify(execFile)
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
it('refuses user impersonation and configuration changes, while forwarding bot commands and redacting user auth data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-facade-')); directories.push(directory)
  const cli = join(directory, 'cli')
  writeFileSync(cli, `#!/usr/bin/env node
const args=process.argv.slice(2);
console.log(JSON.stringify(args[0]==='auth'?{appId:'cli_test',identities:{bot:{status:'ready'},user:{userName:'private user'}}}:args));
`); chmodSync(cli, 0o755)
  const run = (...args: string[]) => exec('python3', [resolve('scripts/lark-bot'), ...args], { env: { ...process.env, DSH_SUPERAGENT_LARK_CLI: cli } })
  await expect(run('im', '+messages-send', '--as', 'user')).rejects.toMatchObject({ code: 1 })
  await expect(run('config', 'strict-mode', 'off')).rejects.toMatchObject({ code: 1 })
  expect(JSON.parse((await run('im', '+chat-list')).stdout)).toEqual(['im', '+chat-list', '--as', 'bot'])
  expect(JSON.parse((await run('im', '+chat-list', '--as=bot')).stdout)).toEqual(['im', '+chat-list', '--as', 'bot'])
  expect((await run('config', 'strict-mode')).stdout).toContain('strict-mode: bot')
  const auth = JSON.parse((await run('auth', 'status')).stdout)
  expect(auth.identities).toEqual({ bot: { status: 'ready' } }); expect(auth.identity).toBe('bot')
})
