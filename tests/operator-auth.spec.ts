import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadOperatorAuth } from '../src/manager/operator-auth.ts'

it('loads only the exact owner-only credential and changes it on explicit restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manager-operator-'))
  const file = join(directory, 'operator-token')
  try {
    const first = 'a'.repeat(64), next = 'b'.repeat(64)
    writeFileSync(file, first + '\n', { mode: 0o600 })
    const allowed = loadOperatorAuth(file)
    expect(allowed(undefined)).toBe(false)
    expect(allowed(`Bearer ${first}`)).toBe(true)
    expect(allowed(first)).toBe(false)
    expect(allowed(`Bearer ${next}`)).toBe(false)
    writeFileSync(file, next)
    expect(allowed(`Bearer ${first}`)).toBe(true)
    expect(loadOperatorAuth(file)(`Bearer ${first}`)).toBe(false)
    expect(loadOperatorAuth(file)(`Bearer ${next}`)).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('refuses public, symlinked, nonregular, missing or malformed token files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manager-operator-'))
  const file = join(directory, 'operator-token')
  try {
    expect(() => loadOperatorAuth(file)).toThrow('Could not open')
    expect(() => loadOperatorAuth(directory)).toThrow('owner-only regular file')
    writeFileSync(file, 'A'.repeat(64), { mode: 0o600 })
    expect(() => loadOperatorAuth(file)).toThrow('lowercase hexadecimal')
    writeFileSync(file, 'a'.repeat(64))
    chmodSync(file, 0o644)
    expect(() => loadOperatorAuth(file)).toThrow('owner-only regular file')
    chmodSync(file, 0o600)
    const link = join(directory, 'linked-token')
    symlinkSync(file, link)
    expect(() => loadOperatorAuth(link)).toThrow('without following symbolic links')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
