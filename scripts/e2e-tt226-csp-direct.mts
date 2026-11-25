import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';
if (process.env.TT222_LOOPBACK_FIXTURE !== '1' || !process.env.BASE) throw new Error('test-only loopback server with port 4043 required');
const origin=new URL(process.env.BASE).origin;
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.setHeader('content-security-policy',req.url==='/allowed'?`frame-ancestors ${origin}`:"frame-ancestors 'none'");res.end('<!doctype html><main id="real-content">Actual permitted origin content</main>');});
await new Promise<void>((resolve,reject)=>server.listen(4043,'127.0.0.1',resolve).once('error',reject));
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt226-csp-direct');
try{
 await test('conservative advisory permits an explicit direct attempt, then return',{},async()=>{
  await fx.windows('browser');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'browser');await page.locator('[data-shell-ready="true"]').waitFor();const win=page.locator('[data-win-id="w1"]');const target='http://127.0.0.1:4043/allowed';
   let directRequests=0;page.on('request',r=>{if(r.url()===target)directRequests++;});
   const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/embed-probe'&&new URL(r.url()).searchParams.get('url')===target);
   await win.getByLabel('Address',{exact:true}).fill(target);await win.getByLabel('Address',{exact:true}).press('Enter');assert.equal((await (await response).json()).verdict,'csp-restricted');
   await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible();assert.equal(directRequests,0,'no browser connection before explicit choice');await win.screenshot({path:'.cache/tt226-framing-options.png'});await win.getByRole('button',{name:'Try direct frame',exact:true}).click();
   await expect(win.frameLocator('iframe').locator('#real-content')).toHaveText('Actual permitted origin content');assert.ok(directRequests>0,'direct browser request observed');
   await win.getByRole('button',{name:'Return to framing options',exact:true}).click();await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible();
  }finally{await ctx.close();}
 });
 await test('explicit attempt does not override browser CSP denial',{},async()=>{
  await fx.windows('browser');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'browser');await page.locator('[data-shell-ready="true"]').waitFor();const win=page.locator('[data-win-id="w1"]');const target='http://127.0.0.1:4043/denied';
   const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/embed-probe'&&new URL(r.url()).searchParams.get('url')===target);
   await win.getByLabel('Address',{exact:true}).fill(target);await win.getByLabel('Address',{exact:true}).press('Enter');assert.equal((await (await response).json()).verdict,'csp-restricted');
   let blocked=false;page.on('console',m=>{if(/frame-ancestors.*none|violates.*Content Security Policy/i.test(m.text()))blocked=true;});
   await win.getByRole('button',{name:'Try direct frame',exact:true}).click();await expect.poll(()=>blocked,{timeout:5000}).toBe(true);await expect(win.frameLocator('iframe').locator('#real-content')).toHaveCount(0);
   await win.getByRole('button',{name:'Return to framing options',exact:true}).click();await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible();
  }finally{await ctx.close();}
 });
 await test('duplicate requires its own direct-frame choice',{},async()=>{
  await fx.windows('browser');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'browser');const win=page.locator('[data-win-id="w1"]');const target='http://127.0.0.1:4043/allowed';
   await win.getByLabel('Address',{exact:true}).fill(target);await win.getByLabel('Address',{exact:true}).press('Enter');
   await win.getByRole('button',{name:'Try direct frame',exact:true}).click();await expect(win.frameLocator('iframe').locator('#real-content')).toBeVisible();
   let duplicateRequests=0;page.on('request',r=>{if(r.url()===target)duplicateRequests++;});
   await win.locator('[data-orbit-target="Tab: 127.0.0.1:4043"]').click({button:'right'});
   await page.getByText('Duplicate URL in new tab',{exact:true}).click();
   await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible({timeout:10000});
   await expect(win.getByRole('button',{name:'Try direct frame',exact:true})).toBeVisible();assert.equal(duplicateRequests,0,'duplicate did not contact the target directly');
  }finally{await ctx.close();}
 });
 await test('untrusted saved iframe mode cannot authorize a restored tab',{},async()=>{
  const previous=await fx.api<{row:{revision:number}}>('GET','/api/state?id=default');
  const target='http://127.0.0.1:4043/allowed';
  await fx.api('PUT','/api/state',{id:'default',revision:previous.row.revision+1000,state:{windows:[{id:'w1',module:'browser',title:'browser',x:20,y:16,w:1100,h:800,z:10,workspace:1,props:{tabs:[{id:'tab0',url:target,title:'site',group:'',pinned:false,asleep:false,mode:'iframe'}],active:'tab0'}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
  const ctx=await fx.context(),page=await ctx.newPage();try{
   let directRequests=0;page.on('request',r=>{if(r.url()===target)directRequests++;});
   await page.goto(fx.BASE,{waitUntil:'domcontentloaded'});const win=page.locator('[data-win-id="w1"]');
   await expect(win.getByText('Embedding policy needs review',{exact:true})).toBeVisible();assert.equal(directRequests,0);
   await win.getByRole('button',{name:'Try direct frame',exact:true}).click();await expect(win.frameLocator('iframe').locator('#real-content')).toBeVisible();assert.ok(directRequests>0);
  }finally{await ctx.close();}
 });
 await test('restored split view probes both visible tabs before framing',{},async()=>{
  const previous=await fx.api<{row:{revision:number}}>('GET','/api/state?id=default');
  const urls=['http://127.0.0.1:4043/allowed','http://127.0.0.1:4043/denied'];
  const tabs=urls.map((url,i)=>({id:`tab${i}`,url,title:`site${i}`,group:'',pinned:false,asleep:false}));
  await fx.api('PUT','/api/state',{id:'default',revision:previous.row.revision+1000,state:{windows:[{id:'w1',module:'browser',title:'browser',x:20,y:16,w:1100,h:800,z:10,workspace:1,props:{tabs,active:'tab0',split:'h'}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
  const ctx=await fx.context(),page=await ctx.newPage();try{
   const responses=urls.map(url=>page.waitForResponse(r=>new URL(r.url()).pathname==='/api/embed-probe'&&new URL(r.url()).searchParams.get('url')===url,{timeout:12000}));
   await page.goto(fx.BASE,{waitUntil:'domcontentloaded'});await page.locator('[data-shell-ready="true"]').waitFor();
   for(const response of responses)assert.equal((await (await response).json()).verdict,'csp-restricted');
   await expect(page.locator('[data-win-id="w1"]').getByText('Embedding policy needs review',{exact:true})).toHaveCount(2);
  }finally{await ctx.close();}
 });
}finally{await fx.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));finish();}
