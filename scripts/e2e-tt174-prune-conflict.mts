import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt174-prune-conflict');
const names=['fusion-backup-23030101-0101.json','fusion-backup-23030102-0101.json','fusion-backup-23030103-0101.json'];const paths=names.map(n=>'/Backups/'+n);const created:string[]=[];
try{
 const list=await fx.api<{nodes:unknown[]}>('GET','/api/fs?op=list&path=%2FBackups');assert.equal(list.nodes.length,0,'exclusive empty /Backups required');
 for(const path of paths){const r=await fx.api<{node?:unknown}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.ok(!r.node,`fixture occupied ${path}`);await fx.api('POST','/api/fs',{op:'write',path,content:'original',mime:'text/plain'});created.push(path);}
 await test('concurrent rewrite after listing cannot move the replacement to Trash',{},async()=>{
  await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();await page.clock.setFixedTime(new Date('2304-01-01T12:00:00Z'));page.on('dialog',d=>void d.accept());
  try{await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();let requests=0;
   await page.route('**/api/fs',async route=>{const body=route.request().postDataJSON();if(body?.op==='trashBackupGuarded'){requests++;assert.equal(body.path,paths[0]);await fx.api('POST','/api/fs',{op:'write',path:paths[0],content:'replacement',mime:'text/plain'});}await route.continue();});
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST'&&r.request().postDataJSON()?.op==='trashBackupGuarded');await root.getByTestId('backup-prune').click();await response;const result=await fx.api<{node:{trashed:boolean;content:string;version:number}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(paths[0]));assert.equal(result.node.trashed,false,'concurrently rewritten target must remain live');assert.equal(result.node.version,2);assert.equal(requests,1);await root.getByTestId('backup-prune-error').waitFor({timeout:6000});await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();
  }finally{await ctx.close();}
 });
 await test('malformed guard is rejected and purge/recreate conflicts with old identity',{},async()=>{
  const stat=async()=> (await fx.api<{node:{id:number;version:number;sha256:string;trashed:boolean}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(paths[0]))).node;
  const send=async(expectedTrash:unknown)=>fetch(fx.BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trash',path:paths[0],expectedTrash})});
  const old=await stat();assert.equal((await send(null)).status,400);assert.equal((await send({id:old.id,version:old.version,sha256:'invalid'})).status,400);assert.equal((await stat()).trashed,false);
  await fx.api('POST','/api/fs',{op:'purge',path:paths[0]});await fx.api('POST','/api/fs',{op:'write',path:paths[0],content:'replacement after purge',mime:'text/plain'});const replacement=await stat();assert.notEqual(replacement.id,old.id);assert.equal((await send({id:old.id,version:old.version,sha256:old.sha256})).status,409);assert.equal((await stat()).trashed,false);
  assert.equal((await send({id:replacement.id,version:replacement.version,sha256:replacement.sha256})).status,200);assert.equal((await stat()).trashed,true);
 });
}finally{for(const path of created)await fx.api('POST','/api/fs',{op:'purge',path}).catch(()=>undefined);await fx.close();finish();}
