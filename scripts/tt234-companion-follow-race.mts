import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { makeHarness } from './harness.mts';
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) throw new Error('Exclusive disposable database and BASE required');
const base=process.env.BASE, db=new pg.Client({connectionString:process.env.DATABASE_URL}), observer=new pg.Client({connectionString:process.env.DATABASE_URL}),{test,finish}=makeHarness('tt234-companion-follow-race');
await db.connect(); await observer.connect();
const id=`tt234-${process.pid}-${Date.now()}`, photo=`/Documents/${id}.png`, side=`/Documents/.${id}.png.edit.json`;
async function op(name:string,path:string,extra:object={}) { const r=await fetch(base+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:name,path,...extra})});const body=await r.json();if(!r.ok) throw new Error(`${name}: ${r.status} ${JSON.stringify(body)}`);return body; }
async function get(path:string) {const r=await fetch(base+'/api/fs?op=read&path='+encodeURIComponent(path));if(r.status===404)return null;if(!r.ok)throw new Error(`read: ${r.status}`);return (await r.json()).node;}
async function setup(){await op('write',photo,{content:'photo'});await op('write',side,{content:'old'});}
async function cleanup(){await op('purge',photo);await op('purge',side);}
async function waitForBlocker(pid:number) {const end=Date.now()+8000;while(Date.now()<end){const r=await observer.query('select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',[pid]);if(r.rowCount)return;await new Promise(r=>setTimeout(r,30));}throw new Error('No real PostgreSQL lock waiter observed');}
async function race(action:'trash'|'restore'|'purge', contentOnly=false) {
 await setup();if(action==='restore')await op('trash',photo);
 const {rows:[{pid}]}=await db.query('select pg_backend_pid() as pid');
 await db.query('begin');
 let pending:Promise<any>|undefined;
 try {
  const content='changed-after-read';const digest=createHash('sha256').update(content).digest('hex');
  if(contentOnly) await db.query('update vfs_nodes set content=$1 where path=$2',[content,side]);
  else await db.query('update vfs_nodes set content=$1,size=$2,sha256=$3,version=version+1,updated_at=now() where path=$4',[content,Buffer.byteLength(content),digest,side]);
  pending=op(action,photo);
  await waitForBlocker(pid);
  // The waiting request has read the previous committed companion and is blocked
  // acquiring its row. Commit the competing change, then observe the real result.
  await db.query('commit');
  const result=await pending;pending=undefined;
  const after=await get(side);
  assert.equal(after?.content,content,'changed companion must survive');
  assert.equal(after?.trashed,action==='restore','companion trash state must remain unchanged');
  assert.match(String(result.sidecar),/^not followed:/);
 } finally {await db.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await cleanup();}
}
try {for(const action of ['trash','restore','purge'] as const)await test(`${action} rejects companion changed while follow waits`,{},()=>race(action));await test('purge detects changed content even when metadata is unchanged',{},()=>race('purge',true));}
finally {await db.end();await observer.end();finish();}
