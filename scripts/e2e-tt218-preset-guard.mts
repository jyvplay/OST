import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt218-preset-guard'),name=`tt218-ui-${Date.now().toString(36)}`,id=`preset:${name}`,path='/api/state?id='+encodeURIComponent(id);
const create=(title:string)=>fx.api('POST','/api/state',{op:'createPreset',name,state:{windows:[{title}]}});
try{
 assert.equal((await fx.api<{row:unknown|null}>('GET',path)).row,null);
 await test('stale UI delete refuses replacement and leaves it intact',{},async()=>{
  await create('old');await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:`Delete preset ${name}`}).waitFor();
   await fx.api('DELETE',path);await create('replacement');const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.op==='deletePresetGuarded');await root.getByRole('button',{name:`Delete preset ${name}`}).click();assert.equal((await response).status(),409);await root.getByRole('alert').filter({hasText:/deletion not confirmed/i}).waitFor();assert.equal((await fx.api<{row:{state:{windows:{title:string}[]}}}>('GET',path)).row.state.windows[0].title,'replacement');
  }finally{await ctx.close();}
 });
 await test('older list without guard disables delete',{},async()=>{
  await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();let deletes=0;try{
   await page.route('**/api/state?list=preset',async route=>{const response=await route.fetch();const body=await response.json();for(const row of body.rows)delete row.generation;await route.fulfill({response,json:body});});
   page.on('request',r=>{if(r.method()==='DELETE'||(r.method()==='POST'&&r.url().endsWith('/api/state')&&r.postDataJSON()?.op==='deletePresetGuarded'))deletes++;});
   await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('alert').filter({hasText:/server does not provide a deletion guard/i}).waitFor();assert.equal(await root.getByRole('button',{name:`Delete preset ${name}`}).isDisabled(),true);assert.equal(deletes,0);assert.ok((await fx.api<{row:unknown}>('GET',path)).row);
  }finally{await ctx.close();}
 });
}finally{await fx.api('DELETE',path).catch(()=>undefined);await fx.close();finish();}
