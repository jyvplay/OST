import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt215-preset-attacks');
const names=['restore','bad-response','held-response'].map(x=>`tt215-${x}-${Date.now().toString(36)}`), ids=names.map(n=>`preset:${n}`);
const read=async(id:string)=>(await fx.api<{row:{revision:number;state:unknown}|null}>('GET','/api/state?id='+encodeURIComponent(id))).row;
const open=async()=>{await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();return {ctx,page,root:page.locator('[data-win-id="w1"]')};};
const save=async(page:import('playwright').Page,root:import('playwright').Locator,name:string)=>{await root.getByRole('button',{name:'Save current layout'}).click();await page.getByTestId('ask-dialog').waitFor();await page.getByTestId('ask-dialog').locator('input').first().fill(name);await page.getByTestId('ask-ok').click();};
try{
 for(const id of ids)assert.equal(await read(id),null);
 await test('saved layout restores after a real additional window opens',{},async()=>{
  const {ctx,page,root}=await open();try{
   await save(page,root,names[0]);await root.getByText(names[0]).waitFor();
   await page.getByTestId('launcher-button').click();await page.getByRole('dialog',{name:'Launcher'}).getByRole('button',{name:'Notes',exact:true}).click();await page.locator('.fs-window[aria-label="Notes"]').waitFor();
   await root.locator('.fs-row').filter({hasText:names[0]}).getByRole('button',{name:'Restore'}).click();await page.locator('.fs-window[aria-label="Notes"]').waitFor({state:'detached'});assert.equal(await page.locator('[data-win-id="w1"]').count(),1);
  }finally{await ctx.close();}
 });
 await test('modal blocks launcher shortcut even with focus moved behind it',{},async()=>{
  const {ctx,page,root}=await open();try{
   await page.getByTestId('launcher-button').focus();await page.keyboard.press('Meta+KeyA');await page.getByRole('dialog',{name:'Launcher'}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Launcher'}).waitFor({state:'hidden'});
   await root.getByRole('button',{name:'Save current layout'}).click();await page.getByTestId('ask-dialog').waitFor();await page.getByTestId('launcher-button').evaluate((el:HTMLElement)=>el.focus());await page.keyboard.press('Meta+KeyA');
   assert.equal(await page.getByRole('dialog',{name:'Launcher'}).count(),0);assert.equal(await page.getByTestId('ask-dialog').count(),1);await page.getByTestId('ask-cancel').click();
  }finally{await ctx.close();}
 });
 await test('invalid success response is not reported as saved',{},async()=>{
  const {ctx,page,root}=await open();try{
   await page.route('**/api/state',route=>route.request().method()==='POST' ? route.fulfill({status:200,contentType:'application/json',body:'{}'}) : route.continue());
   await save(page,root,names[1]);await page.getByText(/save not confirmed.*check/i).waitFor();assert.equal(await read(ids[1]),null);
  }finally{await ctx.close();}
 });
 await test('committed but held response times out as uncertain without retry',{},async()=>{
  const {ctx,page,root}=await open();let count=0;let release!:()=>void;const held=new Promise<void>(r=>{release=r});try{
   await page.route('**/api/state',async route=>{if(route.request().method()==='POST'){count++;const response=await route.fetch();assert.equal(response.status(),200);await held;return route.fulfill({response}).catch(()=>undefined);}return route.continue();});
   await save(page,root,names[2]);await page.getByText(/save not confirmed.*check/i).waitFor({timeout:16000});assert.equal(count,1);assert.ok(await read(ids[2]));assert.equal(await root.getByRole('button',{name:'Save current layout'}).isEnabled(),true);
  }finally{release();await ctx.close();}
 });
}finally{for(const id of ids)await fx.api('DELETE','/api/state?id='+encodeURIComponent(id)).catch(()=>undefined);await fx.close();finish();}
