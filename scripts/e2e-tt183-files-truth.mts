import assert from 'node:assert/strict';
import { Client } from 'pg';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';

const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt183-files-truth');
const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
const path=`/Documents/tt183-${Date.now()}-${process.pid}.txt`;
try{
 await fx.api('POST','/api/fs',{op:'write',path,content:'do not purge',reason:'tt183 real test'});
 await fx.api('POST','/api/fs',{op:'trash',path});
 const before=await db.query('SELECT path,trashed,version,sha256 FROM vfs_nodes WHERE path=$1',[path]);assert.equal(before.rowCount,1);assert.equal(before.rows[0].trashed,true);
 for(const app of ['files','monitor'] as const) await test(`${app} distinguishes fixed examples from real storage and does not mutate Trash`,{},async()=>{
  await fx.windows(app);const ctx=await fx.context();
  try{const page=await ctx.newPage();await fx.ready(page,app);const win=page.locator('[data-win-id="w1"]');
   if(app==='monitor')await win.getByText('Privacy, storage and alarms',{exact:true}).click();
   const trash=win.getByTestId('fm11-tone').locator('xpath=ancestor::section[1]');
   const drop=win.getByTestId('fm14-led').locator('xpath=ancestor::section[1]');
   const volume=win.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   await expect(trash).toContainText('Example only: no Trash items were changed.');
   await expect(drop).toContainText('Example only: no actual drag is measured.');
   await expect(volume).toContainText('Example only: no device was checked.');
   await expect(volume).toContainText('origin quota');await expect(volume).toContainText('example volume');
   await expect(trash.getByTestId('fm11-tone')).toContainText('example');
   await expect(volume.getByTestId('fm08-tone')).toContainText('example');
   for(const badge of [trash.getByTestId('fm11-tone'),drop.getByTestId('fm14-led'),volume.getByTestId('fm08-tone')]){
    assert.equal(await badge.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'example badge must not clip');
   }
   if(app==='files'){
    const words=await win.evaluate(root=>{let n:Node|null,count=0;const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);while((n=walk.nextNode())){const p=n.parentElement;if(!p||p.closest('details:not([open])'))continue;const r=p.getBoundingClientRect(),s=getComputedStyle(p);if(!r.width||!r.height||s.display==='none'||s.visibility==='hidden')continue;count+=(n.textContent??'').trim().split(/\s+/).filter(Boolean).length;}return count;});
    console.log(`    files words after example panels ready: ${words} (session-dependent; no cap claim)`);
   }
   const after=await db.query('SELECT path,trashed,version,sha256 FROM vfs_nodes WHERE path=$1',[path]);assert.deepEqual(after.rows,before.rows);
   if(process.env.TT183_SCREENSHOT && app==='files'){await volume.scrollIntoViewIfNeeded();await win.screenshot({path:process.env.TT183_SCREENSHOT,animations:'disabled'});}
  }finally{await ctx.close();}
 });
 await test('missing browser storage estimate is unavailable, not perpetual loading',{},async()=>{
  await fx.windows('files');const ctx=await fx.context();
  try{const page=await ctx.newPage();await page.addInitScript(()=>{Object.defineProperty(navigator,'storage',{value:undefined,configurable:true});});
   await fx.ready(page,'files');const volume=page.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   await expect(volume).toContainText(/this browser exposes no storage estimate/i);await expect(volume).not.toContainText('reading…');
  }finally{await ctx.close();}
 });
 for(const mode of ['reject','partial'] as const) await test(`${mode} storage estimate stays honest`,{},async()=>{
  await fx.windows('files');const ctx=await fx.context();
  try{const page=await ctx.newPage();await page.addInitScript((kind)=>{
   Object.defineProperty(navigator,'storage',{value:{estimate:kind==='reject'?async()=>{throw new Error('denied');}:async()=>({usage:1})},configurable:true});
  },mode);
   await fx.ready(page,'files');const volume=page.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   await expect(volume).toContainText(mode!=='partial' ? /storage estimate failed; origin usage and quota are unknown/i : /estimate is partial/i);
   await expect(volume).not.toContainText('reading…');
  }finally{await ctx.close();}
 });
}finally{try{await fx.api('POST','/api/fs',{op:'purge',path});}finally{await db.end();await fx.close();finish();}}
