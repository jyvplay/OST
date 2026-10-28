/**
 * TT109 — Recall as an archive of what the browser already loaded.
 *
 * New this turn: RC-34, duplicate recognition. An archive of things you have already seen should answer
 * "you saved this on Tuesday" instead of filing the same bytes twice. The check runs inside the publishing
 * transaction on DECODED bytes (the domain the receipt digests), scoped to the memory's own folder, and it
 * is opt-in so a deliberate re-save and the legacy refetch path keep their old meaning.
 *
 * Also brings four long-untested Recall rows to a tested state against the real server: RC-10 grouping,
 * RC-12 the /Private boundary, RC-13 pair deletion and restore, RC-15 the exclusions that actually exist.
 *
 * Exclusive real HTTP + PostgreSQL. No mocks, no fabricated responses.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { makeHarness } from './harness.mts';
import { recallFolder, recallSource } from '../src/lib/recall-core.ts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL?.endsWith('_test'))
  throw Error('Exclusive _test database required');
const BASE = process.env.TT109_BASE ?? process.env.BASE ?? 'http://127.0.0.1:3000';
const { test, finish } = makeHarness('tt109-recall');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const post = (body: unknown) => fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async <T>(qs: Record<string, string>): Promise<{ status: number; body: T }> => {
  const r = await fetch(`${BASE}/api/fs?${new URLSearchParams(qs)}`);
  return { status: r.status, body: await r.json() as T };
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** A distinct, valid PNG-ish payload per call; Recall stores bytes, it does not re-encode them. */
const pngBytes = (seed: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(seed)]);

interface Published { status: number; body: { ok?: boolean; path?: string; stored?: boolean; duplicateOf?: string; firstSavedAt?: string; error?: string; digest?: string } }
async function publish(opts: { folder: string; bytes: Buffer; onDuplicate?: 'store' | 'skip'; method?: string; capturedAt?: string; page?: string }): Promise<Published> {
  const { folder, bytes } = opts;
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
  const path = `${folder}/${Date.now()}-${randomUUID()}.png`;
  const page = opts.page ?? 'https://example.com/album';
  const receipt = JSON.stringify({
    version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png',
    method: opts.method ?? 'chosen-resident-file', sourceAttribution: 'user-declared-label',
    source: page, page, capturedAt: opts.capturedAt ?? new Date().toISOString(), queryRedacted: true,
  }, null, 2);
  const r = await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt, ...(opts.onDuplicate ? { onDuplicate: opts.onDuplicate } : {}) });
  return { status: r.status, body: await r.json() };
}
/** The pair endpoint refuses a blind mutation on purpose: inspect first, then act on exactly what was inspected. */
async function pairAction(path: string, action: 'trash' | 'restore') {
  const seen = await (await post({ op: 'recallPair', path, action: 'inspect' })).json() as { ok?: boolean; guard?: unknown; error?: string };
  if (!seen.ok) return { status: 409, body: seen };
  const r = await post({ op: 'recallPair', path, action, expected: seen.guard });
  return { status: r.status, body: await r.json() as { ok?: boolean; error?: string } };
}
const listFiles = async (folder: string) =>
  ((await get<{ nodes: { path: string }[] }>({ op: 'list', path: folder })).body.nodes ?? [])
    .map((n) => n.path).filter((p) => !p.endsWith('.recall.json'));

/* ------------------------------------------------------------------ RC-34: duplicate recognition */

await test('an identical memory in the same folder is recognised instead of filed twice', { 'RC-34': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt109.dup.${RUN}`;
  const bytes = pngBytes(`same-${RUN}`);
  const first = await publish({ folder, bytes, onDuplicate: 'skip' });
  assert.equal(first.status, 200, first.body.error);
  assert.equal(first.body.stored, true, 'the first save must store');
  assert.equal(first.body.digest, sha(bytes), 'the server must report the decoded-byte digest it filed under');

  const second = await publish({ folder, bytes, onDuplicate: 'skip' });
  assert.equal(second.status, 200, second.body.error);
  assert.equal(second.body.stored, false, 'the second save of identical bytes must not store');
  assert.equal(second.body.duplicateOf, first.body.path, 'the archive must name the memory it already holds');
  assert.equal(second.body.path, first.body.path, 'the caller must be sent to the memory that exists');
  assert.ok(Number.isFinite(Date.parse(second.body.firstSavedAt ?? '')), 'when it was first saved must be a real instant');

  const files = await listFiles(folder);
  assert.equal(files.length, 1, `the folder must hold exactly one copy, holds ${files.length}`);
  // The receipt of the surviving memory is untouched: a duplicate must not rewrite history.
  const receipt = await get<{ node?: { content: string } }>({ op: 'read', path: first.body.path + '.recall.json' });
  assert.equal(JSON.parse(receipt.body.node!.content).sha256, sha(bytes));
});

await test('duplicate recognition is opt-in: a deliberate re-save still produces a second memory', { 'RC-34': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt109.again.${RUN}`;
  const bytes = pngBytes(`again-${RUN}`);
  assert.equal((await publish({ folder, bytes })).body.stored, true);
  const second = await publish({ folder, bytes });
  assert.equal(second.body.stored, true, 'without onDuplicate:skip the old behaviour must be unchanged');
  assert.equal(second.body.duplicateOf, undefined);
  assert.equal((await listFiles(folder)).length, 2, 'two deliberate saves are two memories');
});

await test('recognition is by decoded bytes and is confined to one folder', { 'RC-34': 'full' }, async () => {
  const a = `/Downloads/Recall/tt109.scopeA.${RUN}`, b = `/Downloads/Recall/tt109.scopeB.${RUN}`;
  const bytes = pngBytes(`scoped-${RUN}`);
  assert.equal((await publish({ folder: a, bytes, onDuplicate: 'skip' })).body.stored, true);
  // Same bytes under a different grouping is a second deliberate memory, not an accident.
  assert.equal((await publish({ folder: b, bytes, onDuplicate: 'skip' })).body.stored, true, 'a different folder must not be deduplicated against');
  // One byte different is a different memory even in the same folder.
  const near = Buffer.concat([bytes, Buffer.from([0])]);
  const other = await publish({ folder: a, bytes: near, onDuplicate: 'skip' });
  assert.equal(other.body.stored, true, 'different bytes must never be treated as a duplicate');
  assert.notEqual(other.body.digest, sha(bytes));
  assert.equal((await listFiles(a)).length, 2);
});

await test('a trashed memory does not block saving it again', { 'RC-34': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt109.trashdup.${RUN}`;
  const bytes = pngBytes(`trashed-${RUN}`);
  const first = await publish({ folder, bytes, onDuplicate: 'skip' });
  const trashed = await pairAction(first.body.path!, 'trash');
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  const again = await publish({ folder, bytes, onDuplicate: 'skip' });
  assert.equal(again.body.stored, true, 'a memory you deleted must be savable again');
  assert.notEqual(again.body.path, first.body.path);
});

await test('an unreadable neighbour cannot break or fake duplicate recognition', { 'RC-34': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt109.noise.${RUN}`;
  const bytes = pngBytes(`noise-${RUN}`);
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
  // A file in the folder whose text is not canonical base64: the duplicate scan must step over it
  // (the CASE guard yields NULL) rather than raising and taking the whole publication down.
  const junk = await post({ op: 'write', path: `${folder}/not-base64-${RUN}.png`, content: 'this is not base64 ***', encoding: 'base64' });
  assert.ok([200, 400, 409, 422].includes(junk.status), `unexpected status planting the odd neighbour: ${junk.status}`);
  const saved = await publish({ folder, bytes, onDuplicate: 'skip' });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.stored, true);
  const repeat = await publish({ folder, bytes, onDuplicate: 'skip' });
  assert.equal(repeat.body.stored, false, 'recognition must still work beside an unreadable file');
});

await test('onDuplicate is validated, and an invalid value writes nothing', { 'RC-34': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt109.badopt.${RUN}`;
  const bytes = pngBytes(`badopt-${RUN}`);
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
  const path = `${folder}/${Date.now()}-${randomUUID()}.png`;
  const receipt = JSON.stringify({ version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png', method: 'chosen-resident-file', sourceAttribution: 'user-declared-label', source: 'https://example.com/a', page: 'https://example.com/a', capturedAt: new Date().toISOString(), queryRedacted: true });
  for (const bad of ['SKIP', 'yes', '', 1, null, {}]) {
    const r = await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt, onDuplicate: bad });
    assert.equal(r.status, 400, `onDuplicate=${JSON.stringify(bad)} → ${r.status}`);
  }
  assert.equal((await listFiles(folder)).length, 0, 'a refused option must leave the folder empty');
});

/* ------------------------------------------------------------------------- RC-10: grouping */

await test('grouping sends the same bytes to the folder the human chose, and cannot escape the Recall root', { 'RC-10': 'full' }, async () => {
  // Pure boundary first: the grouping rule is a library function, so it can be attacked directly.
  const page = 'https://news.example.org/world/story?utm=1';
  assert.equal(recallFolder(page, 'A Title', 'host', ''), '/Downloads/Recall/news.example.org');
  assert.ok(recallFolder(page, 'A Title', 'title', '').startsWith('/Downloads/Recall/'));
  assert.equal(recallFolder(page, 'A Title', 'custom', 'Trip 2026'), '/Downloads/Recall/Trip 2026');
  // A name that sanitises to nothing is refused rather than quietly turned into some default folder:
  // a memory must never land somewhere the human did not name.
  for (const blank of ['', '   ', '\t\n'])
    assert.throws(() => recallFolder(page, 'T', 'custom', blank), `a blank custom name must be refused, not given a default folder: ${JSON.stringify(blank)}`);
  // Everything else is sanitised into one safe segment: separators and control characters become "_",
  // and a name that is only dots becomes an explicit "untitled" rather than a traversal.
  assert.equal(recallFolder(page, 'T', 'custom', '..'), '/Downloads/Recall/untitled');
  assert.equal(recallFolder(page, 'T', 'custom', '/'), '/Downloads/Recall/_');
  for (const hostile of ['../escape', '/etc', 'a/b', 'x'.repeat(400), '\u202eevil name', 'nul\u0000byte', 'CON', '....//....//etc', '\u0000', '//']) {
    const got = recallFolder(page, 'T', 'custom', hostile);
    assert.ok(got.startsWith('/Downloads/Recall/'), `grouping escaped the root with ${JSON.stringify(hostile)}: ${got}`);
    assert.ok(!got.slice('/Downloads/Recall/'.length).includes('/'), `grouping created a subpath with ${JSON.stringify(hostile)}: ${got}`);
    assert.ok(got.length <= 512 && !/[\u0000-\u001f\u007f]/.test(got), `unsafe characters survived in ${got}`);
  }
  // The query string never becomes part of the stored attribution.
  assert.equal(recallSource(page), 'https://news.example.org/world/story');

  // Then end to end: two groupings of identical bytes really are two folders on the server.
  const bytes = pngBytes(`group-${RUN}`);
  const host = `/Downloads/Recall/tt109.host.${RUN}`, custom = `/Downloads/Recall/tt109.custom.${RUN}`;
  assert.equal((await publish({ folder: host, bytes, onDuplicate: 'skip' })).body.stored, true);
  assert.equal((await publish({ folder: custom, bytes, onDuplicate: 'skip' })).body.stored, true);
  assert.equal((await listFiles(host)).length, 1);
  assert.equal((await listFiles(custom)).length, 1);
  const timeline = await get<{ scope: string; totalMemories: number }>({ op: 'recallTimeline', folder: custom, tz: 'UTC' });
  assert.equal(timeline.body.scope, custom, 'the timeline must report the group it was asked about');
  assert.equal(timeline.body.totalMemories, 1);
});

await test('a save outside the Recall root is refused whatever the grouping asked for', { 'RC-10': 'full' }, async () => {
  const bytes = pngBytes(`escape-${RUN}`);
  const receiptFor = (path: string) => JSON.stringify({ version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png', method: 'chosen-resident-file', sourceAttribution: 'user-declared-label', source: 'https://example.com/a', page: 'https://example.com/a', capturedAt: new Date().toISOString(), queryRedacted: true });
  for (const path of ['/Downloads/Recall/../../etc/x.png', '/Documents/x.png', '/Downloads/Recall/x.png', '/Downloads/Recall/a/b/c.png', '/Private/Recall/x/y.png'])
    assert.equal((await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt: receiptFor(path) })).status, 400, `accepted ${path}`);
});

/* ------------------------------------------------------- RC-12 / RC-15: boundaries and exclusions */

await test('memories are never written into Persistent Storage, and the archive says so plainly', { 'RC-12': 'partial', 'RC-15': 'partial' }, async () => {
  const bytes = pngBytes(`private-${RUN}`);
  const path = '/Private/Recall/x/secret.png';
  const receipt = JSON.stringify({ version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png', method: 'chosen-resident-file', sourceAttribution: 'user-declared-label', source: 'https://example.com/a', page: 'https://example.com/a', capturedAt: new Date().toISOString(), queryRedacted: true });
  assert.equal((await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt })).status, 400,
    'Recall must refuse to publish inside /Private rather than writing plaintext there');
  // The register must not claim encryption this path does not have.
  const rows = (await (await fetch(BASE + '/api/features')).json()).rows as { code: string; status: string; nuance: string }[];
  const rc12 = rows.find((r) => r.code === 'RC-12')!;
  assert.notEqual(rc12.status, 'built', 'RC-12 must not be graded built while memories are plaintext');
  assert.match(rc12.nuance, /not encrypted|plaintext|unencrypted/i, 'the register must state the plaintext limit in words');
});

await test('the exclusions that exist are real: query tokens are dropped and a declared label cannot smuggle them back',
  { 'RC-15': 'partial' }, async () => {
    const bytes = pngBytes(`tokens-${RUN}`);
    const folder = `/Downloads/Recall/tt109.tokens.${RUN}`;
    // A receipt whose labels still carry a query string is refused: the redaction is enforced by the server,
    // not merely performed by the client that happens to be shipped with it.
    for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
    const path = `${folder}/${Date.now()}-${randomUUID()}.png`;
    const leaky = JSON.stringify({ version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png', method: 'chosen-resident-file', sourceAttribution: 'user-declared-label', source: 'https://example.com/a?token=SECRET', page: 'https://example.com/a?token=SECRET', capturedAt: new Date().toISOString(), queryRedacted: true });
    assert.equal((await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt: leaky })).status, 400,
      'a receipt carrying query tokens must be refused');
    const dishonest = JSON.stringify({ version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png', method: 'chosen-resident-file', sourceAttribution: 'user-declared-label', source: 'https://example.com/a', page: 'https://example.com/a', capturedAt: new Date().toISOString(), queryRedacted: false });
    assert.equal((await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt: dishonest })).status, 400,
      'a receipt that admits it did not redact must be refused');
    assert.equal((await listFiles(folder)).length, 0);
    // And the register must not claim a classifier that does not exist.
    const rows = (await (await fetch(BASE + '/api/features')).json()).rows as { code: string; nuance: string }[];
    assert.match(rows.find((r) => r.code === 'RC-15')!.nuance, /no automatic|opt-in|not a sensitive-data classifier/i);
  });

/* ------------------------------------------------------------- RC-13: deletion and restoration */

await test('deleting a memory removes the pair together and restoring brings the pair back', { 'RC-13': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt109.life.${RUN}`;
  const bytes = pngBytes(`life-${RUN}`);
  const saved = await publish({ folder, bytes, onDuplicate: 'skip' });
  const audit = async () => (await get<{ healthyPairs: number; orphanMedia: string[]; orphanReceipts: string[] }>({ op: 'recallAudit', folder })).body;
  assert.equal((await audit()).healthyPairs, 1);

  const trash = await pairAction(saved.body.path!, 'trash');
  assert.equal(trash.status, 200, JSON.stringify(trash.body));
  const afterTrash = await audit();
  assert.equal(afterTrash.healthyPairs, 0, 'a trashed memory must leave no healthy pair');
  assert.deepEqual([afterTrash.orphanMedia, afterTrash.orphanReceipts], [[], []],
    'trashing must take media and receipt together — half a pair is the failure mode this guards');

  const restore = await pairAction(saved.body.path!, 'restore');
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  const afterRestore = await audit();
  assert.equal(afterRestore.healthyPairs, 1, 'restoring must bring back a complete, healthy pair');
  const back = await get<{ node?: { content: string } }>({ op: 'read', path: saved.body.path + '.recall.json' });
  assert.equal(JSON.parse(back.body.node!.content).sha256, sha(bytes), 'the restored receipt must still describe the restored bytes');
});

await test('a memory cannot be half-deleted through the pair endpoint', { 'RC-13': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt109.half.${RUN}`;
  const saved = await publish({ folder, bytes: pngBytes(`half-${RUN}`), onDuplicate: 'skip' });
  // Trash only the receipt behind the pair endpoint's back, then ask the pair endpoint to act.
  assert.equal((await post({ op: 'trash', path: saved.body.path + '.recall.json' })).status, 200);
  const mixed = await pairAction(saved.body.path!, 'trash');
  assert.equal(mixed.status, 409, `a mixed trash state must be reported, not silently "fixed": ${JSON.stringify(mixed.body)}`);
  assert.match(String(mixed.body.error), /mixed trash state|no longer/i, 'the refusal must name the mixed state');
  const audit = (await get<{ orphanMedia: string[] }>({ op: 'recallAudit', folder })).body;
  assert.equal(audit.orphanMedia.length, 1, 'the audit must show the media now standing without its receipt');
});

/* ----------------------------------------------- RC-14: the refetch path is the only one that may claim the URL */

await test('only the refetch method may claim the bytes came from the URL it names', { 'RC-14': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt109.attr.${RUN}`;
  const bytes = pngBytes(`attr-${RUN}`);
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
  const receiptFor = (path: string, method: string, attribution: string) => JSON.stringify({
    version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png', method,
    sourceAttribution: attribution, source: 'https://example.com/photo.png', page: 'https://example.com/album',
    capturedAt: new Date().toISOString(), queryRedacted: true,
  });
  const send = (method: string, attribution: string) => {
    const path = `${folder}/${Date.now()}-${randomUUID()}.png`;
    return post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt: receiptFor(path, method, attribution) });
  };
  // A memory of something already on screen must not be filed as if the server had served those bytes.
  for (const method of ['chosen-resident-file', 'human-paste-file', 'batch-loaded-visuals', 'clicked-visual-png'])
    assert.equal((await send(method, 'requested-url')).status, 400, `${method} was allowed to claim requested-url attribution`);
  // And the refetch path must not pretend its bytes were merely a label the human typed.
  assert.equal((await send('original-response', 'user-declared-label')).status, 400,
    'the refetch path was allowed to disclaim the URL it actually requested');
  // A receipt that simply omits the claim is read the conservative way, so it cannot launder a refetch,
  // and it stays acceptable for the already-loaded pathways that never made a claim.
  const sendBare = (method: string) => {
    const path = `${folder}/${Date.now()}-${randomUUID()}.png`;
    const r = JSON.parse(receiptFor(path, method, 'user-declared-label')); delete r.sourceAttribution;
    return post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt: JSON.stringify(r) });
  };
  assert.equal((await sendBare('original-response')).status, 400, 'omitting the claim laundered a refetch');
  assert.equal((await sendBare('chosen-resident-file')).status, 200, 'a receipt that claims nothing must still be filable');
  // The honest combinations are accepted.
  assert.equal((await send('chosen-resident-file', 'user-declared-label')).status, 200);
  assert.equal((await send('original-response', 'requested-url')).status, 200);
  const files = await listFiles(folder);
  assert.equal(files.length, 3, `only the honest receipts may have been filed, found ${files.length}`);
});

finish();
