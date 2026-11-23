import assert from 'node:assert/strict';
import pg from 'pg';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt216-preset-late-commit');
const name=`tt216-late-${Date.now().toString(36)}`, id=`preset:${name}`;
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const read=async()=>(await fx.api<{row:unknown|null}>('GET','/api/state?id='+encodeURIComponent(id))).row;
let inTransaction=false;
try {
 await test('an initially absent list does not prove a timed-out create cannot later commit',{},async()=>{
  assert.equal(await read(),null);await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();
  try {
   const initial=page.waitForResponse(r=>r.request().method()==='GET' && r.url().includes('/api/state?list=preset'));await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();assert.equal((await initial).status(),200);
   await db.query('BEGIN');inTransaction=true;
   // The uncommitted conflicting insert is invisible to ordinary reads but forces
   // the real server's unique-index insertion to wait. Rollback lets it proceed.
   await db.query('INSERT INTO desktop_state(id,state,revision) VALUES($1,$2::jsonb,1)',[id,JSON.stringify({windows:[]})]);
   let creates=0;page.on('request',r=>{if(r.url().endsWith('/api/state')&&r.method()==='POST')creates++;});
   const list=page.waitForResponse(r=>r.request().method()==='GET'&&r.url().includes('/api/state?list=preset'), {timeout:22000});
   await page.locator('[data-win-id="w1"]').getByRole('button',{name:'Save current layout'}).click();await page.getByTestId('ask-dialog').waitFor();await page.getByTestId('ask-dialog').locator('input').fill(name);await page.getByTestId('ask-ok').click();
   let waiting=false;for(let i=0;i<50;i++){const r=await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%insert into \"desktop_state\"%'");if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(waiting,'real server insert must be blocked before timeout');
   await page.getByText(/save not confirmed.*still be in progress/i).waitFor({timeout:20000});const result=await list;assert.equal(result.status(),200);assert.equal((await result.json()).rows.some((r:{id:string})=>r.id===id),false);assert.equal(await read(),null);assert.equal(creates,1);
   await db.query('ROLLBACK');inTransaction=false;
   await page.waitForFunction(async key=>{const r=await fetch('/api/state?id='+encodeURIComponent(key));return !!(await r.json()).row;},id,{timeout:15000});assert.ok(await read());assert.equal(creates,1);
  } finally {if(inTransaction){await db.query('ROLLBACK');inTransaction=false;}await ctx.close();}
 });
}finally{if(inTransaction)await db.query('ROLLBACK');await fx.api('DELETE','/api/state?id='+encodeURIComponent(id)).catch(()=>undefined);await db.end();await fx.close();finish();}
