import assert from 'node:assert/strict';
import { Client } from 'pg';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';

const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt181-token-timeout');
const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();const ids:string[]=[];
const tag=`tt181-${Date.now()}-${process.pid}`;
try{
 await test('lost mint with stalled recovery times out, preserves uncertainty and retries the real list',{},async()=>{
  const anchor=await fx.api<{id:string}>('POST','/api/automation/tokens',{name:`${tag}-anchor`,scopes:['read']});ids.push(anchor.id);
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void,captured!:()=>void;
  const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>captured=r);let minted='',holdNext=false,posts=0;
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()==='POST'){
    posts++;const res=await route.fetch();assert.equal(res.status(),201);const body=await res.json() as {id:string};minted=body.id;ids.push(minted);holdNext=true;await route.abort('failed');return;
   }
   if(holdNext){holdNext=false;const res=await route.fetch();captured();await held;try{await route.fulfill({response:res});}catch{/* client already aborted */}return;}
   await route.continue();
  });
   await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(anchor.id);await page.locator(`[data-token-id="${anchor.id}"]`).waitFor();
   const btn=page.getByTestId('automation-mint');await btn.click();await ready;
   await expect(page.getByText(/a token may have been created/i)).toBeVisible();await expect(btn).toBeDisabled();
   await expect(page.getByTestId('automation-list-error')).toContainText(/timed out/i,{timeout:14000});
   await expect(page.getByTestId('automation-list-error')).toBeVisible();
   if(process.env.TT181_SCREENSHOT) { await page.getByTestId('automation-list-error').scrollIntoViewIfNeeded(); await page.locator('[data-win-id="w1"]').screenshot({path:process.env.TT181_SCREENSHOT,animations:'disabled'}); }
   await expect(btn).toBeEnabled();assert.equal(posts,1);assert.equal(await page.getByTestId('automation-token').count(),0);
   const warning=page.getByTestId('automation-list-error');await warning.getByRole('button',{name:'Retry token list'}).click();await expect(warning).toHaveCount(0);
   await search.fill(minted);await expect(page.locator(`[data-token-id="${minted}"]`)).toBeVisible();
   release();await page.waitForTimeout(400);await expect(page.locator(`[data-token-id="${minted}"]`)).toBeVisible();assert.equal(posts,1);
  }finally{release();await ctx.close();}
 });
 await test('successful mint keeps the one-time secret when its list refresh times out',{},async()=>{
  const anchor=await fx.api<{id:string}>('POST','/api/automation/tokens',{name:`${tag}-second-anchor`,scopes:['read']});ids.push(anchor.id);
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void,captured!:()=>void;
  const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>captured=r);let holdNext=false,minted='';
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()==='POST'){
    const res=await route.fetch();assert.equal(res.status(),201);const body=await res.json() as {id:string};minted=body.id;ids.push(minted);holdNext=true;await route.fulfill({response:res});return;
   }
   if(holdNext){holdNext=false;const res=await route.fetch();captured();await held;try{await route.fulfill({response:res});}catch{/* client already aborted */}return;}
   await route.continue();
  });
   await fx.ready(page,'routines');const initialSearch=page.getByRole('searchbox',{name:'Search automation tokens'});await initialSearch.fill(anchor.id);await page.locator(`[data-token-id="${anchor.id}"]`).waitFor();
   await page.getByTestId('automation-mint').click();await ready;
   const secret=page.getByTestId('automation-token');await expect(secret).toBeVisible();const value=await secret.textContent();assert.ok(value);
   await expect(page.getByTestId('automation-list-error')).toContainText(/timed out/i,{timeout:14000});
   await expect(secret).toHaveText(value!);await expect(page.getByTestId('automation-mint')).toBeDisabled();
   await page.getByTestId('automation-list-error').getByRole('button',{name:'Retry token list'}).click();
   const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(minted);await expect(page.locator(`[data-token-id="${minted}"]`)).toBeVisible();
   release();await expect(secret).toHaveText(value!);await page.getByRole('button',{name:'Done with token'}).click();await expect(page.getByTestId('automation-mint')).toBeEnabled();
  }finally{release();await ctx.close();}
 });
 await test('timed-out older listing cannot replace a newer successful mint refresh',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void,captured!:()=>void,oldRequest:import('playwright').Request|undefined;
  const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>captured=r);let count=0,minted='';
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()==='POST'){
    const res=await route.fetch();assert.equal(res.status(),201);const body=await res.json() as {id:string};minted=body.id;ids.push(minted);await route.fulfill({response:res});return;
   }
   if(++count===1){oldRequest=route.request();const res=await route.fetch();captured();await held;try{await route.fulfill({response:res});}catch{/* client already aborted */}return;}
   await route.continue();
  });
   await fx.ready(page,'routines');await ready;const oldFailed=page.waitForEvent('requestfailed',{predicate:req=>req===oldRequest,timeout:14000});
   await page.getByTestId('automation-mint').click();const secret=page.getByTestId('automation-token');await expect(secret).toBeVisible();
   const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(minted);await expect(page.locator(`[data-token-id="${minted}"]`)).toBeVisible();
   await oldFailed;release();await expect(page.getByTestId('automation-list-error')).toHaveCount(0);await expect(page.locator(`[data-token-id="${minted}"]`)).toBeVisible();await expect(secret).toBeVisible();
  }finally{release();await ctx.close();}
 });
}finally{try{if(ids.length)await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);}finally{await db.end();await fx.close();finish();}}
