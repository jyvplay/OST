import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';
if (process.env.TT222_LOOPBACK_FIXTURE !== '1' || !process.env.BASE) throw Error('isolated loopback test server required');
let slowHits=0; let slowOldRestricted=false; let releaseSlow: (()=>void)|undefined;
let slowSeen: (()=>void)|undefined;
const site=createServer((req,res)=>{
 if(req.url==='/slow' && ++slowHits===1){
  slowSeen?.(); releaseSlow=()=>{if(!res.writableEnded){res.setHeader('content-type','text/html');if(slowOldRestricted)res.setHeader('content-security-policy',"frame-ancestors 'none'");res.end('<!doctype html><main>Slow initial probe</main>');}};
  return;
 }
 res.setHeader('content-type','text/html');
 if(req.url==='/restricted')res.setHeader('content-security-policy',"frame-ancestors 'none'");
 if(req.url==='/chosen')res.setHeader('content-security-policy',`frame-ancestors ${new URL(process.env.BASE!).origin}`);
 res.end(`<!doctype html><title>${req.url}</title><main>Real fixture ${req.url}</main><a href="/restricted">Restricted destination</a>`);
});
await new Promise<void>((resolve,reject)=>site.listen(4043,'127.0.0.1',resolve).once('error',reject));
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt228-proxy-verdict');
try{
 await test('proxy navigation invalidates old direct-frame verdict',{},async()=>{
  await fx.windows('browser');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'browser');const win=page.locator('[data-win-id="w1"]');const initial='http://127.0.0.1:4043/open', next='http://127.0.0.1:4043/restricted';
   await win.getByLabel('Address',{exact:true}).fill(initial);await win.getByLabel('Address',{exact:true}).press('Enter');
   await expect(win.frameLocator('iframe').getByText('Real fixture /open')).toBeVisible();
   await win.getByTestId('br-proxy-all').click();
   await win.frameLocator('[data-testid="wp-frame"]').getByText('Restricted destination').click();
   await expect(win.getByLabel('Address',{exact:true})).toHaveValue(next);
   let direct=0;page.on('request',r=>{if(r.url()===next)direct++;});
   await win.getByTestId('br-proxy-all').click();
   await expect.poll(async()=>direct || await win.getByText('Embedding policy needs review',{exact:true}).count(),{timeout:12000}).toBeGreaterThan(0);
   assert.equal(direct,0,'old embeddable verdict must not cause a direct request for the new URL');
   await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible();
  }finally{await ctx.close();}
 });
 await test('direct choice does not transfer to a new proxied destination',{},async()=>{
  await fx.windows('browser');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'browser');const win=page.locator('[data-win-id="w1"]');const initial='http://127.0.0.1:4043/chosen', next='http://127.0.0.1:4043/restricted';
   await win.getByLabel('Address',{exact:true}).fill(initial);await win.getByLabel('Address',{exact:true}).press('Enter');
   await win.getByRole('button',{name:'Try direct frame',exact:true}).click();await expect(win.frameLocator('iframe').getByText('Real fixture /chosen')).toBeVisible();
   await win.getByTestId('br-proxy-all').click();await win.frameLocator('[data-testid="wp-frame"]').getByText('Restricted destination').click();
   await expect(win.getByLabel('Address',{exact:true})).toHaveValue(next);let direct=0;page.on('request',r=>{if(r.url()===next)direct++;});
   await win.getByTestId('br-proxy-all').click();await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible();assert.equal(direct,0);
   await expect(win.getByRole('button',{name:'Try direct frame',exact:true})).toBeVisible();
  }finally{await ctx.close();}
 });
 await test('in-flight old probe cannot stall or overwrite the new URL',{},async()=>{
  slowHits=0;slowOldRestricted=false;await fx.windows('browser');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'browser');const win=page.locator('[data-win-id="w1"]');const initial='http://127.0.0.1:4043/slow', next='http://127.0.0.1:4043/restricted';
   const seen=new Promise<void>(resolve=>{slowSeen=resolve;});
   const oldResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/embed-probe'&&new URL(r.url()).searchParams.get('url')===initial,{timeout:12000});
   await win.getByLabel('Address',{exact:true}).fill(initial);await win.getByLabel('Address',{exact:true}).press('Enter');await seen;
   await win.getByTestId('br-proxy-all').click();await win.frameLocator('[data-testid="wp-frame"]').getByText('Restricted destination').click();
   await expect(win.getByLabel('Address',{exact:true})).toHaveValue(next);
   let direct=0;page.on('request',r=>{if(r.url()===next)direct++;});await win.getByTestId('br-proxy-all').click();
   await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible({timeout:5000});assert.equal(direct,0);
   assert.ok(releaseSlow);releaseSlow();assert.equal((await (await oldResponse).json()).verdict,'embeddable');
   await expect(win.getByRole('button',{name:'Try direct frame',exact:true})).toBeVisible();assert.equal(direct,0);
  }finally{releaseSlow?.();await ctx.close();}
 });

 await test('ABA navigation rejects the first probe even when its URL matches again',{},async()=>{
  slowHits=0;slowOldRestricted=true;await fx.windows('browser');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'browser');const win=page.locator('[data-win-id="w1"]');const initial='http://127.0.0.1:4043/slow', next='http://127.0.0.1:4043/restricted';
   const seen=new Promise<void>(resolve=>{slowSeen=resolve;});
   const old=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/embed-probe'&&new URL(r.url()).searchParams.get('url')===initial,{timeout:12000});
   await win.getByLabel('Address',{exact:true}).fill(initial);await win.getByLabel('Address',{exact:true}).press('Enter');const oldRequest=await old;await seen;
   await win.getByTestId('br-proxy-all').click();await win.frameLocator('[data-testid="wp-frame"]').getByText('Restricted destination').click();await expect(win.getByLabel('Address',{exact:true})).toHaveValue(next);
   await win.getByTestId('wp-back').click();await expect(win.getByLabel('Address',{exact:true})).toHaveValue(initial);
   await win.getByTestId('br-proxy-all').click();await expect(win.frameLocator('iframe').getByText('Real fixture /slow')).toBeVisible({timeout:5000});
   assert.ok(releaseSlow);releaseSlow();const oldResponse=await oldRequest.response();assert.ok(oldResponse);assert.equal((await oldResponse.json()).verdict,'csp-restricted');
   await page.waitForTimeout(400);await expect(win.frameLocator('iframe').getByText('Real fixture /slow')).toBeVisible();
   await expect(win.getByText('Embedding policy needs review',{exact:true})).toHaveCount(0);
  }finally{releaseSlow?.();await ctx.close();}
 });

}finally{await fx.close();await new Promise<void>((resolve,reject)=>site.close(e=>e?reject(e):resolve()));finish();}
