/**
 * TT116 — SR-05, SR-08, DP-14, SC-02 over HTTP.
 *
 * Four platform claims that were carried as prose with incidental coverage. Each is
 * tested here by the fact that would be false if the claim were decoration:
 *
 *   SR-05 scope     — a scoped search must EXCLUDE a matching document that lives
 *                     outside the scope, and the scope must break on the path
 *                     separator, so /Documents/ab never captures /Documents/abc.
 *   SR-08 diagnostic— an empty query reports index coverage per source; explain=1
 *                     reports the strategy and the exclusions; and asking the server
 *                     to rebuild returns 501 with rebuilt:false instead of pretending.
 *   DP-14 journal   — a write, a move and a trash each leave an observable entry
 *                     carrying the op and the path, and the FM-18 safe save leaves
 *                     its full stage sequence rather than one opaque "done".
 *   SC-02 lock      — a privacy switch set to "off" is enforced by the SERVER: a
 *                     capture-method commit is refused while the switch is off and
 *                     works when it is on, and the refusal writes no file.
 *
 * SC-02 restores the switch in a finally block; leaving capture off would silently
 * break every capture suite that runs after this one in a shared gate database.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('tt116-platform');
const RUN = Date.now().toString(36);

type Res = { status: number; body: Record<string, unknown> };
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
}
const fsPost = (body: unknown) => call('POST', '/api/fs', body);
const fsGet = (qs: string) => call('GET', `/api/fs?${qs}`);

/** Poll, because the fast index is updated on the write path and a read that races
 *  it would make this suite flaky in exactly the way TT115 spent a gate diagnosing. */
async function until<T>(what: string, fn: () => Promise<T | null>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const TERM = `zarquon${RUN}`;
const INSIDE = `/Documents/scope-${RUN}`;
const DECOY = `/Documents/scope-${RUN}-sibling`;

await test('SR-05: a scoped search excludes a matching document outside the scope', { 'SR-05': 'full' }, async () => {
  for (const dir of [INSIDE, DECOY]) await fsPost({ op: 'mkdir', path: dir });
  await fsPost({ op: 'write', path: `${INSIDE}/note.txt`, content: `the ${TERM} is inside`, mime: 'text/plain' });
  await fsPost({ op: 'write', path: `${DECOY}/note.txt`, content: `the ${TERM} is a decoy`, mime: 'text/plain' });

  const all = await until('both documents indexed', async () => {
    const r = await call('GET', `/api/search?q=${TERM}`);
    const hits = r.body.hits as { ref: string }[];
    return hits.length >= 2 ? hits : null;
  });
  assert.ok(all.some((h) => h.ref === `${INSIDE}/note.txt`));
  assert.ok(all.some((h) => h.ref === `${DECOY}/note.txt`));

  const scoped = await call('GET', `/api/search?q=${TERM}&scope=${encodeURIComponent(INSIDE)}`);
  const refs = (scoped.body.hits as { ref: string }[]).map((h) => h.ref);
  assert.deepEqual(refs, [`${INSIDE}/note.txt`], `the scope leaked: ${JSON.stringify(refs)}`);
});

await test('SR-05: the scope breaks on the separator, so a sibling prefix is not captured', { 'SR-05': 'full' }, async () => {
  // /Documents/scope-X is a string prefix of /Documents/scope-X-sibling. A LIKE that
  // forgets the slash would return the decoy, and the confinement would be a lie.
  const scoped = await call('GET', `/api/search?q=${TERM}&scope=${encodeURIComponent(INSIDE)}`);
  const refs = (scoped.body.hits as { ref: string }[]).map((h) => h.ref);
  assert.equal(refs.includes(`${DECOY}/note.txt`), false, 'a sibling folder sharing a name prefix was treated as inside the scope');
  const whole = await call('GET', `/api/search?q=${TERM}&scope=/Documents`);
  assert.equal((whole.body.hits as unknown[]).length >= 2, true, 'the parent scope lost its own children');
});

await test('SR-08: an empty query reports coverage per source instead of guessing', { 'SR-08': 'full' }, async () => {
  const r = await call('GET', '/api/search?q=');
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.hits, [], 'an empty query invented results');
  const coverage = r.body.coverage as { source: string; n: number }[];
  assert.ok(Array.isArray(coverage) && coverage.length >= 1, 'no coverage was reported');
  assert.ok(coverage.every((c) => typeof c.source === 'string' && Number.isInteger(c.n)), JSON.stringify(coverage));
  assert.ok(coverage.some((c) => c.source === 'file' && c.n > 0), 'coverage claims no files are indexed while files are findable');
  assert.ok(typeof r.body.tookMs === 'number', 'the search does not report its own cost');
});

await test('SR-08: explain reports the strategy and the exclusions, not a score', { 'SR-08': 'full' }, async () => {
  const r = await call('GET', `/api/search?q=${TERM}&explain=1`);
  const ex = r.body.explain as { indexedDocs: number; strategy: string; excluded: string; note: string };
  assert.ok(ex, 'explain=1 explained nothing');
  assert.ok(Number.isInteger(ex.indexedDocs) && ex.indexedDocs > 0);
  assert.match(ex.strategy, /tsquery/i, 'the strategy is not named');
  assert.match(ex.excluded, /Private/i, 'the exclusions do not mention the private area');
  const plain = await call('GET', `/api/search?q=${TERM}`);
  assert.equal(plain.body.explain, undefined, 'the diagnostic leaks into every ordinary search');
});

await test('SR-08: the server refuses to claim an index rebuild it did not do', { 'SR-08': 'full' }, async () => {
  const r = await call('POST', '/api/search');
  assert.equal(r.status, 501, `expected an honest refusal, got ${r.status}`);
  assert.equal(r.body.rebuilt, false);
  assert.equal(r.body.ok, false);
});

await test('DP-14: a write, a move and a trash are each observable in the journal', { 'DP-14': 'full' }, async () => {
  const a = `${INSIDE}/journal-${RUN}.txt`, b = `${INSIDE}/journal-${RUN}-moved.txt`;
  await fsPost({ op: 'write', path: a, content: 'observable', mime: 'text/plain' });
  // The route's move takes src/dst. Sending {from,to} makes both undefined, which the
  // server correctly refuses as "identical" — a wrong test, not a missing journal.
  const moved = await fsPost({ op: 'move', src: a, dst: b });
  assert.equal(moved.body.ok, true, `move failed: ${JSON.stringify(moved.body)}`);
  const trashed = await fsPost({ op: 'trash', path: b });
  assert.equal(trashed.body.ok, true, `trash failed: ${JSON.stringify(trashed.body)}`);
  const seen = await until('three journal entries', async () => {
    const r = await call('GET', '/api/jobs?limit=120');
    const ops = (r.body.ops ?? []) as { op: string; path?: string; stage?: string; status?: string }[];
    const mine = ops.filter((o) => JSON.stringify(o).includes(`journal-${RUN}`));
    const kinds = new Set(mine.map((o) => o.op));
    return kinds.has('write') && kinds.has('move') && kinds.has('trash') ? mine : null;
  });
  assert.ok(seen.length >= 3, `only ${seen.length} entries for three operations`);
  const move = seen.find((o) => o.op === 'move') as unknown as { src: string; dst: string } | undefined;
  assert.ok(move && move.src === a && move.dst === b, `a move that does not record both ends is not observable: ${JSON.stringify(move)}`);
  for (const o of seen) assert.ok(typeof o.op === 'string' && o.op.length > 0, `an entry has no operation: ${JSON.stringify(o)}`);
  const write = seen.find((o) => o.op === 'write') as unknown as { steps?: { state: string }[] } | undefined;
  assert.ok((write?.steps ?? []).some((st) => st.state === 'DEST_PUBLISHED'),
    'a write entry carries no stages, so the journal records that something happened but not what');
});

await test('DP-14: a safe save records every stage, not one opaque "done"', { 'DP-14': 'full', 'FM-18': 'partial' }, async () => {
  const token = `tt116dp14${RUN}`;
  const target = `${INSIDE}/staged-${RUN}.txt`;
  const r = await fsPost({ op: 'safeSave', path: target, content: 'staged bytes', mime: 'text/plain', token, bytes: 12 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stages = (r.body.stages ?? []) as string[];
  for (const want of ['PREPARED', 'TEMP_WRITTEN', 'REOPENED', 'VALIDATED', 'REPLACED', 'TEMP_RECLAIMED', 'COMPLETE']) {
    assert.ok(stages.includes(want), `stage ${want} was not recorded; got ${JSON.stringify(stages)}`);
  }
  // The order is the evidence: a reopen that is recorded before the temp write would
  // mean the journal is decorative.
  assert.ok(stages.indexOf('TEMP_WRITTEN') < stages.indexOf('REOPENED'), 'the journal is not in causal order');
  assert.ok(stages.indexOf('VALIDATED') < stages.indexOf('REPLACED'), 'validation is recorded after the replacement it gates');
});

await test('SC-02: a privacy switch set off is enforced by the server, not only the interface', { 'SC-02': 'full', 'RC-36': 'partial' }, async () => {
  const folder = `/Downloads/Recall/lock-${RUN}`;
  await fsPost({ op: 'mkdir', path: folder });
  const bytes = Buffer.from('a captured frame');
  const commit = (name: string) => fsPost({
    op: 'recallCommit', path: `${folder}/${name}`, content: bytes.toString('base64'), mime: 'image/png',
    receipt: JSON.stringify({
      version: 1, path: `${folder}/${name}`, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png',
      method: 'authorized-display-frame', sourceAttribution: 'user-declared-label',
      source: 'https://example.test/p', page: 'https://example.test/p',
      capturedAt: new Date().toISOString(), queryRedacted: true,
    }),
  });

  const before = await call('PUT', '/api/settings', { key: 'privacy.screenCapture', value: 'off' });
  assert.equal(before.status, 200, `the switch is not settable: ${JSON.stringify(before.body)}`);
  try {
    const refused = await commit(`blocked-${RUN}.png`);
    assert.ok(refused.status >= 400, `a capture commit succeeded while capture was switched off: ${JSON.stringify(refused.body)}`);
    assert.match(String(refused.body.error ?? ''), /switched off|capture/i, JSON.stringify(refused.body));
    const listing = await fsGet(`op=list&path=${encodeURIComponent(folder)}`);
    const names = (listing.body.nodes as { name: string }[]).map((n) => n.name);
    assert.equal(names.includes(`blocked-${RUN}.png`), false, 'the refusal still left a file behind');

    // A refusal that also refuses the pathways people rely on would be a bug, not a
    // policy: an ordinary human save of resident bytes is unaffected.
    const ordinary = await fsPost({ op: 'write', path: `${INSIDE}/unaffected-${RUN}.txt`, content: 'still works', mime: 'text/plain' });
    assert.equal(ordinary.status, 200, 'the capture switch disabled unrelated writes');
  } finally {
    const restored = await call('PUT', '/api/settings', { key: 'privacy.screenCapture', value: 'on' });
    assert.equal(restored.status, 200, 'FAILED TO RESTORE the capture switch; later suites in this database are now invalid');
  }
  const allowed = await commit(`allowed-${RUN}.png`);
  assert.equal(allowed.status, 200, `capture is refused even with the switch on: ${JSON.stringify(allowed.body)}`);
});

await test('SC-02: the switch only accepts the values it declares', { 'SC-02': 'full' }, async () => {
  const bad = await call('PUT', '/api/settings', { key: 'privacy.screenCapture', value: 'maybe' });
  assert.equal(bad.status, 422, `an undeclared value was accepted: ${JSON.stringify(bad.body)}`);
  const still = await call('GET', '/api/settings');
  const rows = (still.body.settings ?? still.body.rows ?? []) as Record<string, unknown>;
  const current = Array.isArray(rows)
    ? (rows as { key: string; value: string }[]).find((s) => s.key === 'privacy.screenCapture')?.value
    : (rows as Record<string, string>)['privacy.screenCapture'];
  assert.equal(current, 'on', `the rejected value was written anyway: ${current}`);
});

finish();
