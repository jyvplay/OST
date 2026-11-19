import assert from 'node:assert/strict';
import {Client} from 'pg';
import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt188-revoke-late');
const db=new Client({connectionString:process.env.DATABASE_URL}),locker=new Client({connectionString:process.env.DATABASE_URL});
await db.connect();await locker.connect();const ids:string[]=[];
try {
 await test('a late committed revoke remains marked uncertain after warning dismissal',{},async()=>{
  const tag=`tt188-${Date.now()}-${process.pid}`;
  const a=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(a.id);
  const b=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(b.id);
  await locker.query('BEGIN');await locker.query('SELECT id FROM automation_tokens WHERE id=$1 FOR UPDATE',[a.id]);
  await fx.windows('routines');const ctx=await fx.context();let arrived!:()=>void;const started=new Promise<void>(r=>arrived=r);
  try {
   const page=await ctx.newPage();await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(tag);
   const row=page.locator(`[data-token-id="${a.id}"]`),other=page.locator(`[data-token-id="${b.id}"]`);await expect(row).toBeVisible();await expect(other).toBeVisible();
   await page.route('**/api/automation/tokens?id=*',async route=>{
    if(route.request().method()!=='DELETE')return await route.continue();arrived();
    try{const result=await route.fetch({timeout:30000});await route.fulfill({response:result});}catch{/* client may already be gone */}
   });
   await row.getByRole('button',{name:'Revoke',exact:true}).click();await started;
   await expect.poll(async()=>{const r=await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%automation_tokens%' AND query ILIKE '%for update%'");return r.rows[0].n;},{timeout:8000}).toBeGreaterThan(0);
   const warning=page.getByTestId(`automation-revoke-error-${a.id}`);await expect(warning).toContainText(/timed out/i,{timeout:17000});
   const badge=row.getByTestId('automation-token-state');await expect(badge).toContainText('uncertain',{timeout:10000});
   await expect(badge).toHaveAttribute('data-tone','warn');
   await expect(badge).toHaveAttribute('title',/Last seen live/);
   assert.equal(await badge.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'uncertainty must not be clipped');
   const panel=page.getByRole('heading',{name:'External entry points (AU-03)'}).locator('xpath=ancestor::section[1]');
   await expect(panel.locator('.fs-badge').first()).toContainText('uncertain');
   await expect(other.getByTestId('automation-token-state')).toHaveText('live');
   if(process.env.TT188_SCREENSHOT){await row.scrollIntoViewIfNeeded();await page.locator('[data-win-id="w1"]').screenshot({path:process.env.TT188_SCREENSHOT,animations:'disabled'});}
   await warning.getByRole('button',{name:`Dismiss revocation warning for ${a.id}`}).click();await expect(warning).toHaveCount(0);
   await expect(badge).toContainText('uncertain');
   await locker.query('COMMIT');
   await expect.poll(async()=>(await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${a.token}`}})).status,{timeout:8000}).toBe(401);
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${b.token}`}})).status,200);
   await expect(badge).toContainText('uncertain');
   await row.getByRole('button',{name:'Revoke',exact:true}).click();await expect(badge).toHaveText('revoked',{timeout:10000});
   assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='automation.token.revoked' AND detail=$1",[a.id])).rows[0].n,1,'idempotent retry does not duplicate audit');
  }finally{await locker.query('ROLLBACK').catch(()=>{});await ctx.close();}
 });
} finally {try{await locker.query('ROLLBACK').catch(()=>{});if(ids.length){await db.query("DELETE FROM audit_log WHERE (action='automation.token.revoked' AND detail=ANY($1::text[])) OR (action='automation.token.created' AND split_part(detail,' ',1)=ANY($1::text[]))",[ids]);await db.query('DELETE FROM automation_tokens WHERE id=ANY($1::text[])',[ids]);}}finally{await locker.end();await db.end();await fx.close();finish();}}
