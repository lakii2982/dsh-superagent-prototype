/** Small real subprocess fixture for local CLI stand-ins; never connects to external services. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { gitEnv } from './git.ts'
const exec = promisify(execFile)
export const nativeSubprocess = { spawn: ({ argv, cwd, signal, env }: { argv: string[]; cwd: string; signal: AbortSignal; env?: Record<string, string> }) => {
  let stdout = '', stderr = ''
  const done = exec(argv[0]!, argv.slice(1), { cwd, signal, env: { ...gitEnv(), ...env } }).then(result => {
    stdout = result.stdout; stderr = result.stderr; return { exitCode: 0 }
  }, error => { stderr = error.stderr ?? ''; return { exitCode: typeof error.code === 'number' ? error.code : 1 } })
  return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
} } as unknown as SubprocessRuntime
