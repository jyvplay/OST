import assert from 'node:assert/strict';
import {Client} from 'pg';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt168-revoke-recovery');
const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();const ids:string[]=[],tag=`tt168-${Date.now()}-${process.pid}`;
async function mint(){const r=await fx.api<{id:string;token:string}>('POST','/api/automation/tokens',{name:tag,scopes:['read']});ids.push(r.id);return r;}
async function setup(id:string){await fx.windows('routines');const ctx=await fx.context();const page=await ctx.newPage();await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(id);const row=page.locator(`[data-token-id="${id}"]`);await row.waitFor();return {ctx,page,row};}
try{
 await test('failed audit reports unconfirmed revocation and permits retry',{},async()=>{
  const {id,token}=await mint();const suffix=`${process.pid}_${Date.now()}`,fn=`tt168_f_${suffix}`,tr=`tt168_t_${suffix}`;
  try{
   await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='automation.token.revoked' AND NEW.detail='${id}' THEN RAISE EXCEPTION 'TT168 audit fault'; END IF; RETURN NEW; END $$`);
   await db.query(`CREATE TRIGGER ${tr} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
   const {ctx,page,row}=await setup(id);
   try{
    await row.getByRole('button',{name:'Revoke',exact:true}).click();
    const warning=page.getByTestId(`automation-revoke-error-${id}`);await warning.waitFor({timeout:6000});
    assert.match(await warning.innerText(),/not confirmed/i);await row.getByText('live',{exact:true}).waitFor();
    assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${token}`}})).status,200);
    await db.query(`DROP TRIGGER ${tr} ON audit_log`);await db.query(`DROP FUNCTION ${fn}()`);
    await row.getByRole('button',{name:'Revoke',exact:true}).click();await row.getByText('revoked',{exact:true}).waitFor();
    await warning.waitFor({state:'hidden'});assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${token}`}})).status,401);
   }finally{await ctx.close();}
  }finally{await db.query(`DROP TRIGGER IF EXISTS ${tr} ON audit_log`);await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);}
 });
 await test('lost successful response warns and reloads the committed revoked state',{},async()=>{
  const {id,token}=await mint();const {ctx,page,row}=await setup(id);
  try{
   await page.route('**/api/automation/tokens?id=*',async route=>{
    if(route.request().method()!=='DELETE')return await route.continue();const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');
   });
   await row.getByRole('button',{name:'Revoke',exact:true}).click();const warning=page.getByTestId(`automation-revoke-error-${id}`);await warning.waitFor({timeout:6000});
   assert.match(await warning.innerText(),/not confirmed/i);await row.getByText('revoked',{exact:true}).waitFor();
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${token}`}})).status,401);
  }finally{await ctx.close();}
 });
 await test('repeated activation while DELETE is pending sends one request',{},async()=>{
  const {id}=await mint();const {ctx,page,row}=await setup(id);let calls=0,release!:()=>void,started!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve}), observed=new Promise<void>(resolve=>{started=resolve});
  try{
   await page.route('**/api/automation/tokens?id=*',async route=>{if(route.request().method()!=='DELETE')return await route.continue();calls++;started();await pending;await route.continue();});
   await row.getByRole('button',{name:'Revoke',exact:true}).evaluate((button:HTMLElement)=>{button.click();button.click();});
   await observed;assert.equal(await row.getByRole('button',{name:'Revoke',exact:true}).isDisabled(),true);
   release();await row.getByText('revoked',{exact:true}).waitFor();assert.equal(calls,1);
  }finally{release();await ctx.close();}
 });
 await test('lost revoke and failed refresh retain both warnings until the list is retried',{},async()=>{
  const {id,token}=await mint();const {ctx,page,row}=await setup(id);let failList=true;
  try{
   await page.route('**/api/automation/tokens**',async route=>{
    if(route.request().method()==='DELETE'){const response=await route.fetch();assert.equal(response.status(),200);return await route.abort('failed');}
    if(route.request().method()==='GET'&&failList){failList=false;return await route.abort('failed');}
    await route.continue();
   });
   await row.getByRole('button',{name:'Revoke',exact:true}).click();
   const warning=page.getByTestId(`automation-revoke-error-${id}`), listError=page.getByTestId('automation-list-error');
   await warning.waitFor();await listError.waitFor();await row.getByText('live',{exact:true}).waitFor();
   assert.equal((await fetch(fx.BASE+'/api/automation',{headers:{authorization:`Bearer ${token}`}})).status,401);
   await listError.getByRole('button',{name:'Retry token list'}).click();await listError.waitFor({state:'hidden'});await row.getByText('revoked',{exact:true}).waitFor();
   assert.equal(await warning.isVisible(),true);await warning.getByRole('button',{name:`Dismiss revocation warning for ${id}`}).click();await warning.waitFor({state:'hidden'});
  }finally{await ctx.close();}
 });
}finally{try{if(ids.length){await db.query("DELETE FROM audit_log WHERE (action='automation.token.revoked' AND detail = ANY($1::text[])) OR (action='automation.token.created' AND split_part(detail,' ',1) = ANY($1::text[]))",[ids]);await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);}}finally{await db.end();await fx.close();finish();}}
