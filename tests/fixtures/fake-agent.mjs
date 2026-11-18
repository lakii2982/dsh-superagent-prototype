/**
 * A stand-in for the local `claude` and `codex` CLIs in the delegation tests: it prints the same JSON shapes as the real
 * CLIs, logs the argv and directory it received, and can stay alive so a test can stop it. It never touches the network.
 */
import { appendFileSync, writeFileSync } from 'node:fs'

const [agent, ...args] = process.argv.slice(2)
const log = process.env.FAKE_AGENT_LOG
if (log) appendFileSync(log, `${JSON.stringify({ agent, args, cwd: process.cwd(), proxy: process.env.HTTPS_PROXY ?? null })}\n`)
if (process.env.FAKE_AGENT_WRITE_FILE) writeFileSync(process.env.FAKE_AGENT_WRITE_FILE, 'changed by the fake agent\n')
const mode = process.env.FAKE_AGENT_MODE ?? 'ok'
const session = process.env.FAKE_AGENT_SESSION ?? `${agent}-session-1`
if (mode === 'login') {
  const message = 'Not logged in. Run the login command first.'
  if (agent === 'claude') process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, session_id: session, result: message })}\n`)
  else process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`)
  process.exit(1)
} else if (mode === 'sleep') {
  // Keep the process alive until the runner terminates it.
  setInterval(() => {}, 1000)
} else {
  setTimeout(() => {
    const text = process.env.FAKE_AGENT_TEXT ?? `finished in ${process.cwd()}`
    if (agent === 'claude') {
      process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: text,
        usage: { input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0.02 })}\n`)
    } else {
      process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: session })}\n`)
      process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } })}\n`)
      process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } })}\n`)
    }
  }, Number(process.env.FAKE_AGENT_DELAY_MS ?? 0))
}
