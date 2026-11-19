import assert from 'node:assert/strict';
import { Client } from 'pg';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';

const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt187-revoke-timeout');
const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();const ids:string[]=[];
try {
 for(const committed of [false,true]) await test(`held ${committed?'committed':'undelivered'} revocation reports uncertainty and recovers`,{},async()=>{
  const {id,token}=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:`tt187-${Date.now()}-${process.pid}`,scopes:['read']});ids.push(id);
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void,observe!:()=>void;let count=0;
  const held=new Promise<void>(r=>release=r),received=new Promise<void>(r=>observe=r);
  try {
   const page=await ctx.newPage();await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(id);
   const row=page.locator(`[data-token-id="${id}"]`);await expect(row).toBeVisible();
   await page.route('**/api/automation/tokens?id=*',async route=>{
    if(route.request().method()!=='DELETE')return await route.continue();
    count++;
    if(count===1){const res=committed?await route.fetch():null;if(res)assert.equal(res.status(),200);observe();await held;try{await route.abort('failed');}catch{}return;}
    await route.continue();
   });
   const button=row.getByRole('button',{name:'Revoke',exact:true});await button.evaluate((el:HTMLElement)=>{el.click();el.click();});await received;
   await expect(button).toBeDisabled();
   const warning=page.getByTestId(`automation-revoke-error-${id}`);
   await expect(warning).toContainText(/not confirmed/i,{timeout:17000});
   await expect(row.getByText(committed?'revoked':'live',{exact:true})).toBeVisible({timeout:10000});
   if(process.env.TT187_SCREENSHOT && !committed){await warning.scrollIntoViewIfNeeded();await page.locator('[data-win-id="w1"]').screenshot({path:process.env.TT187_SCREENSHOT,animations:'disabled'});}
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${token}`}})).status,committed?401:200);
   assert.equal(count,1,'no automatic duplicate request');
   if(!committed){await expect(button).toBeEnabled({timeout:10000});release();await button.click();await expect(row.getByText('revoked',{exact:true})).toBeVisible();assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${token}`}})).status,401);assert.equal(count,2);}
  }finally{release();await ctx.close();}
 });
 await test('timed-out committed revocation and failed refresh retain both warnings',{},async()=>{
  const {id,token}=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:`tt187-refresh-${Date.now()}`,scopes:['read']});ids.push(id);
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void,observe!:()=>void,failList=true;
  const held=new Promise<void>(r=>release=r),received=new Promise<void>(r=>observe=r);
  try {
   const page=await ctx.newPage();await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(id);
   const row=page.locator(`[data-token-id="${id}"]`);await expect(row).toBeVisible();
   await page.route('**/api/automation/tokens**',async route=>{
    if(route.request().method()==='DELETE'){const res=await route.fetch();assert.equal(res.status(),200);observe();await held;try{await route.abort('failed');}catch{}return;}
    if(route.request().method()==='GET'&&failList){failList=false;await route.abort('failed');return;}
    await route.continue();
   });
   await row.getByRole('button',{name:'Revoke',exact:true}).click();await received;
   const warning=page.getByTestId(`automation-revoke-error-${id}`),listError=page.getByTestId('automation-list-error');
   await expect(warning).toContainText(/not confirmed.*timed out/i,{timeout:17000});await expect(listError).toBeVisible({timeout:10000});
   await expect(row.getByText('live',{exact:true})).toBeVisible();assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${token}`}})).status,401);
   await listError.getByRole('button',{name:'Retry token list'}).click();await expect(row.getByText('revoked',{exact:true})).toBeVisible();
   await expect(warning).toBeVisible();assert.equal(await listError.count(),0);
  } finally {release();await ctx.close();}
 });
} finally {try{if(ids.length){await db.query("DELETE FROM audit_log WHERE (action='automation.token.revoked' AND detail = ANY($1::text[])) OR (action='automation.token.created' AND split_part(detail,' ',1) = ANY($1::text[]))",[ids]);await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);}}finally{await db.end();await fx.close();finish();}}
