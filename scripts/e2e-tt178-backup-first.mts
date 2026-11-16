import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
if(process.env.TT178_FRESH_DATABASE!=='1') throw new Error('requires a newly initialized, exclusive disposable database');
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt178-backup-first');
const path='/Backups/fusion-backup-20241001-1234.json';let created=false;
const stat=async(path:string)=>(await fx.api<{node:{kind:string;trashed:boolean;version:number}|null}>('GET','/api/fs?op=stat&path='+encodeURIComponent(path))).node;
try{
 assert.equal(await stat('/Backups'),null,'refusing non-fresh database');
 await test('first save creates the absent folder and a guarded copy',{},async()=>{
  await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();try{
   await page.clock.setFixedTime(new Date('2024-10-01T12:34:00Z'));await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});
   await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/saved to/i).waitFor({timeout:12000});created=true;const folder=await stat('/Backups'),file=await stat(path);assert.equal(folder?.kind,'dir');assert.equal(folder?.trashed,false);assert.equal(file?.kind,'file');assert.equal(file?.version,1);
  }finally{await ctx.close();}
 });
 await test('a folder in Trash is not restored or written into by save',{},async()=>{
  assert.equal(created,true);await fx.api('POST','/api/fs',{op:'trash',path:'/Backups'});const beforeFolder=await stat('/Backups'),beforeFile=await stat(path);assert.equal(beforeFolder?.trashed,true);assert.equal(beforeFile?.trashed,true);
  await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();try{await page.clock.setFixedTime(new Date('2024-10-01T12:34:00Z'));await fx.ready(page,'backup');const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/not confirmed/i).waitFor({timeout:12000});assert.deepEqual(await stat('/Backups'),beforeFolder);assert.deepEqual(await stat(path),beforeFile);}finally{await ctx.close();}
 });
 await test('an existing file at the folder path is never changed',{},async()=>{
  await fx.api('POST','/api/fs',{op:'purge',path});await fx.api('POST','/api/fs',{op:'purge',path:'/Backups'});await fx.api('POST','/api/fs',{op:'write',path:'/Backups',content:'fixture file',mime:'text/plain'});const before=await stat('/Backups');assert.equal(before?.kind,'file');
  await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();try{await page.clock.setFixedTime(new Date('2024-10-01T12:34:00Z'));await fx.ready(page,'backup');const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/not confirmed/i).waitFor({timeout:12000});assert.deepEqual(await stat('/Backups'),before);assert.equal(await stat(path),null);}finally{await ctx.close();}
 });
 await test('lost folder response stops before any create request',{},async()=>{
  await fx.api('POST','/api/fs',{op:'purge',path:'/Backups'});assert.equal(await stat('/Backups'),null);await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();let writes=0;
  try{await page.clock.setFixedTime(new Date('2024-10-01T12:34:00Z'));await fx.ready(page,'backup');const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});await page.route('**/api/fs',async route=>{const body=route.request().postDataJSON();if(body?.op==='writeIfUnchanged')writes++;if(body?.op==='mkdir'&&body.path==='/Backups'){const real=await route.fetch();assert.equal(real.status(),200);return route.abort('failed');}return route.continue();});await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/not confirmed/i).waitFor({timeout:12000});assert.equal(writes,0);assert.equal((await stat('/Backups'))?.kind,'dir');assert.equal(await stat(path),null);}finally{await ctx.close();}
 });
 await test('parent trashed between folder ensure and file create stays trashed',{},async()=>{
  assert.equal((await stat('/Backups'))?.trashed,false);assert.equal(await stat(path),null);await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();let writes=0;
  try{await page.clock.setFixedTime(new Date('2024-10-01T12:34:00Z'));await fx.ready(page,'backup');const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});await page.route('**/api/fs',async route=>{const body=route.request().postDataJSON();if(body?.op==='writeIfUnchanged'){writes++;await fx.api('POST','/api/fs',{op:'trash',path:'/Backups'});}return route.continue();});await root.getByTestId('backup-save-files').click();await root.getByTestId('backup-report').getByText(/save refused|not confirmed/i).waitFor({timeout:12000});assert.equal(writes,1);assert.equal((await stat('/Backups'))?.trashed,true);assert.equal(await stat(path),null);}finally{await ctx.close();}
 });
}finally{if(created){await fx.api('POST','/api/fs',{op:'purge',path});await fx.api('POST','/api/fs',{op:'purge',path:'/Backups'});}await fx.close();finish();}
