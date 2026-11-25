import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { executable } from '../deployment.ts'
import { workerBin } from '../infra/environment.ts'

const run = promisify(execFile)
const cliEnv = () => ({ ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
function lark(stateDir: string) {
  try { return executable(process.env.DSH_SUPERAGENT_LARK_CLI || 'lark-cli', process.env.PATH ?? '', workerBin(stateDir)) }
  catch { throw new Error('管理服务未检测到飞书 CLI。请在运行 DSH 的主机安装飞书 CLI，然后点击重新发现。') }
}
export const botFacade = () => join(dirname(createRequire(import.meta.url).resolve('dsh-superagent/package.json')), 'scripts/lark-bot')
const profileSchema = z.object({ name: z.string().min(1), appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
  brand: z.enum(['feishu', 'lark']).default('feishu'), user: z.string().nullish() })
export async function profiles(stateDir: string, signal: AbortSignal) {
  const cli = lark(stateDir)
  try {
    const { stdout } = await run(cli, ['profile', 'list'], { signal, timeout: 12000, env: cliEnv() })
    return z.array(profileSchema).nullable().parse(JSON.parse(stdout)) ?? []
  } catch (error) {
    const { stderr = '' } = error as { stderr?: string }
    if (/no profiles|no config|not configured/i.test(stderr)) return []
    throw new Error('无法读取本机飞书账号。请检查管理服务是否能访问当前用户的飞书 CLI 配置，然后重新发现。')
  }
}
export async function discoverProfiles(stateDir: string, signal: AbortSignal, known: { appId: string; name: string }[]) {
  const rows = await profiles(stateDir, signal)
  const cli = lark(stateDir)
  // Limit simultaneous Keychain and bot-info requests on shared installations.
  const items = []
  for (let offset = 0; offset < rows.length; offset += 6) {
    items.push(...await Promise.all(rows.slice(offset, offset + 6).map(async row => {
      let name = known.find(bot => bot.appId === row.appId)?.name
      if (!name) {
        try {
          const { stdout } = await run(cli, ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson', '--profile=' + row.name],
            { signal, timeout: 6000, env: cliEnv() })
          name = z.object({ bot: z.object({ app_name: z.string() }) }).parse(JSON.parse(stdout.trim().split('\n')[0]!)).bot.app_name
        } catch { /* A profile can still be selected and verified after access is restored. */ }
      }
      return { profile: row.name, account: row.user || undefined, appId: row.appId, brand: row.brand, name }
    })))
  }
  return items
}
export async function feishuQr(stateDir: string, url: string, signal: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-qr-'))
  try {
    await run(lark(stateDir), ['auth', 'qrcode', url, '--output', 'permission.png'], { cwd: dir, signal, timeout: 8000, env: cliEnv() })
    return 'data:image/png;base64,' + (await readFile(join(dir, 'permission.png'))).toString('base64')
  } finally { await rm(dir, { recursive: true, force: true }) }
}

interface Registration {
  id: string; profile: string; status: 'waiting' | 'ready' | 'failed'; url?: string; image?: string; error?: string
}
/** Only the confirmation URL is exposed. App credentials and device codes stay in the official CLI. */
export class FeishuRegistration {
  private current?: Registration
  private cancelProcess?: () => void
  constructor(private stateDir: string, private signal: AbortSignal) {}
  get(id: string) {
    if (!this.current || this.current.id !== id) throw new Error('本次扫码已结束，请重新发起。')
    return this.current
  }
  cancel(id: string) {
    this.get(id)
    this.cancelProcess?.()
    this.current = undefined
  }
  start() {
    if (this.current?.status === 'waiting') throw new Error('已有账号正在等待扫码，请先完成当前授权，或等待其过期。')
    const cli = lark(this.stateDir)
    const id = randomUUID()
    const job: Registration = { id, profile: 'dsh-' + id, status: 'waiting' }
    this.current = job
    const child = spawn(cli, ['config', 'init', '--new', '--name', job.profile, '--brand', 'feishu', '--lang', 'zh'],
      { env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const terminate = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM') } catch { /* Already finished. */ }
      }
    }
    this.cancelProcess = terminate
    this.signal.addEventListener('abort', terminate, { once: true })
    const expiry = setTimeout(terminate, 600000)
    expiry.unref()
    let keychainError = false
    const consume = (stream: NodeJS.ReadableStream) => {
      let tail = ''
      stream.on('data', (chunk: Buffer) => {
        const output = tail + chunk.toString()
        keychainError ||= /keychain/i.test(output)
        // Wait for a delimiter so a URL split across chunks is never presented prematurely.
        const match = /https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/page\/cli\?[^\s"'<>\\]+(?=[\s"'<>\\])/.exec(output)
        tail = output.slice(-2048)
        if (job.url || !match || !URL.canParse(match[0]) || !new URL(match[0]).searchParams.get('user_code')) return
        job.url = match[0]
        void feishuQr(this.stateDir, job.url, this.signal).then(image => { if (job.status === 'waiting') job.image = image }, () => {})
      })
    }
    consume(child.stdout); consume(child.stderr)
    child.once('error', () => { job.status = 'failed'; job.error = '飞书授权未能启动，请重试。' })
    child.once('close', code => {
      clearTimeout(expiry)
      this.signal.removeEventListener('abort', terminate)
      if (this.current === job) this.cancelProcess = undefined
      job.status = code === 0 ? 'ready' : 'failed'
      if (code !== 0) job.error = keychainError ? '系统钥匙串无法保存飞书凭据。请解锁钥匙串并允许 DSH 访问后重试。' : '扫码未完成或已过期。可重新发现已添加的账号，或再次发起扫码。'
      delete job.url; delete job.image
    })
    return job
  }
}
