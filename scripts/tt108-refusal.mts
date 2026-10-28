/**
 * TT108 — adversarial tests aimed at the middleware-refusal repair.
 *
 * The defect: src/proxy.ts answers a refusal by REWRITING to /api/refused (TT37 moved refusals off the
 * middleware's own response path to stop an unhandled ECONNRESET). But the matcher "/api/:path*" also
 * matched /api/refused, so the rewritten request was judged a second time — still carrying the cross-site
 * Origin, or the malformed body, that caused the refusal — and was rewritten again. A development build
 * absorbed the loop; a production build proxies every hop over HTTP, so the client waited thirty seconds
 * and then received 500. Every CSRF refusal and every malformed-JSON refusal was affected. The same
 * behaviour was reproduced on the TT107 build, so this is an old defect that only a production-mode gate
 * could see; the functional suites passed because 500-after-30s still "refuses".
 *
 * The repair is one early return for /api/refused. These tests attack it from both sides: the refusal must
 * still happen (no bypass through the exempt path) and it must happen quickly (no loop), on every
 * body-taking route rather than the one or two a hand-written list would name.
 *
 * Exclusive real HTTP against a real production server and a real PostgreSQL database. Nothing is mocked.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE)
  throw new Error('Exclusive disposable server/database and BASE required');
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('tt108-refusal');

/** A refusal must be fast. The defect produced exactly 30s; a generous bound still separates the two by 10x. */
const FAST_MS = 3000;

async function timed(path: string, init: RequestInit) {
  const t0 = performance.now();
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  return { status: r.status, text, ms: performance.now() - t0 };
}
const json = (body: string, extra: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body,
});
const noteCount = async () => ((await (await fetch(BASE + '/api/notes')).json()).rows ?? []).length;

/** Every static API route that defines a body-taking handler, discovered from the tree rather than listed. */
function bodyRoutes(dir = 'src/app/api', url = '/api'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry.startsWith('[') || entry.startsWith('(')) continue; // dynamic segments need a real id
      out.push(...bodyRoutes(p, `${url}/${entry}`));
    } else if (entry === 'route.ts') {
      const src = readFileSync(p, 'utf8');
      if (/export\s+(async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(src)) out.push(url);
    }
  }
  return out;
}
// /api/wp/s/* forwards proxied bodies unparsed and /api/privacy/thumbnail-cache bounds its own stream: both are
// deliberately exempt from the JSON pre-check (see src/proxy.ts), so neither can be expected to refuse here.
const ROUTES = bodyRoutes().filter((u) => !u.startsWith('/api/wp/s') && u !== '/api/privacy/thumbnail-cache' && u !== '/api/refused');

await test('every body-taking API route refuses a malformed JSON body quickly, not after a thirty-second loop',
  { 'AU-03': 'partial' }, async () => {
    assert.ok(ROUTES.length >= 20, `expected the route scan to find the API surface, found ${ROUTES.length}`);
    const slow: string[] = [], wrong: string[] = [];
    for (const u of ROUTES) {
      const r = await timed(u, json('{oops'));
      if (r.ms >= FAST_MS) slow.push(`${u} ${Math.round(r.ms)}ms`);
      if (r.status !== 400) wrong.push(`${u} → ${r.status}`);
    }
    assert.deepEqual(slow, [], `refusals must not hang: ${slow.join(', ')}`);
    assert.deepEqual(wrong, [], `malformed JSON must be 400: ${wrong.join(', ')}`);
  });

await test('a cross-site request is refused quickly on every body-taking route and writes nothing',
  { 'WP-06': 'full' }, async () => {
    const before = await noteCount();
    const slow: string[] = [], wrong: string[] = [];
    for (const u of ROUTES) {
      const r = await timed(u, json('{"title":"csrf-attempt","body":"x"}', { origin: 'https://evil.example' }));
      if (r.ms >= FAST_MS) slow.push(`${u} ${Math.round(r.ms)}ms`);
      if (r.status !== 403) wrong.push(`${u} → ${r.status}`);
    }
    assert.deepEqual(slow, [], `CSRF refusals must not hang: ${slow.join(', ')}`);
    assert.deepEqual(wrong, [], `cross-site writes must be 403: ${wrong.join(', ')}`);
    assert.equal(await noteCount(), before, 'a refused cross-site request must not create a record');
  });

await test('the refusal body still names the reason and the refusal is not cached',
  { 'WP-06': 'full' }, async () => {
    const mal = await timed('/api/notes', json('{oops'));
    assert.equal(mal.status, 400); assert.equal(JSON.parse(mal.text).error, 'malformed JSON body');
    const csrf = await timed('/api/notes', json('{"title":"x"}', { origin: 'https://evil.example' }));
    assert.equal(csrf.status, 403); assert.match(JSON.parse(csrf.text).error, /^refused: /);
    const r = await fetch(BASE + '/api/notes', json('{oops'));
    assert.match(r.headers.get('cache-control') ?? '', /no-store/, 'a refusal must not be stored by any cache');
  });

await test('the exempt refusal endpoint cannot be turned into a bypass or a 200',
  { 'WP-06': 'full' }, async () => {
    const before = await noteCount();
    // Exempting /api/refused from the matcher means an attacker may call it directly. It must stay an error-only
    // endpoint: no method, header or origin can make it succeed or reach another handler.
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await timed('/api/refused', { method, headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: method === 'GET' ? undefined : '{"title":"bypass"}' });
      assert.ok(r.status === 403 || r.status === 400, `${method} /api/refused → ${r.status}`);
      assert.ok(r.ms < FAST_MS, `${method} /api/refused took ${Math.round(r.ms)}ms`);
    }
    // A forged status header must not promote the response; the route only ever answers 400 or 403.
    for (const forged of ['200', '204', '301', 'abc', '400']) {
      const r = await timed('/api/refused', json('{"a":1}', { 'x-fusion-refused-status': forged }));
      assert.equal(r.status, forged === '400' ? 400 : 403, `forged status ${forged} → ${r.status}`);
    }
    // A forged message is decoded defensively and bounded, and a broken percent-escape must not throw.
    const long = await timed('/api/refused', json('{"a":1}', { 'x-fusion-refused-error': 'A'.repeat(2000) }));
    assert.ok(JSON.parse(long.text).error.length <= 300, 'the refusal message must stay bounded');
    const broken = await timed('/api/refused', json('{"a":1}', { 'x-fusion-refused-error': '%E0%A4%A' }));
    assert.equal(JSON.parse(broken.text).error, 'refused');
    assert.equal(await noteCount(), before, 'the refusal endpoint must never write');
  });

await test('a refusal cannot be made to loop: malformed body and foreign origin together stay fast',
  { 'WP-06': 'full' }, async () => {
    // The original defect: the refusal target was re-judged and re-rewritten. Feed it both refusal triggers at once,
    // and feed them to a path that looks like the refusal target, to try to re-enter the rewrite.
    // Each spelling normalises differently; the exemption must hold for all of them, not just the canonical one.
    for (const path of ['/api/refused', '/api/refused/', '/api/refused//', '/api/notes', '/api/notes/', '/api/notes//',
                        '/api/refused/../notes', '/api/refused/extra', '/API/REFUSED', '/api/notes?x=1']) {
      const r = await timed(path, json('{oops', { origin: 'https://evil.example' }));
      assert.ok(r.ms < FAST_MS, `${path} took ${Math.round(r.ms)}ms — the refusal loop is back`);
      assert.ok(r.status >= 400 && r.status < 500, `${path} → ${r.status}`);
    }
  });

await test('a client that resets mid-refusal does not take the server down (TT37 property, refusal path)',
  { 'WP-06': 'partial' }, async () => {
    const u = new URL(BASE);
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => {
        const s = net.connect(Number(u.port || 80), u.hostname, () => {
          s.write('POST /api/notes HTTP/1.1\r\nHost: ' + u.host + '\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n{oops');
          setTimeout(() => { s.resetAndDestroy(); resolve(); }, 15);
        });
        s.on('error', () => resolve());
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    const alive = await timed('/api/notes', json('{oops'));
    assert.equal(alive.status, 400, 'the server must still answer refusals after six resets');
    const ok = await (await fetch(BASE + '/api/settings')).json();
    assert.equal(ok.ok, true, 'the server must still answer ordinary requests after six resets');
  });

await test('valid same-origin writes are untouched by the exemption', { 'WP-06': 'full' }, async () => {
  const before = await noteCount();
  const r = await timed('/api/notes', json(JSON.stringify({ title: `tt108-refusal-${Date.now()}`, body: 'ok' })));
  assert.equal(r.status, 200);
  assert.equal(await noteCount(), before + 1, 'a legitimate write must still succeed');
});

finish();
