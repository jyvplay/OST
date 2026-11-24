import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('tt220-density-identity');
import {waitForDensity} from './density-readiness.mts';
try{
 await test('wrong window cannot satisfy the target app readiness',{},async()=>{
  await fx.windows('spec');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'spec');await page.locator('[data-shell-ready="true"]').waitFor();await page.waitForFunction(()=>(document.querySelector('[data-win-id="w1"]')?.textContent??'').length>30);
   assert.equal(await page.locator('[data-win-id="w1"]').getAttribute('aria-label'),'spec');let accepted=true;try{await waitForDensity(page,'beam',700);}catch{accepted=false;}assert.equal(accepted,false,'spec must not count as beam');
  }finally{await ctx.close();}
 });
 await test('correct app reaches readiness',{},async()=>{
  await fx.windows('beam');const ctx=await fx.context(),page=await ctx.newPage();try{await fx.ready(page,'beam');await page.locator('[data-shell-ready="true"]').waitFor();await waitForDensity(page,'beam',12000);}finally{await ctx.close();}
 });
}finally{await fx.close();finish();}
