/**
 * TT110 — server-side rows that shipped without a test, plus the new capture policy.
 *
 * Every assertion here talks to the running production build over HTTP. Where a claim is
 * cryptographic (BL-02) it is checked with Node's own crypto against the public key the server
 * publishes, so the proof does not come from the same code that produced the signature.
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const RUN = Math.random().toString(36).slice(2, 8);
const { test, finish } = makeHarness('tt110-core');

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON answer */ }
  return { status: r.status, json, text };
};
const fs = (body: unknown) => call('POST', '/api/fs', body);
const get = <T = Record<string, unknown>,>(path: string) => call('GET', path).then((r) => r.json as T);
const pngBytes = (seed: string) => {
  // A tiny but real PNG: signature, IHDR, one IDAT of a single grey pixel, IEND.
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); head.copy(out, 4); out.writeUInt32BE(crc(head), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  const tone = createHash('sha256').update(seed).digest()[0];
  const idat = Buffer.from([0x78, 0x01, 0x01, 0x02, 0x00, 0xFD, 0xFF, 0x00, tone, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
};
const setPolicy = (value: string) => call('PUT', '/api/settings', { key: 'privacy.screenCapture', value });

/* ------------------------------------------------------------------ RC-36: the capture policy */

await test('the capture policy is enforced where the writing happens, not only where the buttons are',
  { 'RC-36': 'full', 'SC-02': 'partial' }, async () => {
    const folder = `/Downloads/Recall/tt110.policy.${RUN}`;
    for (const p of ['/Downloads', '/Downloads/Recall', folder]) await fs({ op: 'mkdir', path: p });
    const bytes = pngBytes(`policy-${RUN}`);
    const send = (method: string) => {
      const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      const receipt = JSON.stringify({
        version: 1, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        mime: 'image/png', method, sourceAttribution: 'user-declared-label',
        source: 'https://example.com/surface', page: 'https://example.com/surface',
        capturedAt: new Date().toISOString(), queryRedacted: true,
      });
      return fs({ op: 'recallCommit', path, content: bytes.toString('base64'), mime: 'image/png', receipt });
    };

    // With the policy on, every capture method is accepted as before.
    assert.equal((await setPolicy('on')).status, 200);
    for (const m of ['authorized-display-frame', 'authorized-display-recording', 'fusion-element-frame'])
      assert.equal((await send(m)).status, 200, `${m} should be allowed while the policy is on`);

    // Switch it off: the refusal comes from the server, so a client that still has the old UI,
    // or no UI at all, cannot write a capture.
    assert.equal((await setPolicy('off')).status, 200);
    for (const m of ['authorized-display-frame', 'authorized-display-recording', 'fusion-element-frame']) {
      const r = await send(m);
      // A configured refusal is not an uncertain publication: it answers 403 and says why, so the
      // caller is never told to go and look for a pair that was never written.
      assert.equal(r.status, 403, `${m} was accepted while capture was switched off (${r.text.slice(0, 120)})`);
      assert.match(String(r.json.error ?? ''), /switched off/i, `the refusal must name the switch: ${r.text.slice(0, 160)}`);
      assert.doesNotMatch(String(r.json.error ?? ''), /not acknowledged|Inspect the saved pair/i,
        'a deterministic refusal must not be reported as an uncertain write');
    }
    // Pathways that save something the page already had are untouched by a capture policy.
    assert.equal((await send('chosen-resident-file')).status, 200,
      'the capture switch must not disable saving a file the human chose');
    assert.equal((await send('human-paste-file')).status, 200);

    // And the refusal wrote nothing at all — not a media file, not an orphan receipt.
    const listing = await get<{ nodes?: { name: string }[] }>(`/api/fs?op=list&path=${encodeURIComponent(folder)}`);
    const names = (listing.nodes ?? []).map((n) => n.name);
    assert.equal(names.filter((n) => !n.endsWith('.recall.json')).length, 5,
      `expected exactly the five accepted memories, found ${names.length} entries`);
    assert.equal((await setPolicy('on')).status, 200);
  }).finally(() => setPolicy('on'));

await test('an unknown capture policy value cannot be smuggled into the setting',
  { 'RC-36': 'full' }, async () => {
    const bad = await setPolicy('sometimes');
    assert.equal(bad.status, 422, `a nonsense policy value was accepted: ${bad.text.slice(0, 120)}`);
    const now = await get<{ rows?: { key: string; value: string }[] }>('/api/settings');
    const row = (now.rows ?? []).find((r) => r.key === 'privacy.screenCapture');
    assert.ok(row, 'the capture policy must exist as a real setting');
    assert.equal(row!.value, 'on', 'the rejected value must not have been stored');
  });

/* ------------------------------------------------------------------ BL-02 / BL-05: licensing */

await test('a licence verifies offline against the published key, and the grace period is stated',
  { 'BL-02': 'partial' }, async () => {
    const clientId = `tt110-${RUN}`;
    const before = await get<{ publicKey: string; tier: string; gracePeriodDays: number }>(`/api/entitlement?clientId=${clientId}`);
    assert.match(before.publicKey, /BEGIN PUBLIC KEY/, 'the authority must publish its public key for offline checks');
    assert.equal(before.tier, 'none');
    assert.equal(before.gracePeriodDays, 14);

    const issued = await call('POST', '/api/entitlement', { action: 'issue', clientId, kind: 'pro' });
    const key = String((issued.json as { licenseKey?: string }).licenseKey ?? '');
    assert.ok(key.includes('.'), 'the authority returned no licence key');

    // Verify the signature here, with Node's crypto and the published PEM — not by asking the
    // server whether its own signature is good.
    const [payload, signature] = key.split('.');
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { clientId: string; kind: string; issuer: string };
    const ok = edVerify(null, Buffer.from(payload, 'base64url'), createPublicKey(before.publicKey), Buffer.from(signature, 'base64url'));
    assert.equal(ok, true, 'the licence signature does not verify against the published public key');
    assert.equal(claim.clientId, clientId);
    assert.equal(claim.kind, 'pro');

    // A tampered claim must fail the same check, or "verification" means nothing.
    const forged = { ...claim, kind: 'propack' };
    const forgedPayload = Buffer.from(JSON.stringify(forged)).toString('base64url');
    assert.equal(edVerify(null, Buffer.from(forgedPayload, 'base64url'), createPublicKey(before.publicKey), Buffer.from(signature, 'base64url')), false,
      'an edited claim still verified — the signature is not binding');
    const serverForged = await call('POST', '/api/entitlement', { action: 'activate', clientId, key: `${forgedPayload}.${signature}` });
    assert.equal(serverForged.status, 400, 'the server activated a forged licence');

    const activated = await call('POST', '/api/entitlement', { action: 'activate', clientId, key });
    assert.equal(activated.status, 200);
    const after = await get<{ tier: string }>(`/api/entitlement?clientId=${clientId}`);
    assert.equal(after.tier, 'pro', 'the activated licence did not raise the tier');
  });

await test('there is no remote wipe and no kill switch anywhere in the server',
  { 'BL-05': 'full' }, async () => {
    // 1. Structural: no route in the tree implements a remote erase or a remote disable.
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === 'route.ts') routes.push(full);
      }
    };
    walk('src/app/api');
    assert.ok(routes.length > 20, `expected the full route tree, found ${routes.length}`);
    const forbidden = /\b(remoteWipe|killSwitch|kill_switch|remote_wipe|deactivateAllDevices|revokeAllData)\b/;
    const offenders = routes.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, [], `remote-control machinery found in: ${offenders.join(', ')}`);

    // 2. Behavioural: losing the entitlement must not cost the user their files.
    const clientId = `tt110-wipe-${RUN}`;
    const path = `/Documents/tt110-${RUN}.txt`;
    await fs({ op: 'write', path, content: `kept through revocation ${RUN}`, mime: 'text/plain' });
    const issued = await call('POST', '/api/entitlement', { action: 'issue', clientId, kind: 'pro' });
    await call('POST', '/api/entitlement', { action: 'activate', clientId, key: String((issued.json as { licenseKey?: string }).licenseKey) });
    const del = await call('DELETE', `/api/entitlement?clientId=${clientId}`);
    assert.ok([200, 204, 400, 404, 405].includes(del.status), `unexpected revocation answer ${del.status}`);
    const still = await get<{ node?: { path: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
    assert.ok(still.node, 'a file disappeared when the entitlement was taken away');
  });

/* ------------------------------------------------------------------ DP-14: observable jobs */

await test('every file operation leaves an observable journal entry with its final state',
  { 'DP-14': 'partial' }, async () => {
    const src = `/Documents/tt110-job-${RUN}.txt`;
    const dst = `/Documents/tt110-job-copy-${RUN}.txt`;
    await fs({ op: 'write', path: src, content: `job ${RUN}`, mime: 'text/plain' });
    const copied = await fs({ op: 'copy', src, dst });
    assert.equal(copied.status, 200, `copy failed: ${copied.text.slice(0, 160)}`);
    const jobs = await get<{ ops?: { op: string; src: string; dst: string; state: string; bytes: number }[] }>('/api/jobs?limit=60');
    const ops = jobs.ops ?? [];
    assert.ok(ops.length > 0, 'the job journal is empty after doing work');
    const mine = ops.filter((o) => o.src === src || o.dst === dst || o.src === dst);
    assert.ok(mine.length >= 2, `expected the write and the copy to be journalled, saw ${mine.length}`);
    for (const o of mine) {
      assert.match(o.state, /^(COMPLETE|FAILED|PENDING|RUNNING)$/, `unexpected journal state ${o.state}`);
      assert.equal(o.state, 'COMPLETE', `a finished operation is still recorded as ${o.state}`);
    }
    console.log(`    journal: ${mine.map((o) => `${o.op}:${o.state}`).join(', ')}`);
  });

/* ------------------------------------------------------------------ AU-01: routines */

await test('a routine can be rehearsed without doing anything, and both rehearsal and run are audited',
  { 'AU-01': 'partial' }, async () => {
    const created = await call('POST', '/api/routines', {
      name: `tt110 ${RUN}`, trigger: 'manual', actions: [{ cmd: 'open', arg: 'files' }, { cmd: 'theme', arg: 'dark' }],
    });
    assert.equal(created.status, 200, `routine creation failed: ${created.text.slice(0, 200)}`);
    const id = (created.json as { row?: { id: number; actions: unknown } }).row?.id;
    assert.ok(id, 'no routine id came back');

    const dry = await call('POST', '/api/routines', { ranId: id, dry: true });
    assert.equal(dry.status, 200);
    const real = await call('POST', '/api/routines', { ranId: id, dry: false });
    assert.equal(real.status, 200);

    const jobs = await get<{ log?: { actor: string; action: string; detail: string }[] }>('/api/jobs?limit=80');
    const mine = (jobs.log ?? []).filter((l) => l.actor === 'routine' && l.detail === String(id));
    const actions = mine.map((l) => l.action);
    assert.ok(actions.includes('routine.dryrun'), `the rehearsal was not audited: ${actions.join(',')}`);
    assert.ok(actions.includes('routine.run'), `the run was not audited: ${actions.join(',')}`);

    // An action the engine does not implement must be refused at creation, not discovered at run time.
    const bogus = await call('POST', '/api/routines', {
      name: `tt110 bogus ${RUN}`, trigger: 'manual', actions: [{ cmd: 'rm-rf', arg: '/' }],
    });
    assert.equal(bogus.status, 400, 'an unknown routine command was accepted');
    console.log(`    routine ${id}: audited ${actions.join(' + ')}; unknown command refused`);
  });

/* ------------------------------------------------------------------ SR-05 / SR-08: search */

await test('search can be confined to one folder, and says what it searched when it finds nothing',
  { 'SR-05': 'partial', 'SR-08': 'partial' }, async () => {
    const token = `tt110tok${RUN}`;
    const inside = `/Documents/tt110-scope-${RUN}/inside.txt`;
    const outside = `/Documents/tt110-other-${RUN}/outside.txt`;
    for (const d of [`/Documents/tt110-scope-${RUN}`, `/Documents/tt110-other-${RUN}`]) await fs({ op: 'mkdir', path: d });
    await fs({ op: 'write', path: inside, content: `${token} inside the scope`, mime: 'text/plain' });
    await fs({ op: 'write', path: outside, content: `${token} outside the scope`, mime: 'text/plain' });

    const all = await get<{ hits?: { ref: string }[] }>(`/api/search?q=${token}`);
    const refs = (all.hits ?? []).map((h) => h.ref);
    assert.ok(refs.includes(inside) && refs.includes(outside), `unscoped search missed a file: ${refs.join(', ')}`);

    const scoped = await get<{ hits?: { ref: string }[] }>(`/api/search?q=${token}&scope=${encodeURIComponent(`/Documents/tt110-scope-${RUN}`)}`);
    const scopedRefs = (scoped.hits ?? []).map((h) => h.ref);
    assert.deepEqual(scopedRefs, [inside], `the folder scope leaked: ${scopedRefs.join(', ')}`);

    // SR-08: the coverage read is a diagnostic, and an empty result explains itself.
    const coverage = await get<{ coverage?: { source: string; n: number }[] }>('/api/search?q=');
    const sources = (coverage.coverage ?? []).map((c) => c.source);
    assert.ok(sources.includes('file') && sources.includes('spec'), `coverage is missing sources: ${sources.join(',')}`);
    const miss = await get<{ hits?: unknown[]; explain?: { indexedDocs?: number; strategy?: string; excluded?: string } }>(
      `/api/search?q=zzz-${RUN}-no-such-token&explain=1`);
    assert.equal((miss.hits ?? []).length, 0);
    assert.ok(miss.explain, 'a search that finds nothing must be able to say why');
    assert.ok((miss.explain!.indexedDocs ?? 0) > 0, 'the diagnostic reports an empty index');
    assert.match(String(miss.explain!.strategy), /tsquery|substring/i);
    assert.match(String(miss.explain!.excluded), /Private|trashed/i);
    console.log(`    scope held (1 hit of 2); index ${miss.explain!.indexedDocs} docs via ${miss.explain!.strategy}`);
  });

finish();
