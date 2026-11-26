import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt216-preset-refresh');
const name=`tt216-refresh-${Date.now().toString(36)}`,id=`preset:${name}`, lateName=`${name}-new`,lateId=`preset:${lateName}`;
try{
 await test('a hanging preset refresh cannot indefinitely lock Save or imply an up-to-date list',{},async()=>{
  assert.equal((await fx.api<{row:unknown|null}>('GET','/api/state?id='+encodeURIComponent(id))).row,null);
  await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();let release!:()=>void;const held=new Promise<void>(r=>{release=r});let intercepted=0;
  try{
   const initial=page.waitForResponse(r=>r.request().method()==='GET' && r.url().includes('/api/state?list=preset'));await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();assert.equal((await initial).status(),200);const root=page.locator('[data-win-id="w1"]');await root.getByText('Loading presets…').waitFor({state:'hidden'});
   await page.route('**/api/state?list=preset',async route=>{intercepted++;await held;await route.continue().catch(()=>undefined);});
   await root.getByRole('button',{name:'Save current layout'}).click();await page.getByTestId('ask-dialog').waitFor();await page.getByTestId('ask-dialog').locator('input').fill(name);await page.getByTestId('ask-ok').click();
   await root.getByRole('alert').filter({hasText:/preset list.*out of date/i}).waitFor({timeout:17000});assert.equal(intercepted,1);assert.equal(await root.getByRole('button',{name:'Save current layout'}).isEnabled(),true);
   assert.ok((await fx.api<{row:unknown|null}>('GET','/api/state?id='+encodeURIComponent(id))).row);
   release();await page.unroute('**/api/state?list=preset');await root.getByRole('button',{name:'Refresh presets'}).click();await root.getByText(name).waitFor();assert.equal(await root.getByRole('alert').filter({hasText:/preset list.*out of date/i}).count(),0);
  }finally{release();await ctx.close();}
 });
 await test('malformed successful list response is reported, not treated as empty',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();try{
   await page.route('**/api/state?list=preset',route=>route.fulfill({status:200,contentType:'application/json',body:'{"rows":{}}'}));await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('alert').filter({hasText:/preset list.*out of date/i}).waitFor();assert.equal(await root.getByText('No presets yet.').count(),0);
  }finally{await ctx.close();}
 });
 await test('an older delayed refresh cannot replace a newer successful list',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();let release!:()=>void, seen!:()=>void;const held=new Promise<void>(r=>{release=r}), firstSeen=new Promise<void>(r=>{seen=r});let count=0;
  try{
   await page.route('**/api/state?list=preset',route=>route.abort('failed'));await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('alert').filter({hasText:/preset list.*out of date/i}).waitFor();assert.equal(await root.getByText('No presets yet.').count(),0);
   await page.unroute('**/api/state?list=preset');await page.route('**/api/state?list=preset',async route=>{count++;if(count===1){const response=await route.fetch();seen();await held;await route.fulfill({response}).catch(()=>undefined);}else await route.continue();});
   await root.getByRole('button',{name:'Refresh presets'}).click();await firstSeen;
   await fx.api('POST','/api/state',{op:'createPreset',name:lateName,state:{windows:[]}});
   await root.getByRole('button',{name:'Refresh presets'}).click();await root.getByText(lateName).waitFor();
   const response=page.waitForResponse(r=>r.url().includes('/api/state?list=preset'));release();await response;await page.waitForTimeout(200);assert.equal(await root.getByText(lateName).count(),1);
  }finally{release();await ctx.close();}
 });

}finally{for(const key of [id,lateId])await fx.api('DELETE','/api/state?id='+encodeURIComponent(key)).catch(()=>undefined);await fx.close();finish();}
