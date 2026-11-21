import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt173-backup-prune');
const names=['fusion-backup-23020101-0101.json','fusion-backup-23020102-0101.json','fusion-backup-23020103-0101.json','fusion-backup-23020104-0101.json'];const paths=names.map(n=>'/Backups/'+n);const created=new Set<string>();
async function populate(){const listing=await fx.api<{nodes:unknown[]}>('GET','/api/fs?op=list&path=%2FBackups');assert.equal(listing.nodes.length,0,'test requires an empty disposable /Backups, refuses to alter other entries');for(const path of paths){const before=await fx.api<{node?:unknown}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.ok(!before.node,`occupied ${path}`);await fx.api('POST','/api/fs',{op:'write',path,content:'tt173-owned',mime:'text/plain'});created.add(path);}}
async function clear(){for(const path of created){await fx.api('POST','/api/fs',{op:'purge',path});created.delete(path);}}
async function open(){await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();await page.clock.setFixedTime(new Date('2304-01-01T12:00:00Z'));page.on('dialog',d=>void d.accept());await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();return {ctx,page,root};}
async function trashed(path:string){const data=await fx.api<{node:{trashed:boolean}|null}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.ok(data.node,`missing ${path}`);return data.node.trashed;}
try{
 await test('confirmed prune moves only two older real copies to Trash',{},async()=>{
  await populate();const {ctx,root}=await open();try{await root.getByTestId('backup-prune').click();await root.getByTestId('backup-report').getByText(/pruned 2/i).waitFor({timeout:6000});for(let i=0;i<4;i++)assert.equal(await trashed(paths[i]),i<2,paths[i]);}finally{await ctx.close();await clear();}
 });
 await test('lost response after second real Trash commit warns and refreshes',{},async()=>{
  await populate();const {ctx,page,root}=await open();let sent=0;
  try{await page.route('**/api/fs',async route=>{const body=route.request().postDataJSON();if(body?.op!=='trash')return route.continue();sent++;if(sent===2){const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}await route.continue();});await root.getByTestId('backup-prune').click();const warning=root.getByTestId('backup-prune-error');await warning.waitFor({timeout:6000});assert.match(await warning.innerText(),/not confirmed.*may have moved/s);await root.getByTestId('backup-inventory-row').filter({hasText:names[1]}).waitFor({state:'hidden'});for(let i=0;i<4;i++)assert.equal(await trashed(paths[i]),i<2,paths[i]);assert.equal(sent,2);await warning.getByRole('button',{name:'Dismiss prune warning'}).click();await warning.waitFor({state:'hidden'});}finally{await ctx.close();await clear();}
 });
 await test('repeated activation while first Trash request is held does not duplicate batch',{},async()=>{
  await populate();const {ctx,page,root}=await open();let sent=0,release!:()=>void,started!:()=>void;const hold=new Promise<void>(r=>{release=r}),seen=new Promise<void>(r=>{started=r});
  try{await page.route('**/api/fs',async route=>{const body=route.request().postDataJSON();if(body?.op!=='trash')return route.continue();sent++;if(sent===1){started();await hold;}await route.continue();});await root.getByTestId('backup-prune').evaluate((b:HTMLElement)=>{b.click();b.click();});let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([seen,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Trash request not observed')),12000);})]).finally(()=>clearTimeout(timer));assert.equal(await root.getByTestId('backup-prune').isDisabled(),true);release();await root.getByTestId('backup-report').getByText(/pruned 2/i).waitFor({timeout:6000});assert.equal(sent,2);for(let i=0;i<4;i++)assert.equal(await trashed(paths[i]),i<2,paths[i]);}finally{release();await ctx.close();await clear();}
 });
 await test('partial batch and failed inventory refresh retain both warnings until retry',{},async()=>{
  await populate();const {ctx,page,root}=await open();let sent=0,failList=false;
  try{
   await page.route('**/api/fs**',async route=>{const u=new URL(route.request().url());if(route.request().method()==='POST'){const body=route.request().postDataJSON();if(body?.op==='trash'&&++sent===2){failList=true;return route.fulfill({status:500,contentType:'application/json',body:'{"ok":false}'});}}if(route.request().method()==='GET'&&u.searchParams.get('op')==='list'&&u.searchParams.get('path')==='/Backups'&&failList){failList=false;return route.abort('failed');}await route.continue();});
   await root.getByTestId('backup-prune').click();const warning=root.getByTestId('backup-prune-error'),stale=root.getByTestId('backup-inventory-error');await warning.waitFor({timeout:6000});await stale.waitFor({timeout:6000});assert.equal(await root.getByTestId('backup-prune').isDisabled(),true);assert.equal(await trashed(paths[1]),true);assert.equal(await trashed(paths[0]),false);await stale.getByRole('button',{name:'Retry backup inventory'}).click();await stale.waitFor({state:'hidden'});await root.getByTestId('backup-inventory-row').filter({hasText:names[1]}).waitFor({state:'hidden'});await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();assert.equal(await warning.isVisible(),true);
  }finally{await ctx.close();await clear();}
 });
}finally{await clear();await fx.close();finish();}
