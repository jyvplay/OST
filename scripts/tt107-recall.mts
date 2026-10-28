/**
 * TT107 — receipt-indexed search, pair-integrity audit and guarded unpaired cleanup,
 * against a real server and a real PostgreSQL database.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE, dsn = process.env.DATABASE_URL;
if (!BASE || !dsn || process.env.TT89_DISPOSABLE_DATABASE !== '1' || !new URL(dsn).pathname.endsWith('_test'))
  throw Error('Exclusive _test target required');
const { test, finish } = makeHarness('tt107-recall');
const pool = new pg.Pool({ connectionString: dsn });
const stamp = Date.now();
const folder = `/Downloads/Recall/search107-${stamp}`;
const other = `/Downloads/Recall/other107-${stamp}`;

const post = async (body: unknown) => {
  const r = await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const get = async (params: Record<string, string>) => {
  const r = await fetch(BASE + '/api/fs?' + new URLSearchParams(params));
  return { status: r.status, data: await r.json() };
};
const search = (params: Record<string, string> = {}) => get({ op: 'recallSearch', ...params });
const audit = (params: Record<string, string> = {}) => get({ op: 'recallAudit', ...params });

async function save(dir: string, method: string, page: string, capturedAt: string, body = [1, 2, 3, 4]) {
  const path = `${dir}/${randomUUID()}.png`;
  const content = Buffer.from(body).toString('base64');
  const receipt = JSON.stringify({
    version: 1, path, bytes: body.length, mime: 'image/png',
    sha256: createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex'),
    method, capturedAt, source: page, page, queryRedacted: true,
  });
  const r = await post({ op: 'recallCommit', path, content, mime: 'image/png', receipt });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return path;
}
const paths = (r: { data: { nodes?: { path: string }[] } }) => (r.data.nodes ?? []).map((n) => n.path);

try {
  await fetch(BASE + '/api/settings');
  for (const p of ['/Downloads', '/Downloads/Recall', folder, other]) assert.equal((await post({ op: 'mkdir', path: p })).status, 200);

  const chosen = await save(folder, 'human-selected-file', 'https://example.com/a', '2026-03-05T10:00:00.000Z');
  const pasted = await save(folder, 'human-paste-file', 'https://example.com/b', '2026-04-10T10:00:00.000Z');
  const clicked = await save(folder, 'clicked-visual-png', 'https://pictures.test/c', '2026-05-20T10:00:00.000Z');
  const elsewhere = await save(other, 'saved-preview-frame', 'https://example.com/d', '2026-06-01T10:00:00.000Z');

  await test('search filters by save method across every Recall folder', { 'RC-27': 'partial' }, async () => {
    const r = await search({ method: 'human-paste-file' });
    assert.equal(r.status, 200);
    assert.ok(paths(r).includes(pasted));
    assert.ok(!paths(r).includes(chosen) && !paths(r).includes(clicked));
  });

  await test('search filters by exact page host and never by substring', { 'RC-27': 'partial' }, async () => {
    const r = await search({ host: 'pictures.test' });
    assert.deepEqual(paths(r).filter((p) => p.startsWith(folder)), [clicked]);
    assert.equal(paths(await search({ host: 'ictures.test' })).length, 0);
    assert.equal(paths(await search({ host: 'example.com.evil.test' })).length, 0);
  });

  await test('search filters by capture date range inclusively', { 'RC-27': 'partial' }, async () => {
    const inRange = paths(await search({ from: '2026-04-01', to: '2026-05-21' }));
    assert.ok(inRange.includes(pasted) && inRange.includes(clicked));
    assert.ok(!inRange.includes(chosen) && !inRange.includes(elsewhere));
    assert.ok(paths(await search({ from: '2026-03-05', to: '2026-03-05T10:00:00.000Z' })).includes(chosen), 'boundary not inclusive');
  });

  await test('search combines filters and returns metadata only, never media bodies', { 'RC-27': 'partial' }, async () => {
    const r = await search({ method: 'human-selected-file', host: 'example.com' });
    assert.deepEqual(paths(r).filter((p) => p.startsWith(folder)), [chosen]);
    const text = JSON.stringify(r.data);
    assert.ok(!text.includes(Buffer.from([1, 2, 3, 4]).toString('base64')), 'media body leaked into search results');
    assert.ok(!/"content"/.test(text));
  });

  await test('a receipt that is not valid JSON is skipped and counted, not a query failure', { 'RC-27': 'partial', 'RC-28': 'partial' }, async () => {
    const broken = `${folder}/${randomUUID()}.png`;
    await post({ op: 'write', path: broken, content: Buffer.from([7, 7]).toString('base64'), encoding: 'base64', mime: 'image/png' });
    await post({ op: 'write', path: broken + '.recall.json', content: 'this is not json at all', encoding: 'utf8', mime: 'application/json' });
    const r = await search({});
    assert.equal(r.status, 200, 'invalid receipt aborted the search query');
    assert.ok(!paths(r).includes(broken), 'unreadable receipt was treated as a match');
    assert.ok(r.data.unreadableReceipts >= 1, 'unreadable receipt was not counted');
    const a = await audit({ folder });
    assert.ok((a.data.unreadableReceipts as string[]).includes(broken + '.recall.json'));
  });

  await test('trashed memories disappear from search results', { 'RC-27': 'partial' }, async () => {
    const victim = await save(folder, 'human-drop-file', 'https://gone.test/x', '2026-02-02T00:00:00.000Z');
    assert.ok(paths(await search({ host: 'gone.test' })).includes(victim));
    const guard = (await post({ op: 'recallPair', path: victim, action: 'inspect' })).data.guard;
    assert.equal((await post({ op: 'recallPair', path: victim, action: 'trash', expected: guard })).status, 200);
    assert.equal(paths(await search({ host: 'gone.test' })).length, 0);
  });

  for (const bad of [{ method: 'Not A Method' }, { method: 'x'.repeat(80) }, { host: 'bad host!' }, { from: 'yesterday' }, { to: '05-2026' }, { limit: '0' }, { limit: '1000' }])
    await test('search rejects invalid filter ' + JSON.stringify(bad), { 'RC-27': 'partial' }, async () => {
      assert.equal((await search(bad as Record<string, string>)).status, 400);
    });

  await test('audit reports a healthy folder with no orphans', { 'RC-28': 'partial' }, async () => {
    const clean = `/Downloads/Recall/clean107-${stamp}`;
    assert.equal((await post({ op: 'mkdir', path: clean })).status, 200);
    await save(clean, 'human-selected-file', 'https://example.com/ok', '2026-06-06T00:00:00.000Z');
    const a = await audit({ folder: clean });
    assert.equal(a.status, 200);
    assert.deepEqual([a.data.mediaFiles, a.data.receiptFiles, a.data.healthyPairs], [1, 1, 1]);
    assert.deepEqual(a.data.orphanMedia, []);
    assert.deepEqual(a.data.orphanReceipts, []);
    assert.deepEqual(a.data.checksumMismatch, []);
  });

  await test('audit detects media without receipt and receipt without media', { 'RC-28': 'partial' }, async () => {
    const lonelyMedia = `${folder}/${randomUUID()}.png`;
    await post({ op: 'write', path: lonelyMedia, content: Buffer.from([3, 3]).toString('base64'), encoding: 'base64', mime: 'image/png' });
    const ghost = await save(folder, 'human-selected-file', 'https://ghost.test/y', '2026-01-01T00:00:00.000Z');
    await pool.query('DELETE FROM vfs_nodes WHERE path = $1', [ghost]); // media removed behind the app's back
    const a = await audit({ folder });
    assert.ok((a.data.orphanMedia as string[]).includes(lonelyMedia));
    assert.ok((a.data.orphanReceipts as string[]).includes(ghost + '.recall.json'));
  });

  await test('audit detects a receipt/byte checksum mismatch and never rewrites it', { 'RC-28': 'partial' }, async () => {
    const tampered = await save(folder, 'human-selected-file', 'https://tamper.test/z', '2026-01-02T00:00:00.000Z');
    const changed = Buffer.from([9, 9, 9, 9]).toString('base64');
    await pool.query('UPDATE vfs_nodes SET content = $2, sha256 = encode(sha256(convert_to($2,\'UTF8\')),\'hex\') WHERE path = $1', [tampered, changed]);
    const a = await audit({ folder });
    assert.ok((a.data.checksumMismatch as string[]).includes(tampered));
    const after = await pool.query('SELECT content FROM vfs_nodes WHERE path = $1', [tampered]);
    assert.equal(after.rows[0].content, changed, 'audit modified stored bytes');
  });

  await test('unpaired cleanup refuses a complete pair', { 'RC-28': 'partial' }, async () => {
    const healthy = await save(folder, 'human-selected-file', 'https://keep.test/1', '2026-01-03T00:00:00.000Z');
    const node = (await get({ op: 'stat', path: healthy })).data.node;
    const r = await post({ op: 'recallOrphan', path: healthy, expected: { id: node.id, version: node.version, sha256: node.sha256 } });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /complete pair/);
    assert.equal((await pool.query('SELECT trashed FROM vfs_nodes WHERE path = $1', [healthy])).rows[0].trashed, false);
  });

  await test('unpaired cleanup trashes a true orphan under a guard and the audit clears', { 'RC-28': 'partial' }, async () => {
    const orphan = `${folder}/${randomUUID()}.png`;
    await post({ op: 'write', path: orphan, content: Buffer.from([4, 4]).toString('base64'), encoding: 'base64', mime: 'image/png' });
    const node = (await get({ op: 'stat', path: orphan })).data.node;
    const r = await post({ op: 'recallOrphan', path: orphan, expected: { id: node.id, version: node.version, sha256: node.sha256 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const row = (await pool.query('SELECT trashed, trashed_from, version FROM vfs_nodes WHERE path = $1', [orphan])).rows[0];
    assert.equal(row.trashed, true);
    assert.equal(row.trashed_from, orphan);
    assert.equal(row.version, node.version + 1);
    assert.equal((await pool.query("SELECT 1 FROM index_docs WHERE source='file' AND ref=$1", [orphan])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action='fs.recall-orphan' AND detail=$1", [orphan])).rowCount, 1);
    assert.ok(!((await audit({ folder })).data.orphanMedia as string[]).includes(orphan));
    const again = await post({ op: 'recallOrphan', path: orphan, expected: { id: node.id, version: node.version, sha256: node.sha256 } });
    assert.equal(again.status, 409, 'second cleanup of the same file should conflict');
  });

  await test('unpaired cleanup refuses a stale guard', { 'RC-28': 'partial' }, async () => {
    const orphan = `${folder}/${randomUUID()}.png`;
    await post({ op: 'write', path: orphan, content: Buffer.from([6, 6]).toString('base64'), encoding: 'base64', mime: 'image/png' });
    const node = (await get({ op: 'stat', path: orphan })).data.node;
    await post({ op: 'write', path: orphan, content: Buffer.from([6, 6, 6]).toString('base64'), encoding: 'base64', mime: 'image/png' });
    const r = await post({ op: 'recallOrphan', path: orphan, expected: { id: node.id, version: node.version, sha256: node.sha256 } });
    assert.equal(r.status, 409);
    assert.equal((await pool.query('SELECT trashed FROM vfs_nodes WHERE path = $1', [orphan])).rows[0].trashed, false);
  });

  await test('unpaired cleanup refuses a receipt whose media reappeared', { 'RC-28': 'partial' }, async () => {
    const path = await save(folder, 'human-selected-file', 'https://race.test/2', '2026-01-04T00:00:00.000Z');
    const receipt = path + '.recall.json';
    const node = (await get({ op: 'stat', path: receipt })).data.node;
    const r = await post({ op: 'recallOrphan', path: receipt, expected: { id: node.id, version: node.version, sha256: node.sha256 } });
    assert.equal(r.status, 409);
  });

  for (const bad of ['/', '/etc/passwd', '/Private/x.png', `${folder}/nested/x.png`, '/Downloads/Recall/x'])
    await test('unpaired cleanup rejects non-Recall path ' + bad, { 'RC-28': 'partial' }, async () => {
      assert.equal((await post({ op: 'recallOrphan', path: bad, expected: { id: 1, version: 1, sha256: 'a'.repeat(64) } })).status, 400);
    });

  for (const guard of [null, {}, { id: 0, version: 1, sha256: 'a'.repeat(64) }, { id: 1, version: 1, sha256: 'zz' }])
    await test('unpaired cleanup rejects invalid guard ' + JSON.stringify(guard), { 'RC-28': 'partial' }, async () => {
      assert.equal((await post({ op: 'recallOrphan', path: `${folder}/x.png`, expected: guard })).status, 400);
    });

  await test('audit scope rejects a non-canonical folder', { 'RC-28': 'partial' }, async () => {
    assert.equal((await audit({ folder: '/Downloads/Recall/a/../b' })).status, 400);
    assert.equal((await audit({ folder: '/etc' })).status, 400);
  });
} finally {
  await pool.end();
}
finish();
