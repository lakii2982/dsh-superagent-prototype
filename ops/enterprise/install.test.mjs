import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const source = dirname(fileURLToPath(import.meta.url))

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-release-install-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const release = join(root, 'release'), bin = join(root, 'bin'), stage = join(root, 'stage'), target = join(root, 'deployment with spaces')
  await Promise.all([mkdir(release), mkdir(bin), mkdir(stage)])
  await copyFile(join(source, 'install.sh'), join(release, 'install.sh'))
  await copyFile(join(source, 'dsh-enterprise'), join(release, 'dsh-enterprise'))
  await chmod(join(release, 'dsh-enterprise'), 0o700)
  const executable = async (name, text) => { await writeFile(join(bin, name), text, { mode: 0o700 }) }
  // Fake only the DSH process. Tests use the real shell, Node, tar and filesystem.
  await executable('id', '#!/bin/sh\nprintf "1000\\n"\n')
  await executable('dsh', `#!${process.execPath}\nconst fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.2.2-rc.5'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(join(root, 'dsh-operations.log'))}, JSON.stringify(args) + '\\n');
if (args[1] === '--from-default-profile') fs.mkdirSync(path.join(process.env.DSH_HOME, 'profiles', args[0]), { recursive: true });
`)
  const pkg = join(stage, 'package')
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-superagent', version: '0.1.1', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  for (const filename of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) await writeFile(join(pkg, filename), '')
  for (const dependency of ['zod', 'proper-lockfile']) {
    const location = join(pkg, 'node_modules', dependency)
    await mkdir(location, { recursive: true })
    await writeFile(join(location, 'package.json'), JSON.stringify({ name: dependency, main: 'index.js' }))
    await writeFile(join(location, 'index.js'), 'module.exports = {}\n')
  }
  const archive = join(release, 'dsh-superagent-0.1.1.tgz')
  const packed = spawnSync('tar', ['-czf', archive, '-C', stage, 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  const metadata = { pluginVersion: '0.1.1', verifiedDshVersion: '0.2.2-rc.5', package: 'dsh-superagent-0.1.1.tgz',
    packageSha256: createHash('sha256').update(await readFile(archive)).digest('hex') }
  const metadataFile = join(release, 'BUILD-INFO.json')
  const writeMetadata = value => writeFile(metadataFile, typeof value === 'string' ? value : JSON.stringify(value))
  await writeMetadata(metadata)
  const run = () => spawnSync('bash', [join(release, 'install.sh'), '--home', target, '--no-start'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000,
  })
  const exists = file => stat(file).then(() => true, () => false)
  return { root, target, release, metadata, metadataFile, archive, run, writeMetadata, exists }
}

test('installs a verified package into a new path without starting the service', async t => {
  const f = await fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const config = JSON.parse(await readFile(join(f.target, 'service.json'), 'utf8'))
  assert.equal(config.sha256, f.metadata.packageSha256)
  assert.equal(config.bundle, join(f.target, 'releases', f.metadata.packageSha256, 'package'))
  assert.equal((await stat(join(f.target, 'operator.token'))).mode & 0o777, 0o600)
  const actions = (await readFile(join(f.root, 'dsh-operations.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(actions.length, 3)
  assert(actions.every(args => !args.includes('--no-open')))
  assert.match(result.stdout, /Installed/)
})

test('refuses a missing build manifest before creating the deployment or running DSH mutations', async t => {
  const f = await fixture(t)
  await rm(f.metadataFile)
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /BUILD-INFO.json is missing/)
  assert.equal(await f.exists(f.target), false)
  assert.equal(await f.exists(join(f.root, 'dsh-operations.log')), false)
})

test('refuses malformed release metadata with a readable error', async t => {
  const f = await fixture(t)
  for (const invalid of ['{broken', { ...f.metadata, packageSha256: 'not-a-checksum' },
    { ...f.metadata, package: 'different-package.tgz' }, { ...f.metadata, pluginVersion: '../bad' }]) {
    await f.writeMetadata(invalid)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /BUILD-INFO.json.*invalid/)
    assert.equal(await f.exists(f.target), false)
  }
})

test('refuses checksum mismatch before extracting the archive or changing the deployment', async t => {
  const f = await fixture(t)
  await f.writeMetadata({ ...f.metadata, packageSha256: '0'.repeat(64) })
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /package SHA-256 does not match BUILD-INFO.json/)
  assert.equal(await f.exists(f.target), false)
  assert.equal(await f.exists(join(f.root, 'dsh-operations.log')), false)
})

test('refuses a manifest for a different verified DSH version', async t => {
  const f = await fixture(t)
  await f.writeMetadata({ ...f.metadata, verifiedDshVersion: '0.2.0' })
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires a different DSH version/)
  assert.equal(await f.exists(f.target), false)
})

test('checks the extracted plugin version against release metadata before touching DSH profiles', async t => {
  const f = await fixture(t)
  await f.writeMetadata({ ...f.metadata, pluginVersion: '0.9.0', package: 'dsh-superagent-0.9.0.tgz' })
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(await readFile(join(f.target, 'install.log'), 'utf8'), /package version does not match BUILD-INFO.json/)
  assert.equal(await f.exists(join(f.target, 'service.json')), false)
  assert.equal(await f.exists(join(f.root, 'dsh-operations.log')), false)
})
