import assert from 'node:assert/strict';
import { Client } from 'pg';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';

const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt182-mint-timeout');
const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();const ids:string[]=[];
const tag=`tt182-${Date.now()}-${process.pid}`;
try{
 await test('stalled committed mint times out without hiding uncertainty or replacing a secret',{},async()=>{
  const anchor=await fx.api<{id:string}>('POST','/api/automation/tokens',{name:`${tag}-anchor`,scopes:['read']});ids.push(anchor.id);
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void,captured!:()=>void;
  const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>captured=r);let count=0,committed='';
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()!=='POST')return await route.continue();
   count++;const res=await route.fetch();assert.equal(res.status(),201);const body=await res.json() as {id:string};ids.push(body.id);
   if(count===1){committed=body.id;captured();await held;try{await route.fulfill({response:res});}catch{/* aborted client */}return;}
   await route.fulfill({response:res});
  });
   await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(anchor.id);await page.locator(`[data-token-id="${anchor.id}"]`).waitFor();
   const btn=page.getByTestId('automation-mint');await btn.click();await ready;await expect(btn).toBeDisabled();
   await expect(page.getByText(/a token may have been created/i)).toBeVisible({timeout:18000});await expect(page.getByText(/creation request timed out/i)).toBeVisible();
   await expect(btn).toBeEnabled({timeout:10000});assert.equal(await page.getByTestId('automation-token').count(),0);
   await search.fill(committed);await expect(page.locator(`[data-token-id="${committed}"]`)).toBeVisible();
   const data=await fx.api<{rows:{id:string}[]}>('GET','/api/automation/tokens');assert.ok(data.rows.some(row=>row.id===committed));assert.equal(count,1);
   assert.equal(await page.getByTestId('automation-token').count(),0);assert.equal(count,1);
   await btn.click();const secret=page.getByTestId('automation-token');await expect(secret).toBeVisible();await expect(btn).toBeDisabled();assert.equal(count,2);
   const value=await secret.textContent();assert.ok(value);release();await page.waitForTimeout(400);
   await expect(secret).toHaveText(value!);await expect(btn).toBeDisabled();assert.equal(count,2);
  }finally{release();await ctx.close();}
 });
 await test('mint blocked before delivery times out and a deliberate retry can succeed',{},async()=>{
  const anchor=await fx.api<{id:string}>('POST','/api/automation/tokens',{name:`${tag}-before`,scopes:['read']});ids.push(anchor.id);
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void,captured!:()=>void;
  const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>captured=r);let count=0;
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()!=='POST')return await route.continue();count++;
   if(count===1){captured();await held;try{await route.abort('failed');}catch{/* client timed out */}return;}
   const res=await route.fetch();assert.equal(res.status(),201);const body=await res.json() as {id:string};ids.push(body.id);await route.fulfill({response:res});
  });
   await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(anchor.id);await page.locator(`[data-token-id="${anchor.id}"]`).waitFor();
   await page.getByLabel('Token name',{exact:true}).fill(`${tag}-blocked`);const btn=page.getByTestId('automation-mint');await btn.click();await ready;
   await expect(page.getByText(/creation request timed out/i)).toBeVisible({timeout:18000});await expect(btn).toBeEnabled({timeout:10000});
   const rows=await db.query('SELECT id FROM automation_tokens WHERE name=$1',[`${tag}-blocked`]);assert.equal(rows.rowCount,0);
   release();await btn.click();await expect(page.getByTestId('automation-token')).toBeVisible();await expect(btn).toBeDisabled();assert.equal(count,2);
  }finally{release();await ctx.close();}
 });
 await test('concise routine guidance preserves planner and trigger safety boundaries',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context();
  try{const page=await ctx.newPage();await fx.ready(page,'routines');
   await expect(page.getByText('Local planner: no requests run or origins authenticated. Manage server tokens below.')).toBeVisible();
   await expect(page.getByText('Triggers run while the shell is open; every run is logged in Monitor.')).toBeVisible();
   if(process.env.TT182_SCREENSHOT) { await page.getByText('Local planner: no requests run or origins authenticated. Manage server tokens below.').scrollIntoViewIfNeeded(); await page.locator('[data-win-id="w1"]').screenshot({path:process.env.TT182_SCREENSHOT,animations:'disabled'}); }
   await expect(page.getByLabel('Routine trigger')).toBeVisible();await expect(page.getByTestId('routines-validate')).toBeVisible();
  }finally{await ctx.close();}
 });
}finally{try{if(ids.length)await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);}finally{await db.end();await fx.close();finish();}}
