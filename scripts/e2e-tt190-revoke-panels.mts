import assert from 'node:assert/strict';
import {Client} from 'pg';
import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';

const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt190-revoke-panels');
const db=new Client({connectionString:process.env.DATABASE_URL}),locker=new Client({connectionString:process.env.DATABASE_URL});
await db.connect();await locker.connect();const ids:string[]=[];
try {
 for(const denied of [false,true]) await test(`two open panels share uncertainty${denied?' when storage is denied':''}`,{},async()=>{
  const tag=`tt190-${Date.now()}-${process.pid}-${denied}`;
  const a=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(a.id);
  const b=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(b.id);
  await locker.query('BEGIN');await locker.query('SELECT id FROM automation_tokens WHERE id=$1 FOR UPDATE',[a.id]);
  await fx.windows('routines',2);const ctx=await fx.context();
  try {
   if(denied) await ctx.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    Storage.prototype.getItem=function(key){if(key.startsWith('fusion.revoke-uncertain.'))throw new DOMException('denied','SecurityError');return get.call(this,key);};
    Storage.prototype.setItem=function(key,value){if(key.startsWith('fusion.revoke-uncertain.'))throw new DOMException('denied','SecurityError');return set.call(this,key,value);};
   });
   const page=await ctx.newPage();await fx.ready(page,'routines');
   const w1=page.locator('[data-win-id="w1"]'),w2=page.locator('[data-win-id="w2"]');
   await w1.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   await w2.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   const first=w1.locator(`[data-token-id="${a.id}"]`),second=w2.locator(`[data-token-id="${a.id}"]`),other=w2.locator(`[data-token-id="${b.id}"]`);
   await expect(first.getByTestId('automation-token-state')).toHaveText('live');await expect(second.getByTestId('automation-token-state')).toHaveText('live');
   await first.getByRole('button',{name:'Revoke',exact:true}).click();
   await expect.poll(async()=> (await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%automation_tokens%' AND query ILIKE '%for update%'")).rows[0].n,{timeout:8000}).toBeGreaterThan(0);
   await expect(first.getByTestId('automation-token-state')).toContainText('uncertain');
   await expect(second.getByTestId('automation-token-state')).toContainText('uncertain');
   await expect(other.getByTestId('automation-token-state')).toHaveText('live');
   if(denied) await expect(w1.getByTestId('automation-marker-storage-error')).toContainText('reloading may lose it');
   await locker.query('COMMIT');
   await expect.poll(async()=>(await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${a.token}`}})).status,{timeout:8000}).toBe(401);
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${b.token}`}})).status,200);
   await expect(second.getByTestId('automation-token-state')).toContainText('uncertain');
  }finally {await locker.query('ROLLBACK').catch(()=>{});await ctx.close();}
 });
 await test('late list response cannot erase another panel marker when storage is denied',{},async()=>{
  const tag=`tt190-delayed-${Date.now()}-${process.pid}`;
  const a=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(a.id);
  await locker.query('BEGIN');await locker.query('SELECT id FROM automation_tokens WHERE id=$1 FOR UPDATE',[a.id]);
  await fx.windows('routines',2);const ctx=await fx.context();
  let release!:()=>void; const waitRelease=new Promise<void>(r=>release=r);
  let captured!:()=>void;const waitCaptured=new Promise<void>(r=>captured=r);
  try {
   await ctx.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    Storage.prototype.getItem=function(key){if(key.startsWith('fusion.revoke-uncertain.'))throw new DOMException('denied','SecurityError');return get.call(this,key);};
    Storage.prototype.setItem=function(key,value){if(key.startsWith('fusion.revoke-uncertain.'))throw new DOMException('denied','SecurityError');return set.call(this,key,value);};
   });
   const page=await ctx.newPage();let count=0;
   await page.route('**/api/automation/tokens',async route=>{
    if(route.request().method()!=='GET')return await route.continue();
    const n=++count;if(n!==2)return await route.continue();
    const response=await route.fetch();captured();await waitRelease;
    try{await route.fulfill({response});}catch{/* page may have closed during cleanup */}
   });
   await fx.ready(page,'routines');await waitCaptured;
   const wins=page.locator('[data-win-id]');
   const loaded=wins.filter({has:page.getByRole('searchbox',{name:'Search automation tokens'})});
   await expect(loaded).toHaveCount(1);await loaded.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   await loaded.locator(`[data-token-id="${a.id}"]`).getByRole('button',{name:'Revoke',exact:true}).click();
   await expect.poll(async()=> (await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%automation_tokens%' AND query ILIKE '%for update%'")).rows[0].n,{timeout:8000}).toBeGreaterThan(0);
   release();
   const both=page.getByRole('searchbox',{name:'Search automation tokens'});await expect(both).toHaveCount(2);await both.nth(0).fill(tag);await both.nth(1).fill(tag);
   const badges=page.locator(`[data-token-id="${a.id}"]`).getByTestId('automation-token-state');await expect(badges).toHaveCount(2);
   await expect(badges.nth(0)).toContainText('uncertain');await expect(badges.nth(1)).toContainText('uncertain');
   await locker.query('COMMIT');await expect.poll(async()=>(await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${a.token}`}})).status,{timeout:8000}).toBe(401);
  }finally{release();await locker.query('ROLLBACK').catch(()=>{});await ctx.close();}
 });
}finally{try{await locker.query('ROLLBACK').catch(()=>{});if(ids.length){await db.query("DELETE FROM audit_log WHERE (action='automation.token.revoked' AND detail=ANY($1::text[])) OR (action='automation.token.created' AND split_part(detail,' ',1)=ANY($1::text[]))",[ids]);await db.query('DELETE FROM automation_tokens WHERE id=ANY($1::text[])',[ids]);}}finally{await locker.end();await db.end();await fx.close();finish();}}
