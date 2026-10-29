/**
 * TT114 — RC-39: exactly-once Recall publication under a lost acknowledgement.
 *
 * The limit this closes has stood since TT106 and was stated in every turn report since: a Recall
 * commit writes a media/receipt pair atomically, but if the HTTP RESPONSE is lost the client learns
 * nothing. Retrying might file the memory twice; not retrying might lose it; the honest advice was
 * "inspect Files before retrying" — a human step in the middle of a save.
 *
 * RC-39 makes the retry decidable. The client mints a UUID before it sends, puts it in the receipt,
 * and the server claims that token in the SAME transaction that writes the pair. A retry carrying
 * the same token is answered from the token row with the path the first attempt published.
 *
 * What is actually proved here, against the real Next server and the real PostgreSQL:
 *   1. a token-carrying publication still writes a normal pair;
 *   2. the lost acknowledgement itself — the client aborts mid-flight, then retries — leaves exactly
 *      one memory, and the retry names it;
 *   3. eight genuinely concurrent attempts with one token produce exactly one memory;
 *   4. a token cannot be replayed to claim different bytes (409, nothing written);
 *   5. a replay after the memory was trashed says so rather than silently resurrecting it;
 *   6. publications without a token behave exactly as before.
 *
 * No mocks. Every request below is real HTTP to the running server.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL?.endsWith('_test'))
  throw Error('Exclusive _test database required');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const { test, finish } = makeHarness('tt114-recall-token');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const post = (body: unknown, init: RequestInit = {}) =>
  fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pngBytes = (seed: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(seed)]);

interface Ack { ok?: boolean; path?: string; stored?: boolean; replayed?: boolean; present?: boolean; digest?: string; firstSavedAt?: string; error?: string }

/** Build one complete, valid commit body. The SAME body is what a retry re-sends, byte for byte. */
function commitBody(opts: { folder: string; bytes: Buffer; token: string | null; path?: string }) {
  const { folder, bytes } = opts;
  const path = opts.path ?? `${folder}/${Date.now()}-${randomUUID()}.png`;
  const page = 'https://example.com/album';
  const receipt = JSON.stringify({
    version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png',
    method: 'chosen-resident-file', sourceAttribution: 'user-declared-label',
    ...(opts.token ? { commitToken: opts.token } : {}),
    source: page, page, capturedAt: new Date().toISOString(), queryRedacted: true,
  }, null, 2);
  return { op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt };
}

async function mkdirs(folder: string) {
  for (const p of ['/Downloads', '/Downloads/Recall', folder]) await post({ op: 'mkdir', path: p });
}
const send = async (body: unknown, init?: RequestInit): Promise<{ status: number; body: Ack }> => {
  const r = await post(body, init);
  return { status: r.status, body: await r.json() as Ack };
};
/** Media files only; the receipt sits beside each one and would double every count. */
const mediaIn = async (folder: string): Promise<string[]> => {
  const r = await fetch(`${BASE}/api/fs?${new URLSearchParams({ op: 'list', path: folder })}`);
  const j = await r.json() as { nodes?: { path: string }[] };
  return (j.nodes ?? []).map((n) => n.path).filter((p) => !p.endsWith('.recall.json'));
};

/* ------------------------------------------------------- 1. the ordinary path still works */

await test('a publication carrying a token writes one pair and reports the digest it filed', { 'RC-39': 'full', 'RC-01': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt114.plain.${RUN}`;
  await mkdirs(folder);
  const bytes = pngBytes(`plain-${RUN}`);
  const first = await send(commitBody({ folder, bytes, token: randomUUID() }));
  assert.equal(first.status, 200, first.body.error);
  assert.equal(first.body.stored, true, 'a first publication must store');
  assert.equal(first.body.replayed, undefined, 'a first publication is not a replay');
  assert.equal(first.body.digest, sha(bytes), 'the server reports the decoded-byte digest');
  const media = await mediaIn(folder);
  assert.equal(media.length, 1, `exactly one memory, found ${media.length}`);
  const receipt = await (await fetch(`${BASE}/api/fs?${new URLSearchParams({ op: 'read', path: media[0] + '.recall.json' })}`)).json() as { node?: { content: string } };
  assert.ok(receipt.node?.content.includes('commitToken'), 'the receipt records the token that published it');
  console.log(`    published ${media[0].split('/').pop()} with a token in its receipt`);
});

/* ------------------------------------------------------- 2. the lost acknowledgement itself */

await test('the client aborts mid-flight and retries: exactly one memory exists and the retry names it', { 'RC-39': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt114.lost.${RUN}`;
  await mkdirs(folder);
  const bytes = pngBytes(`lost-${RUN}`);
  const token = randomUUID();
  const body = commitBody({ folder, bytes, token });

  // A real lost acknowledgement: the request leaves, the server does its work, and the client
  // tears the socket down before reading the answer. Whether the commit landed is genuinely
  // unknown to the client at this point — that is the whole difficulty being removed.
  const ac = new AbortController();
  // Note the trailing catch: .then(onOk, onErr) does NOT catch a rejection thrown by onOk, and an
  // abort that lands after the headers but before the body makes r.json() reject inside it.
  const inFlight = post(body, { signal: ac.signal })
    .then(async (r) => ({ reached: true as const, status: r.status, body: await r.json() as Ack }),
      () => ({ reached: false as const, status: 0, body: {} as Ack }))
    .catch(() => ({ reached: false as const, status: 0, body: {} as Ack }));
  setTimeout(() => ac.abort(), 12);
  const outcome = await inFlight;
  console.log(`    first attempt ${outcome.reached ? `completed (${outcome.status})` : 'was aborted before the answer arrived'}`);

  // The client cannot tell, so it retries with the same token — which is now safe.
  const retry = await send(body);
  assert.equal(retry.status, 200, retry.body.error);
  const media = await mediaIn(folder);
  assert.equal(media.length, 1, `a lost acknowledgement plus a retry must leave exactly one memory, found ${media.length}`);
  assert.equal(retry.body.path, media[0], 'the retry must name the memory that actually exists');

  // If the first attempt did land, the retry is a replay and must say so rather than claim a write.
  if (retry.body.replayed) {
    assert.equal(retry.body.stored, false, 'a replay stores nothing');
    assert.equal(retry.body.present, true, 'the replay reports the pair is still there');
    console.log('    the retry was answered from the token: stored=false, replayed=true');
  } else {
    assert.equal(retry.body.stored, true, 'if the first attempt never committed, the retry publishes normally');
    console.log('    the first attempt never committed; the retry published it');
  }
});

/* ------------------------------------------------------- 3. genuine concurrency on one token */

await test('eight concurrent attempts with one token publish exactly one memory', { 'RC-39': 'full', 'RC-11': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt114.race.${RUN}`;
  await mkdirs(folder);
  const bytes = pngBytes(`race-${RUN}`);
  const token = randomUUID();
  // Distinct paths on purpose: if the token were ignored, each attempt would happily create its
  // own memory and the folder would hold eight. One shared path would be caught by the existing
  // create-only conflict instead, which would prove nothing about the token.
  const bodies = Array.from({ length: 8 }, () => commitBody({ folder, bytes, token }));
  const results = await Promise.all(bodies.map((b) => send(b)));

  const ok = results.filter((r) => r.status === 200);
  assert.equal(ok.length, 8, `every attempt must get a determinate answer, got statuses ${results.map((r) => r.status).join(',')}`);
  const wrote = ok.filter((r) => r.body.stored === true);
  const replays = ok.filter((r) => r.body.replayed === true);
  assert.equal(wrote.length, 1, `exactly one attempt may write, ${wrote.length} did`);
  assert.equal(replays.length, 7, `the other seven must be answered from the token, ${replays.length} were`);
  const media = await mediaIn(folder);
  assert.equal(media.length, 1, `the folder must hold exactly one memory, it holds ${media.length}`);
  for (const r of ok) assert.equal(r.body.path, media[0], 'every answer names the one memory that exists');
  console.log(`    8 concurrent attempts → 1 write, 7 replays, 1 memory on disk`);
});

/* ------------------------------------------------------- 4. a token is not a capability */

await test('a token cannot be replayed to claim different bytes', { 'RC-39': 'full', 'RC-14': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt114.bind.${RUN}`;
  await mkdirs(folder);
  const token = randomUUID();
  const first = await send(commitBody({ folder, bytes: pngBytes(`bind-a-${RUN}`), token }));
  assert.equal(first.status, 200, first.body.error);

  const second = await send(commitBody({ folder, bytes: pngBytes(`bind-b-DIFFERENT-${RUN}`), token }));
  assert.equal(second.status, 409, `different bytes under one token must be refused, got ${second.status}`);
  assert.match(String(second.body.error), /already published different bytes/i);
  const media = await mediaIn(folder);
  assert.equal(media.length, 1, `the refusal must write nothing, folder holds ${media.length}`);
  console.log('    second bytes refused with 409; nothing written');
});

/* ------------------------------------------------------- 5. honest about a deleted memory */

await test('a replay after the memory was trashed reports its absence instead of resurrecting it', { 'RC-39': 'full', 'RC-13': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt114.gone.${RUN}`;
  await mkdirs(folder);
  const bytes = pngBytes(`gone-${RUN}`);
  const token = randomUUID();
  const body = commitBody({ folder, bytes, token });
  const first = await send(body);
  assert.equal(first.status, 200, first.body.error);
  const path = String(first.body.path);

  const seen = await (await post({ op: 'recallPair', path, action: 'inspect' })).json() as { ok?: boolean; guard?: unknown };
  assert.ok(seen.ok, 'the pair must be inspectable before it is trashed');
  const trashed = await (await post({ op: 'recallPair', path, action: 'trash', expected: seen.guard })).json() as { ok?: boolean; error?: string };
  assert.ok(trashed.ok, `trashing the pair must succeed: ${trashed.error}`);

  const replay = await send(body);
  assert.equal(replay.status, 200, replay.body.error);
  assert.equal(replay.body.replayed, true, 'the token still answers after the memory is gone');
  assert.equal(replay.body.present, false, 'and it says plainly that the pair is no longer there');
  assert.equal(replay.body.stored, false, 'a replay never writes, not even to restore');
  const media = await mediaIn(folder);
  assert.equal(media.length, 0, 'the trashed memory is not silently re-created');
  console.log('    replay after trash: replayed=true, present=false, nothing re-created');
});

/* ------------------------------------------------------- 6. nothing old was broken */

await test('publications without a token keep their previous behaviour exactly', { 'RC-39': 'full', 'RC-01': 'partial' }, async () => {
  const folder = `/Downloads/Recall/tt114.legacy.${RUN}`;
  await mkdirs(folder);
  const bytes = pngBytes(`legacy-${RUN}`);
  const a = await send(commitBody({ folder, bytes, token: null }));
  const b = await send(commitBody({ folder, bytes, token: null }));
  assert.equal(a.status, 200, a.body.error);
  assert.equal(b.status, 200, b.body.error);
  assert.equal(a.body.stored, true);
  assert.equal(b.body.stored, true, 'without a token a deliberate re-save still stores a second memory');
  assert.equal(a.body.replayed, undefined);
  assert.equal(b.body.replayed, undefined);
  const media = await mediaIn(folder);
  assert.equal(media.length, 2, `two untokened saves are two memories, found ${media.length}`);
  console.log('    untokened saves unchanged: 2 deliberate saves → 2 memories');
});

/* ------------------------------------------------------- 7. the token's own shape is checked */

await test('a malformed token is refused before anything is written', { 'RC-39': 'full' }, async () => {
  const folder = `/Downloads/Recall/tt114.shape.${RUN}`;
  await mkdirs(folder);
  for (const bad of ['not-a-uuid', 'A0000000-0000-4000-8000-000000000000', '', '../../etc/passwd']) {
    const bytes = pngBytes(`shape-${bad}-${RUN}`);
    const body = commitBody({ folder, bytes, token: null });
    const receipt = JSON.parse(body.receipt) as Record<string, unknown>;
    receipt.commitToken = bad;
    const r = await send({ ...body, receipt: JSON.stringify(receipt, null, 2) });
    assert.equal(r.status, 400, `token ${JSON.stringify(bad)} must be refused, got ${r.status}`);
  }
  const media = await mediaIn(folder);
  assert.equal(media.length, 0, `no malformed token may write, folder holds ${media.length}`);
  console.log('    4 malformed tokens refused (uppercase, empty, non-UUID, path-shaped); nothing written');
});


/* ------------------------------------------------------------------ the Specs mirror */

/**
 * Requirement standing since TT103: every Recall requirement is mirrored into the Specs app, and
 * no row is graded above its evidence. This asserts both halves against the live API — the new
 * row exists and says what was actually proven, and no Recall row anywhere claims "built" without
 * naming a test file that exists on disk.
 */
await test('Specs mirrors RC-39 and no Recall row is graded above its evidence',
  { 'RC-39': 'partial' }, async () => {
  const r = await fetch(BASE + '/api/features');
  const j = await r.json() as { rows: { code: string; status: string; test: string; nuance: string }[] };
  const rc39 = j.rows.find((x) => x.code === 'RC-39');
  assert.ok(rc39, 'RC-39 is mirrored into Specs');
  assert.equal(rc39!.status, 'built');
  assert.ok(rc39!.test.includes('tt114-recall-token'), `RC-39 names its suite, got "${rc39!.test}"`);
  for (const phrase of ['ON CONFLICT DO NOTHING', 'replayed:true', '409', 'not a distributed transaction']) {
    assert.ok(rc39!.nuance.includes(phrase), `RC-39 states "${phrase}" rather than implying more`);
  }

  const recall = j.rows.filter((x) => /^RC-\d+/.test(x.code));
  const builtWithoutTest = recall.filter((x) => x.status === 'built' && !x.test).map((x) => x.code);
  assert.deepEqual(builtWithoutTest, [], `every built Recall row names a test; bare: ${builtWithoutTest.join(', ')}`);

  const { existsSync } = await import('node:fs');
  const missing: string[] = [];
  for (const row of recall) {
    for (const file of row.test.match(/[\w.-]+\.mts/g) ?? []) {
      if (!existsSync(new URL(`./${file}`, import.meta.url))) missing.push(`${row.code} -> ${file}`);
    }
  }
  assert.deepEqual(missing, [], `every named Recall test file exists: ${missing.join(', ')}`);
  console.log(`    ${recall.length} Recall rows mirrored; all built rows name a suite, all named suites exist on disk`);
});

await finish();
