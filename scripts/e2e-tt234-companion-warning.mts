import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt234-companion-warning');
const lock=new pg.Client({connectionString:process.env.DATABASE_URL}), observer=new pg.Client({connectionString:process.env.DATABASE_URL});await lock.connect();await observer.connect();
const id=`tt234-ui-${process.pid}-${Date.now()}`,photo=`/Documents/${id}.png`,side=`/Documents/.${id}.png.edit.json`;
try{
 await fx.api('POST','/api/fs',{op:'write',path:photo,content:'photo'});await fx.api('POST','/api/fs',{op:'write',path:side,content:'old'});
 const current=await fx.api<{row?:{revision?:number}}>('GET','/api/state?id=default');
 await fx.api('PUT','/api/state',{id:'default',revision:Number(current.row?.revision??0)+1000,state:{windows:[{id:'w1',module:'files',title:'Files',x:20,y:16,w:1400,h:900,z:10,workspace:1,props:{path:'/Documents'}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
 const ctx=await fx.context();try{
  const page=await ctx.newPage();await fx.ready(page,'files');const row=page.locator(`[role="option"][data-path="${photo}"]`);await row.waitFor();
  await test('Files exposes a real partial companion outcome and retains it until dismissed',{},async()=>{
   await row.click();const {rows:[{pid}]}=await lock.query('select pg_backend_pid() as pid');await lock.query('begin');let committed=false;
   try{
    const content='edited during follow',hash=createHash('sha256').update(content).digest('hex');await lock.query('update vfs_nodes set content=$1,size=$2,sha256=$3,version=version+1 where path=$4',[content,Buffer.byteLength(content),hash,side]);
    const response=page.waitForResponse(r=>r.url().endsWith('/api/fs')&&r.request().method()==='POST'&&r.request().postDataJSON()?.op==='trash');
    await page.keyboard.press('Delete');const until=Date.now()+10000;let waiting=false;
    while(Date.now()<until){if((await observer.query('select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',[pid])).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,30));}
    assert.ok(waiting,'real PostgreSQL waiter observed');await lock.query('commit');committed=true;
    const result=await (await response).json();assert.match(result.sidecar,/^not followed:/);
    const warning=page.getByTestId('files-companion-warning');await expect(warning).toContainText('primary completed, companion not confirmed');await expect(warning).toContainText(photo);
    const db=await observer.query('select trashed,content from vfs_nodes where path=$1',[side]);assert.equal(db.rows[0].trashed,false);assert.equal(db.rows[0].content,content);
    await warning.getByRole('button',{name:'Dismiss warnings'}).click();await expect(warning).toHaveCount(0);
   }finally{if(!committed)await lock.query('rollback').catch(()=>{});}
  });
 }finally{await ctx.close();}
}finally{try{await fx.api('POST','/api/fs',{op:'purge',path:photo});await fx.api('POST','/api/fs',{op:'purge',path:side});}finally{await lock.end();await observer.end();await fx.close();finish();}}
