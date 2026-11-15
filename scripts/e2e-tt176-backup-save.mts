import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt176-backup-save');
const path='/Backups/fusion-backup-20241001-1234.json'; let owned=false;
const stat=async()=> (await fx.api<{node:{id:number;version:number;content:string;trashed:boolean}|null}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path))).node;
const open=async()=>{await fx.windows('backup');const ctx=await fx.context();const page=await ctx.newPage();await page.clock.setFixedTime(new Date('2024-10-01T12:34:00Z'));await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});return {ctx,page,root};};
try {
 assert.equal(await stat(),null,'fixture path must be unoccupied, including Trash');
 await test('same-minute second save never overwrites the existing copy',{},async()=>{
  const {ctx,page,root}=await open();try{
   await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/saved to/i).waitFor({timeout:12000});owned=true;const original=await stat();assert.ok(original);assert.equal(original.version,1);
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST'&&['write','writeIfUnchanged'].includes(r.request().postDataJSON()?.op));await root.getByTestId('backup-save-files').click();await response;
   const after=await stat();assert.deepEqual(after,original,'second save must not change any part of first copy');await root.getByTestId('backup-report').getByText(/already exists|not confirmed/i).waitFor({timeout:12000});
  }finally{await ctx.close();}
 });
 await test('two real tabs racing for one absent name cannot overwrite each other',{},async()=>{
  await fx.api('POST','/api/fs',{op:'purge',path});owned=false;await fx.windows('backup');const ctx=await fx.context();const pages=[await ctx.newPage(),await ctx.newPage()];let release!:()=>void, seen!:()=>void,count=0;const gate=new Promise<void>(r=>release=r),both=new Promise<void>(r=>seen=r);
  try{
   for(const page of pages){await page.clock.setFixedTime(new Date('2024-10-01T12:34:00Z'));await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});await page.route('**/api/fs',async route=>{const body=route.request().postDataJSON();if(body?.op==='writeIfUnchanged'&&body.path===path){if(++count===2)seen();await gate;}await route.continue();});}
   await Promise.all(pages.map(page=>page.locator('[data-win-id="w1"]').getByTestId('backup-save-files').click()));await Promise.race([both,new Promise((_,reject)=>setTimeout(()=>reject(new Error('both requests did not arrive')),12000))]);owned=true;release();
   const reports=await Promise.all(pages.map(async page=>{const report=page.getByTestId('backup-report');await report.getByText(/saved to|already exists/i).waitFor({timeout:12000});return await report.innerText();}));owned=true;assert.equal(reports.filter(r=>/saved to/i.test(r)).length,1);assert.equal(reports.filter(r=>/already exists/i.test(r)).length,1);const result=await stat();assert.ok(result);assert.equal(result.version,1);assert.equal(count,2);
  }finally{release();await ctx.close();}
 });
 await test('lost response after actual create warns without retrying or overwriting',{},async()=>{
  await fx.api('POST','/api/fs',{op:'purge',path});owned=false;const {ctx,page,root}=await open();let requests=0;
  try{await page.route('**/api/fs',async route=>{const body=route.request().postDataJSON();if(body?.op==='writeIfUnchanged'&&body.path===path){requests++;owned=true;const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}return route.continue();});
   await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/not confirmed.*may have been created/i).waitFor({timeout:12000});const result=await stat();assert.ok(result);assert.equal(result.version,1);assert.equal(requests,1);
  }finally{await ctx.close();}
 });
 await test('a trashed same-name file is not revived or overwritten',{},async()=>{
  await fx.api('POST','/api/fs',{op:'trash',path});const before=await stat();assert.ok(before?.trashed);const {ctx,root}=await open();
  try{await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/already exists/i).waitFor({timeout:12000});assert.deepEqual(await stat(),before);}finally{await ctx.close();}
 });
 await test('duplicate activation during pending create sends only one request',{},async()=>{
  await fx.api('POST','/api/fs',{op:'purge',path});owned=false;const {ctx,page,root}=await open();let release!:()=>void,seen!:()=>void,count=0;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r);
  try{await page.route('**/api/fs',async route=>{if(route.request().postDataJSON()?.op==='writeIfUnchanged'){count++;seen();await gate;}await route.continue();});await root.getByTestId('backup-save-files').evaluate((b:HTMLElement)=>{b.click();b.click();});await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('request missing')),12000))]);assert.equal(await root.getByTestId('backup-save-files').isDisabled(),true);owned=true;release();await root.getByTestId('backup-report').getByText(/saved to/i).waitFor({timeout:12000});assert.equal(count,1);assert.equal((await stat())?.version,1);}finally{release();await ctx.close();}
 });
 await test('a malformed success response cannot produce a saved report',{},async()=>{
  await fx.api('POST','/api/fs',{op:'purge',path});owned=false;const {ctx,page,root}=await open();
  try{await page.route('**/api/fs',async route=>{if(route.request().postDataJSON()?.op==='writeIfUnchanged'){owned=true;const real=await route.fetch();assert.equal(real.status(),200);return route.fulfill({status:200,contentType:'application/json',body:'{}'});}return route.continue();});await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/not confirmed/i).waitFor({timeout:12000});assert.equal((await stat())?.version,1);}finally{await ctx.close();}
 });
} finally {if(owned) await fx.api('POST','/api/fs',{op:'purge',path});await fx.close();finish();}
