import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
import pg from 'pg';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt213-backup-inventory-guard');
const names=['fusion-backup-20240101-1200.json','fusion-backup-20240102-1200.json','fusion-backup-20240103-1200.json','fusion-backup-20240104-1200.json','fusion-backup-20310101-1200.json'];
const paths=names.map(n=>'/Backups/'+n),owned=new Set<string>();
async function setup(){
 const list=await fx.api<{nodes:unknown[]}>('GET','/api/fs?op=list&path=%2FBackups');assert.equal(list.nodes.length,0,'requires exclusive empty disposable backup folder');
 for(const path of paths){const {node}=await fx.api<{node:unknown}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.equal(node,null,`fixture occupied: ${path}`);}
 for(const path of paths.slice(0,4)){await fx.api('POST','/api/fs',{op:'write',path,content:'tt213-owned'});owned.add(path);}
}
async function cleanup(){for(const path of owned){await fx.api('POST','/api/fs',{op:'purge',path});owned.delete(path);}}
async function open(){await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();await page.clock.setFixedTime(new Date('2025-01-01T12:00:00Z'));page.on('dialog',d=>void d.accept());await fx.ready(page,'backup');const root=page.locator('[data-win-id="w1"]');await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();return {ctx,page,root};}
async function trashed(){const states=[];for(const path of paths){const {node}=await fx.api<{node:{trashed:boolean}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.ok(node);states.push(node.trashed);}return states;}
try{
 await fx.api('POST','/api/fs',{op:'mkdir',path:'/Backups'});
 await test('future copy created after list aborts before any deletion',{},async()=>{
  await setup();const {ctx,root}=await open();try{
   await fx.api('POST','/api/fs',{op:'write',path:paths[4],content:'tt213-future'});owned.add(paths[4]);
   await root.getByTestId('backup-prune').click();await root.getByTestId('backup-prune-error').or(root.getByTestId('backup-report').getByText(/pruned/i)).first().waitFor({timeout:12000});
   assert.deepEqual(await trashed(),[false,false,false,false,false]);assert.equal(await root.getByTestId('backup-prune-error').isVisible(),true);
  }finally{await ctx.close();await cleanup();}
 });
 await test('new copy between two requests stops the remaining batch',{},async()=>{
  await setup();const {ctx,page,root}=await open();let requests=0;
  try{
   await page.route('**/api/fs',async route=>{
    if(route.request().method()!=='POST'||route.request().postDataJSON()?.op!=='trashBackupGuarded')return route.continue();
    requests++;if(requests===2){await fx.api('POST','/api/fs',{op:'write',path:paths[4],content:'tt213-future'});owned.add(paths[4]);}await route.continue();
   });
   await root.getByTestId('backup-prune').click();await root.getByTestId('backup-prune-error').or(root.getByTestId('backup-report').getByText(/pruned/i)).first().waitFor({timeout:12000});
   assert.equal(requests,2);assert.deepEqual(await trashed(),[false,true,false,false,false]);assert.equal(await root.getByTestId('backup-prune-error').isVisible(),true);
  }finally{await ctx.close();await cleanup();}
 });
 await test('rewriting a kept copy after listing stops deletion of other copies',{},async()=>{
  await setup();const {ctx,root}=await open();try{
   await fx.api('POST','/api/fs',{op:'write',path:paths[3],content:'changed kept copy'});
   await root.getByTestId('backup-prune').click();await root.getByTestId('backup-prune-error').or(root.getByTestId('backup-report').getByText(/pruned/i)).first().waitFor({timeout:12000});
   for(const path of paths.slice(0,4)){const {node}=await fx.api<{node:{trashed:boolean}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.equal(node.trashed,false,path);}
   assert.equal(await root.getByTestId('backup-prune-error').isVisible(),true);
  }finally{await ctx.close();await cleanup();}
 });
 await test('malformed inventory guards refuse without trashing the target',{},async()=>{
  await setup();try{
   const {node}=await fx.api<{node:{id:number;version:number;sha256:string}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(paths[0]));
   const guard={id:node.id,version:node.version,sha256:node.sha256},entry={name:names[0],...guard};
   for(const inventory of [undefined,null,[],[entry,entry],[{...entry,name:'../escape'}]]){
    const response=await fetch(fx.BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trashBackupGuarded',path:paths[0],expectedTrash:guard,expectedBackupInventory:inventory})});assert.equal(response.status,400);
   }
   const {node:after}=await fx.api<{node:{trashed:boolean}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(paths[0]));assert.equal(after.trashed,false);
  }finally{await cleanup();}
 });
 await test('uncommitted cooperating writer blocks prune then invalidates the inventory',{},async()=>{
  await setup();const {ctx,page,root}=await open();const db=new pg.Client({connectionString:process.env.DATABASE_URL});let committed=false;
  try{
   await db.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock_shared(1179997001, 1447449413)');
   await db.query("INSERT INTO vfs_nodes (path,parent,name,kind,content) VALUES ($1,'/Backups',$2,'file','tt213-lock-test')",[paths[4],names[4]]);
   const request=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/fs')&&r.postDataJSON()?.op==='trashBackupGuarded');
   const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/fs')&&r.request().postDataJSON()?.op==='trashBackupGuarded');
   await root.getByTestId('backup-prune').click();await request;
   let timer:ReturnType<typeof setTimeout>|undefined;const early=await Promise.race([response.then(()=>true),new Promise<boolean>(r=>{timer=setTimeout(()=>r(false),300);})]).finally(()=>clearTimeout(timer));assert.equal(early,false,'exclusive guard must wait for the writer');
   await db.query('COMMIT');committed=true;owned.add(paths[4]);assert.equal((await response).status(),409);await root.getByTestId('backup-prune-error').waitFor();assert.deepEqual(await trashed(),[false,false,false,false,false]);
  }finally{if(!committed)await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{});await ctx.close();await cleanup();}
 });
}finally{await cleanup();await fx.close();finish();}
