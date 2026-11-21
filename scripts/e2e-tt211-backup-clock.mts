import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt211-backup-clock');
const names=['fusion-backup-20250101-1200.json','fusion-backup-20250102-1200.json','fusion-backup-20250103-1159.json','fusion-backup-20300101-1200.json'];
const paths=names.map(n=>'/Backups/'+n),owned:string[]=[];
try{
 await fx.api('POST','/api/fs',{op:'mkdir',path:'/Backups'});
 const listing=await fx.api<{nodes:unknown[]}>('GET','/api/fs?op=list&path=%2FBackups');assert.equal(listing.nodes.length,0,'exclusive empty disposable backup folder required');
 for(const path of paths){const {node}=await fx.api<{node:unknown}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.equal(node,null);await fx.api('POST','/api/fs',{op:'write',path,content:'fixture',mime:'text/plain'});owned.push(path);}
 await test('future copy is unknown and cannot cause any actual Trash request',{},async()=>{
  await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();let trashes=0;
  try{
   await page.clock.setFixedTime(new Date('2025-01-03T12:00:00Z'));
   await page.addInitScript(()=>localStorage.setItem('fusion.last-backup.v1',String(Date.parse('2030-01-01T12:00:00Z'))));
   page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/fs')&&r.postDataJSON()?.op==='trash')trashes++;});
   await fx.ready(page,'backup');const root=page.locator('[data-win-id="w1"]');
   const future=root.getByTestId('backup-inventory-row').filter({hasText:names[3]});await future.waitFor();assert.match(await future.innerText(),/date unknown/i);
   await page.waitForFunction(()=>/time unknown.*clock/i.test(document.querySelector('[data-testid="backup-freshness"]')?.textContent??''));
   await root.getByTestId('backup-prune').click();await root.getByTestId('backup-report').getByText(/prune refused.*future/i).waitFor();assert.equal(trashes,0);
   for(const path of paths){const {node}=await fx.api<{node:{trashed:boolean}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.ok(node);assert.equal(node.trashed,false,path);}
  }finally{await ctx.close();}
 });
}finally{for(const path of owned)await fx.api('POST','/api/fs',{op:'purge',path}).catch(()=>undefined);await fx.close();finish();}
