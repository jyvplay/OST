import assert from 'node:assert/strict';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';

const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt185-quota-timeout');
try {
 for (const app of ['files','monitor'] as const) await test(`${app}: delayed browser estimate becomes unknown, then accepts the actual late result`,{},async()=>{
  await fx.windows(app); const ctx=await fx.context();
  try {
   const page=await ctx.newPage();
   await page.addInitScript(()=>{
    const original=navigator.storage;
    Object.defineProperty(navigator,'storage',{configurable:true,value:{...original,estimate:()=>new Promise(resolve=>{
     const w=window as unknown as {tt185Resolvers:((v:{usage:number;quota:number})=>void)[]};
     (w.tt185Resolvers ??= []).push(resolve);
    })}});
   });
   await fx.ready(page,app); if(app==='monitor') await page.getByText('Privacy, storage and alarms',{exact:true}).click();
   const volume=page.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   await expect(volume).toContainText('Storage estimate is taking too long; origin usage and quota are unknown.',{timeout:9000});
   await page.evaluate(()=>(window as unknown as {tt185Resolvers:((v:{usage:number;quota:number})=>void)[]}).tt185Resolvers.forEach(resolve=>resolve({usage:1024*1024,quota:10*1024*1024})));
   await expect(volume).toContainText(/1\.0 MB.*0\.01 GB.*10\.0 %/);
   await expect(volume).not.toContainText('taking too long');
  } finally { await ctx.close(); }
 });
 await test('a prompt result is not overwritten by a stale deadline',{},async()=>{
  await fx.windows('files'); const ctx=await fx.context();
  try {
   const page=await ctx.newPage();
   await page.addInitScript(()=>{Object.defineProperty(navigator,'storage',{configurable:true,value:{estimate:async()=>({usage:1024*1024,quota:10*1024*1024})}});});
   await fx.ready(page,'files'); const volume=page.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   await expect(volume).toContainText(/1\.0 MB.*0\.01 GB.*10\.0 %/);
   // Deliberately cross the real deadline: an earlier passing snapshot cannot
   // detect a forgotten timer that overwrites a successful response later.
   await page.waitForTimeout(5600);
   await expect(volume).toContainText(/1\.0 MB.*0\.01 GB.*10\.0 %/);
   await expect(volume).not.toContainText('taking too long');
  } finally {await ctx.close();}
 });
 await test('a rejected late estimate is reported as failed rather than successful',{},async()=>{
  await fx.windows('files');const ctx=await fx.context();
  try {
   const page=await ctx.newPage();
   await page.addInitScript(()=>{Object.defineProperty(navigator,'storage',{configurable:true,value:{estimate:()=>new Promise((_,reject)=>{
    (window as unknown as {tt185Reject:()=>void}).tt185Reject=()=>reject(new Error('late failure'));
   })}});});
   await fx.ready(page,'files');const volume=page.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   await expect(volume).toContainText('Storage estimate is taking too long; origin usage and quota are unknown.',{timeout:9000});
   await page.evaluate(()=>(window as unknown as {tt185Reject:()=>void}).tt185Reject());
   await expect(volume).toContainText('Storage estimate failed; origin usage and quota are unknown.');
   assert.equal(await volume.getByTestId('fm08-tone').textContent(),'example');
  } finally {await ctx.close();}
 });
} finally {await fx.close();finish();}
