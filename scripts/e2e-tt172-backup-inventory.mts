import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt172-backup-inventory');
const names=['fusion-backup-23010101-0101.json','fusion-backup-23010102-0101.json','fusion-backup-23010103-0101.json'];const paths=names.map(n=>'/Backups/'+n),created:string[]=[];
async function setup(handler:(route:any)=>Promise<void>){await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();await page.route('**/api/fs?*',async route=>{const u=new URL(route.request().url());if(route.request().method()==='GET'&&u.searchParams.get('op')==='list'&&u.searchParams.get('path')==='/Backups')return handler(route);await route.continue();});await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();return {ctx,page,root:page.locator('[data-win-id="w1"]')};}
try{
 for(const path of paths){const existing=await fx.api<{node?:unknown}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.ok(!existing.node,`fixture occupied: ${path}`);await fx.api('POST','/api/fs',{op:'write',path,content:'tt172 fixture',mime:'text/plain'});created.push(path);}
 await test('initial HTTP failure is not an empty backup folder and retry lists real copies',{},async()=>{
  let fail=true;const {ctx,root}=await setup(async route=>{if(fail){fail=false;return route.fulfill({status:500,contentType:'application/json',body:'{"error":"fault"}'});}await route.continue();});
  try{const err=root.getByTestId('backup-inventory-error');await err.waitFor({timeout:6000});assert.match(await err.innerText(),/unavailable/i);assert.equal(await root.getByText(/None yet/).count(),0);assert.equal(await root.getByTestId('backup-prune').isDisabled(),true);await err.getByRole('button',{name:'Retry backup inventory'}).click();await err.waitFor({state:'hidden'});for(const name of names)await root.getByTestId('backup-inventory-row').filter({hasText:name}).waitFor();assert.equal(await root.getByTestId('backup-prune').isEnabled(),true);}finally{await ctx.close();}
 });
 await test('a failed refresh keeps rows visibly stale and disables prune until retry',{},async()=>{
  let fail=false;const {ctx,root}=await setup(async route=>{if(fail){fail=false;return route.abort('failed');}await route.continue();});
  try{await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();fail=true;await root.getByRole('button',{name:'Refresh backup inventory'}).click();const err=root.getByTestId('backup-inventory-error');await err.waitFor({timeout:6000});assert.match(await err.innerText(),/out of date/i);assert.equal(await root.getByTestId('backup-prune').isDisabled(),true);await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();await err.getByRole('button',{name:'Retry backup inventory'}).click();await err.waitFor({state:'hidden'});assert.equal(await root.getByTestId('backup-prune').isEnabled(),true);}finally{await ctx.close();}
 });
 await test('pending refresh blocks pruning and a late older failure cannot undo newer success',{},async()=>{
  let mode=false,calls=0,release!:()=>void,started!:()=>void;const held=new Promise<void>(r=>{release=r}),seen=new Promise<void>(r=>{started=r});
  const {ctx,page,root}=await setup(async route=>{if(mode&&++calls===1){started();await held;return route.fulfill({status:500,contentType:'application/json',body:'{"error":"late"}'});}await route.continue();});
  try{await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();mode=true;const refresh=root.getByRole('button',{name:'Refresh backup inventory'});await refresh.click();await seen;assert.equal(await root.getByTestId('backup-prune').isDisabled(),true);const newer=page.waitForResponse(r=>r.url().includes('op=list')&&r.url().includes('%2FBackups')&&r.status()===200);await refresh.click();await newer;await root.getByTestId('backup-prune').waitFor({state:'visible'});const late=page.waitForResponse(r=>r.url().includes('op=list')&&r.status()===500);release();await late;await page.waitForTimeout(250);assert.equal(await root.getByTestId('backup-inventory-error').count(),0);assert.equal(await root.getByTestId('backup-prune').isEnabled(),true);}finally{release();await ctx.close();}
 });
 await test('a malformed successful response does not claim an empty folder',{},async()=>{
  const {ctx,root}=await setup(async route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"path":"/Backups","nodes":null}'}));
  try{await root.getByTestId('backup-inventory-error').waitFor({timeout:6000});assert.equal(await root.getByText(/None yet/).count(),0);assert.equal(await root.getByTestId('backup-prune').isDisabled(),true);}finally{await ctx.close();}
 });
}finally{for(const path of created)await fx.api('POST','/api/fs',{op:'purge',path}).catch(()=>undefined);await fx.close();finish();}
