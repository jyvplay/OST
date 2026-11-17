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
   const status=volume.getByRole('status',{name:'Origin storage estimate'});
   await expect(status).toHaveText('reading…');
   await expect(status).toContainText('Storage estimate is taking too long; origin usage and quota are unknown.',{timeout:9000});
   await page.evaluate(()=>(window as unknown as {tt185Resolvers:((v:{usage:number;quota:number})=>void)[]}).tt185Resolvers.forEach(resolve=>resolve({usage:1024*1024,quota:10*1024*1024})));
   await expect(status).toContainText(/1\.0 MB.*0\.01 GB.*10\.0 %/);
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
 for(const app of ['files','monitor'] as const) await test(`${app}: quota updates have an accessible live status`,{},async()=>{
  await fx.windows(app);const ctx=await fx.context();
  try {
   const page=await ctx.newPage();await fx.ready(page,app);
   if(app==='monitor') await page.getByText('Privacy, storage and alarms',{exact:true}).click();
   const volume=page.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   const status=volume.getByRole('status',{name:'Origin storage estimate'}); await expect(status).toHaveCount(1);
   await expect(status).toHaveAttribute('aria-atomic','true');
   await expect(status).not.toHaveText('reading…');
  } finally {await ctx.close();}
 });
 await test('a closed panel cannot overwrite a newly mounted panel with its late result',{},async()=>{
  await fx.windows('files');const ctx=await fx.context();
  try {
   const page=await ctx.newPage();await page.addInitScript(()=>{
    const w=window as unknown as {tt186Resolvers:((value:{usage:number;quota:number})=>void)[]};w.tt186Resolvers=[];
    Object.defineProperty(navigator,'storage',{configurable:true,value:{estimate:()=>new Promise(resolve=>w.tt186Resolvers.push(resolve))}});
   });
   await fx.ready(page,'files'); const volume=page.getByTestId('fm08-tone').locator('xpath=ancestor::section[1]');
   await expect(volume).toContainText('reading…');
   const before=await page.evaluate(()=>(window as unknown as {tt186Resolvers:unknown[]}).tt186Resolvers.length);
   assert.ok(before>=1,'first estimate requested');
   await page.getByRole('button',{name:'Terminal pane'}).click();await expect(volume).toHaveCount(0);
   await page.getByRole('button',{name:'Terminal pane'}).click();await expect(volume).toContainText('reading…');
   await page.waitForFunction(n=>(window as unknown as {tt186Resolvers:unknown[]}).tt186Resolvers.length>n,before);
   await page.evaluate(n=>{const all=(window as unknown as {tt186Resolvers:((value:{usage:number;quota:number})=>void)[]}).tt186Resolvers;all.slice(0,n).forEach(r=>r({usage:1000000,quota:10000000}));},before);
   await expect(volume).toContainText('reading…');
   await page.evaluate(n=>{const all=(window as unknown as {tt186Resolvers:((value:{usage:number;quota:number})=>void)[]}).tt186Resolvers;all.slice(n).forEach(r=>r({usage:2000000,quota:10000000}));},before);
   await expect(volume).toContainText(/2\.0 MB.*20\.0 %/);
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
