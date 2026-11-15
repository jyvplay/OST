import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx = await disposableShell(), {test, finish} = makeHarness('e2e-tt175-backup-dates');
const names = ['fusion-backup-20230230-0101.json','fusion-backup-20240301-0101.json','fusion-backup-20250301-0101.json','fusion-backup-20260301-0101.json'];
const paths = names.map(n => '/Backups/' + n), owned: string[] = [];
try {
  const listing = await fx.api<{nodes:unknown[]}>('GET','/api/fs?op=list&path=%2FBackups');
  assert.equal(listing.nodes.length,0,'requires an exclusive empty disposable Backups folder');
  for (const path of paths) { const {node} = await fx.api<{node:unknown}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path)); assert.equal(node,null); await fx.api('POST','/api/fs',{op:'write',path,content:'owned fixture',mime:'text/plain'}); owned.push(path); }
  await test('impossible date remains unknown and survives real pruning',{},async()=>{
    await fx.windows('backup'); const ctx=await fx.context(),page=await ctx.newPage(); page.on('dialog',d=>void d.accept());
    try {
      await fx.ready(page,'backup'); await page.locator('[data-shell-ready="true"]').waitFor(); const root=page.locator('[data-win-id="w1"]');
      const invalid=root.getByTestId('backup-inventory-row').filter({hasText:names[0]}); await invalid.waitFor();
      await root.getByTestId('backup-prune').click(); await root.getByTestId('backup-report').getByText(/pruned/i).waitFor({timeout:12000});
      const statuses=[]; for (const path of paths) {const r=await fx.api<{node:{trashed:boolean}|null}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path));assert.ok(r.node);statuses.push(r.node.trashed);}
      assert.deepEqual(statuses,[false,true,false,false],'invalid date must survive; only oldest valid copy should move');
      assert.match(await invalid.innerText(),/date unknown/);
    } finally {await ctx.close();}
  });
  await test('a stale second tab does not repeat a first tab prune',{},async()=>{
    await fx.api('POST','/api/fs',{op:'restore',path:paths[1]});
    await fx.windows('backup'); const ctx=await fx.context(), first=await ctx.newPage(), second=await ctx.newPage();
    first.on('dialog',d=>void d.accept()); second.on('dialog',d=>void d.accept());
    try {
      await fx.ready(first,'backup'); await fx.ready(second,'backup');
      const a=first.locator('[data-win-id="w1"]'),b=second.locator('[data-win-id="w1"]');
      await a.getByTestId('backup-inventory-row').filter({hasText:names[1]}).waitFor();await b.getByTestId('backup-inventory-row').filter({hasText:names[1]}).waitFor();
      await a.getByTestId('backup-prune').click();await a.getByTestId('backup-report').getByText(/pruned/i).waitFor({timeout:12000});
      await b.getByTestId('backup-prune').click();await b.getByTestId('backup-prune-error').waitFor({timeout:12000});
      await b.getByTestId('backup-inventory-row').filter({hasText:names[1]}).waitFor({state:'hidden'});
      for(const i of [0,2,3]){const {node}=await fx.api<{node:{trashed:boolean}}>('GET','/api/fs?op=stat&path='+encodeURIComponent(paths[i]));assert.equal(node.trashed,false,names[i]);}
    } finally {await ctx.close();}
  });
} finally {for (const path of owned) await fx.api('POST','/api/fs',{op:'purge',path}).catch(()=>undefined); await fx.close(); finish();}
