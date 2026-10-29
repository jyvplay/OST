/**
 * TT108 — the test TT107 named as its next highest-information experiment.
 *
 * TT107 proved rollback when the *application* process is killed mid-transaction,
 * and stated plainly that it could not speak for a crash of the database engine
 * itself. This suite provisions a dedicated PostgreSQL cluster, drives real
 * publications through a real production server, SIGKILLs the whole postmaster
 * process group mid-burst, restarts it, and checks what survived.
 *
 * Three configurations are run so the method's own resolution is measured, not
 * assumed. TT107 predicted this experiment would be blind to every durability
 * setting; arm B refutes that prediction, so the prediction is recorded as wrong.
 *
 *   arm A  synchronous_commit=on,  fsync=on   — the shipped configuration.
 *          Expect: nothing acknowledged is lost; no half pairs.
 *   arm B  synchronous_commit=off             — POSITIVE CONTROL. The commit is
 *          acknowledged while its WAL record is still in the server's own memory,
 *          so killing the process destroys it. Expect: acknowledged memories ARE
 *          lost. This proves the method can actually detect a durability
 *          regression, so arm A's pass is not vacuous. Atomicity must still hold:
 *          the lost tail must consist of whole pairs, never halves.
 *   arm C  fsync=off, full_page_writes=off    — NEGATIVE CONTROL / the blind spot.
 *          The WAL record has been written to the operating system before the
 *          acknowledgement, and the page cache outlives the process, so nothing is
 *          lost. This is exactly where the method cannot see: it certifies crash
 *          recovery only, and cannot certify power loss. Said out loud, not implied.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, openSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1') throw Error('Disposable environment required');

const { test, finish } = makeHarness('tt108-engine-crash');
const TOOLS = process.env.TOOLS_DIR ?? '/home/user/tools';
const PKG = path.join(TOOLS, 'node_modules', '@embedded-postgres', 'linux-x64');
const bin = (n: string) => path.join(PKG, 'native', 'bin', n);
const PG_ENV = { ...process.env, LD_LIBRARY_PATH: [path.join(PKG, 'native', 'lib'), process.env.LD_LIBRARY_PATH ?? ''].filter(Boolean).join(':') };
const DATA = path.join(TOOLS, 'pgdata108');
const PGPORT = Number(process.env.TT108_PGPORT ?? 5433);
const APPPORT = Number(process.env.TT108_APPPORT ?? 3108);
const LOGFILE = path.join(TOOLS, 'pg108.log');
const DSN = `postgresql://postgres:postgres@127.0.0.1:${PGPORT}/crash108`;
const BASE = `http://127.0.0.1:${APPPORT}`;
const FOLDER = '/Downloads/Recall/crash108';

// A dedicated cluster on its own port: this suite must never be able to kill the
// engine the rest of the test run is using.
assert.notEqual(PGPORT, 5432, 'refusing to crash the shared development cluster');
for (const n of ['initdb', 'postgres']) if (!existsSync(bin(n))) throw Error(`missing ${bin(n)} — run scripts/sandbox/bootstrap.sh`);

const listening = (port: number) => new Promise<boolean>((res) => {
  const s = connect(port, '127.0.0.1', () => { s.end(); res(true); });
  s.on('error', () => res(false));
});
const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 120)); }
  throw Error('timeout waiting for ' + what);
};

let pgProc: ChildProcess | null = null;
let appProc: ChildProcess | null = null;

function initCluster() {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const pw = path.join(TOOLS, '.pgpw108');
  writeFileSync(pw, 'postgres\n');
  const r = spawnSync(bin('initdb'), ['-D', DATA, '-U', 'postgres', '--pwfile', pw, '-A', 'md5', '-E', 'UTF8', '--locale=C'], { env: PG_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, 'initdb failed: ' + (r.stderr ?? ''));
  const c = spawnSync(bin('postgres'), ['--single', '-D', DATA, 'postgres'], { env: PG_ENV, input: 'CREATE DATABASE crash108;\n', encoding: 'utf8' });
  assert.equal(c.status, 0, 'create database failed: ' + (c.stderr ?? ''));
}

type Gucs = Record<string, string>;
const ARM_A: Gucs = { synchronous_commit: 'on', fsync: 'on', full_page_writes: 'on' };
const ARM_B: Gucs = { synchronous_commit: 'off', fsync: 'on', full_page_writes: 'on' };
const ARM_C: Gucs = { synchronous_commit: 'on', fsync: 'off', full_page_writes: 'off' };

async function startPg(gucs: Gucs) {
  writeFileSync(LOGFILE, '');
  const log = openSync(LOGFILE, 'a');
  const args = ['-D', DATA, '-p', String(PGPORT), '-k', '/tmp', '-c', 'listen_addresses=127.0.0.1', '-c', 'log_min_messages=info',
    ...Object.entries(gucs).flatMap(([k, v]) => ['-c', `${k}=${v}`])];
  pgProc = spawn(bin('postgres'), args, { env: PG_ENV, detached: true, stdio: ['ignore', log, log] });
  await waitFor('postgres', () => listening(PGPORT));
}

/** SIGKILL the postmaster *and every backend* — the closest thing to pulling the plug that a process can do. */
function killEngine() {
  assert.ok(pgProc?.pid, 'no engine to kill');
  process.kill(-pgProc.pid, 'SIGKILL');
  pgProc = null;
}

function pushSchema() {
  const r = spawnSync('npx', ['drizzle-kit', 'push', '--dialect', 'postgresql', '--schema', './src/db/schema.ts', '--url', DSN, '--force'],
    { encoding: 'utf8', env: { ...process.env } });
  assert.match((r.stdout ?? '') + (r.stderr ?? ''), /Changes applied|No changes detected/, 'schema push failed: ' + (r.stderr ?? r.stdout));
}

async function startApp() {
  appProc = spawn('node_modules/.bin/next', ['start', '--hostname', '127.0.0.1', '--port', String(APPPORT)], {
    env: { ...process.env, DATABASE_URL: DSN, NODE_OPTIONS: '--use-system-ca', NEXT_TELEMETRY_DISABLED: '1' },
    detached: true, stdio: 'ignore',
  });
  await waitFor('app', async () => {
    try { return (await fetch(BASE + '/api/settings')).ok; } catch { return false; }
  }, 60000);
}

interface Published { path: string; sha: string; acknowledged: boolean }

/** Fire publications continuously until `stop` flips, recording exactly which ones the server acknowledged. */
async function publishUntil(stop: { now: boolean }, concurrency = 6): Promise<Published[]> {
  const done: Published[] = [];
  const worker = async () => {
    while (!stop.now) {
      const p = `${FOLDER}/${randomUUID()}.png`;
      const body = Buffer.from([137, 80, 78, 71, Math.floor(Math.random() * 255)]);
      const content = body.toString('base64');
      const sha = createHash('sha256').update(body).digest('hex');
      const receipt = JSON.stringify({ version: 1, path: p, bytes: body.length, mime: 'image/png', sha256: sha,
        method: 'human-selected-file', capturedAt: new Date().toISOString(), source: 'https://crash.test/x', page: 'https://crash.test/x', queryRedacted: true });
      const record: Published = { path: p, sha, acknowledged: false };
      done.push(record);
      try {
        const r = await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'recallCommit', path: p, content, mime: 'image/png', receipt }) });
        record.acknowledged = r.status === 200;
        await r.text();
      } catch { /* the engine died under this request: unacknowledged by definition */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return done;
}

interface Survey { media: Map<string, string>; receipts: Set<string>; indexRows: Set<string> }

async function survey(): Promise<Survey> {
  const pool = new pg.Pool({ connectionString: DSN, max: 2 });
  try {
    const rows = await pool.query(
      `SELECT path, encode(sha256(decode(content,'base64')),'hex') AS sha FROM vfs_nodes
        WHERE kind='file' AND trashed=false AND path LIKE $1 AND name NOT LIKE '%.recall.json'`, [FOLDER + '/%']);
    const rec = await pool.query(
      `SELECT path FROM vfs_nodes WHERE kind='file' AND trashed=false AND path LIKE $1 AND name LIKE '%.recall.json'`, [FOLDER + '/%']);
    const idx = await pool.query(`SELECT ref FROM index_docs WHERE source='file' AND ref LIKE $1 AND ref NOT LIKE '%.recall.json'`, [FOLDER + '/%']);
    return {
      media: new Map(rows.rows.map((r) => [r.path as string, r.sha as string])),
      receipts: new Set(rec.rows.map((r) => (r.path as string).replace(/\.recall\.json$/, ''))),
      indexRows: new Set(idx.rows.map((r) => r.ref as string)),
    };
  } finally { await pool.end(); }
}

/** One full crash cycle. Returns what was published and what survived. */
async function crashCycle(gucs: Gucs, settleMs: number) {
  initCluster();
  await startPg(gucs);
  pushSchema();
  await startApp();
  await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'mkdir', path: '/Downloads' }) });
  await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'mkdir', path: '/Downloads/Recall' }) });
  await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'mkdir', path: FOLDER }) });

  const stop = { now: false };
  const burst = publishUntil(stop);
  await new Promise((r) => setTimeout(r, settleMs));
  killEngine();                       // plug pulled here
  stop.now = true;
  const published = await burst;
  assert.ok(published.length >= 5, 'the burst never got going: ' + published.length);
  assert.ok(published.some((p) => p.acknowledged), 'nothing was acknowledged before the crash');

  await startPg(gucs);                // crash recovery happens here
  const log = readFileSync(LOGFILE, 'utf8');
  const survived = await survey();
  const acknowledged = published.filter((p) => p.acknowledged);
  const lost = acknowledged.filter((p) => !survived.media.has(p.path));
  const halfPairs = [...survived.media.keys()].filter((p) => !survived.receipts.has(p))
    .concat([...survived.receipts].filter((p) => !survived.media.has(p)));
  return { published, acknowledged, lost, halfPairs, survived, log };
}

function stopAll() {
  try { if (appProc?.pid) process.kill(-appProc.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { if (pgProc?.pid) process.kill(-pgProc.pid, 'SIGTERM'); } catch { /* already gone */ }
  appProc = null; pgProc = null;
}

try {
  // ---------- arm A: the shipped configuration ----------
  const durable = await crashCycle(ARM_A, 1400);
  const ack = durable.acknowledged;

  await test('the engine really crashed and recovered, rather than shutting down cleanly', {}, () => {
    assert.match(durable.log, /database system was not properly shut down|automatic recovery in progress/i,
      'no crash-recovery evidence in the engine log; the kill did not produce a crash');
    assert.match(durable.log, /redo (starts|done)|recovery/i, 'no WAL redo evidence in the engine log');
    assert.match(durable.log, /database system is ready to accept connections/i, 'engine never came back up');
  });

  await test('every acknowledged publication survived the engine crash, complete and intact', { 'RC-30': 'partial' }, () => {
    assert.ok(ack.length >= 3, 'too few acknowledged publications to be meaningful: ' + ack.length);
    const lost = ack.filter((p) => !durable.survived.media.has(p.path));
    assert.deepEqual(lost.map((p) => p.path), [], `${lost.length} acknowledged publications were lost by crash recovery`);
    for (const p of ack) {
      assert.equal(durable.survived.media.get(p.path), p.sha, 'surviving bytes do not match what was acknowledged: ' + p.path);
      assert.ok(durable.survived.receipts.has(p.path), 'acknowledged media survived without its receipt: ' + p.path);
      assert.ok(durable.survived.indexRows.has(p.path), 'acknowledged memory survived unsearchable: ' + p.path);
    }
  });

  await test('no half pair survived the crash, including the publications in flight', { 'RC-30': 'partial', 'RC-29': 'partial' }, () => {
    const mediaOnly = [...durable.survived.media.keys()].filter((p) => !durable.survived.receipts.has(p));
    const receiptOnly = [...durable.survived.receipts].filter((p) => !durable.survived.media.has(p));
    assert.deepEqual(mediaOnly, [], 'media survived with no receipt');
    assert.deepEqual(receiptOnly, [], 'receipt survived with no media');
    for (const ref of durable.survived.indexRows)
      assert.ok(durable.survived.media.has(ref), 'search index kept a row for media that did not survive: ' + ref);
  });

  await test('an unacknowledged publication is all-or-nothing, never partially applied', { 'RC-30': 'partial' }, () => {
    const unacked = durable.published.filter((p) => !p.acknowledged);
    for (const p of unacked) {
      const hasMedia = durable.survived.media.has(p.path), hasReceipt = durable.survived.receipts.has(p.path);
      assert.equal(hasMedia, hasReceipt, 'in-flight publication left half a pair behind: ' + p.path);
      if (hasMedia) assert.equal(durable.survived.media.get(p.path), p.sha, 'in-flight publication survived with wrong bytes');
    }
  });

  await test('the application reconnects to the recovered engine without a restart', { 'RC-30': 'partial' }, async () => {
    // The pool's sockets all died with the engine; the server must rebuild them.
    await waitFor('app to recover', async () => {
      try { return (await fetch(BASE + '/api/fs?op=list&path=' + encodeURIComponent(FOLDER))).ok; } catch { return false; }
    }, 30000);
    const r = await fetch(BASE + '/api/fs?op=list&path=' + encodeURIComponent(FOLDER));
    const body = await r.json() as { nodes: unknown[] };
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(body.nodes), 'listing broken after engine recovery');
  });

  stopAll();

  // ---------- arm B: positive control — does this method detect ANY regression? ----------
  const asyncCommit = await crashCycle(ARM_B, 1000);

  await test('positive control: with synchronous_commit=off the same crash DOES lose acknowledged memories', { 'RC-30': 'partial' }, () => {
    assert.match(asyncCommit.log, /database system was not properly shut down|automatic recovery in progress/i, 'arm B did not crash');
    assert.ok(asyncCommit.acknowledged.length >= 3, 'too few acknowledged publications in arm B');
    // TT107 predicted the method would be blind to every durability setting. It is not:
    // synchronous_commit=off acknowledges while the WAL record is still in the server's
    // own memory, and SIGKILL destroys exactly that. Arm A's pass is therefore a real
    // measurement rather than a test that could never have failed.
    assert.ok(asyncCommit.lost.length > 0,
      'arm B lost nothing, so the method has no demonstrated sensitivity and arm A proves nothing');
  });

  await test('positive control: even when the WAL tail is lost, whole pairs are lost — never half of one', { 'RC-30': 'partial', 'RC-29': 'partial' }, () => {
    // An interrupted WAL is truncated at the last complete record, so an unfinished
    // transaction is never replayed in part. Atomicity survives a configuration that
    // durability does not.
    assert.deepEqual(asyncCommit.halfPairs, [], 'losing the WAL tail tore a pair in half');
    for (const p of asyncCommit.lost)
      assert.ok(!asyncCommit.survived.receipts.has(p.path), 'media was lost but its receipt survived: ' + p.path);
    for (const [path, sha] of asyncCommit.survived.media) {
      const match = asyncCommit.published.find((p) => p.path === path);
      if (match) assert.equal(sha, match.sha, 'surviving bytes were corrupted by recovery: ' + path);
    }
  });

  stopAll();

  // ---------- arm C: negative control — where the method is blind ----------
  const noFsync = await crashCycle(ARM_C, 1000);

  await test('negative control: with fsync and full_page_writes OFF nothing is lost, so this method cannot certify power loss', { 'RC-30': 'partial' }, () => {
    assert.match(noFsync.log, /database system was not properly shut down|automatic recovery in progress/i, 'arm C did not crash');
    assert.ok(noFsync.acknowledged.length >= 3, 'too few acknowledged publications in arm C');
    // The WAL record reached the operating system before the acknowledgement, and the
    // page cache outlives the killed process. A configuration that would lose data in a
    // real power cut is indistinguishable here from the safe one. This is the exact
    // boundary of the claim: crash recovery is certified, power-loss durability is not.
    assert.deepEqual(noFsync.lost.map((p) => p.path), [],
      'arm C lost data, which would mean the blind spot described in this suite is mis-stated');
    assert.deepEqual(noFsync.halfPairs, [], 'half pair survived in arm C');
  });

  await test('the shipped cluster does not run the configuration that arm B showed to be lossy', { 'RC-30': 'partial' }, async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const { rows } = await pool.query('SHOW synchronous_commit');
      assert.equal(rows[0].synchronous_commit, 'on',
        'the cluster this application runs against acknowledges commits before the WAL leaves memory');
    } finally { await pool.end(); }
  });

  await test('the suite states its own blind spot rather than claiming power-loss durability', { 'RC-30': 'partial' }, () => {
    // Normalise comment wrapping so the guard tracks the sentence, not its line breaks.
    const claim = readFileSync('scripts/tt108-engine-crash.mts', 'utf8').replace(/[\s*]+/g, ' ');
    assert.match(claim, /certifies crash recovery only, and cannot certify power loss/i,
      'the stated limit was edited out of the suite that depends on it');
    assert.match(claim, /POSITIVE CONTROL/, 'the sensitivity control was removed, leaving arm A unfalsifiable');
  });
} finally {
  stopAll();
}
finish();
