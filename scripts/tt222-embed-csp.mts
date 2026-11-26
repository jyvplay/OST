import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeHarness } from './harness.mts';
import { launchChromium } from './browser-launch.mts';
import { expect } from 'playwright/test';
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
  '/override-allow': 'frame-ancestors *',
  '/override-deny': "frame-ancestors 'none'",
  '/xfo-only': undefined,
  '/report-only': undefined,
  '/other-first': "default-src 'self', frame-ancestors *",
  '/wrong-name': "not-frame-ancestors *",
  '/empty-xfo': 'frame-ancestors',

};
const xfo: Record<string,string> = {'/override-allow':'DENY','/override-deny':'SAMEORIGIN','/xfo-only':'DENY','/report-only':'DENY','/other-first':'DENY','/wrong-name':'DENY','/empty-xfo':'DENY'};
const server = createServer((req,res) => {
  const path = req.url ?? '';
  const policy=cases[path]; if (policy) res.setHeader('content-security-policy', policy);
  if (xfo[path]) res.setHeader('x-frame-options',xfo[path]);
  if (path === '/report-only') res.setHeader('content-security-policy-report-only','frame-ancestors *');
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end('<!doctype html><title>real test origin</title><main id="marker">actual fixture content</main>');
});
await new Promise<void>((resolve,reject)=>server.listen(4043,'127.0.0.1',resolve).once('error',reject));
try {
  for(const [path, verdict] of [['/wildcard','csp-restricted'], ['/any','embeddable'], ['/multi','csp-restricted'], ['/empty','csp-restricted'], ['/unrelated','embeddable'], ['/duplicate-allow','embeddable'], ['/duplicate-deny','csp-restricted'], ['/mixed','csp-restricted'], ['/override-allow','embeddable'], ['/override-deny','csp-restricted'], ['/xfo-only','deny'], ['/report-only','deny'], ['/other-first','embeddable'], ['/wrong-name','deny'], ['/empty-xfo','csp-restricted']] as const) {
    await test(`${path}: real origin policy`,{},async()=>{
      const target = `http://127.0.0.1:4043${path}`;
      const direct = await fetch(target); assert.equal(direct.headers.get('content-security-policy'), cases[path] ?? null);
      const r = await fetch(`${base}/api/embed-probe?url=${encodeURIComponent(target)}`); assert.equal(r.status,200); const data=await r.json();
      assert.equal(data.status,200,JSON.stringify(data)); assert.equal(data.verdict,verdict,JSON.stringify(data));
    });
  }
  await test('Chromium enforces the observed CSP over conflicting XFO',{},async()=>{
    const browser = await launchChromium(), ctx = await browser.newContext(), page = await ctx.newPage();
    try {
      await page.goto('http://localhost:4043/parent');
      const child=page.locator('iframe');
      await page.evaluate(() => { const f=document.createElement('iframe'); f.id='policy-child'; document.body.appendChild(f); });
      await child.evaluate((f: HTMLIFrameElement) => { f.src='http://127.0.0.1:4043/override-allow'; });
      await expect(page.frameLocator('#policy-child').locator('#marker')).toHaveText('actual fixture content', {timeout:5000});
      let blocked = false;
      page.on('console', msg => { if (/frame-ancestors.*none|violates.*Content Security Policy/i.test(msg.text())) blocked=true; });
      await child.evaluate((f: HTMLIFrameElement) => { f.src='http://127.0.0.1:4043/override-deny'; });
      await expect.poll(() => blocked, {timeout:5000}).toBe(true);
    } finally { await ctx.close(); await browser.close(); }
  });
} finally { await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve())); finish(); }
