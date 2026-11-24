import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const properLockfile = require('proper-lockfile');
const repositoryId = '11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dsh-maintenance-test-')));
  const home = path.join(root, 'service');
  await fs.mkdir(home, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sha = 'b'.repeat(64);
  const bundle = path.join(home, 'releases', sha, 'package');
  const repo = path.join(home, 'manager', 'repositories', repositoryId);
  await fs.mkdir(bundle, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(repo, 'dsh-home'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(bundle, 'package.json'), '{"name":"dsh-superagent"}', { mode: 0o600 });
  await fs.symlink(path.resolve(source, '../../node_modules'), path.join(bundle, 'node_modules'), 'dir');
  // Stub only the loopback occupancy probe: this suite never binds ports or touches a live DSH instance.
  const networkShim = path.join(root, 'network-shim.mjs');
  await fs.writeFile(networkShim, `import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
net.createConnection = ({ port }) => {
  const socket = new EventEmitter();
  socket.setTimeout = () => socket;
  socket.destroy = () => socket;
  queueMicrotask(() => Number(process.env.TEST_OCCUPIED_PORT) === port
    ? socket.emit('connect') : socket.emit('error', Object.assign(new Error('not listening'), { code: 'ECONNREFUSED' })));
  return socket;
};
syncBuiltinESMExports();`);
  const port = 53081, repoPort = 53082;
  const config = { schema: 1, profile: 'dsh-enterprise-abcdef1234567890', port, capacity: 12, dsh: process.execPath,
    bundle, sha256: sha, path: process.env.PATH, operatorTokenFile: path.join(home, 'operator.token') };
  await fs.writeFile(path.join(home, 'service.json'), JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(path.join(home, 'operator.token'), 'a'.repeat(64), { mode: 0o600 });
  await fs.copyFile(path.join(source, 'dsh-enterprise'), path.join(home, 'dsh-enterprise'));
  await fs.chmod(path.join(home, 'dsh-enterprise'), 0o700);
  await fs.writeFile(path.join(repo, 'dsh-home', '.credentials.yaml'), 'synthetic secret', { mode: 0o600 });
  const db = new DatabaseSync(path.join(home, 'manager', 'manager.sqlite'));
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO kv VALUES (?,?)').run('repositories', JSON.stringify([{ id: repositoryId, port: repoPort }]));
  db.close();
  const state = { occupiedPort: 0 };
  const run = (...args) => exec(process.execPath, ['--import', networkShim, path.join(home, 'dsh-enterprise'), ...args], {
    timeout: 30_000, env: { ...process.env, TEST_OCCUPIED_PORT: String(state.occupiedPort) } });
  return { root, home, config, repo, repoPort, run, state, backup: path.join(root, 'backup') };
}

test('creates a verified private offline snapshot including credentials and preserves external links without following them', async t => {
  const f = await fixture(t);
  const result = JSON.parse((await f.run('backup', f.backup)).stdout);
  assert.equal(result.verified, true);
  assert.equal((await fs.stat(f.backup)).mode & 0o777, 0o700);
  const snapshot = path.join(f.backup, 'snapshot');
  assert.equal((await fs.stat(path.join(snapshot, 'operator.token'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(snapshot, 'manager', 'repositories', repositoryId, 'dsh-home', '.credentials.yaml'), 'utf8'), 'synthetic secret');
  assert.equal((await fs.lstat(path.join(snapshot, 'releases', f.config.sha256, 'package', 'node_modules'))).isSymbolicLink(), true);
  const manifest = JSON.parse(await fs.readFile(path.join(f.backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.some(entry => entry.path.endsWith('.lock') || entry.path === 'manager.pid'), false);
  assert.equal(JSON.parse((await f.run('verify-backup', f.backup)).stdout).verified, true);
  await assert.rejects(f.run('backup', f.backup), /Destination already exists/);
  await assert.rejects(f.run('backup', path.join(f.home, 'backup')), /outside the installation/);
});

test('refuses maintenance while the manager PID, repository port or runtime state lock is active', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, 'manager.pid'), String(process.pid));
  await assert.rejects(f.run('backup', f.backup), /Stop the manager/);
  await fs.rm(path.join(f.home, 'manager.pid'));
  f.state.occupiedPort = f.repoPort;
  await assert.rejects(f.run('backup', f.backup), /Port .* is active/);
  f.state.occupiedPort = 0;
  const unlock = properLockfile.lockSync(f.repo);
  try { await assert.rejects(f.run('backup', f.backup), /Lock file is already being held/); }
  finally { unlock(); }
  assert.equal(await fs.stat(f.backup).catch(() => null), null);
});

test('restores only the same stopped installation and preserves the complete pre-restore state without starting services', async t => {
  const f = await fixture(t);
  await f.run('backup', f.backup);
  await fs.writeFile(path.join(f.repo, 'accepted-after-backup.txt'), 'new event must be preserved', { mode: 0o600 });
  const result = JSON.parse((await f.run('restore', f.backup)).stdout);
  assert.equal(result.running, false);
  assert.equal(await fs.stat(path.join(f.home, 'manager.pid')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(f.repo, 'accepted-after-backup.txt')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(result.preservedCurrentState, 'snapshot', 'manager', 'repositories', repositoryId, 'accepted-after-backup.txt'), 'utf8'), 'new event must be preserved');
  assert.equal(JSON.parse((await f.run('verify-backup', result.preservedCurrentState)).stdout).verified, true);
  assert.equal(await fs.stat(`${f.home}.lifecycle.lock`).catch(() => null), null);
  assert.equal(await fs.stat(path.join(f.home, 'manager.lock')).catch(() => null), null);
});

test('refuses changed snapshots, different releases and non-private backup files before restore writes', async t => {
  const f = await fixture(t);
  await f.run('backup', f.backup);
  const token = path.join(f.backup, 'snapshot', 'operator.token');
  await fs.appendFile(token, '\nchanged');
  await assert.rejects(f.run('restore', f.backup), /integrity verification failed/);
  await fs.writeFile(token, 'a'.repeat(64));
  await fs.chmod(token, 0o644);
  await assert.rejects(f.run('verify-backup', f.backup), /Snapshot is not private/);
  await fs.chmod(token, 0o600);
  const manifestFile = path.join(f.backup, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.releaseSha256 = 'c'.repeat(64);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(f.run('restore', f.backup), /exact release/);
  assert.equal((await fs.readdir(f.root)).some(name => name.includes('before-restore')), false);
});

test('rejects snapshots with altered owner write permissions before creating restore side effects', async t => {
  const f = await fixture(t);
  await f.run('backup', f.backup);
  const token = path.join(f.backup, 'snapshot', 'operator.token');
  await fs.chmod(token, 0o400);
  await assert.rejects(f.run('restore', f.backup), /owner permissions changed/);
  assert.equal((await fs.readdir(f.root)).some(name => name.includes('before-restore')), false);
  assert.equal(await fs.readFile(path.join(f.home, 'operator.token'), 'utf8'), 'a'.repeat(64));
  await fs.chmod(token, 0o600);
  assert.equal(JSON.parse((await f.run('verify-backup', f.backup)).stdout).verified, true);
});

test('refuses restoring while an instance port is active and refuses rotating symbolic log links', async t => {
  const f = await fixture(t);
  await f.run('backup', f.backup);
  f.state.occupiedPort = f.repoPort;
  await assert.rejects(f.run('restore', f.backup), /Port .* is active/);
  assert.equal((await fs.readdir(f.root)).some(name => name.includes('before-restore')), false);
  f.state.occupiedPort = 0;
  const unrelated = path.join(f.root, 'unrelated.log');
  await fs.writeFile(unrelated, 'outside the installation', { mode: 0o600 });
  await fs.symlink(unrelated, path.join(f.home, 'manager.log'));
  await assert.rejects(f.run('rotate-logs'), /Log must be a regular file/);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'outside the installation');
});

test('rotates manager and repository logs only while stopped, keeping five private generations', async t => {
  const f = await fixture(t);
  const logs = path.join(f.home, 'manager', 'logs');
  await fs.mkdir(logs, { mode: 0o700 });
  const files = [path.join(f.home, 'manager.log'), path.join(logs, `${repositoryId}.log`)];
  for (const file of files) {
    await fs.writeFile(file, 'current', { mode: 0o600 });
    await fs.truncate(file, 21 * 1024 * 1024);
    for (let n = 1; n <= 5; n++) await fs.writeFile(`${file}.${n}`, `generation ${n}`, { mode: 0o600 });
  }
  const result = JSON.parse((await f.run('rotate-logs')).stdout);
  assert.equal(result.rotated.length, 2);
  for (const file of files) {
    assert.equal((await fs.stat(file)).size, 0);
    assert.equal((await fs.stat(`${file}.1`)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(`${file}.5`, 'utf8'), 'generation 4');
    assert.equal(await fs.stat(`${file}.6`).catch(() => null), null);
  }
  assert.equal(JSON.parse((await f.run('rotate-logs')).stdout).rotated.length, 0);
});

test('keeps WAL snapshots immutable while checking and restoring their repository registry', async t => {
  const f = await fixture(t);
  const seed = path.join(f.root, 'wal-seed.sqlite');
  const db = new DatabaseSync(seed);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO kv VALUES (?,?)').run('repositories', JSON.stringify([{ id: repositoryId, port: f.repoPort }]));
    // Simulate a stopped/crash snapshot whose committed data is still in WAL, with no SHM file.
    for (const suffix of ['', '-wal']) await fs.copyFile(seed + suffix, path.join(f.home, 'manager', 'manager.sqlite') + suffix);
  } finally { db.close(); }
  await f.run('backup', f.backup);
  const backupDb = path.join(f.backup, 'snapshot', 'manager', 'manager.sqlite');
  assert.equal(await fs.stat(backupDb + '-shm').catch(() => null), null);
  assert.ok((await fs.stat(backupDb + '-wal')).size > 0);
  await f.run('restore', f.backup);
  assert.equal(await fs.stat(backupDb + '-shm').catch(() => null), null);
  assert.equal(JSON.parse((await f.run('verify-backup', f.backup)).stdout).verified, true);
});

test('reads repository logs and rejects invalid IDs without interpreting them as paths or options', async t => {
  const f = await fixture(t);
  const logs = path.join(f.home, 'manager', 'logs');
  await fs.mkdir(logs, { mode: 0o700 });
  await fs.writeFile(path.join(logs, `${repositoryId}.log`), 'repository fixture log\n', { mode: 0o600 });
  assert.match((await f.run('logs', repositoryId)).stdout, /repository fixture log/);
  await assert.rejects(f.run('logs', '../../operator.token'), /Usage/);
  await assert.rejects(f.run('logs', '22222222-2222-4222-8222-222222222222'), /Unknown repository/);
});
