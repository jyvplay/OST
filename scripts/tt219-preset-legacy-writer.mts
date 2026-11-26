import assert from 'node:assert/strict';
import pg from 'pg';
import {makeHarness} from './harness.mts';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.DATABASE_URL||!process.env.BASE)throw new Error('exclusive disposable DB and BASE required');
const base=process.env.BASE,{test,finish}=makeHarness('tt219-preset-legacy-writer');const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const prefix=`tt219-${process.pid}-${Date.now()}`,ids=['update','insert','disabled'].map(x=>`preset:${prefix}-${x}`);
const create=async(id:string)=>{const r=await fetch(base+'/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'createPreset',name:id.slice(7),state:{windows:[]}})});assert.equal(r.status,200);};
const gen=async(id:string)=>(await db.query('SELECT generation FROM desktop_state WHERE id=$1',[id])).rows[0].generation as string;
const guarded=async(id:string,generation:string)=>fetch(base+'/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'deletePresetGuarded',id,generation})});
let disabled=false;
try{
 for(const id of ids)assert.equal((await db.query('SELECT id FROM desktop_state WHERE id=$1',[id])).rowCount,0);
 await test('legacy SQL update changes generation and rejects stale delete',{},async()=>{
  await create(ids[0]);const old=await gen(ids[0]);await db.query('UPDATE desktop_state SET state=$2::jsonb, revision=2 WHERE id=$1',[ids[0],JSON.stringify({windows:[{title:'legacy-update'}]})]);assert.notEqual(await gen(ids[0]),old);assert.equal((await guarded(ids[0],old)).status,409);assert.equal((await db.query('SELECT state FROM desktop_state WHERE id=$1',[ids[0]])).rows[0].state.windows[0].title,'legacy-update');
 });
 await test('explicitly reused token on insert cannot impersonate a prior generation',{},async()=>{
  await create(ids[1]);const old=await gen(ids[1]);await db.query('DELETE FROM desktop_state WHERE id=$1',[ids[1]]);await db.query('INSERT INTO desktop_state (id,state,revision,generation) VALUES ($1,$2::jsonb,1,$3::uuid)',[ids[1],JSON.stringify({windows:[{title:'replacement'}]}),old]);assert.notEqual(await gen(ids[1]),old);assert.equal((await guarded(ids[1],old)).status,409);assert.equal((await db.query('SELECT state FROM desktop_state WHERE id=$1',[ids[1]])).rows[0].state.windows[0].title,'replacement');
 });
 // Only run this invasive trigger-state case against a disposable exclusive DB.
 await test('disabled guard trigger makes guarded deletion fail closed',{},async()=>{
  await create(ids[2]);const current=await gen(ids[2]);await db.query('ALTER TABLE desktop_state DISABLE TRIGGER ost_desktop_generation_guard');disabled=true;
  const response=await guarded(ids[2],current);assert.notEqual(response.status,200);assert.equal((await db.query('SELECT id FROM desktop_state WHERE id=$1',[ids[2]])).rowCount,1);
 });
}finally{if(disabled)await db.query('ALTER TABLE desktop_state ENABLE TRIGGER ost_desktop_generation_guard');for(const id of ids)await db.query('DELETE FROM desktop_state WHERE id=$1',[id]);await db.end();finish();}
