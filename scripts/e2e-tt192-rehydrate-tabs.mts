import assert from 'node:assert/strict';
import {Client} from 'pg';
import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt192-rehydrate-tabs');
const db=new Client({connectionString:process.env.DATABASE_URL}),locker=new Client({connectionString:process.env.DATABASE_URL});
await db.connect();await locker.connect();const ids:string[]=[];
try {
 for(const denied of [false,true]) await test(`peer rehydrating after a handshake informs an already open tab${denied?' with storage denied':''}`,{},async()=>{
  const tag=`tt192-${Date.now()}-${process.pid}-${denied}`;
  const a=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(a.id);
  const b=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(b.id);
  await locker.query('BEGIN');await locker.query('SELECT id FROM automation_tokens WHERE id=$1 FOR UPDATE',[a.id]);
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  let captured!:()=>void;const capturedList=new Promise<void>(r=>captured=r);
  try {
   const first=await ctx.newPage();await fx.ready(first,'routines');await first.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   await first.route('**/api/automation/tokens?id=*',async route=>{
    if(route.request().method()!=='DELETE')return await route.continue();
    try{const response=await route.fetch({timeout:30000});await route.fulfill({response});}catch{/* navigation may close the route */}
   });
   await first.locator(`[data-token-id="${a.id}"]`).getByRole('button',{name:'Revoke',exact:true}).click();
   await expect.poll(async()=>(await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%automation_tokens%' AND query ILIKE '%for update%'")).rows[0].n,{timeout:8000}).toBeGreaterThan(0);
   assert.equal(await first.evaluate(id=>sessionStorage.getItem(`fusion.revoke-uncertain.${id}`),a.id),'1');
   await first.addInitScript(()=>{const Native=window.BroadcastChannel;
    class Observed extends Native {constructor(name:string){super(name);if(name==='fusion.revoke-uncertain.v1')this.addEventListener('message',event=>{if(event.data?.type==='request')(window as unknown as {tt192Requests:number}).tt192Requests++;});}}
    (window as unknown as {tt192Requests:number}).tt192Requests=0;window.BroadcastChannel=Observed;
   });
   await first.route('**/api/automation/tokens',async route=>{if(route.request().method()!=='GET')return await route.continue();const response=await route.fetch();captured();await gate;try{await route.fulfill({response});}catch{/* cleanup */}});
   await first.reload({waitUntil:'domcontentloaded'});await capturedList;
   const second=await ctx.newPage();
   if(denied) await second.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(key){if(key.startsWith('fusion.revoke-uncertain.'))throw new DOMException('denied','SecurityError');return get.call(this,key);};Storage.prototype.setItem=function(key,value){if(key.startsWith('fusion.revoke-uncertain.'))throw new DOMException('denied','SecurityError');return set.call(this,key,value);};});
   await fx.ready(second,'routines');await second.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   const other=second.locator(`[data-token-id="${a.id}"]`).getByTestId('automation-token-state');await expect(other).toHaveText('live');
   await expect.poll(()=>first.evaluate(()=>(window as unknown as {tt192Requests:number}).tt192Requests)).toBeGreaterThan(0);
   release();await first.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   await expect(first.locator(`[data-token-id="${a.id}"]`).getByTestId('automation-token-state')).toContainText('uncertain');
   await expect(other).toContainText('uncertain');
   await expect(second.locator(`[data-token-id="${b.id}"]`).getByTestId('automation-token-state')).toHaveText('live');
   if(denied) await expect(second.getByTestId('automation-marker-storage-error')).toContainText('reloading may lose it');
   else assert.equal(await second.evaluate(id=>sessionStorage.getItem(`fusion.revoke-uncertain.${id}`),a.id),'1');
   await locker.query('COMMIT');await expect.poll(async()=>(await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${a.token}`}})).status,{timeout:8000}).toBe(401);
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${b.token}`}})).status,200);
  }finally{release();await locker.query('ROLLBACK').catch(()=>{});await ctx.close();}
 });
}finally{try{await locker.query('ROLLBACK').catch(()=>{});if(ids.length){await db.query("DELETE FROM audit_log WHERE (action='automation.token.revoked' AND detail=ANY($1::text[])) OR (action='automation.token.created' AND split_part(detail,' ',1)=ANY($1::text[]))",[ids]);await db.query('DELETE FROM automation_tokens WHERE id=ANY($1::text[])',[ids]);}}finally{await locker.end();await db.end();await fx.close();finish();}}
