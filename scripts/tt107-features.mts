/**
 * TT107 — first real tests for shipped-but-untested rows: the framing-refusal
 * proxy, reader mode, embeddability probing, trial expiry and the cast registry,
 * plus an integrity check that every declared-blocked row still refuses honestly.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE, dsn = process.env.DATABASE_URL, FX = process.env.TT107_FIXTURE ?? 'http://127.0.0.1:4003';
if (!BASE || !dsn || process.env.TT89_DISPOSABLE_DATABASE !== '1' || !new URL(dsn).pathname.endsWith('_test'))
  throw Error('Exclusive _test target required');
const { test, finish } = makeHarness('tt107-features');
const pool = new pg.Pool({ connectionString: dsn });
const stamp = Date.now();
const jget = async (p: string) => { const r = await fetch(BASE + p); return { status: r.status, data: await r.json() }; };
const jpost = async (p: string, body: unknown) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

/** Start the fixture origin if the operator has not already left one running. */
let fixture: ChildProcess | null = null;
const fixtureUp = async () => { try { return (await fetch(FX + '/open')).ok; } catch { return false; } };
if (!(await fixtureUp())) {
  fixture = spawn(process.execPath, ['scripts/tt107-fixture.mjs', new URL(FX).port], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fixtureUp()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(await fixtureUp(), 'fixture origin did not start on ' + FX);
}

try {
  await fetch(BASE + '/api/settings');

  // ---- WM-17: same-origin proxy for sites that refuse framing -------------
  await test('raw proxy re-serves a framing-refusing page without its refusal headers', { 'WM-17': 'partial' }, async () => {
    const direct = await fetch(FX + '/');
    assert.equal(direct.headers.get('x-frame-options'), 'DENY', 'fixture must actually refuse framing');
    const r = await fetch(BASE + '/api/webproxy?' + new URLSearchParams({ url: FX + '/', mode: 'raw' }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-fusion-proxy-mode'), 'raw');
    assert.equal(r.headers.get('x-fusion-proxy-source'), FX + '/');
    assert.equal(r.headers.get('x-frame-options'), null, 'target refusal header was forwarded to the browser');
    assert.ok(!/frame-ancestors/i.test(r.headers.get('content-security-policy') ?? ''), 'target frame-ancestors was forwarded');
    assert.match(await r.text(), /Readable heading/);
  });

  await test('raw proxy anchors relative subresources with a base href and defuses framebusting', { 'WM-17': 'partial' }, async () => {
    const body = await (await fetch(BASE + '/api/webproxy?' + new URLSearchParams({ url: FX + '/', mode: 'raw' }))).text();
    // Documented mechanism and its documented cost: the document is re-served from
    // our origin, while subresources still resolve to the target through <base href>.
    assert.ok(body.includes(`<base href="${FX}/">`), 'no base href, so relative subresources would break');
    assert.ok(!/top\s*!==\s*self/.test(body), 'top!==self framebusting idiom not neutralised');
  });

  await test('proxy refuses non-HTML content and missing arguments', { 'WM-17': 'partial', 'WM-18': 'partial' }, async () => {
    assert.equal((await fetch(BASE + '/api/webproxy?url=' + encodeURIComponent(FX + '/plain.txt'))).status, 415);
    assert.equal((await fetch(BASE + '/api/webproxy')).status, 400);
    assert.equal((await fetch(BASE + '/api/webproxy?url=' + encodeURIComponent('http://127.0.0.1:4999/'))).status, 502);
  });

  // ---- WM-18: reader mode -------------------------------------------------
  await test('reader mode extracts the article and drops chrome, scripts and styles', { 'WM-18': 'partial' }, async () => {
    const r = await fetch(BASE + '/api/webproxy?' + new URLSearchParams({ url: FX + '/', mode: 'reader' }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-fusion-proxy-mode'), 'reader');
    const html = await r.text();
    assert.match(html, /First paragraph of real article text/);
    assert.match(html, /Fixture &amp; &quot;Article&quot;/, 'title not carried through in escaped form');
    for (const gone of ['Navigation we drop', 'Site header we drop', 'Footer we drop', 'window.tracked', '.ad{display:none}'])
      assert.ok(!html.includes(gone), 'reader kept page chrome or code: ' + gone);
  });

  await test('reader mode neutralises inline handlers and javascript: links', { 'WM-18': 'partial' }, async () => {
    const html = await (await fetch(BASE + '/api/webproxy?' + new URLSearchParams({ url: FX + '/', mode: 'reader' }))).text();
    assert.ok(!/onclick=/i.test(html), 'inline event handler survived');
    assert.ok(!/javascript:/i.test(html), 'javascript: URL survived');
    assert.ok(!/steal\(\)/.test(html), 'script body survived');
    assert.match(html, /Paragraph carrying an inline handler/, 'sanitising dropped the text as well');
  });

  await test('reader mode defeats javascript: scheme evasion instead of deleting a substring', { 'WM-18': 'partial' }, async () => {
    const html = await (await fetch(BASE + '/api/webproxy?' + new URLSearchParams({ url: FX + '/inject', mode: 'reader' }))).text();
    assert.ok(!/javascript:/i.test(html), 'a javascript: URL reached the sanitised document');
    assert.ok(!/data:text\/html/i.test(html), 'a data: URL survived');
    // The payload may appear as inert escaped text ("&lt;img ... onerror=..."); what
    // must not appear is a real tag carrying a handler.
    assert.ok(!/<[a-z][^>]*\son\w+\s*=/i.test(html), 'a live element carries an inline event handler');
    assert.ok(!/<script/i.test(html), 'a script element survived');
    assert.match(html, /Body text\./, 'sanitising destroyed the article');
  });

  await test('reader mode escapes a hostile page title instead of injecting it', { 'WM-18': 'partial' }, async () => {
    const html = await (await fetch(BASE + '/api/webproxy?' + new URLSearchParams({ url: FX + '/inject', mode: 'reader' }))).text();
    assert.ok(!/<img src=x/i.test(html), 'decoded title was injected as live markup');
    assert.match(html, /&lt;img src=x/, 'title not present in escaped form');
  });

  await test('reader mode resolves relative links and images against the source', { 'WM-18': 'partial' }, async () => {
    const html = await (await fetch(BASE + '/api/webproxy?' + new URLSearchParams({ url: FX + '/', mode: 'reader' }))).text();
    assert.ok(html.includes(FX + '/relative/next'), 'relative link not absolutised');
    assert.ok(html.includes(FX + '/pic.png'), 'relative image not absolutised');
  });

  // ---- CM-02: install-any-site decision rests on a real probe -------------
  await test('embed probe reports a framing refusal from X-Frame-Options', { 'CM-02': 'partial' }, async () => {
    const r = await jget('/api/embed-probe?url=' + encodeURIComponent(FX + '/'));
    assert.equal(r.status, 200);
    assert.equal(r.data.verdict, 'deny', JSON.stringify(r.data));
    assert.equal(r.data.headers['x-frame-options'], 'deny');
    assert.notEqual(r.data.host, 'S1-window', 'a refusing site was still offered an iframe window');
  });

  await test('embed probe reports a framing refusal from CSP frame-ancestors', { 'CM-02': 'partial' }, async () => {
    const r = await jget('/api/embed-probe?url=' + encodeURIComponent(FX + '/csp'));
    assert.equal(r.data.verdict, 'csp-restricted', JSON.stringify(r.data));
    assert.match(String(r.data.headers['frame-ancestors'] ?? r.data.reason), /none/i);
    assert.equal(r.data.host, 'S3-handoff', 'a CSP-refusing site was still offered an iframe window');
  });

  await test('embed probe clears a permissive page so it can become a window', { 'CM-02': 'partial' }, async () => {
    const r = await jget('/api/embed-probe?url=' + encodeURIComponent(FX + '/open'));
    assert.equal(r.data.verdict, 'embeddable', JSON.stringify(r.data));
    assert.equal(r.data.host, 'S1-window', 'an embeddable site was not offered a real window');
  });

  await test('embed probe rejects malformed and non-http targets', { 'CM-02': 'partial' }, async () => {
    assert.equal((await jget('/api/embed-probe')).status, 400);
    assert.equal((await jget('/api/embed-probe?url=' + encodeURIComponent('ftp://x.test/'))).status, 400,
      'a non-http scheme was coerced into an https probe');
    assert.equal((await jget('/api/embed-probe?url=' + encodeURIComponent('javascript:alert(1)'))).status, 400);
    assert.equal((await jget('/api/embed-probe?url=' + encodeURIComponent('http://'))).status, 400);
  });

  // ---- BL-03: trial with an honest end state ------------------------------
  await test('a trial grants 14 days and cannot be taken twice', { 'BL-03': 'partial' }, async () => {
    const client = 'tt107-trial-' + stamp;
    const first = await jpost('/api/entitlement', { action: 'trial', clientId: client });
    assert.equal(first.status, 200);
    const days = (new Date(first.data.expiresAt).getTime() - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days <= 14.01, 'trial length was ' + days + ' days');
    assert.equal((await jget('/api/entitlement?clientId=' + client)).data.tier, 'trial');
    const second = await jpost('/api/entitlement', { action: 'trial', clientId: client });
    assert.equal(second.status, 409, 'a second trial was granted on the same client');
  });

  await test('an expired trial degrades to read-only and still shows its history', { 'BL-03': 'partial' }, async () => {
    const client = 'tt107-expired-' + stamp;
    await jpost('/api/entitlement', { action: 'trial', clientId: client });
    await pool.query("UPDATE entitlements SET expires_at = now() - interval '1 day' WHERE client_id = $1", [client]);
    const r = await jget('/api/entitlement?clientId=' + client);
    assert.equal(r.data.tier, 'none', 'expired trial still reported a paid tier');
    assert.equal(r.data.entitlements.length, 1, 'expiry deleted the record instead of degrading');
    assert.equal(r.data.entitlements[0].kind, 'trial');
    assert.ok(!/upgrade now|limited time|act fast/i.test(JSON.stringify(r.data)), 'expiry response carries nagging copy');
  });

  await test('an unknown client is untiered rather than defaulted to paid', { 'BL-03': 'partial' }, async () => {
    const r = await jget('/api/entitlement?clientId=tt107-unknown-' + stamp);
    assert.equal(r.data.tier, 'none');
    assert.deepEqual(r.data.entitlements, []);
    assert.ok(r.data.publicKey, 'offline verification key missing');
  });

  // ---- CA-14 / SC-09: cast trust memory and session registry --------------
  await test('a never-seen cast target arrives untrusted and trust is remembered', { 'CA-14': 'partial' }, async () => {
    const name = 'tt107-tv-' + stamp;
    const first = await jpost('/api/beam', { action: 'seen', name, kind: 'presentation', host: 'fixture' });
    assert.equal(first.data.firstSeen, true);
    assert.equal(first.data.trusted, false, 'an unseen target must not be pre-trusted');
    await jpost('/api/beam', { action: 'trust', name, trusted: true });
    const again = await jpost('/api/beam', { action: 'seen', name, kind: 'presentation', host: 'fixture' });
    assert.equal(again.data.firstSeen, false);
    assert.equal(again.data.trusted, true, 'confirmed trust was not remembered');
    const row = (await pool.query('SELECT trusted FROM cast_targets WHERE name = $1', [name])).rows;
    assert.equal(row.length, 1, 'trust duplicated the target row');
    assert.equal(row[0].trusted, true);
  });

  await test('trust can be withdrawn again for one target only', { 'CA-14': 'partial' }, async () => {
    const keep = 'tt107-keep-' + stamp, drop = 'tt107-drop-' + stamp;
    for (const name of [keep, drop]) {
      await jpost('/api/beam', { action: 'seen', name, kind: 'presentation', host: 'fixture' });
      await jpost('/api/beam', { action: 'trust', name, trusted: true });
    }
    await jpost('/api/beam', { action: 'trust', name: drop, trusted: false });
    const rows = await pool.query('SELECT name, trusted FROM cast_targets WHERE name = ANY($1)', [[keep, drop]]);
    assert.equal(rows.rows.find((r) => r.name === drop)!.trusted, false);
    assert.equal(rows.rows.find((r) => r.name === keep)!.trusted, true, 'withdrawing one target cleared another');
  });

  await test('every cast session is registered and closed in the database', { 'SC-09': 'partial' }, async () => {
    const name = 'tt107-session-' + stamp;
    await jpost('/api/beam', { action: 'seen', name, kind: 'presentation', host: 'fixture' });
    const started = await jpost('/api/beam', { action: 'start', name, transport: 'presentation', source: 'window:test' });
    const id = started.data.sessionId ?? started.data.id;
    assert.ok(id, 'start did not return a session id: ' + JSON.stringify(started.data));
    const open = (await pool.query('SELECT stopped_at, state, target_name FROM beam_sessions WHERE id = $1', [id])).rows;
    assert.equal(open.length, 1, 'no session row was written, so no indicator could be bound to it');
    assert.equal(open[0].stopped_at, null);
    assert.equal(open[0].target_name, name, 'session is not bound to the confirmed target');
    await jpost('/api/beam', { action: 'stop', sessionId: id });
    assert.notEqual((await pool.query('SELECT stopped_at FROM beam_sessions WHERE id = $1', [id])).rows[0].stopped_at, null,
      'stopping a session left it open in the registry');
  });

  await test('a cast session cannot be opened against an unregistered target', { 'SC-09': 'partial', 'CA-14': 'partial' }, async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM beam_sessions')).rows[0].n;
    const highWater = (await pool.query('SELECT coalesce(max(id), 0)::int AS id FROM beam_sessions')).rows[0].id;
    for (const body of [
      { action: 'start', name: 'tt107-never-seen-' + stamp, transport: 'presentation', source: 'w' },
      { action: 'start', transport: 'presentation', source: 'w' },
      { action: 'start', name: '   ', transport: 'presentation', source: 'w' },
    ]) assert.equal((await jpost('/api/beam', body)).status, 400, 'opened a session for ' + JSON.stringify(body));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM beam_sessions')).rows[0].n, before, 'a rejected start still wrote a session row');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM beam_sessions WHERE target_name = 'unknown' AND id > $1", [highWater])).rows[0].n, 0,
      'a session was recorded against no identifiable target');
  });

  // ---- declared-blocked rows must keep refusing, with a stated reason -----
  await test('every capability declared blocked is still refused with a stated reason', {
    'AP-03': 'partial', 'TD-05': 'partial', 'MS-02': 'partial', 'FM-12': 'partial', 'SR-07': 'partial', 'SC-04': 'partial', 'CM-01': 'partial',
  }, async () => {
    const r = await jget('/api/features');
    const rows = r.data.rows as { code: string; status: string; nuance?: string; route?: string }[];
    assert.ok(Array.isArray(rows) && rows.length > 300, 'feature index did not load');
    for (const id of ['AP-03', 'TD-05', 'MS-02', 'FM-12', 'SR-07', 'SC-04', 'CM-01']) {
      const row = rows.find((f) => f.code === id);
      assert.ok(row, 'missing declared row ' + id);
      assert.equal(row.status, 'blocked', id + ' silently changed away from a blocked declaration');
      assert.ok((row.nuance ?? '').trim().length > 10, id + ' is blocked without a stated reason');
      assert.ok(!/^https?:/.test(row.route ?? ''), id + ' advertises a route for a blocked capability');
    }
  });
} finally {
  await pool.end();
  fixture?.kill('SIGTERM');
}
finish();
