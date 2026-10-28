/**
 * TT107 — real process-death atomicity.
 *
 * This suite spawns an actual production server, blocks its publication
 * transaction *between* the two writes with a real PostgreSQL advisory lock,
 * then SIGKILLs the whole server process group. It is a genuine crash of the
 * application process, not a simulated failure: no mocking, no fault injection
 * inside application code.
 *
 * Honest boundary: PostgreSQL itself stays alive, so this proves rollback on
 * client death, NOT power-loss/fsync durability of the database engine.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { makeHarness } from './harness.mts';

const dsn = process.env.DATABASE_URL;
if (!dsn || process.env.TT89_DISPOSABLE_DATABASE !== '1' || !new URL(dsn).pathname.endsWith('_test'))
  throw Error('Exclusive _test database required');
const PORT = Number(process.env.TT107_CRASH_PORT ?? 3102);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 777107;
const { test, finish } = makeHarness('tt107-crash');
const pool = new pg.Pool({ connectionString: dsn, max: 6 });
const folder = '/Downloads/Recall/crash107';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null>, ms = 30000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== false) return v as T;
    if (Date.now() > deadline) throw Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

let server: ChildProcess | null = null;
async function startServer() {
  const child = spawn('node_modules/.bin/next', ['start', '--hostname', '127.0.0.1', '--port', String(PORT)], {
    env: { ...process.env, DATABASE_URL: dsn, NODE_ENV: 'production' },
    detached: true, // own process group so the kill reaches every worker
    stdio: 'ignore',
  });
  child.unref();
  server = child;
  await until('server ready', async () => {
    try { return (await fetch(BASE + '/api/settings')).ok ? true : null; } catch { return null; }
  });
  return child;
}
function killServerGroup() {
  if (!server?.pid) throw Error('no server to kill');
  process.kill(-server.pid, 'SIGKILL'); // whole group, not a graceful shutdown
  server = null;
}

const receiptFor = (path: string, content: string, method: string) => JSON.stringify({
  version: 1, path, bytes: Buffer.from(content, 'base64').length, mime: 'image/png',
  sha256: createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex'),
  method, capturedAt: new Date().toISOString(),
  source: 'https://example.com/', page: 'https://example.com/', queryRedacted: true,
});

const post = async (body: unknown) => {
  const r = await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

const rowsFor = async (p: string) =>
  (await pool.query('SELECT path, trashed, version FROM vfs_nodes WHERE path = $1 OR path = $2 ORDER BY path', [p, p + '.recall.json'])).rows;
const sideRows = async (p: string) => ({
  index: (await pool.query("SELECT 1 FROM index_docs WHERE source='file' AND ref = ANY($1::text[])", [[p, p + '.recall.json']])).rowCount,
  ops: (await pool.query('SELECT 1 FROM file_ops WHERE src = ANY($1::text[])', [[p, p + '.recall.json']])).rowCount,
  audit: (await pool.query('SELECT 1 FROM audit_log WHERE detail = $1', [p])).rowCount,
});

/** A real BEFORE INSERT trigger that parks the transaction on an advisory lock. */
async function arm(matcher: string) {
  // Two sequences: sequence advances survive rollback, so after the crash they prove
  // which statements the dead transaction actually executed.
  await pool.query('CREATE SEQUENCE IF NOT EXISTS tt107_media_hits');
  await pool.query('CREATE SEQUENCE IF NOT EXISTS tt107_hits');
  await pool.query(`CREATE OR REPLACE FUNCTION tt107_park() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.path LIKE '%/crash107/%' AND NEW.path NOT LIKE '%.recall.json' THEN PERFORM nextval('tt107_media_hits'); END IF;
      IF NEW.path LIKE ${matcher} THEN PERFORM nextval('tt107_hits'); PERFORM pg_advisory_xact_lock(${KEY}); END IF;
      RETURN NEW;
    END $$`);
  await pool.query('DROP TRIGGER IF EXISTS tt107_park ON vfs_nodes');
  await pool.query('CREATE TRIGGER tt107_park BEFORE INSERT ON vfs_nodes FOR EACH ROW EXECUTE FUNCTION tt107_park()');
}
async function armUpdate(matcher: string) {
  await pool.query('CREATE SEQUENCE IF NOT EXISTS tt107_hits');
  await pool.query(`CREATE OR REPLACE FUNCTION tt107_park_u() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.path LIKE ${matcher} THEN PERFORM nextval('tt107_hits'); PERFORM pg_advisory_xact_lock(${KEY}); END IF;
      RETURN NEW;
    END $$`);
  await pool.query('DROP TRIGGER IF EXISTS tt107_park_u ON vfs_nodes');
  await pool.query('CREATE TRIGGER tt107_park_u BEFORE UPDATE ON vfs_nodes FOR EACH ROW EXECUTE FUNCTION tt107_park_u()');
}
async function disarm() {
  await pool.query('DROP TRIGGER IF EXISTS tt107_park ON vfs_nodes');
  await pool.query('DROP TRIGGER IF EXISTS tt107_park_u ON vfs_nodes');
  await pool.query('DROP FUNCTION IF EXISTS tt107_park()');
  await pool.query('DROP FUNCTION IF EXISTS tt107_park_u()');
  await pool.query('DROP SEQUENCE IF EXISTS tt107_hits');
  await pool.query('DROP SEQUENCE IF EXISTS tt107_media_hits');
}

/** An assigned transaction id proves the parked backend has already WRITTEN inside its transaction. */
const parkedBackendHasWritten = async (pid: number) =>
  (await pool.query('SELECT backend_xid IS NOT NULL AS wrote FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]?.wrote === true;
const seqHits = async (name: string) => {
  const r = await pool.query(`SELECT last_value, is_called FROM ${name}`);
  return r.rows[0].is_called ? Number(r.rows[0].last_value) : 0;
};
const triggerHits = () => seqHits('tt107_hits');

const blockedBackend = async () => {
  const r = await pool.query(
    `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory' AND pid <> pg_backend_pid()`);
  return r.rowCount ? (r.rows[0].pid as number) : null;
};

try {
  await startServer();
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) assert.ok((await post({ op: 'mkdir', path: p })).status === 200);

  await test('SIGKILL between the two writes leaves no half pair and no orphan metadata', { 'RC-29': 'partial', 'RC-22': 'partial' }, async () => {
    const path = `${folder}/${randomUUID()}.png`;
    const content = Buffer.from([9, 8, 7, 6]).toString('base64');
    const holder = await pool.connect();
    let backendPid = 0;
    try {
      await arm(`'%.recall.json'`);
      await holder.query('SELECT pg_advisory_lock($1)', [KEY]); // park the receipt insert
      const inflight = post({ op: 'recallCommit', path, content, mime: 'image/png', receipt: receiptFor(path, content, 'human-selected-file') })
        .catch(() => ({ status: 0, data: null })); // the response is expected to be lost with the process
      backendPid = await until('server transaction parked on the advisory lock', blockedBackend);

      // Anti-vacuity: prove the crash lands strictly BETWEEN the two writes. Sequence
      // advances are not rolled back, so they are durable witnesses of what ran:
      //   media sequence = 1  -> the media INSERT executed inside this transaction
      //   receipt sequence = 1 -> the receipt INSERT was reached and is parked
      // and an assigned backend_xid corroborates that the transaction has written.
      assert.equal(await seqHits('tt107_media_hits'), 1, 'media INSERT never executed; the crash would be before the first write');
      assert.equal(await triggerHits(), 1, 'receipt INSERT never reached; the crash would not be between the two writes');
      assert.ok(await parkedBackendHasWritten(backendPid), 'parked transaction had not written yet; test would be vacuous');
      // Isolation check while the transaction is still open: the first write must not be visible outside it.
      assert.equal((await rowsFor(path)).length, 0, 'uncommitted media row was visible to another session');

      killServerGroup();
      await holder.query('SELECT pg_advisory_unlock($1)', [KEY]);
      await until('crashed backend to disappear', async () => {
        const r = await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [backendPid]);
        return r.rowCount === 0 ? true : null;
      });
      await inflight;

      assert.deepEqual(await rowsFor(path), [], 'rows survived the crash — publication was not atomic');
      assert.deepEqual(await sideRows(path), { index: 0, ops: 0, audit: 0 }, 'orphan metadata survived the crash');
    } finally {
      holder.release();
      await disarm();
    }
  });

  await test('server restarts and the same payload then publishes the exact pair', { 'RC-29': 'partial' }, async () => {
    await startServer();
    const path = `${folder}/${randomUUID()}.png`;
    const content = Buffer.from([5, 5, 5, 5]).toString('base64');
    const r = await post({ op: 'recallCommit', path, content, mime: 'image/png', receipt: receiptFor(path, content, 'human-selected-file') });
    assert.equal(r.status, 200);
    assert.equal((await rowsFor(path)).length, 2);
  });

  await test('SIGKILL during a guarded paired trash leaves both files active and indexed', { 'RC-29': 'partial', 'RC-25': 'partial' }, async () => {
    const path = `${folder}/${randomUUID()}.png`;
    const content = Buffer.from([1, 1, 2, 2]).toString('base64');
    assert.equal((await post({ op: 'recallCommit', path, content, mime: 'image/png', receipt: receiptFor(path, content, 'human-paste-file') })).status, 200);
    const before = await rowsFor(path);
    const guard = (await post({ op: 'recallPair', path, action: 'inspect' })).data.guard;
    const holder = await pool.connect();
    let backendPid = 0;
    try {
      await armUpdate(`'%.recall.json'`);
      await holder.query('SELECT pg_advisory_lock($1)', [KEY]);
      const inflight = post({ op: 'recallPair', path, action: 'trash', expected: guard }).catch(() => ({ status: 0, data: null }));
      backendPid = await until('trash transaction parked', blockedBackend);
      assert.equal(await triggerHits(), 1, 'receipt-update trigger never ran');
      assert.ok(await parkedBackendHasWritten(backendPid), 'parked trash transaction had not written yet');
      killServerGroup();
      await holder.query('SELECT pg_advisory_unlock($1)', [KEY]);
      await until('crashed backend to disappear', async () => {
        const r = await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [backendPid]);
        return r.rowCount === 0 ? true : null;
      });
      await inflight;
      assert.deepEqual(await rowsFor(path), before, 'trash flags or versions changed despite the crash');
      const idx = (await pool.query("SELECT 1 FROM index_docs WHERE source='file' AND ref = ANY($1::text[])", [[path, path + '.recall.json']])).rowCount;
      assert.equal(idx, 2, 'search entries were deleted by a transaction that never committed');
    } finally {
      holder.release();
      await disarm();
    }
  });

  await test('after the crash the pair is still guard-consistent and can be trashed and restored', { 'RC-29': 'partial' }, async () => {
    await startServer();
    const rows = await pool.query(
      `SELECT path FROM vfs_nodes WHERE parent = $1 AND kind='file' AND mime='image/png' AND trashed = false ORDER BY id DESC LIMIT 1`, [folder]);
    const path = rows.rows[0].path as string;
    const inspected = await post({ op: 'recallPair', path, action: 'inspect' });
    assert.equal(inspected.status, 200);
    const trashed = await post({ op: 'recallPair', path, action: 'trash', expected: inspected.data.guard });
    assert.equal(trashed.status, 200);
    const restored = await post({ op: 'recallPair', path, action: 'restore', expected: trashed.data.guard });
    assert.equal(restored.status, 200);
    assert.ok((await rowsFor(path)).every((n) => !n.trashed));
  });
} finally {
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* already dead */ }
  await disarm().catch(() => {});
  await pool.end();
}
finish();
