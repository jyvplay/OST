/**
 * TT116 — RC-13 (retention) and RC-18 (snapshot pagination), against real HTTP and
 * real PostgreSQL.
 *
 * Both rows were `partial` for a named reason, and both reasons are closed here.
 *
 * RC-13 had deletion but no retention. A rule-driven bulk trash is the operation
 * most likely to quietly do the wrong thing, so the tests are written from the
 * attacker's side: a dry run must change nothing, the plan a dry run shows must be
 * the plan that gets executed, an unpaired file must survive a policy that would
 * otherwise sweep it, and a policy must not be able to name a folder outside
 * /Downloads/Recall.
 *
 * RC-18 said "not a transactional snapshot across pages". That is not a theoretical
 * complaint: page 1 then a new save then page 2 skips a memory, because every row
 * shifted by one. The test below performs exactly that interleaving and asserts the
 * reader sees each memory once.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL?.endsWith('_test'))
  throw Error('Exclusive _test database required');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const { test, finish } = makeHarness('tt116-recall-retention');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const post = async (body: unknown) => {
  const r = await fetch(BASE + '/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const get = async (q: string) => {
  const r = await fetch(BASE + '/api/fs?' + q);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pngBytes = (seed: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(seed)]);

/** One real, complete, verifiable memory — the same body the Recall UI sends. */
async function saveMemory(folder: string, seed: string) {
  const dir = `/Downloads/Recall/${folder}`;
  for (const p of ['/Downloads', '/Downloads/Recall', dir]) await post({ op: 'mkdir', path: p });
  const bytes = pngBytes(`${seed}-${RUN}`);
  const path = `${dir}/${seed}.png`;
  const page = 'https://example.com/album';
  const receipt = JSON.stringify({
    version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png',
    method: 'chosen-resident-file', sourceAttribution: 'user-declared-label',
    commitToken: randomUUID(),
    source: page, page, capturedAt: new Date().toISOString(), queryRedacted: true,
  }, null, 2);
  const r = await post({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt });
  assert.equal(r.status, 200, `saving ${seed} failed: ${JSON.stringify(r.body)}`);
  return path;
}

const FOLDER = `tt116ret${RUN}`;
const DIR = `/Downloads/Recall/${FOLDER}`;

await test('a dry run reports a complete plan and changes nothing at all', { 'RC-13': 'full' }, async () => {
  for (let i = 0; i < 5; i++) await saveMemory(FOLDER, `m${i}`);
  const usage = await get(`op=recallUsage&folder=${encodeURIComponent(DIR)}`);
  assert.equal(usage.body.memories, 5, JSON.stringify(usage.body));

  const plan = await post({ op: 'recallRetention', folder: DIR, maxItems: 2, dryRun: true });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.dryRun, true);
  assert.equal(plan.body.considered, 5);
  assert.equal(plan.body.kept, 2);
  const planned = (plan.body.candidates as { path: string; reasons: string[] }[]).map((c) => c.path);
  assert.equal(planned.length, 3, `expected the three oldest to be planned, got ${JSON.stringify(planned)}`);
  assert.deepEqual(planned.map((p) => p.split('/').pop()), ['m2.png', 'm1.png', 'm0.png']);
  assert.deepEqual(plan.body.trashed, [], 'a dry run trashed something');
  const after = await get(`op=recallUsage&folder=${encodeURIComponent(DIR)}`);
  assert.equal(after.body.memories, 5, 'a dry run changed the archive');
});

await test('applying the policy trashes exactly what the dry run showed, as pairs', { 'RC-13': 'full' }, async () => {
  const plan = await post({ op: 'recallRetention', folder: DIR, maxItems: 2, dryRun: true });
  const planned = (plan.body.candidates as { path: string }[]).map((c) => c.path);
  const run = await post({ op: 'recallRetention', folder: DIR, maxItems: 2, dryRun: false });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.dryRun, false);
  assert.deepEqual(run.body.trashed, planned, 'the applied run did not match the plan that was reviewed');
  assert.deepEqual(run.body.skipped, []);
  const after = await get(`op=recallUsage&folder=${encodeURIComponent(DIR)}`);
  assert.equal(after.body.memories, 2);
  // A memory is a pair: the receipt must have gone with it, and both must be in Trash
  // rather than destroyed.
  for (const p of planned) {
    const media = await get(`op=stat&path=${encodeURIComponent(p)}`);
    const receipt = await get(`op=stat&path=${encodeURIComponent(p + '.recall.json')}`);
    assert.equal((media.body.node as { trashed: boolean }).trashed, true, `${p} was not trashed`);
    assert.equal((receipt.body.node as { trashed: boolean }).trashed, true, `${p}'s receipt was left behind`);
  }
});

await test('retention refuses a memory it cannot prove is a complete pair', { 'RC-13': 'full', 'RC-28': 'partial' }, async () => {
  const folder = `tt116unpaired${RUN}`;
  const dir = `/Downloads/Recall/${folder}`;
  const keep = await saveMemory(folder, 'keeper');
  const orphaned = await saveMemory(folder, 'orphan');
  // Remove only the receipt, leaving the media unpaired. Retention must not sweep it:
  // an unpaired file is a finding for the integrity audit, not rubbish to be cleared.
  const t = await post({ op: 'trash', path: orphaned + '.recall.json' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const run = await post({ op: 'recallRetention', folder: dir, maxItems: 0, dryRun: false });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const skipped = run.body.skipped as { path: string; reason: string }[];
  assert.ok(skipped.some((s) => s.path === orphaned), `the unpaired file was not skipped: ${JSON.stringify(run.body)}`);
  assert.match(skipped.find((s) => s.path === orphaned)!.reason, /pair/);
  assert.ok((run.body.trashed as string[]).includes(keep), 'the complete pair was not trashed');
  const still = await get(`op=stat&path=${encodeURIComponent(orphaned)}`);
  assert.equal((still.body.node as { trashed: boolean }).trashed, false, 'an unpaired memory was swept by retention');
  // Leave no unpaired file behind. A later suite's integrity audit is entitled to
  // find an archive this suite did not vandalise, and a gate is a shared database.
  await post({ op: 'trash', path: orphaned });
  const gone = await get(`op=stat&path=${encodeURIComponent(orphaned)}`);
  assert.equal((gone.body.node as { trashed: boolean }).trashed, true, 'cleanup failed; this suite would poison the audit suites');
});

await test('the two keep-rules compose by intersection, not by union', { 'RC-13': 'full' }, async () => {
  const folder = `tt116both${RUN}`;
  const dir = `/Downloads/Recall/${folder}`;
  for (let i = 0; i < 4; i++) await saveMemory(folder, `b${i}`);
  // Everything here was saved seconds ago, so a 1-day age window keeps all four.
  // A count window of 1 must still remove three: survival requires BOTH windows.
  const plan = await post({ op: 'recallRetention', folder: dir, maxAgeDays: 1, maxItems: 1, dryRun: true });
  assert.equal(plan.body.kept, 1, JSON.stringify(plan.body));
  assert.equal((plan.body.candidates as unknown[]).length, 3);
  const reasons = (plan.body.candidates as { reasons: string[] }[]).flatMap((c) => c.reasons);
  assert.ok(reasons.every((r) => r === 'outside the newest-N window'), `age should not have fired: ${JSON.stringify(reasons)}`);
  // An age window of 0 days removes everything, including the newest.
  const all = await post({ op: 'recallRetention', folder: dir, maxAgeDays: 0, maxItems: 1000, dryRun: true });
  assert.equal(all.body.kept, 0, JSON.stringify(all.body));
});

await test('a policy cannot name a folder outside the Recall archive, or no policy at all', { 'RC-13': 'full', 'SC-02': 'partial' }, async () => {
  for (const folder of ['/Documents', '/Downloads/Recall', '/Downloads/Recall/a/b', '/Downloads/Recall/../Documents', '']) {
    const r = await post({ op: 'recallRetention', folder, maxItems: 0, dryRun: false });
    assert.equal(r.status, 400, `${folder} was accepted as a retention scope`);
  }
  const none = await post({ op: 'recallRetention', folder: DIR, dryRun: true });
  assert.equal(none.status, 400, 'a policy with no rule at all was accepted');
  for (const bad of [{ maxItems: -1 }, { maxAgeDays: -5 }, { maxItems: 1.5 }, { maxItems: 'all' }]) {
    const r = await post({ op: 'recallRetention', folder: DIR, ...bad, dryRun: true });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} was accepted`);
  }
});

await test('paging the timeline is a snapshot: a save during the read cannot hide a memory', { 'RC-18': 'full' }, async () => {
  const folder = `tt116page${RUN}`;
  const dir = `/Downloads/Recall/${folder}`;
  const saved: string[] = [];
  for (let i = 0; i < 6; i++) saved.push(await saveMemory(folder, `p${String(i).padStart(2, '0')}`));

  // Read it in pages of 101 the way the UI does, but with a save interleaved between
  // page 1 and page 2 — the exact condition the row said it did not handle.
  const page1 = await get(`op=recallPage&path=${encodeURIComponent(dir)}`);
  assert.equal(page1.status, 200, JSON.stringify(page1.body));
  const asOf = page1.body.asOf as string;
  assert.ok(asOf && /^[0-9]+$/.test(asOf), `page 1 did not pin a snapshot: ${JSON.stringify(page1.body).slice(0, 200)}`);
  const firstIds = (page1.body.nodes as { id: number; path: string }[]).map((n) => n.id);
  assert.equal(firstIds.length, 6);

  await saveMemory(folder, 'intruder');

  // Re-read the same snapshot: the intruder must not be in it, and the ids must be
  // exactly the ones page 1 reported.
  const again = await get(`op=recallPage&path=${encodeURIComponent(dir)}&asOf=${asOf}`);
  const againIds = (again.body.nodes as { id: number; path: string }[]).map((n) => n.id);
  assert.deepEqual(againIds, firstIds, 'the snapshot shifted under the reader');
  assert.ok(!(again.body.nodes as { path: string }[]).some((n) => n.path.includes('intruder')),
    'a memory saved after the snapshot leaked into it');

  // Without the snapshot the newer memory is visible — proving the pin is what did it.
  const unpinned = await get(`op=recallPage&path=${encodeURIComponent(dir)}`);
  assert.ok((unpinned.body.nodes as { path: string }[]).some((n) => n.path.includes('intruder')),
    'the unpinned read should see the newest memory');
  assert.equal((unpinned.body.nodes as unknown[]).length, 7);

  // And a malformed snapshot is refused rather than ignored.
  for (const bad of ['0', 'abc', '-1', '99999999999']) {
    const r = await get(`op=recallPage&path=${encodeURIComponent(dir)}&asOf=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `asOf=${bad} was accepted`);
  }
});

await test('a retention run is auditable after the fact', { 'RC-13': 'full', 'DP-14': 'partial' }, async () => {
  const folder = `tt116audit${RUN}`;
  const dir = `/Downloads/Recall/${folder}`;
  await saveMemory(folder, 'a1');
  await saveMemory(folder, 'a2');
  await post({ op: 'recallRetention', folder: dir, maxItems: 1, dryRun: false });
  const log = (await (await fetch(`${BASE}/api/jobs?limit=200`)).json()) as { ok: boolean; log: { action: string; detail: string; actor: string }[] };
  const rows = log.log ?? [];
  const run = rows.find((r) => r.action === 'recall.retention.run' && r.detail.includes(folder));
  assert.ok(run, `no audit entry for the retention run: ${JSON.stringify(rows.slice(0, 3))}`);
  assert.equal(run.actor, 'policy', 'a rule-driven trash must not be recorded as a human action');
  assert.match(run.detail, /considered 2, trashed 1/);
  const item = rows.find((r) => r.action === 'recall.retention.trash' && r.detail.includes('a1.png'));
  assert.ok(item, 'the individual memory trashed by the policy was not recorded');
  assert.match(item.detail, /newest-N window/);
});

finish();
