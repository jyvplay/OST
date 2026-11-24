import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeHarness } from './harness.mts';
const base = process.env.BASE;
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !base || process.env.TT222_LOOPBACK_FIXTURE !== '1') throw new Error('exclusive disposable server configured with test-only loopback port 4043 required');
const {test,finish} = makeHarness('tt222-embed-csp');
const cases: Record<string, string | undefined> = {
  '/wildcard': "frame-ancestors https://*.trusted.example",
  '/any': 'frame-ancestors *',
  '/multi': "frame-ancestors *, frame-ancestors 'none'",
  '/empty': 'frame-ancestors',
  '/unrelated': "not-frame-ancestors 'none'; default-src 'self'",
  '/duplicate-allow': "frame-ancestors *; frame-ancestors 'none'",
  '/duplicate-deny': "frame-ancestors 'none'; frame-ancestors *",
  '/mixed': "FRAME-ANCESTORS https://*.trusted.example; default-src *",

};
const server = createServer((req,res) => { const policy=cases[req.url ?? '']; if (policy) res.setHeader('content-security-policy', policy); res.end('<!doctype html><title>real test origin</title>'); });
await new Promise<void>((resolve,reject)=>server.listen(4043,'127.0.0.1',resolve).once('error',reject));
try {
  for(const [path, verdict] of [['/wildcard','csp-restricted'], ['/any','embeddable'], ['/multi','csp-restricted'], ['/empty','csp-restricted'], ['/unrelated','embeddable'], ['/duplicate-allow','embeddable'], ['/duplicate-deny','csp-restricted'], ['/mixed','csp-restricted']] as const) {
    await test(`${path}: real origin policy`,{},async()=>{
      const target = `http://127.0.0.1:4043${path}`;
      const direct = await fetch(target); assert.equal(direct.headers.get('content-security-policy'), cases[path]);
      const r = await fetch(`${base}/api/embed-probe?url=${encodeURIComponent(target)}`); assert.equal(r.status,200); const data=await r.json();
      assert.equal(data.status,200,JSON.stringify(data)); assert.equal(data.verdict,verdict,JSON.stringify(data));
    });
  }
} finally { await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve())); finish(); }
