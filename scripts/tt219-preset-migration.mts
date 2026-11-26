import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {makeHarness} from './harness.mts';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.DATABASE_URL||!process.env.BASE)throw new Error('exclusive disposable DB and BASE required');
const {test,finish}=makeHarness('tt219-preset-migration'),db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const name=`tt219-migrate-${process.pid}-${Date.now()}`,id=`preset:${name}`,sql=await readFile('src/db/migrations/tt219-preset-generation-trigger.sql','utf8');
try{
 await test('migration invalidates pre-install stale generations and preserves data on rerun',{},async()=>{
  assert.equal((await db.query('SELECT id FROM desktop_state WHERE id=$1',[id])).rowCount,0);
  await db.query('ALTER TABLE desktop_state DISABLE TRIGGER ost_desktop_generation_guard');
  await db.query('INSERT INTO desktop_state(id,state,revision) VALUES($1,$2::jsonb,1)',[id,JSON.stringify({windows:[{title:'before'}]})]);
  const old=(await db.query('SELECT generation FROM desktop_state WHERE id=$1',[id])).rows[0].generation;
  await db.query('UPDATE desktop_state SET state=$2::jsonb,revision=2 WHERE id=$1',[id,JSON.stringify({windows:[{title:'legacy-edit'}]})]);
  await db.query(sql);const once=(await db.query('SELECT state,revision,generation FROM desktop_state WHERE id=$1',[id])).rows[0];assert.notEqual(once.generation,old);assert.equal(once.state.windows[0].title,'legacy-edit');assert.equal(once.revision,2);
  const r=await fetch(process.env.BASE+'/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'deletePresetGuarded',id,generation:old})});assert.equal(r.status,409);
  await db.query(sql);const twice=(await db.query('SELECT state,revision,generation FROM desktop_state WHERE id=$1',[id])).rows[0];assert.deepEqual(twice.state,once.state);assert.equal(twice.revision,once.revision);assert.notEqual(twice.generation,once.generation);
 });
}finally{await db.query(sql);await db.query('DELETE FROM desktop_state WHERE id=$1',[id]);await db.end();finish();}
