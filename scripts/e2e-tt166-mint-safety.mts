import assert from 'node:assert/strict';
import { Client } from 'pg';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';
const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt166-mint-safety');
const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();const ids:string[]=[];
const tag=`tt166-${Date.now()}-${process.pid}`;
try{
 await test('rapid mint attempts cannot overwrite an unread one-time secret',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context();let release!:()=>void, captured!:()=>void;
  const hold=new Promise<void>(r=>release=r), first=new Promise<void>(r=>captured=r);let calls=0;
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()==='POST'){calls++;const res=await route.fetch();assert.equal(res.status(),201);const obj=await res.json() as {id:string};ids.push(obj.id);captured();await hold;await route.fulfill({response:res});}
   else await route.continue();
  });
   await fx.ready(page,'routines');await page.getByLabel('Token name',{exact:true}).fill(tag);
   const btn=page.getByTestId('automation-mint');
   await btn.evaluate((el:HTMLButtonElement)=>{el.click();el.click();});await first;await page.waitForTimeout(700);
   assert.equal(calls,1,'two rapid activations must not create two tokens');assert.equal(await btn.isDisabled(),true);
   release();await page.getByTestId('automation-token').waitFor();
   assert.equal(await btn.isDisabled(),true,'minting must stay disabled until the secret is dismissed');
   const secret=await page.getByTestId('automation-token').textContent();
   await btn.evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));
   assert.equal(calls,1,'a forced activation must not create another token');
   assert.ok((await page.getByTestId('automation-token').textContent())===secret,'the displayed secret must not change');
   await page.getByRole('button',{name:'Done with token'}).click();await page.getByTestId('automation-token').waitFor({state:'hidden'});
   assert.equal(await btn.isEnabled(),true);
   await btn.click();await page.getByTestId('automation-token').waitFor();
   assert.equal(calls,2,'a deliberate new mint must still work');
  }finally{release();await ctx.close();}
 });
 await test('failed mint permits an explicit retry without displaying a secret',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context();let fail=true;
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()!=='POST')return await route.continue();
   if(fail){fail=false;return await route.abort('failed');}
   const res=await route.fetch();assert.equal(res.status(),201);const obj=await res.json() as {id:string};ids.push(obj.id);await route.fulfill({response:res});
  });
   await fx.ready(page,'routines');const btn=page.getByTestId('automation-mint');await btn.click();
   await page.getByText(/failed to fetch/i).first().waitFor();assert.equal(await btn.isEnabled(),true);assert.equal(await page.getByTestId('automation-token').count(),0);
   await btn.click();await page.getByTestId('automation-token').waitFor();assert.equal(await btn.isDisabled(),true);
  }finally{await ctx.close();}
 });
 await test('lost mint response warns and refreshes the committed token row',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context();let minted='';
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()!=='POST')return await route.continue();
   const res=await route.fetch();assert.equal(res.status(),201);const obj=await res.json() as {id:string};minted=obj.id;ids.push(obj.id);await route.abort('failed');
  });
   await fx.ready(page,'routines');await page.getByRole('searchbox',{name:'Search automation tokens'}).waitFor();
   await page.getByTestId('automation-mint').click();await page.getByText(/a token may have been created/i).waitFor();
   const search=page.getByRole('searchbox',{name:'Search automation tokens'});await search.fill(minted);await page.locator(`[data-token-id="${minted}"]`).waitFor();
   assert.equal(await page.getByTestId('automation-token').count(),0);
   const data=await fx.api<{rows:{id:string}[]}>('GET','/api/automation/tokens');assert.ok(data.rows.some(r=>r.id===minted));
  }finally{await ctx.close();}
 });
 await test('curl example and token copies are both masked in clipboard history',{},async()=>{
  const cur=await fx.api<{row:{revision:number}}>('GET','/api/state?id=default');
  await fx.api('PUT','/api/state',{id:'default',revision:Number(cur.row.revision)+1000,state:{windows:[
   {id:'w1',module:'routines',title:'routines',x:10,y:10,w:715,h:810,z:10,workspace:1,props:{}},
   {id:'w2',module:'clipboard',title:'clipboard',x:735,y:10,w:715,h:810,z:11,workspace:1,props:{}}
  ],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
  const ctx=await fx.context();
  try{const page=await ctx.newPage();await page.route('**/api/automation/tokens',async route=>{
   if(route.request().method()!=='POST')return await route.continue();const res=await route.fetch();assert.equal(res.status(),201);const obj=await res.json() as {id:string};ids.push(obj.id);await route.fulfill({response:res});
  });
   await fx.ready(page,'routines');await page.getByTestId('automation-mint').click();const token=page.getByTestId('automation-token');await token.waitFor();const value=await token.textContent();assert.ok(value);
   const list=page.locator('[data-win-id="w2"] [data-testid="clip-list"]');await list.waitFor({state:'attached'});
   await page.getByRole('button',{name:'Copy curl example'}).click();await list.getByRole('listitem').first().waitFor();
   const first=await list.getByRole('listitem').first().innerText();
   assert.ok(!first.includes(value!), 'curl example leaked its token into app clipboard history');assert.match(first,/sensitive · masked/);
   await page.getByRole('button',{name:'Copy token',exact:true}).click();
   await page.waitForFunction(()=>document.querySelectorAll('[data-win-id="w2"] [data-testid="clip-list"] [role="listitem"]').length===2);
   const entries=await list.getByRole('listitem').allInnerTexts();assert.ok(entries.every(x=>!x.includes(value!) && x.includes('sensitive · masked')),'both copies must be masked');
  }finally{await ctx.close();}
 });
}finally{try{if(ids.length)await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);}finally{await db.end();await fx.close();finish();}}
