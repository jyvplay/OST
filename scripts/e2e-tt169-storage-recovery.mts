import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(), {test,finish}=makeHarness('e2e-tt169-storage-recovery');
async function open(route:(route:any)=>Promise<void>){await fx.windows('storage');const ctx=await fx.context(),page=await ctx.newPage();await page.route('**/api/storage',route);await fx.ready(page,'storage');return {ctx,page,app:page.getByTestId('storage-app')};}
try{
 await test('initial HTTP failure is unavailable, then retry loads the real overview',{},async()=>{
  let fail=true;const {ctx,page,app}=await open(async route=>{if(route.request().method()==='GET'&&fail){fail=false;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fault'})});}await route.continue();});
  try{const warning=app.getByTestId('storage-overview-error');await warning.waitFor({timeout:6000});assert.match(await warning.innerText(),/unavailable/i);assert.equal(await app.getByText('No duplicate content.').count(),0);await warning.getByRole('button',{name:'Retry storage overview'}).click();await warning.waitFor({state:'hidden'});await app.getByTestId('storage-bucket-row-browser').waitFor();assert.ok(await app.locator('[data-testid^="storage-bucket-row-"]').count()>1);}finally{await ctx.close();}
 });
 await test('failed refresh marks retained data stale until successful retry',{},async()=>{
  let fail=false;const {ctx,app}=await open(async route=>{if(route.request().method()==='GET'&&fail){fail=false;return route.abort('failed');}await route.continue();});
  try{await app.locator('[data-testid^="storage-bucket-row-"]').nth(1).waitFor();fail=true;await app.getByRole('button',{name:'Refresh storage overview'}).click();const warning=app.getByTestId('storage-overview-error');await warning.waitFor({timeout:6000});assert.match(await warning.innerText(),/out of date/i);await warning.getByRole('button',{name:'Retry storage overview'}).click();await warning.waitFor({state:'hidden'});await app.locator('[data-testid^="storage-bucket-row-"]').nth(1).waitFor();}finally{await ctx.close();}
 });
 await test('a late older failure cannot replace a newer successful refresh',{},async()=>{
  let mode=false,count=0,release!:()=>void,started!:()=>void;const held=new Promise<void>(r=>{release=r}),seen=new Promise<void>(r=>{started=r});
  const {ctx,app}=await open(async route=>{if(route.request().method()==='GET'&&mode){count++;if(count===1){started();await held;return route.fulfill({status:500,contentType:'application/json',body:'{"error":"late"}'});}}await route.continue();});
  try{await app.locator('[data-testid^="storage-bucket-row-"]').nth(1).waitFor();mode=true;const refresh=app.getByRole('button',{name:'Refresh storage overview'});await refresh.click();await seen;const success=app.page().waitForResponse(r=>r.url().endsWith('/api/storage')&&r.request().method()==='GET'&&r.status()===200);await refresh.click();await success;const late=app.page().waitForResponse(r=>r.url().endsWith('/api/storage')&&r.status()===500);release();await late;await app.page().waitForTimeout(250);assert.equal(await app.getByTestId('storage-overview-error').count(),0);}finally{release();await ctx.close();}
 });
 await test('HTTP 500 with a success-shaped real body is still rejected',{},async()=>{
  const {ctx,app}=await open(async route=>{if(route.request().method()==='GET'){const response=await route.fetch();return route.fulfill({response,status:500});}await route.continue();});
  try{const warning=app.getByTestId('storage-overview-error');await warning.waitFor({timeout:6000});assert.match(await warning.innerText(),/unavailable/i);assert.equal(await app.getByText('No duplicate content.').count(),0);}finally{await ctx.close();}
 });
 await test('malformed success response is not represented as an empty overview',{},async()=>{
  const {ctx,app}=await open(async route=>{if(route.request().method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});await route.continue();});
  try{await app.getByTestId('storage-overview-error').waitFor({timeout:6000});assert.equal(await app.getByText('No duplicate content.').count(),0);}finally{await ctx.close();}
 });
}finally{await fx.close();finish();}
