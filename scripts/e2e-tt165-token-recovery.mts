import assert from 'node:assert/strict';
import { Client } from 'pg';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';
const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt165-token-recovery');
const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
const ids:string[]=[], tag=`tt165-${Date.now()}-${process.pid}`;
async function mint(name:string){const x=await fx.api<{id:string}>('POST','/api/automation/tokens',{name,scopes:['read']});ids.push(x.id);return x.id;}
try{
 await test('search during a pending real mint is not reset when its response arrives',{},async()=>{
  const anchor=await mint(`${tag}-anchor`);await fx.windows('routines');const ctx=await fx.context();
  let release!:()=>void, captured!:()=>void;const hold=new Promise<void>(r=>release=r), ready=new Promise<void>(r=>captured=r);
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()==='POST'){const response=await route.fetch();const data=await response.json() as {id:string};ids.push(data.id);captured();await hold;await route.fulfill({response});}
   else await route.continue();
  });
   await fx.ready(page,'routines'); const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.waitFor();
   await page.getByLabel('Token name',{exact:true}).fill(`${tag}-new`);await page.getByTestId('automation-mint').click();await ready;
   await search.fill(anchor);release();await page.getByTestId('automation-token').waitFor();
   await page.locator(`[data-token-id="${anchor}"]`).waitFor();assert.equal(await search.inputValue(),anchor);
  }finally{release();await ctx.close();}
 });
 await test('failed initial listing is not described as empty and can be retried',{},async()=>{
  const anchor=await mint(`${tag}-initial`);await fx.windows('routines');const ctx=await fx.context();
  try {const page=await ctx.newPage();let fail=true;
   await page.route('**/api/automation/tokens',async route=>{if(fail&&route.request().method()==='GET'){fail=false;await route.abort('failed');}else await route.continue();});
   await fx.ready(page,'routines'); const warning=page.getByTestId('automation-list-error');await warning.waitFor();
   assert.equal(await page.getByText(/No tokens\. Nothing outside/).count(),0);
   await warning.getByRole('button',{name:'Retry token list'}).click();await warning.waitFor({state:'hidden'});
   const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(anchor);await page.locator(`[data-token-id="${anchor}"]`).waitFor();
  }finally{await ctx.close();}
 });
 await test('failed refresh retains secret and marks old list stale until retry',{},async()=>{
  const anchor=await mint(`${tag}-refresh`);await fx.windows('routines');const ctx=await fx.context();
  try {const page=await ctx.newPage();let fail=false;
   await page.route('**/api/automation/tokens',async route=>{if(fail&&route.request().method()==='GET'){fail=false;await route.abort('failed');}else await route.continue();});
   await fx.ready(page,'routines');const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(anchor);await page.locator(`[data-token-id="${anchor}"]`).waitFor();
   fail=true; const post=page.waitForResponse(r=>r.url().endsWith('/api/automation/tokens')&&r.request().method()==='POST');
   await page.getByTestId('automation-mint').click();const res=await post;assert.equal(res.status(),201);const minted=await res.json() as {id:string};ids.push(minted.id);
   const secret=page.getByTestId('automation-token');await secret.waitFor();const warning=page.getByTestId('automation-list-error');await warning.waitFor();
   assert.match(await warning.innerText(),/out of date/i);
   await warning.getByRole('button',{name:'Retry token list'}).click();await warning.waitFor({state:'hidden'});assert.equal(await secret.isVisible(),true);
   await search.fill(minted.id);await page.locator(`[data-token-id="${minted.id}"]`).waitFor();
  }finally{await ctx.close();}
 });
 await test('older successful listing cannot mask a newer failed refresh',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context();
  let release!:()=>void, captured!:()=>void, delivered!:()=>void;
  const held=new Promise<void>(r=>release=r), gotOld=new Promise<void>(r=>captured=r), oldDelivered=new Promise<void>(r=>delivered=r);let count=0;
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()!=='GET'){await route.continue();return;}
   count++;if(count===1){const response=await route.fetch();captured();await held;await route.fulfill({response});delivered();}
   else if(count===2) await route.abort('failed'); else await route.continue();
  });
   await fx.ready(page,'routines');await gotOld;
   const post=page.waitForResponse(r=>r.url().endsWith('/api/automation/tokens')&&r.request().method()==='POST');
   await page.getByTestId('automation-mint').click();const res=await post;assert.equal(res.status(),201);const minted=await res.json() as {id:string};ids.push(minted.id);
   const warning=page.getByTestId('automation-list-error');await warning.waitFor();release();await oldDelivered;await page.waitForTimeout(500);
   assert.equal(await warning.isVisible(),true);assert.equal(await page.getByText(/No tokens\. Nothing outside/).count(),0);
   await warning.getByRole('button',{name:'Retry token list'}).click();await warning.waitFor({state:'hidden'});
   const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(minted.id);await page.locator(`[data-token-id="${minted.id}"]`).waitFor();
   assert.equal(await page.getByTestId('automation-token').isVisible(),true);
  }finally{release();await ctx.close();}
 });
}finally{try{if(ids.length)await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);}finally{await db.end();await fx.close();finish();}}
