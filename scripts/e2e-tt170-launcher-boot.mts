import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt170-launcher-boot');
try{
 await test('server-rendered launcher cannot be activated before client boot',{},async()=>{
  const ctx=await fx.context(), page=await ctx.newPage(); let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
  try{
   await page.route('**/_next/static/chunks/*.js',async route=>{await held;await route.continue();});
   await page.goto(fx.BASE+'/?amnesia=1',{waitUntil:'commit'});
   const launcher=page.getByTestId('launcher-button');await launcher.waitFor({timeout:10000});
   assert.equal(await page.locator('[data-shell-ready="false"]').count(),1);
   assert.equal(await launcher.isDisabled(),true,'server-rendered launcher must not appear usable before client boot');
   release();await page.locator('[data-shell-ready="true"]').waitFor({timeout:30000});
   const fusion=page.locator('[data-shell-ready="true"][data-layout="fusion"]');assert.equal(await fusion.count(),1);
   await page.getByTestId('launcher-button').click();await page.getByRole('dialog',{name:'Launcher'}).waitFor();
  }finally{release();await ctx.close();}
 });
 await test('a failed bootstrap still enables the Fusion launcher in read-only shell',{},async()=>{
  const ctx=await fx.context(),page=await ctx.newPage();
  try{await page.route('**/api/bootstrap',route=>route.abort('failed'));await page.goto(fx.BASE+'/?amnesia=1',{waitUntil:'domcontentloaded'});await page.locator('[data-shell-ready="true"][data-layout="fusion"]').waitFor({timeout:30000});const launcher=page.getByTestId('launcher-button');assert.equal(await launcher.isEnabled(),true);await launcher.focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Launcher'}).waitFor();}finally{await ctx.close();}
 });
}finally{await fx.close();finish();}
