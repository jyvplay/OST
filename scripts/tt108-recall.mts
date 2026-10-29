/**
 * TT108 — the three new human-initiated saving pathways, tested at the layer where
 * each one actually lives.
 *
 *   RC-31  counted batch save of already-decoded visuals (page agent + commit shape)
 *   RC-32  day-grouped saving timeline (PostgreSQL aggregation over real receipts)
 *   RC-33  region crop of an already-decoded preview, with checked provenance
 *
 * Everything here runs against a real server and a real database. The crop geometry
 * is a pure function and is attacked directly; the provenance rules are attacked
 * through HTTP, because that is where a hostile caller would reach them.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cropRegion, validDerivedFrom, MIN_CROP } from '../src/lib/recall-memory.ts';
import { makeHarness } from './harness.mts';

const dsn = process.env.DATABASE_URL;
if (!dsn || process.env.TT89_DISPOSABLE_DATABASE !== '1' || !new URL(dsn).pathname.endsWith('_test'))
  throw Error('Exclusive _test database required');
const BASE = process.env.TT108_BASE ?? 'http://127.0.0.1:3000';
const { test, finish } = makeHarness('tt108-recall');
// TT109: every folder this suite counts in is unique per run. The first version used fixed folder names, so the
// suite passed on a pristine database and then failed on the second run against the same one, counting the
// previous run's pairs as well (12 !== 4). A gate that only passes once is not a gate.
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const FOLDER = `/Downloads/Recall/tt108.test.${RUN}`;

const post = (body: unknown) => fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async <T>(qs: Record<string, string>): Promise<{ status: number; body: T }> => {
  const r = await fetch(BASE + '/api/fs?' + new URLSearchParams(qs));
  return { status: r.status, body: await r.json() as T };
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Publish one memory through the real endpoint, exactly as the browser does. */
async function publish(opts: { method?: string; capturedAt?: string; page?: string; bytes?: Buffer; derivedFrom?: unknown; folder?: string } = {}) {
  const folder = opts.folder ?? FOLDER;
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
  const body = opts.bytes ?? Buffer.from([137, 80, 78, 71, ...randomUUID().slice(0, 8).split('').map((c) => c.charCodeAt(0))]);
  const path = `${folder}/${Date.now()}-${randomUUID()}.png`;
  const receipt: Record<string, unknown> = {
    version: 1, path, bytes: body.length, mime: 'image/png', sha256: sha(body),
    method: opts.method ?? 'human-selected-file', capturedAt: opts.capturedAt ?? new Date().toISOString(),
    source: opts.page ?? 'https://memories.test/a', page: opts.page ?? 'https://memories.test/a', queryRedacted: true,
  };
  if (opts.derivedFrom !== undefined) receipt.derivedFrom = opts.derivedFrom;
  const r = await post({ op: 'recallCommit', path, content: body.toString('base64'), mime: 'image/png', receipt: JSON.stringify(receipt) });
  return { status: r.status, body: await r.json() as { ok: boolean; error?: string; derivedFrom?: string }, path, sha: sha(body), bytes: body };
}

/* --------------------------------------------- RC-33: crop geometry, attacked directly */

await test('a region dragged over a scaled preview maps onto the source pixel grid', { 'RC-33': 'partial' }, () => {
  // 400x300 picture shown at half size: a 50x40 drag is 100x80 real pixels.
  assert.deepEqual(cropRegion({ x: 10, y: 20, width: 50, height: 40 }, { width: 200, height: 150 }, { width: 400, height: 300 }),
    { x: 20, y: 40, width: 100, height: 80 });
  // 1:1 preview is the identity case
  assert.deepEqual(cropRegion({ x: 0, y: 0, width: 64, height: 64 }, { width: 64, height: 64 }, { width: 64, height: 64 }),
    { x: 0, y: 0, width: 64, height: 64 });
});

await test('a backwards drag selects the same region as the forward drag', { 'RC-33': 'partial' }, () => {
  const forward = cropRegion({ x: 10, y: 10, width: 40, height: 30 }, { width: 100, height: 100 }, { width: 100, height: 100 });
  const backward = cropRegion({ x: 50, y: 40, width: -40, height: -30 }, { width: 100, height: 100 }, { width: 100, height: 100 });
  assert.deepEqual(backward, forward);
});

await test('a drag released past the edge keeps the part that exists instead of reading outside the picture', { 'RC-33': 'full' }, () => {
  const r = cropRegion({ x: -30, y: -30, width: 200, height: 200 }, { width: 100, height: 100 }, { width: 100, height: 100 });
  assert.deepEqual(r, { x: 0, y: 0, width: 100, height: 100 });
  const edge = cropRegion({ x: 80, y: 80, width: 50, height: 50 }, { width: 100, height: 100 }, { width: 100, height: 100 });
  assert.deepEqual(edge, { x: 80, y: 80, width: 20, height: 20 });
  for (const bad of [
    { s: { x: 0, y: 0, width: 4, height: 50 }, why: 'thinner than the minimum' },
    { s: { x: 0, y: 0, width: 0, height: 0 }, why: 'a click, not a drag' },
    { s: { x: 500, y: 500, width: 10, height: 10 }, why: 'entirely outside' },
    { s: { x: Number.NaN, y: 0, width: 10, height: 10 }, why: 'not a number' },
  ]) assert.throws(() => cropRegion(bad.s, { width: 100, height: 100 }, { width: 100, height: 100 }), /select|outside|finite/i, bad.why);
  assert.throws(() => cropRegion({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 100 }, { width: 100, height: 100 }), /decoding/i);
  assert.throws(() => cropRegion({ x: 0, y: 0, width: 10, height: 10 }, { width: 10, height: 10 }, { width: 5000, height: 5000 }), /16-megapixel/);
  assert.equal(MIN_CROP, 8);
});

await test('malformed provenance is refused by the shared shape gate', { 'RC-33': 'partial' }, () => {
  const self = '/Downloads/Recall/x/a.png';
  const good = { path: '/Downloads/Recall/x/b.png', sha256: 'a'.repeat(64), region: { x: 0, y: 0, width: 10, height: 10 } };
  assert.deepEqual(validDerivedFrom(good, self), good);
  const cases: [unknown, RegExp][] = [
    [null, /derivedFrom/], ['x', /derivedFrom/], [[], /derivedFrom/],
    [{ ...good, path: self }, /itself/],
    [{ ...good, path: '/etc/passwd' }, /canonical/],
    [{ ...good, path: '/Downloads/Recall/x/b.png.recall.json' }, /canonical/],
    [{ ...good, sha256: 'nope' }, /SHA-256/],
    [{ ...good, region: { x: -1, y: 0, width: 10, height: 10 } }, /non-negative/],
    [{ ...good, region: { x: 0.5, y: 0, width: 10, height: 10 } }, /whole number/],
    [{ ...good, region: { x: 0, y: 0, width: 0, height: 10 } }, /at least one pixel|non-negative/],
    [{ ...good, region: { x: 0, y: 0, width: 5000, height: 5000 } }, /16 megapixels/],
    [{ ...good, region: { x: 0, y: 0, width: 10 } }, /exactly x, y, width and height/],
    [{ ...good, note: 'extra' }, /Unexpected derivedFrom/],
  ];
  for (const [value, re] of cases) assert.throws(() => validDerivedFrom(value, self), re, JSON.stringify(value));
});

/* --------------------------------------------- RC-33: provenance enforced by the server */

const parent = await publish({ method: 'human-selected-file' });

await test('a crop publishes with provenance pointing at the saved memory it was cut from', { 'RC-33': 'full' }, async () => {
  assert.equal(parent.status, 200, parent.body.error);
  const before = await get<{ node: { sha256: string; version: number; size: number } }>({ op: 'stat', path: parent.path });
  const crop = await publish({ method: 'cropped-preview-region', derivedFrom: { path: parent.path, sha256: parent.sha, region: { x: 1, y: 2, width: 16, height: 9 } } });
  assert.equal(crop.status, 200, crop.body.error);
  assert.equal(crop.body.derivedFrom, parent.path);
  const stored = await get<{ node: { content: string; encoding: string } }>({ op: 'read', path: crop.path + '.recall.json' });
  assert.equal(stored.body.node.encoding, 'utf8', 'a receipt must stay readable text');
  const receipt = JSON.parse(stored.body.node.content) as { derivedFrom: { path: string; region: { width: number } } };
  assert.equal(receipt.derivedFrom.path, parent.path, 'the stored receipt lost its provenance');
  assert.equal(receipt.derivedFrom.region.width, 16);
  // the parent is untouched: a crop is a new memory, never an edit
  const after = await get<{ node: { sha256: string; version: number; size: number } }>({ op: 'stat', path: parent.path });
  assert.deepEqual(after.body.node, before.body.node, 'saving a region modified the original memory');
  assert.notEqual(crop.path, parent.path, 'the crop overwrote its own parent');
});

await test('a crop naming a parent this archive does not hold is refused', { 'RC-33': 'full' }, async () => {
  const missing = await publish({ method: 'cropped-preview-region', derivedFrom: { path: FOLDER + '/never-saved.png', sha256: 'b'.repeat(64), region: { x: 0, y: 0, width: 4, height: 4 } } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error ?? '', /no longer saved/i);
  const wrongHash = await publish({ method: 'cropped-preview-region', derivedFrom: { path: parent.path, sha256: 'c'.repeat(64), region: { x: 0, y: 0, width: 4, height: 4 } } });
  assert.equal(wrongHash.status, 400);
  assert.match(wrongHash.body.error ?? '', /has changed/i);
});

await test('provenance and method cannot be separated in either direction', { 'RC-33': 'full' }, async () => {
  const bare = await publish({ method: 'cropped-preview-region' });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error ?? '', /must record the memory it was derived from/i);
  const smuggled = await publish({ method: 'human-selected-file', derivedFrom: { path: parent.path, sha256: parent.sha, region: { x: 0, y: 0, width: 4, height: 4 } } });
  assert.equal(smuggled.status, 400);
  assert.match(smuggled.body.error ?? '', /Only a derived-region save/i);
});

await test('a refused crop leaves neither media nor receipt behind', { 'RC-33': 'full' }, async () => {
  const before = await get<{ mediaFiles: number; receiptFiles: number }>({ op: 'recallAudit', folder: FOLDER });
  for (let i = 0; i < 3; i++) await publish({ method: 'cropped-preview-region', derivedFrom: { path: parent.path, sha256: 'd'.repeat(64), region: { x: 0, y: 0, width: 4, height: 4 } } });
  const after = await get<{ mediaFiles: number; receiptFiles: number; orphanMedia: string[]; orphanReceipts: string[] }>({ op: 'recallAudit', folder: FOLDER });
  assert.equal(after.body.mediaFiles, before.body.mediaFiles, 'a rejected crop still wrote media');
  assert.equal(after.body.receiptFiles, before.body.receiptFiles, 'a rejected crop still wrote a receipt');
  assert.deepEqual(after.body.orphanMedia, []);
  assert.deepEqual(after.body.orphanReceipts, []);
});

/* --------------------------------------------- RC-32: the day-grouped timeline */

const DAY_FOLDER = `/Downloads/Recall/tt108.days.${RUN}`;
const dayOf = (back: number) => new Date(Date.now() - back * 86400000).toISOString();

await test('the timeline groups real saved memories by day with counts, bytes and methods', { 'RC-32': 'full' }, async () => {
  const made: Record<string, number> = {};
  for (const [back, method] of [[0, 'human-selected-file'], [0, 'cropped-preview-region'], [1, 'human-paste-file'], [3, 'batch-loaded-visuals']] as const) {
    const at = dayOf(back);
    const extra = method === 'cropped-preview-region' ? { derivedFrom: { path: parent.path, sha256: parent.sha, region: { x: 0, y: 0, width: 8, height: 8 } } } : {};
    const r = await publish({ method, capturedAt: at, folder: DAY_FOLDER, ...extra });
    assert.equal(r.status, 200, `${method}: ${r.body.error}`);
    made[at.slice(0, 10)] = (made[at.slice(0, 10)] ?? 0) + 1;
  }
  const { status, body } = await get<{ ok: boolean; zone: string; days: { day: string; memories: number; bytes: number; methods: string[] }[]; totalMemories: number }>(
    { op: 'recallTimeline', folder: DAY_FOLDER, tz: 'UTC' });
  assert.equal(status, 200);
  assert.equal(body.zone, 'UTC');
  assert.equal(body.totalMemories, 4, 'timeline did not count every saved memory');
  for (const [day, n] of Object.entries(made)) {
    const row = body.days.find((d) => d.day === day);
    assert.ok(row, 'missing day ' + day + ' in ' + body.days.map((d) => d.day).join(','));
    assert.equal(Number(row.memories), n, 'wrong count for ' + day);
    assert.ok(Number(row.bytes) > 0, 'day reported zero bytes');
  }
  const today = body.days.find((d) => d.day === dayOf(0).slice(0, 10));
  assert.deepEqual([...(today?.methods ?? [])].sort(), ['cropped-preview-region', 'human-selected-file']);
  assert.deepEqual([...body.days].map((d) => d.day), [...body.days].map((d) => d.day).sort().reverse(), 'days are not newest-first');
});

await test('selecting a day returns exactly that day through the ordinary server-side search', { 'RC-32': 'full' }, async () => {
  const day = dayOf(1).slice(0, 10);
  const { body } = await get<{ nodes: { path: string }[] }>({ op: 'recallSearch', from: day, to: day + 'T23:59:59.999Z' });
  assert.ok(body.nodes.length >= 1, 'the selected day returned nothing');
  for (const n of body.nodes) assert.ok(n.path.startsWith('/Downloads/Recall/'), 'search escaped the Recall root');
  const empty = await get<{ nodes: unknown[] }>({ op: 'recallSearch', from: '1999-01-01', to: '1999-01-01T23:59:59.999Z' });
  assert.deepEqual(empty.body.nodes, [], 'a day with no memories was not empty');
});

await test('a day drill-down stays inside the folder it was launched from', { 'RC-32': 'full', 'RC-27': 'partial' }, async () => {
  const today = new Date().toISOString().slice(0, 10);
  const scoped = await get<{ nodes: { path: string }[]; filters: { folder: string | null } }>(
    { op: 'recallSearch', from: today, to: today + 'T23:59:59.999Z', folder: DAY_FOLDER });
  assert.equal(scoped.body.filters.folder, DAY_FOLDER);
  assert.ok(scoped.body.nodes.length >= 1, 'the scoped day returned nothing');
  for (const n of scoped.body.nodes) assert.ok(n.path.startsWith(DAY_FOLDER + '/'), 'a day drill-down escaped its folder: ' + n.path);
  const everywhere = await get<{ nodes: { path: string }[] }>({ op: 'recallSearch', from: today, to: today + 'T23:59:59.999Z' });
  assert.ok(everywhere.body.nodes.length > scoped.body.nodes.length, 'the folder filter changed nothing, so it proves nothing');
  for (const bad of ['/Downloads/Recall/a/b', '/etc', '/Downloads/Recall/x/../y', 'relative']) {
    const r = await get<{ error: string }>({ op: 'recallSearch', folder: bad });
    assert.equal(r.status, 400, 'accepted a non-canonical folder filter: ' + bad);
    assert.match(r.body.error, /folder filter/i);
  }
});

await test('the timeline refuses an injected time zone and a non-canonical folder', { 'RC-32': 'full' }, async () => {
  for (const tz of ["UTC'; DROP TABLE vfs_nodes; --", 'Not A Zone', 'a'.repeat(80)]) {
    const r = await get<{ ok: boolean; error: string }>({ op: 'recallTimeline', tz });
    assert.equal(r.status, 400, 'accepted hostile time zone ' + tz);
    assert.match(r.body.error, /Invalid time zone/);
  }
  const bad = await get<{ error: string }>({ op: 'recallTimeline', folder: '/Downloads/Recall/a/../../etc' });
  assert.equal(bad.status, 400);
  // the table is still there, i.e. nothing was executed
  const alive = await get<{ ok: boolean }>({ op: 'recallAudit', folder: DAY_FOLDER });
  assert.equal(alive.status, 200);
  assert.equal(alive.body.ok, true);
});

await test('a receipt with an unreadable capture time is counted apart, never placed in a made-up day', { 'RC-32': 'full' }, async () => {
  // Write a receipt whose capturedAt is not a timestamp, beside a real media file.
  const stray = `${DAY_FOLDER}/${Date.now()}-${randomUUID()}.png`;
  const body = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  await post({ op: 'write', path: stray, content: body.toString('base64'), encoding: 'base64', mime: 'image/png' });
  await post({ op: 'write', path: stray + '.recall.json', content: JSON.stringify({ version: 1, path: stray, bytes: body.length, mime: 'image/png', sha256: sha(body), method: 'human-selected-file', capturedAt: 'whenever', queryRedacted: true, source: 'https://x.test/', page: 'https://x.test/' }), encoding: 'utf8', mime: 'application/json' });
  const { body: t } = await get<{ days: { day: string; memories: number }[]; undatedReceipts: number; totalMemories: number }>({ op: 'recallTimeline', folder: DAY_FOLDER, tz: 'UTC' });
  assert.equal(t.undatedReceipts, 1, 'the undated receipt was not reported');
  assert.equal(t.totalMemories, 4, 'the undated receipt was silently given a day');
  assert.ok(!t.days.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d.day)), 'a malformed day bucket appeared');
});

await test('an unreadable receipt cannot abort the timeline query', { 'RC-32': 'full' }, async () => {
  const stray = `${DAY_FOLDER}/${Date.now()}-${randomUUID()}.png`;
  await post({ op: 'write', path: stray + '.recall.json', content: 'not json at all {{{', encoding: 'utf8', mime: 'application/json' });
  const { status, body } = await get<{ ok: boolean; unreadableReceipts: number; days: unknown[] }>({ op: 'recallTimeline', folder: DAY_FOLDER, tz: 'UTC' });
  assert.equal(status, 200, 'a corrupt receipt broke the timeline');
  assert.equal(body.ok, true);
  assert.ok(body.unreadableReceipts >= 1, 'the corrupt receipt was not counted');
  assert.ok(body.days.length >= 2, 'the timeline lost its days');
});

/* --------------------------------------------- RC-31: the counted batch */

await test('the page agent encodes already-decoded visuals and never requests a URL again', { 'RC-31': 'partial' }, async () => {
  const shim = await (await fetch(BASE + '/wp-shim.js')).text();
  const start = shim.indexOf("e.data.fusionWp!=='recall-batch'");
  assert.ok(start > 0, 'the served shim has no batch listener at all');
  // The slice must end where the batch listener ends, not at 'whatever token appears next':
  // later pathways (RC-38's resident-object reader) legitimately read blob: URLs inside the
  // document, and sweeping them into this slice made a true guard fail for the wrong reason.
  const after = shim.indexOf('\n  /**', start);
  const nextListener = shim.indexOf('addEventListener("message"', start);
  const end = Math.min(...[after, nextListener, shim.indexOf('DOMContentLoaded', start)].filter((n) => n > start));
  const handler = shim.slice(start, end);
  assert.ok(handler.length > 400, 'the batch handler is not in the served shim');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'new Image(', '.src=']) assert.ok(!handler.includes(forbidden), `the batch path may not use ${forbidden}`);
  assert.ok(handler.includes('drawImage'), 'the batch must read existing pixels');
  assert.ok(handler.includes('readyState<2') && handler.includes('.complete'), 'the batch must skip undecoded elements');
  assert.ok(handler.includes('mediaKeys'), 'the batch must skip protected media');
  assert.ok(handler.includes('16777216'), 'the batch must keep the 16 MP budget');
  assert.ok(/candidates\.length<200/.test(handler), 'the batch must keep the 200-candidate traversal budget');
  assert.ok(handler.includes('considered') && handler.includes('eligible'), 'the batch must report what it examined');
});

await test('every member of a batch is published as its own complete, independent pair', { 'RC-31': 'full' }, async () => {
  const batchFolder = `/Downloads/Recall/tt108.batch.${RUN}`;
  const saved = [];
  for (let i = 0; i < 4; i++) saved.push(await publish({ method: 'batch-loaded-visuals', folder: batchFolder, bytes: Buffer.from([137, 80, 78, 71, i, i, i, i]) }));
  for (const s of saved) assert.equal(s.status, 200, s.body.error);
  const { body } = await get<{ mediaFiles: number; receiptFiles: number; healthyPairs: number; orphanMedia: string[]; orphanReceipts: string[]; checksumMismatch: string[] }>({ op: 'recallAudit', folder: batchFolder });
  assert.equal(body.mediaFiles, 4);
  assert.equal(body.receiptFiles, 4);
  assert.equal(body.healthyPairs, 4, 'a batch member is not a healthy pair');
  assert.deepEqual([body.orphanMedia, body.orphanReceipts, body.checksumMismatch], [[], [], []]);
  // and each is independently searchable by the batch method
  const found = await get<{ nodes: { path: string }[] }>({ op: 'recallSearch', method: 'batch-loaded-visuals' });
  assert.ok(found.body.nodes.length >= 4, 'batch members are not searchable by method');
});

await test('one bad member of a batch cannot take the others down with it', { 'RC-31': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt108.partial.${RUN}`;
  const ok1 = await publish({ method: 'batch-loaded-visuals', folder, bytes: Buffer.from([1, 2, 3, 4]) });
  // a member whose declared digest does not match its bytes is refused on its own
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
  const path = `${folder}/${Date.now()}-${randomUUID()}.png`;
  const bytes = Buffer.from([9, 9, 9, 9]);
  const lying = await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png',
    receipt: JSON.stringify({ version: 1, path, bytes: bytes.length, mime: 'image/png', sha256: 'e'.repeat(64), method: 'batch-loaded-visuals', capturedAt: new Date().toISOString(), source: 'https://x.test/', page: 'https://x.test/', queryRedacted: true }) });
  assert.equal(lying.status, 400);
  const ok2 = await publish({ method: 'batch-loaded-visuals', folder, bytes: Buffer.from([5, 6, 7, 8]) });
  assert.equal(ok1.status, 200); assert.equal(ok2.status, 200);
  const { body } = await get<{ mediaFiles: number; healthyPairs: number }>({ op: 'recallAudit', folder });
  assert.equal(body.mediaFiles, 2, 'the refused member left bytes behind');
  assert.equal(body.healthyPairs, 2);
});

await test('the Specs app carries every new Recall requirement of this turn', { 'RC-30': 'partial', 'RC-31': 'partial', 'RC-32': 'partial', 'RC-33': 'partial' }, async () => {
  const r = await fetch(BASE + '/api/features');
  const { rows } = await r.json() as { rows: { code: string; nuance: string; status: string; test: string }[] };
  for (const code of ['RC-30', 'RC-31', 'RC-32', 'RC-33']) {
    const row = rows.find((x) => x.code === code);
    assert.ok(row, `${code} is missing from the register`);
    assert.ok(row.nuance.length > 240, `${code} has no substantive nuance recorded`);
    assert.ok(row.test, `${code} names no test`);
  }
  // the claims that must stay in the register because they are limits, not features
  assert.match(rows.find((x) => x.code === 'RC-30')!.nuance, /power-loss durability is NOT/);
  assert.match(rows.find((x) => x.code === 'RC-31')!.nuance, /no URL is refetched/);
  assert.match(rows.find((x) => x.code === 'RC-32')!.nuance, /no periodic background capture/);
  assert.match(rows.find((x) => x.code === 'RC-33')!.nuance, /not authenticated attestation/);
  assert.match(rows.find((x) => x.code === 'RC-29')!.nuance, /TT108 UPDATE/);
});

finish();
