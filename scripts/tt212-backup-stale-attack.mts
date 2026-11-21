// Opt-in reproduction of TT212's former stale-inventory counterexample.
// The fixed app should refuse to Trash any copy in this specific schedule.
import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
const fx=await disposableShell();
const names=['fusion-backup-20240101-1200.json','fusion-backup-20240102-1200.json','fusion-backup-20240103-1200.json','fusion-backup-20240104-1200.json','fusion-backup-20310101-1200.json'];
const paths=names.map(n=>'/Backups/'+n),owned:string[]=[];
try{
 await fx.api('POST','/api/fs',{op:'mkdir',path:'/Backups'});
 const listing=await fx.api<{nodes:unknown[]}>('GET','/api/fs?op=list&path=%2FBackups');assert.equal(listing.nodes.length,0,'requires exclusive empty disposable backup folder');
 for(const path of paths){const {node}=await fx.api<{node:unknown}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.equal(node,null,`fixture occupied: ${path}`);}
 for(const path of paths.slice(0,4)){await fx.api('POST','/api/fs',{op:'write',path,content:'tt212-owned'});owned.push(path);}
 await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();
 try{
  await page.clock.setFixedTime(new Date('2025-01-01T12:00:00Z'));page.on('dialog',d=>void d.accept());
  await fx.ready(page,'backup');const root=page.locator('[data-win-id="w1"]');await root.getByTestId('backup-inventory-row').filter({hasText:names[0]}).waitFor();
  await fx.api('POST','/api/fs',{op:'write',path:paths[4],content:'tt212-future'});owned.push(paths[4]);
  await root.getByTestId('backup-prune').click();await root.getByTestId('backup-prune-error').waitFor({timeout:12000});
  const states=[];for(const path of paths){const {node}=await fx.api<{node:{trashed:boolean}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));states.push(node.trashed);}
  assert.deepEqual(states,[false,false,false,false,false]);
  console.log('STALE-INVENTORY ATTACK REFUSED: all five real files remain live');
 }finally{await ctx.close();}
}finally{for(const path of owned)await fx.api('POST','/api/fs',{op:'purge',path}).catch(()=>undefined);await fx.close();}
