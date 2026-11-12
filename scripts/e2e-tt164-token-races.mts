import assert from 'node:assert/strict';
import { Client } from 'pg';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';
const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt164-token-races');
const ids:string[]=[], tag=`tt164-${Date.now()}-${process.pid}`;
const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
const mint=async(name:string)=>{const r=await fx.api<{id:string}>('POST','/api/automation/tokens',{name,scopes:['read']});ids.push(r.id);return r.id;};
try {
 await test('equal creation times have a stable unique ID tiebreaker',{},async()=>{
  for(let i=0;i<10;i++) await mint(`${tag}-tie-${i}`);
  const tie=ids.slice();
  await db.query('UPDATE automation_tokens SET created_at = $1 WHERE id = ANY($2::text[])',['2020-01-01T00:00:00Z',tie]);
  const expected=await db.query<{id:string}>('SELECT id FROM automation_tokens WHERE id = ANY($1::text[]) ORDER BY created_at, id',[tie]);
  const result=await fx.api<{rows:{id:string}[]}>('GET','/api/automation/tokens');
  const actual=result.rows.filter(r=>tie.includes(r.id)).map(r=>r.id);
  assert.deepEqual(actual,expected.rows.map(r=>r.id));
 });
 await test('mint selects its actual page when other clients add more than a page',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context();
  try{
   const page=await ctx.newPage(); await fx.ready(page,'routines');
   await page.getByRole('searchbox',{name:'Search automation tokens'}).waitFor();
   for(let i=0;i<16;i++) await mint(`${tag}-concurrent-${i}`);
   await page.getByLabel('Token name',{exact:true}).fill(`${tag}-created-in-ui`);
   const post=page.waitForResponse(r=>r.url().endsWith('/api/automation/tokens') && r.request().method()==='POST');
   await page.getByTestId('automation-mint').click();
   const r=await post; assert.equal(r.status(),201); const created=await r.json() as {id:string}; ids.push(created.id);
   await page.getByTestId('automation-token').waitFor();
   await page.locator(`[data-token-id="${created.id}"]`).waitFor({timeout:6000});
   assert.equal(await page.getByRole('searchbox',{name:'Search automation tokens'}).inputValue(),'');
  } finally {await ctx.close();}
 });
 await test('a delayed old listing cannot overwrite a newer minted token listing',{},async()=>{
  await fx.windows('routines'); const ctx=await fx.context();
  let release!:()=>void, captured!:()=>void, delivered!:()=>void;
  const held=new Promise<void>(r=>{release=r;}), gotOld=new Promise<void>(r=>{captured=r;}), oldDelivered=new Promise<void>(r=>{delivered=r;});
  let first=true;
  try {
   const page=await ctx.newPage();
   await page.route('**/api/automation/tokens',async route=>{
    if(route.request().method()==='GET' && first){first=false;const response=await route.fetch();captured();await held;await route.fulfill({response});delivered();}
    else await route.continue();
   });
   await fx.ready(page,'routines'); await gotOld;
   await page.getByLabel('Token name',{exact:true}).fill(`${tag}-delayed`);
   const post=page.waitForResponse(r=>r.url().endsWith('/api/automation/tokens') && r.request().method()==='POST');
   await page.getByTestId('automation-mint').click();
   const response=await post; assert.equal(response.status(),201);const created=await response.json() as {id:string};ids.push(created.id);
   const search=page.getByRole('searchbox',{name:'Search automation tokens'}); await search.fill(created.id);
   const row=page.locator(`[data-token-id="${created.id}"]`);await row.waitFor({timeout:6000});
   release(); await oldDelivered; await page.waitForTimeout(500);
   assert.equal(await row.isVisible(),true,'old GET must not overwrite the newer listing');
  } finally {release();await ctx.close();}
 });
 await test('typing during mint refresh keeps the user filter and first matching page',{},async()=>{
  const existing=await mint(`${tag}-search-anchor`); await fx.windows('routines');const ctx=await fx.context();
  let release!:()=>void, captured!:()=>void, delivered!:()=>void;
  const held=new Promise<void>(r=>{release=r;}), gotList=new Promise<void>(r=>{captured=r;}), done=new Promise<void>(r=>{delivered=r;});
  let hold=false;
  try{
   const page=await ctx.newPage();
   await page.route('**/api/automation/tokens',async route=>{
    if(hold && route.request().method()==='GET'){hold=false;const response=await route.fetch();captured();await held;await route.fulfill({response});delivered();}
    else await route.continue();
   });
   await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.waitFor();
   await page.getByLabel('Token name',{exact:true}).fill(`${tag}-new`);hold=true;
   const post=page.waitForResponse(r=>r.url().endsWith('/api/automation/tokens') && r.request().method()==='POST');
   await page.getByTestId('automation-mint').click();const response=await post;assert.equal(response.status(),201);const created=await response.json() as {id:string};ids.push(created.id);
   await gotList;await search.fill(existing);release();await done;
   await page.locator(`[data-token-id="${existing}"]`).waitFor();
   assert.equal(await search.inputValue(),existing);
   await page.getByText('1–1 of 1',{exact:true}).waitFor();
  }finally{release();await ctx.close();}
 });
} finally {
 try {if(ids.length) await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);} finally {await db.end();await fx.close();finish();}
}
