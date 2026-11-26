import assert from 'node:assert/strict';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';
import pg from 'pg';
import { createHash } from 'node:crypto';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt231-storage-duplicates');
const prefix=`tt231-${process.pid}-${Date.now()}`, a=`/Documents/${prefix}-a.txt`, b=`/Documents/${prefix}-b.txt`;
const owned=new Set<string>();
async function setup(){for(const path of [a,b]){await fx.api('POST','/api/fs',{op:'write',path,content:prefix});owned.add(path);}}
async function cleanup(){for(const path of owned){await fx.api('POST','/api/fs',{op:'purge',path});owned.delete(path);}}
async function open(){await fx.windows('storage');const ctx=await fx.context(),page=await ctx.newPage();await fx.ready(page,'storage');const group=page.getByTestId('storage-duplicate-group').filter({hasText:prefix});await group.waitFor();return {ctx,page,group};}
async function active(path:string){const {node}=await fx.api<{node:{trashed:boolean;content?:string}}>('GET','/api/fs?op=read&path='+encodeURIComponent(path));return node;}
try{
 await test('changed target is not trashed from a stale duplicate report',{},async()=>{
  await setup();const {ctx,page,group}=await open();try{
   await fx.api('POST','/api/fs',{op:'write',path:b,content:prefix+'-changed'});
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST');
   await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).click();assert.equal((await response).status(),409);
   await page.getByRole('alert').getByText(/Trash not confirmed/).waitFor();
   const node=await active(b);assert.equal(node.trashed,false,'changed target must survive');assert.equal(node.content,prefix+'-changed');
  }finally{await ctx.close();await cleanup();}
 });
 await test('changed retained copy prevents discarding the last matching copy',{},async()=>{
  await setup();const {ctx,page,group}=await open();try{
   await fx.api('POST','/api/fs',{op:'write',path:a,content:prefix+'-changed'});
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST');
   await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).click();assert.equal((await response).status(),409);
   await page.getByRole('alert').getByText(/Trash not confirmed/).waitFor();
   const node=await active(b);assert.equal(node.trashed,false,'last matching copy must survive');assert.equal(node.content,prefix);
  }finally{await ctx.close();await cleanup();}
 });
 await test('unchanged duplicates allow one guarded Trash and retain the other',{},async()=>{
  await setup();const {ctx,page,group}=await open();try{
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST');
   await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).click();assert.equal((await response).status(),200);
   assert.equal((await active(a)).trashed,false);assert.equal((await active(b)).trashed,true);
  }finally{await ctx.close();await cleanup();}
 });
 await test('concurrent opposing requests cannot discard both copies',{},async()=>{
  await setup();try{
   const first=await active(a) as {id:number;version:number;sha256:string}, second=await active(b) as {id:number;version:number;sha256:string};
   const guarded=(path:string,t:typeof first,peerPath:string,peer:typeof first)=>fetch(fx.BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trashDuplicateGuarded',path,expectedTrash:{id:t.id,version:t.version,sha256:t.sha256},duplicatePeer:{path:peerPath,id:peer.id,version:peer.version,sha256:peer.sha256}})});
   const responses=await Promise.all([guarded(a,first,b,second),guarded(b,second,a,first)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
   const states=[(await active(a)).trashed,(await active(b)).trashed];assert.equal(states.filter(x=>!x).length,1);
  }finally{await cleanup();}
 });
 await test('lost acknowledgement is reported as uncertain after actual commit',{},async()=>{
  await setup();const {ctx,page,group}=await open();try{
   await page.route('**/api/fs',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON()?.op==='trashDuplicateGuarded'){await route.fetch();await route.abort('failed');}else await route.continue();});
   await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).click();
   await page.getByRole('alert').getByText(/may have completed/).waitFor();assert.equal((await active(b)).trashed,true);assert.equal((await active(a)).trashed,false);
  }finally{await ctx.close();await cleanup();}
 });
 await test('invalid or missing peer guard fails closed',{},async()=>{
  await setup();try{
   const t=await active(b) as {id:number;version:number;sha256:string};
   for(const peer of [undefined,null,{path:b,id:t.id,version:t.version,sha256:t.sha256},{path:a,id:t.id,version:t.version,sha256:'x'}]){
    const response=await fetch(fx.BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trashDuplicateGuarded',path:b,expectedTrash:{id:t.id,version:t.version,sha256:t.sha256},duplicatePeer:peer})});assert.equal(response.status,400);
   }
   assert.equal((await active(a)).trashed,false);assert.equal((await active(b)).trashed,false);
  }finally{await cleanup();}
 });

 await test('older server without identities disables destructive actions with an explanation',{},async()=>{
  await setup();await fx.windows('storage');const ctx=await fx.context(),page=await ctx.newPage();try{
   await page.route('**/api/storage',async route=>{const response=await route.fetch();const body=await response.json();for(const group of body.duplicates)delete group.identities;await route.fulfill({response,json:body});});
   await fx.ready(page,'storage');const group=page.getByTestId('storage-duplicate-group').filter({hasText:prefix});await group.waitFor();
   await page.getByText('Duplicate Trash unavailable: file identities are missing or invalid. Refresh or update the server.').waitFor();
   assert.equal(await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).isDisabled(),true);
   assert.equal((await active(a)).trashed,false);assert.equal((await active(b)).trashed,false);
  }finally{await ctx.close();await cleanup();}
 });

 await test('guard waits for a cooperating writer then rejects its changed peer',{},async()=>{
  await setup();const db=new pg.Client({connectionString:process.env.DATABASE_URL});let committed=false;
  try{
   const first=await active(a) as {id:number;version:number;sha256:string},second=await active(b) as {id:number;version:number;sha256:string};
   await db.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock_shared(1179997001, 1447449413)');
   const content=prefix+'-locked-change',hash=createHash('sha256').update(content).digest('hex');
   await db.query('UPDATE vfs_nodes SET content=$1, sha256=$2, version=version+1 WHERE path=$3',[content,hash,a]);
   const response=fetch(fx.BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trashDuplicateGuarded',path:b,expectedTrash:{id:second.id,version:second.version,sha256:second.sha256},duplicatePeer:{path:a,id:first.id,version:first.version,sha256:first.sha256}})});
   let timer:ReturnType<typeof setTimeout>|undefined;const early=await Promise.race([response.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),300);})]).finally(()=>clearTimeout(timer));assert.equal(early,false,'guard must wait for the cooperating writer');
   await db.query('COMMIT');committed=true;assert.equal((await response).status,409);assert.equal((await active(b)).trashed,false);assert.equal((await active(a)).content,content);
  }finally{if(!committed)await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{});await cleanup();}
 });

}finally{await cleanup();await fx.close();finish();}
