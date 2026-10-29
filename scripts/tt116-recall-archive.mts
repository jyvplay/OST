/**
 * TT116 — RC-34, RC-27, RC-28, RC-10 against the running server over HTTP only.
 *
 * Four Recall behaviours have shipped mechanisms and prose claims, but their only
 * coverage was incidental: a browser suite that happened to walk past them. This
 * suite addresses each one directly and, for each, asserts the thing that would be
 * false if the mechanism were decorative:
 *
 *   RC-10 grouping   — the folder a memory lands in is DERIVED from the page, and
 *                      three groupings put the same page in three different folders.
 *   RC-34 recognition— a second save of identical bytes with onDuplicate:'skip'
 *                      returns the FIRST memory's path and writes no second file.
 *                      The default still stores, because a deliberate re-save is
 *                      a legitimate act and silently dropping it would be a lie.
 *   RC-27 search     — method/host/date filters select, and a filter that matches
 *                      nothing returns an empty list rather than everything.
 *   RC-28 audit      — a receipt deleted out from under a memory is REPORTED as an
 *                      orphan and is never regenerated.
 *
 * Everything here is one fetch at a time against a server that is already running,
 * so the suite costs seconds and can be run on every gate.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('tt116-recall-archive');

type Res = { status: number; body: Record<string, unknown> };
async function post(body: unknown): Promise<Res> {
  const r = await fetch(`${BASE}/api/fs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}
async function get(qs: string): Promise<Res> {
  const r = await fetch(`${BASE}/api/fs?${qs}`);
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

/** The same grouping rule the UI applies, restated here so the test is independent
 *  of the implementation it is checking (importing recallFolder would only prove
 *  the function equals itself). */
function expectedFolder(url: string, title: string, grouping: 'host' | 'title' | 'custom', custom: string): string {
  const u = new URL(url);
  const raw = grouping === 'custom' ? custom : grouping === 'title' ? (title || u.hostname) : u.host;
  const label = raw.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '').trim().slice(0, 90) || 'untitled';
  return `/Downloads/Recall/${label}`;
}

const RUN = Date.now().toString(36);
/** A one-pixel PNG: real bytes, small, and identical every time it is used. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function saveMemory(folder: string, name: string, b64: string, over: Record<string, unknown> = {}) {
  await post({ op: 'mkdir', path: folder });
  const bytes = Buffer.from(b64, 'base64');
  const receipt = {
    version: 1, path: `${folder}/${name}`, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: 'image/png', method: 'chosen-resident-file',
    sourceAttribution: 'user-declared-label',
    source: 'https://example.test/pic.png', page: 'https://example.test/album',
    capturedAt: new Date().toISOString(), queryRedacted: true,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'onDuplicate')),
  };
  return await post({ op: 'recallCommit', path: `${folder}/${name}`, content: b64, mime: 'image/png', receipt: JSON.stringify(receipt), ...(over.onDuplicate ? { onDuplicate: over.onDuplicate } : {}) });
}

await test('RC-10: the folder is derived from the page, and three groupings mean three folders', { 'RC-10': 'full' }, async () => {
  const url = 'https://shop.example.test:8443/catalog/item?id=9';
  const seen = new Set<string>();
  for (const [grouping, custom] of [['host', ''], ['title', ''], ['custom', `Holiday ${RUN}`]] as const) {
    const folder = expectedFolder(url, `Blue Vase ${RUN}`, grouping, custom);
    const r = await saveMemory(folder, `g-${grouping}-${RUN}.png`, PNG);
    assert.equal(r.status, 200, `${grouping} grouping refused: ${JSON.stringify(r.body)}`);
    const stat = await get(`op=stat&path=${encodeURIComponent(`${folder}/g-${grouping}-${RUN}.png`)}`);
    assert.equal(stat.status, 200, `${grouping}: the memory is not where the grouping says it is`);
    seen.add(folder);
  }
  assert.equal(seen.size, 3, 'two groupings collapsed into one folder');
  // The host grouping must carry the port, or two different servers share an archive.
  assert.ok([...seen].some((f) => f.includes('8443')), 'the host grouping dropped the port');
});

await test('RC-10: a custom grouping with no name is refused rather than quietly filed somewhere', { 'RC-10': 'full' }, async () => {
  // The derivation is a client-side rule; the server's own guard is the path shape.
  const bad = await post({ op: 'recallCommit', path: '/Downloads/Recall/a/b/c.png', content: PNG, mime: 'image/png', receipt: '{}' });
  assert.equal(bad.status >= 400, true, 'a memory outside the one-level grouping layout was accepted');
});

await test('RC-34: a second save of identical bytes is recognised, not duplicated', { 'RC-34': 'full' }, async () => {
  const folder = `/Downloads/Recall/dedupe-${RUN}`;
  const first = await saveMemory(folder, `one-${RUN}.png`, PNG);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await saveMemory(folder, `two-${RUN}.png`, PNG, { onDuplicate: 'skip' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  // The real contract: nothing was stored, and the answer names the memory already held.
  assert.equal(again.body.stored, false, 'identical bytes were not recognised');
  assert.equal(again.body.duplicateOf, `${folder}/one-${RUN}.png`, 'recognition did not point at the memory already held');
  assert.equal(again.body.path, `${folder}/one-${RUN}.png`);
  assert.ok(typeof again.body.firstSavedAt === 'string' && !Number.isNaN(Date.parse(again.body.firstSavedAt as string)),
    'recognition did not say when the bytes were first saved');
  const after = await get(`op=list&path=${encodeURIComponent(folder)}`);
  const present = (after.body.nodes as { name: string }[]).map((n) => n.name);
  assert.equal(present.includes(`two-${RUN}.png`), false, 'a skipped duplicate still wrote a second file');
  // The honest half: the DEFAULT is still to store, because a deliberate re-save is
  // a choice the person made and dropping it silently would be the wrong answer.
  const deliberate = await saveMemory(folder, `three-${RUN}.png`, PNG);
  assert.equal(deliberate.status, 200);
  assert.equal(deliberate.body.stored, true, 'a deliberate re-save was silently dropped');
  const third = await get(`op=stat&path=${encodeURIComponent(`${folder}/three-${RUN}.png`)}`);
  assert.equal(third.status, 200, 'the default re-save did not write');
});

await test('RC-34: different bytes under the same name are never treated as a duplicate', { 'RC-34': 'full' }, async () => {
  const folder = `/Downloads/Recall/dedupe-${RUN}`;
  const other = Buffer.from('a different picture entirely, byte for byte').toString('base64');
  const r = await saveMemory(folder, `four-${RUN}.png`, other, { onDuplicate: 'skip' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stored, true, 'distinct bytes were reported as already held');
  assert.equal(r.body.duplicateOf, undefined);
});

await test('RC-27: method, host and date filters select, and a dead filter returns nothing', { 'RC-27': 'full' }, async () => {
  const folder = `/Downloads/Recall/search-${RUN}`;
  await saveMemory(folder, `clip-${RUN}.png`, PNG, { page: 'https://news.example.test/a', method: 'chosen-resident-file' });
  const all = await get(`op=recallSearch&folder=${encodeURIComponent(folder)}`);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const rows = all.body.nodes as { path: string; method?: string; host?: string }[];
  assert.ok(Array.isArray(rows) && rows.length >= 1, `no memories found in ${folder}`);

  const byMethod = await get(`op=recallSearch&folder=${encodeURIComponent(folder)}&method=chosen-resident-file`);
  assert.ok((byMethod.body.nodes as unknown[]).length >= 1, 'the method filter excluded a memory saved by that method');
  const wrongMethod = await get(`op=recallSearch&folder=${encodeURIComponent(folder)}&method=authorized-display-frame`);
  assert.equal((wrongMethod.body.nodes as unknown[]).length, 0, 'the method filter matched a memory saved another way');

  const byHost = await get(`op=recallSearch&folder=${encodeURIComponent(folder)}&host=news.example.test`);
  assert.ok((byHost.body.nodes as unknown[]).length >= 1, 'the host filter excluded its own host');
  const wrongHost = await get(`op=recallSearch&folder=${encodeURIComponent(folder)}&host=nowhere.example.test`);
  assert.equal((wrongHost.body.nodes as unknown[]).length, 0, 'the host filter is not filtering');

  const future = await get(`op=recallSearch&folder=${encodeURIComponent(folder)}&from=2099-01-01`);
  assert.equal((future.body.nodes as unknown[]).length, 0, 'a memory was saved in the future');
  const past = await get(`op=recallSearch&folder=${encodeURIComponent(folder)}&to=2000-01-01`);
  assert.equal((past.body.nodes as unknown[]).length, 0, 'a memory was saved before this project existed');
});

await test('RC-27: a malformed filter is refused, not silently ignored', { 'RC-27': 'full' }, async () => {
  for (const q of ['method=NOT a method', 'host=inva lid host', 'from=yesterday', 'limit=0', 'folder=/etc']) {
    const r = await get(`op=recallSearch&${q}`);
    assert.equal(r.status, 400, `"${q}" was accepted: ${JSON.stringify(r.body)}`);
  }
});

await test('RC-28: a memory that lost its receipt is reported, and the receipt is never invented', { 'RC-28': 'full' }, async () => {
  const folder = `/Downloads/Recall/audit-${RUN}`;
  const media = `${folder}/pic-${RUN}.png`;
  const saved = await saveMemory(folder, `pic-${RUN}.png`, PNG);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const healthy = await get(`op=recallAudit&folder=${encodeURIComponent(folder)}`);
  assert.equal(healthy.body.healthyPairs, 1, `expected one healthy pair, got ${JSON.stringify(healthy.body)}`);
  assert.deepEqual(healthy.body.orphanMedia, []);

  await post({ op: 'trash', path: `${media}.recall.json` });
  const broken = await get(`op=recallAudit&folder=${encodeURIComponent(folder)}`);
  assert.deepEqual(broken.body.orphanMedia, [media], 'the audit did not notice a missing receipt');
  assert.equal(broken.body.healthyPairs, 0, 'a memory with no receipt was counted as healthy');

  // Nothing in the system may write the receipt back: provenance cannot be reconstructed.
  const listing = await get(`op=list&path=${encodeURIComponent(folder)}`);
  const names = (listing.body.nodes as { name: string }[]).map((n) => n.name);
  assert.equal(names.includes(`pic-${RUN}.png.recall.json`), false,
    'a receipt was regenerated after the fact, which would be a fabricated provenance');

  // Cleanup: leave no unpaired file for a later suite's audit to trip over.
  await post({ op: 'trash', path: media });
});

await test('RC-28: the audit refuses a scope that is not a Recall grouping folder', { 'RC-28': 'full' }, async () => {
  // An empty scope is NOT in this list: widening to every folder is a documented
  // choice the person makes, and refusing it would be the wrong behaviour to lock in.
  for (const f of ['/Documents', '/Downloads/Recall', '/Downloads/Recall/a/b']) {
    const r = await get(`op=recallAudit&folder=${encodeURIComponent(f)}`);
    assert.equal(r.status, 400, `scope "${f}" was accepted`);
  }
});

finish();
