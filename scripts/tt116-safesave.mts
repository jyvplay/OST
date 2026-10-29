/**
 * TT116 — FM-18: the safe-save contract, proved rather than described.
 *
 * Until this turn FM-18's own specs row said the quiet part out loud: "There is no
 * /api/fs safeSave operation, temp-output/reopen validation, or ... non-overwriting
 * Save a Copy." The row was `partial` because the capability did not exist. This
 * suite exists to make the row either `built` or still honest.
 *
 * The contract under test, stage by stage:
 *   write the bytes somewhere else → reopen that object from storage → validate what
 *   STORAGE returned → atomically replace the target from the validated bytes →
 *   reclaim the temporary output. And on every failing path: the original is exactly
 *   as it was, and no temporary output is left behind.
 *
 * What makes these tests worth anything is the negative half. It is easy to write a
 * "safe save" that is a rename of `write`; such an implementation passes test 1 and
 * fails tests 3, 4, 5, 6 and 11, which each demand that a REFUSED save changed
 * nothing — same id, same version, same bytes.
 *
 * Every request is real HTTP to the running Next server against real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL?.endsWith('_test'))
  throw Error('Exclusive _test database required');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const { test, finish } = makeHarness('tt116-safesave');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DIR = `/Documents/tt116-${RUN}`;

const post = async (body: unknown) => {
  const r = await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const get = async (q: string) => {
  const r = await fetch(BASE + '/api/fs?' + q);
  return (await r.json()) as Record<string, unknown>;
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomUUID().replace(/-/g, '');

interface Node { id: number; version: number; sha256: string; size: number; content?: string }
/** Read a file's identity the way a caller would before offering a conditional save. */
const stat = async (path: string): Promise<Node | null> => {
  const j = await get(`op=stat&path=${encodeURIComponent(path)}`);
  const n = j.node as Node | null;
  return n && typeof n.id === 'number' ? n : null;
};
const read = async (path: string): Promise<string> => {
  const j = await get(`op=read&path=${encodeURIComponent(path)}`);
  return ((j.node as { content?: string } | undefined)?.content) ?? '';
};
/** Every temporary output still on disk. The contract says: none, between saves. */
const temps = async (): Promise<string[]> => {
  const j = await get(`op=list&path=${encodeURIComponent('/.safe-save')}`);
  const rows = (j.nodes ?? []) as { path: string; trashed?: boolean; kind: string }[];
  return rows.filter((r) => !r.trashed && r.kind === 'file').map((r) => r.path);
};

await post({ op: 'mkdir', path: DIR });
// Start from a clean temporary-output folder: these tests assert that none is left
// behind, which only means something if none was there to begin with.
await post({ op: 'safeSaveSweep', olderThanMs: 0 });

await test('a safe save of a new file publishes it and leaves no temporary output', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/new.txt`;
  const content = `created by tt116 ${RUN}`;
  const r = await post({ op: 'safeSave', path, content, declaredSha256: sha(content) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replaced, true, 'a new file should report that the target was published');
  assert.equal(r.body.sha256, sha(content));
  assert.equal(await read(path), content, 'the published bytes are not the bytes that were saved');
  // The five stages are the contract; a renamed `write` cannot produce this list.
  assert.deepEqual(r.body.stages, ['PREPARED', 'TEMP_WRITTEN', 'REOPENED', 'VALIDATED', 'REPLACED', 'TEMP_RECLAIMED', 'COMPLETE']);
  assert.deepEqual(await temps(), [], 'a completed save left its temporary output behind');
});

await test('replacing an existing file advances it by one version and keeps the previous one', { 'FM-18': 'full', 'PR-01': 'partial' }, async () => {
  const path = `${DIR}/replaced.txt`;
  await post({ op: 'safeSave', path, content: 'first' });
  const before = await stat(path);
  assert.ok(before, 'the first save did not produce a file');
  const r = await post({ op: 'safeSave', path, content: 'second', expected: { id: before.id, version: before.version, sha256: before.sha256 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.version, before.version + 1, 'a replacement must advance the version exactly once');
  assert.equal(await read(path), 'second');
  const versions = await get(`op=versions&path=${encodeURIComponent(path)}`);
  const list = (versions.versions ?? []) as { content: string }[];
  assert.ok(list.some((v) => v.content === 'first'), 'the replaced bytes were not snapshotted as a previous version');
  assert.deepEqual(await temps(), []);
});

await test('a save whose bytes do not match the digest the caller declared is refused, and the original is untouched', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/guarded.txt`;
  await post({ op: 'safeSave', path, content: 'original bytes' });
  const before = await stat(path);
  const r = await post({ op: 'safeSave', path, content: 'different bytes', declaredSha256: sha('a lie about the bytes') });
  assert.equal(r.status, 422, `expected 422 Unprocessable, got ${r.status}: ${JSON.stringify(r.body)}`);
  const after = await stat(path);
  assert.equal(after!.version, before!.version, 'a refused save advanced the version');
  assert.equal(after!.sha256, before!.sha256, 'a refused save changed the stored bytes');
  assert.equal(await read(path), 'original bytes');
  assert.deepEqual(await temps(), [], 'a refused save left its temporary output behind');
});

await test('a malformed payload is refused and the file it was aimed at is untouched', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/config.json`;
  await post({ op: 'safeSave', path, content: '{"ok":true}', validate: 'json' });
  const before = await stat(path);
  const r = await post({ op: 'safeSave', path, content: '{"ok":true', validate: 'json' });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(String(r.body.error), /well-formed JSON/);
  assert.equal(await read(path), '{"ok":true}', 'a file was replaced with unparseable JSON');
  assert.equal((await stat(path))!.version, before!.version);
  assert.deepEqual(await temps(), []);
});

await test('text that cannot survive a byte round-trip is refused', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/surrogate.txt`;
  await post({ op: 'safeSave', path, content: 'intact' });
  // A lone high surrogate is a legal JavaScript string and an illegal UTF-8 sequence.
  const r = await post({ op: 'safeSave', path, content: `broken \ud800 here` });
  assert.equal(r.status, 422, `a lone surrogate should not reach storage: ${JSON.stringify(r.body)}`);
  assert.equal(await read(path), 'intact');
  assert.deepEqual(await temps(), []);
});

await test('a target that moved under the caller is refused rather than overwritten', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/raced.txt`;
  await post({ op: 'safeSave', path, content: 'v1' });
  const stale = await stat(path);
  await post({ op: 'safeSave', path, content: 'v2 written by someone else', expected: { id: stale!.id, version: stale!.version, sha256: stale!.sha256 } });
  const r = await post({ op: 'safeSave', path, content: 'v2 from the stale editor', expected: { id: stale!.id, version: stale!.version, sha256: stale!.sha256 } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(String(r.body.error), /version|bytes changed/);
  assert.equal(await read(path), 'v2 written by someone else', 'the stale save overwrote a newer file');
  assert.deepEqual(await temps(), []);
});

await test('when replacement is unavailable the bytes are published beside the original, never over it', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/busy.txt`;
  await post({ op: 'safeSave', path, content: 'the newer file' });
  const current = await stat(path);
  // A well-formed guard that simply does not describe the file that is there now:
  // the shape is valid, the digest is from an older edit. This is what an editor
  // holding an open document sees after someone else saves over it.
  const stale = { id: current!.id, version: current!.version, sha256: sha('something older') };
  const r = await post({ op: 'safeSave', path, content: 'rescued work', expected: stale, onConflict: 'copy' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replaced, false, 'a Save a Copy must not claim it replaced the target');
  assert.equal(r.body.savedCopyTo, `${DIR}/busy (copy).txt`);
  assert.equal(await read(`${DIR}/busy (copy).txt`), 'rescued work');
  assert.equal(await read(path), 'the newer file', 'Save a Copy touched the original');
  // A second rescue must not overwrite the first rescue either.
  const r2 = await post({ op: 'safeSave', path, content: 'rescued twice', expected: stale, onConflict: 'copy' });
  assert.equal(r2.body.savedCopyTo, `${DIR}/busy (copy 2).txt`);
  assert.equal(await read(`${DIR}/busy (copy).txt`), 'rescued work');
  assert.deepEqual(await temps(), []);
});

await test('a save whose acknowledgement was lost is answered, not performed again', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/tokened.txt`;
  const tok = token();
  const first = await post({ op: 'safeSave', path, content: 'exactly once', token: tok });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  const retry = await post({ op: 'safeSave', path, content: 'exactly once', token: tok });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true, 'the retry was performed again instead of replayed');
  assert.equal(retry.body.version, first.body.version, 'the retry advanced the version a second time');
  assert.equal((await stat(path))!.version, first.body.version);
  assert.deepEqual(await temps(), []);
});

await test('a save token cannot be reused to publish different bytes', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/tokenguard.txt`;
  const tok = token();
  await post({ op: 'safeSave', path, content: 'the bytes this token names', token: tok });
  const before = await stat(path);
  const r = await post({ op: 'safeSave', path, content: 'completely different bytes', token: tok });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal((await stat(path))!.version, before!.version);
  assert.equal(await read(path), 'the bytes this token names');
});

await test('eight concurrent saves of one token publish one version', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/concurrent.txt`;
  const tok = token();
  const content = 'one body, eight arrivals';
  const results = await Promise.all(Array.from({ length: 8 }, () => post({ op: 'safeSave', path, content, token: tok })));
  const ok = results.filter((r) => r.status === 200);
  const performed = ok.filter((r) => r.body.replayed === false);
  // Exactly one attempt may perform the save. Losers either replay it or are told the
  // first attempt is still in flight; neither may write.
  assert.equal(performed.length, 1, `${performed.length} of 8 concurrent attempts performed a write`);
  assert.equal((await stat(path))!.version, 1, 'the file was written more than once');
  assert.equal(await read(path), content);
  assert.deepEqual(await temps(), []);
});

await test('a save larger than the store limit is refused before anything is written', { 'FM-18': 'full' }, async () => {
  const path = `${DIR}/huge.txt`;
  const r = await post({ op: 'safeSave', path, content: 'x'.repeat(8 * 1024 * 1024 + 1) });
  assert.equal(r.status, 400, JSON.stringify(r.body).slice(0, 200));
  assert.equal(await stat(path), null, 'an oversize save created a file');
  assert.deepEqual(await temps(), []);
});

await test('a temporary output abandoned by a dead process is reclaimable and age-bounded', { 'FM-18': 'full', 'DP-14': 'partial' }, async () => {
  // Simulate the crash the stage boundary exists for: a temporary output that no
  // save is going to finish. It is written through the ordinary write path, which is
  // exactly what an interrupted safe save leaves behind.
  const orphan = `/.safe-save/${RUN}-orphan.part`;
  await post({ op: 'write', path: orphan, content: 'abandoned between stages' });
  assert.ok((await temps()).includes(orphan), 'the orphan was not created');
  // An age bound is what stops a sweep from deleting a save that is still running.
  const young = await post({ op: 'safeSaveSweep', olderThanMs: 600_000 });
  assert.equal(young.status, 200);
  assert.deepEqual(young.body.reclaimed, [], 'the sweep reclaimed a temporary output younger than its own bound');
  assert.ok((await temps()).includes(orphan));
  const swept = await post({ op: 'safeSaveSweep', olderThanMs: 0 });
  assert.ok((swept.body.reclaimed as string[]).includes(orphan), 'the sweep did not reclaim an abandoned temporary output');
  assert.ok(!(await temps()).includes(orphan));
});

await test('every safe save is visible in the job journal with the stages it really went through', { 'DP-14': 'full', 'FM-18': 'full' }, async () => {
  const path = `${DIR}/journalled.txt`;
  const r = await post({ op: 'safeSave', path, content: 'journal me' });
  assert.equal(r.status, 200);
  const jobs = (await (await fetch(BASE + '/api/jobs')).json()) as { ok: boolean; ops: { id: number; op: string; state: string; src: string; steps: { state: string }[] }[] };
  assert.equal(jobs.ok, true);
  const mine = jobs.ops.find((o) => o.id === r.body.opId);
  assert.ok(mine, 'the safe save did not appear in the journal at all');
  assert.equal(mine.op, 'safeSave');
  assert.equal(mine.state, 'COMPLETE');
  assert.equal(mine.src, path);
  assert.deepEqual(mine.steps.map((s) => s.state), ['PREPARED', 'TEMP_WRITTEN', 'REOPENED', 'VALIDATED', 'REPLACED', 'TEMP_RECLAIMED', 'COMPLETE']);
  // And a refused one is recorded as FAILED rather than quietly forgotten.
  const bad = await post({ op: 'safeSave', path: `${DIR}/journalled-bad.json`, content: 'not json at all', validate: 'json' });
  assert.equal(bad.status, 422);
  const jobs2 = (await (await fetch(BASE + '/api/jobs')).json()) as { ops: { op: string; state: string; src: string; error: string }[] };
  const failed = jobs2.ops.find((o) => o.src === `${DIR}/journalled-bad.json`);
  assert.ok(failed, 'a refused safe save left no journal entry');
  assert.equal(failed.state, 'FAILED');
  assert.match(failed.error, /JSON/);
});

await test('a safe-saved text file becomes searchable, and a refused one does not', { 'FM-18': 'full', 'SR-05': 'partial' }, async () => {
  const needle = `tt116needle${RUN}`;
  await post({ op: 'safeSave', path: `${DIR}/searchable.txt`, content: `the token is ${needle}` });
  const hit = (await (await fetch(`${BASE}/api/search?q=${needle}`)).json()) as { ok: boolean; hits: { ref: string }[] };
  assert.equal(hit.ok, true);
  assert.ok(hit.hits.some((h) => h.ref === `${DIR}/searchable.txt`), 'a safe-saved file is not searchable');
  const ghost = `tt116ghost${RUN}`;
  await post({ op: 'safeSave', path: `${DIR}/ghost.json`, content: `{"not json ${ghost}`, validate: 'json' });
  const miss = (await (await fetch(`${BASE}/api/search?q=${ghost}`)).json()) as { hits: { ref: string }[] };
  assert.equal(miss.hits.length, 0, 'a refused save still reached the search index');
});

await test('the temporary output folder cannot be used as a target', { 'FM-18': 'full', 'SC-02': 'partial' }, async () => {
  const r = await post({ op: 'safeSave', path: '/.safe-save/sneaky.part', content: 'x' });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /temporary output folder/);
});

finish();
