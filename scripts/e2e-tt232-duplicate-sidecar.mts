import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt232-duplicate-sidecar');
const id=`tt232-${process.pid}-${Date.now()}`;
const a=`/Documents/${id}-a.png`,b=`/Documents/${id}-b.png`,side=`/Documents/.${id}-b.png.edit.json`;
const paths=[a,b,side];
async function setup(){for(const path of [a,b])await fx.api('POST','/api/fs',{op:'write',path,content:id,mime:'image/png'});await fx.api('POST','/api/fs',{op:'write',path:side,content:'old-recipe'});}
async function cleanup(){for(const path of paths)await fx.api('POST','/api/fs',{op:'purge',path});}
async function node(path:string){return (await fx.api<{node:{trashed:boolean;content:string}}>('GET','/api/fs?op=read&path='+encodeURIComponent(path))).node;}
async function open(){await fx.windows('storage');const ctx=await fx.context(),page=await ctx.newPage();await fx.ready(page,'storage');const group=page.getByTestId('storage-duplicate-group').filter({hasText:id});await group.waitFor();return {ctx,page,group};}
try{
 await test('changed sidecar must not be trashed from stale report',{},async()=>{
  await setup();const {ctx,page,group}=await open();try{
   await fx.api('POST','/api/fs',{op:'write',path:side,content:'new-recipe'});
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST');
   await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).click();
   assert.equal((await response).status(),409);assert.equal((await node(b)).trashed,false);assert.equal((await node(side)).trashed,false);assert.equal((await node(side)).content,'new-recipe');
  }finally{await ctx.close();await cleanup();}
 });
 await test('unchanged companion and target trash together',{},async()=>{
  await setup();const {ctx,page,group}=await open();try{
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST');
   await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).click();assert.equal((await response).status(),200);
   assert.equal((await node(b)).trashed,true);assert.equal((await node(side)).trashed,true);assert.equal((await node(a)).trashed,false);
  }finally{await ctx.close();await cleanup();}
 });
 await test('companion created after report prevents both deletions',{},async()=>{
  await setup();await fx.api('POST','/api/fs',{op:'purge',path:side});const {ctx,page,group}=await open();try{
   await fx.api('POST','/api/fs',{op:'write',path:side,content:'new-recipe'});
   const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST');
   await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).click();assert.equal((await response).status(),409);
   assert.equal((await node(b)).trashed,false);assert.equal((await node(side)).trashed,false);
  }finally{await ctx.close();await cleanup();}
 });
 await test('a retained peer that is also the companion cannot be trashed',{},async()=>{
  await setup();try{
   await fx.api('POST','/api/fs',{op:'write',path:side,content:id});
   const target=await node(b) as {id:number;version:number;sha256:string},peer=await node(side) as {id:number;version:number;sha256:string};
   const res=await fetch(fx.BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trashDuplicateWithSidecarGuarded',path:b,expectedTrash:target,duplicatePeer:{...peer,path:side},expectedSidecar:peer})});
   assert.equal(res.status,409);assert.equal((await node(b)).trashed,false);assert.equal((await node(side)).trashed,false);
  }finally{await cleanup();}
 });
 await test('missing companion guard refuses without mutation',{},async()=>{
  await setup();try{
   const target=await node(b) as {id:number;version:number;sha256:string},peer=await node(a) as {id:number;version:number;sha256:string};
   const res=await fetch(fx.BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trashDuplicateWithSidecarGuarded',path:b,expectedTrash:target,duplicatePeer:{...peer,path:a}})});
   assert.equal(res.status,400);assert.equal((await node(b)).trashed,false);assert.equal((await node(side)).trashed,false);
  }finally{await cleanup();}
 });

 await test('old server without companion snapshots fails closed',{},async()=>{
  await setup();await fx.windows('storage');const ctx=await fx.context(),page=await ctx.newPage();try{
   await page.route('**/api/storage',async route=>{const response=await route.fetch();const body=await response.json();for(const group of body.duplicates)for(const item of group.identities)delete item.sidecar;await route.fulfill({response,json:body});});
   await fx.ready(page,'storage');const group=page.getByTestId('storage-duplicate-group').filter({hasText:id});await group.waitFor();
   assert.equal(await group.locator('div.fs-row').filter({hasText:b}).getByRole('button',{name:'Trash'}).isDisabled(),true);
   await page.getByText('Duplicate Trash unavailable: file identities are missing or invalid. Refresh or update the server.').waitFor();
   assert.equal((await node(b)).trashed,false);assert.equal((await node(side)).trashed,false);
  }finally{await ctx.close();await cleanup();}
 });

}finally{await fx.close();finish();}
