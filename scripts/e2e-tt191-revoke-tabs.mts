import assert from 'node:assert/strict';
import {Client} from 'pg';
import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';

const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt191-revoke-tabs');
const db=new Client({connectionString:process.env.DATABASE_URL}),locker=new Client({connectionString:process.env.DATABASE_URL});
await db.connect();await locker.connect();const ids:string[]=[];
try {
 for(const late of [false,true]) await test(`${late?'late-joining':'already-open'} tab marks a pending revoke uncertain`,{},async()=>{
  const tag=`tt191-${Date.now()}-${process.pid}-${late}`;
  const a=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(a.id);
  const b=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(b.id);
  await locker.query('BEGIN');await locker.query('SELECT id FROM automation_tokens WHERE id=$1 FOR UPDATE',[a.id]);
  await fx.windows('routines');const ctx=await fx.context();
  try {
   const first=await ctx.newPage();await fx.ready(first,'routines');await first.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   const second=await ctx.newPage();
   if(!late){await fx.ready(second,'routines');await second.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);await expect(second.locator(`[data-token-id="${a.id}"]`).getByTestId('automation-token-state')).toHaveText('live');}
   await first.locator(`[data-token-id="${a.id}"]`).getByRole('button',{name:'Revoke',exact:true}).click();
   await expect.poll(async()=>(await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%automation_tokens%' AND query ILIKE '%for update%'")).rows[0].n,{timeout:8000}).toBeGreaterThan(0);
   if(late){await fx.ready(second,'routines');await second.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);}
   await expect(second.locator(`[data-token-id="${a.id}"]`).getByTestId('automation-token-state')).toContainText('uncertain');
   await expect(second.locator(`[data-token-id="${b.id}"]`).getByTestId('automation-token-state')).toHaveText('live');
   assert.equal(await second.evaluate(id=>sessionStorage.getItem(`fusion.revoke-uncertain.${id}`),a.id),'1');
   assert.equal(await second.evaluate(secret=>JSON.stringify(sessionStorage).includes(secret),a.token),false);
   await locker.query('COMMIT');await expect.poll(async()=>(await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${a.token}`}})).status,{timeout:8000}).toBe(401);
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${b.token}`}})).status,200);
  } finally {await locker.query('ROLLBACK').catch(()=>{});await ctx.close();}
 });
 await test('oversized messages are rejected without treating markers as authorization',{},async()=>{
  const tag=`tt191-invalid-${Date.now()}-${process.pid}`;
  const a=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(a.id);
  const b=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(b.id);
  await fx.windows('routines');const ctx=await fx.context();
  try {
   const page=await ctx.newPage();await fx.ready(page,'routines');await page.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   await expect(page.locator(`[data-token-id="${b.id}"]`).getByTestId('automation-token-state')).toHaveText('live');
   await page.evaluate(({a,b})=>{const c=new BroadcastChannel('fusion.revoke-uncertain.v1');c.postMessage({type:'markers',ids:Array(101).fill(b)});c.postMessage({type:'markers',ids:[a]});c.close();},{a:a.id,b:b.id});
   await expect(page.locator(`[data-token-id="${a.id}"]`).getByTestId('automation-token-state')).toContainText('uncertain');
   await expect(page.locator(`[data-token-id="${b.id}"]`).getByTestId('automation-token-state')).toHaveText('live');
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${a.token}`}})).status,200);
  }finally{await ctx.close();}
 });
 await test('unavailable channel leaves the local revoke usable and exposes the stale-tab caveat',{},async()=>{
  const tag=`tt191-no-channel-${Date.now()}-${process.pid}`;
  const a=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(a.id);
  await fx.windows('routines');const ctx=await fx.context();
  try {
   await ctx.addInitScript(()=>{const Native=window.BroadcastChannel;Object.defineProperty(window,'BroadcastChannel',{value:class extends Native {constructor(name:string){if(name==='fusion.revoke-uncertain.v1')throw new DOMException('blocked','SecurityError');super(name);}}});});
   const page=await ctx.newPage();await fx.ready(page,'routines');await page.getByRole('searchbox',{name:'Search automation tokens'}).fill(tag);
   await expect(page.getByText('Other tabs may be out of date.',{exact:false})).toBeVisible();
   const row=page.locator(`[data-token-id="${a.id}"]`);await row.getByRole('button',{name:'Revoke',exact:true}).click();
   await expect(row.getByTestId('automation-token-state')).toHaveText('revoked',{timeout:10000});
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${a.token}`}})).status,401);
  }finally{await ctx.close();}
 });
}finally{try{await locker.query('ROLLBACK').catch(()=>{});if(ids.length){await db.query("DELETE FROM audit_log WHERE (action='automation.token.revoked' AND detail=ANY($1::text[])) OR (action='automation.token.created' AND split_part(detail,' ',1)=ANY($1::text[]))",[ids]);await db.query('DELETE FROM automation_tokens WHERE id=ANY($1::text[])',[ids]);}}finally{await locker.end();await db.end();await fx.close();finish();}}
