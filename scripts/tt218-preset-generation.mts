import assert from 'node:assert/strict';
import pg from 'pg';
import {makeHarness} from './harness.mts';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.DATABASE_URL||!process.env.BASE)throw new Error('exclusive disposable database and BASE required');
const base=process.env.BASE,{test,finish}=makeHarness('tt218-preset-generation'),name=`tt218-${process.pid}-${Date.now()}`,id=`preset:${name}`,path='/api/state?id='+encodeURIComponent(id);
async function call(method:string,path:string,body?:unknown){const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
const create=async(title:string)=>call('POST','/api/state',{op:'createPreset',name,state:{windows:[{title}]}});
const generation=async()=>{const list=await call('GET','/api/state?list=preset');assert.equal(list.status,200);const row=list.body.rows.find((x:{id:string})=>x.id===id);assert.ok(row);assert.match(row.generation,/^[0-9a-f-]{36}$/);return row.generation as string;};
const del=async(g:string)=>call('POST','/api/state',{op:'deletePresetGuarded',id,generation:g});
try{
 assert.equal((await call('GET',path)).body.row,null);
 await test('stale generation cannot delete replacement',{},async()=>{
  assert.equal((await create('old')).status,200);const old=await generation();assert.equal((await del(old)).status,200);assert.equal((await create('replacement')).status,200);const fresh=await generation();assert.notEqual(fresh,old);assert.equal((await del(old)).status,409);assert.equal((await call('GET',path)).body.row.state.windows[0].title,'replacement');
 });
 await test('updated preset invalidates previous generation',{},async()=>{
  const old=await generation();assert.equal((await call('PUT','/api/state',{id,state:{windows:[{title:'updated'}]},revision:2})).status,200);const fresh=await generation();assert.notEqual(fresh,old);assert.equal((await del(old)).status,409);assert.equal((await call('GET',path)).body.row.state.windows[0].title,'updated');assert.equal((await del(fresh)).status,200);
 });
 await test('locked update invalidates a waiting guarded delete',{},async()=>{
  assert.equal((await create('before-lock')).status,200);const old=await generation();const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();let active=false;let pending:Promise<{status:number;body:any}>|undefined;
  try{
   await db.query('BEGIN');active=true;await db.query('UPDATE desktop_state SET generation=gen_random_uuid(), state=$2::jsonb WHERE id=$1',[id,JSON.stringify({windows:[{title:'locked-update'}]})]);
   pending=del(old);let waiting=false;for(let i=0;i<100;i++){await db.query("SELECT pg_stat_clear_snapshot()");const q=await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%delete from \"desktop_state\"%'");if(q.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(waiting,'guarded delete must wait on row lock');
   await db.query('COMMIT');active=false;assert.equal((await pending).status,409);assert.equal((await call('GET',path)).body.row.state.windows[0].title,'locked-update');
  }finally{if(active)await db.query('ROLLBACK');if(pending)await pending.catch(()=>undefined);await db.end();}
 });
 await test('malformed token and non-preset id fail closed',{},async()=>{
  assert.equal((await del('not-a-uuid')).status,400);assert.equal((await call('POST','/api/state',{op:'deletePresetGuarded',id:'default',generation:'00000000-0000-4000-8000-000000000000'})).status,400);
 });
}finally{await call('DELETE',path).catch(()=>undefined);finish();}
