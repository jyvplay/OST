import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt217-preset-delete');
const names=['rejected','lost','held','bad','ok'].map(x=>`tt217-${x}-${Date.now().toString(36)}`),ids=names.map(n=>`preset:${n}`);
const read=async(id:string)=>(await fx.api<{row:unknown|null}>('GET','/api/state?id='+encodeURIComponent(id))).row;
async function open(index:number){await fx.api('POST','/api/state',{op:'createPreset',name:names[index],state:{windows:[]}});await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByText(names[index]).waitFor();return {ctx,page,root,row:root.locator('.fs-row').filter({hasText:names[index]})};}
try{
 for(const id of ids)assert.equal(await read(id),null);
 await test('rejected delete is visibly unconfirmed and preserves preset',{},async()=>{
  const {ctx,page,root,row}=await open(0);let requests=0;try{
   await page.route('**/api/state*',route=>{if(route.request().method()==='POST' && route.request().postDataJSON()?.op==='deletePresetGuarded'){requests++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});}return route.continue();});
   await row.getByText('✕',{exact:true}).click();await root.getByRole('alert').filter({hasText:/deletion not confirmed/i}).waitFor({timeout:7000});assert.equal(requests,1);assert.ok(await read(ids[0]));await root.getByText(names[0]).last().waitFor();
  }finally{await ctx.close();}
 });
 await test('committed delete with lost response is uncertain and not retried',{},async()=>{
  const {ctx,page,root,row}=await open(1);let requests=0;try{
   await page.route('**/api/state*',async route=>{if(route.request().method()==='POST' && route.request().postDataJSON()?.op==='deletePresetGuarded'){requests++;const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}return route.continue();});
   await row.getByText('✕',{exact:true}).click();await root.getByRole('alert').filter({hasText:/deletion not confirmed/i}).waitFor({timeout:7000});assert.equal(requests,1);assert.equal(await read(ids[1]),null);
  }finally{await ctx.close();}
 });
 await test('held committed response times out without a second delete',{},async()=>{
  const {ctx,page,root,row}=await open(2);let requests=0;let release!:()=>void;const held=new Promise<void>(r=>{release=r});try{
   await page.route('**/api/state*',async route=>{if(route.request().method()==='POST' && route.request().postDataJSON()?.op==='deletePresetGuarded'){requests++;const response=await route.fetch();assert.equal(response.status(),200);await held;return route.fulfill({response}).catch(()=>undefined);}return route.continue();});
   const button=row.getByRole('button',{name:`Delete preset ${names[2]}`});await button.evaluate((el:HTMLElement)=>{el.click();el.click();});await root.getByRole('alert').filter({hasText:/deletion not confirmed.*still be in progress/i}).waitFor({timeout:17000});assert.equal(requests,1);assert.equal(await read(ids[2]),null);
  }finally{release();await ctx.close();}
 });
 await test('malformed success does not confirm deletion',{},async()=>{
  const {ctx,page,root,row}=await open(3);try{
   await page.route('**/api/state*',route=>route.request().method()==='POST' && route.request().postDataJSON()?.op==='deletePresetGuarded'?route.fulfill({status:200,contentType:'application/json',body:'{}'}):route.continue());
   await row.getByRole('button',{name:`Delete preset ${names[3]}`}).click();await root.getByRole('alert').filter({hasText:/deletion not confirmed/i}).waitFor();assert.ok(await read(ids[3]));
  }finally{await ctx.close();}
 });
 await test('confirmed deletion removes the row and warning is absent',{},async()=>{
  const {ctx,root,row}=await open(4);try{
   await row.getByRole('button',{name:`Delete preset ${names[4]}`}).click();await root.getByText(names[4]).waitFor({state:'hidden'});assert.equal(await read(ids[4]),null);assert.equal(await root.getByRole('alert').filter({hasText:/deletion not confirmed/i}).count(),0);
  }finally{await ctx.close();}
 });

}finally{for(const id of ids)await fx.api('DELETE','/api/state?id='+encodeURIComponent(id)).catch(()=>undefined);await fx.close();finish();}
