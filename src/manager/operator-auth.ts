/** Loads the operator credential once per manager start and keeps it outside settings and logs. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { authorized } from './protocol.ts'

export const OPERATOR_AUTH_REQUIRED = 'operator_auth_required'

export function loadOperatorAuth(file: string): (authorization: string | undefined) => boolean {
  if (!isAbsolute(file)) throw new Error('operatorTokenFile must be an absolute path')
  let descriptor: number
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new Error('Could not open operatorTokenFile as a regular file without following symbolic links')
  }
  try {
    const stat = fstatSync(descriptor)
    const uid = process.getuid?.()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (uid !== undefined && uid !== stat.uid)) {
      throw new Error('operatorTokenFile must be an owner-only regular file belonging to the manager process user')
    }
    if (stat.size !== 64 && stat.size !== 65) throw new Error('operatorTokenFile must contain 64 lowercase hexadecimal characters')
    const value = Buffer.alloc(66)
    const count = readSync(descriptor, value, 0, value.length, 0)
    const token = value.subarray(0, count).toString('utf8')
    if (count !== stat.size || !/^[0-9a-f]{64}\n?$/.test(token)) {
      throw new Error('operatorTokenFile must contain 64 lowercase hexadecimal characters')
    }
    return authorization => authorized(authorization, token.trimEnd())
  } finally {
    closeSync(descriptor)
  }
}
