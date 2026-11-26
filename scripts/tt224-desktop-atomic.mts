import assert from 'node:assert/strict';
import pg from 'pg';
import {makeHarness} from './harness.mts';
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) throw new Error('exclusive disposable database and BASE required');
const base = process.env.BASE, dsn = process.env.DATABASE_URL, id = `session:tt224-${process.pid}-${Date.now()}`;
const {test,finish} = makeHarness('tt224-desktop-atomic');
async function req(method:string, body?:object) { const r=await fetch(`${base}/api/state${method==='GET'||method==='DELETE'?'?id='+encodeURIComponent(id):''}`, {method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}); return {status:r.status,body:await r.json()}; }
try {
  await test('waiting stale write cannot replace a newer committed revision',{},async()=>{
    assert.equal((await req('PUT',{id,revision:1,state:{marker:'before'}})).status,200);
    const db=new pg.Client({connectionString:dsn}); await db.connect(); let active=false; let pending:ReturnType<typeof req>|undefined;
    try {
      await db.query('BEGIN'); active=true; await db.query('UPDATE desktop_state SET revision=3, state=$2::jsonb WHERE id=$1',[id,JSON.stringify({marker:'newer'})]);
      pending=req('PUT',{id,revision:2,state:{marker:'stale'}});
      let waiting=false;
      for(let i=0;i<100;i++) { await db.query('SELECT pg_stat_clear_snapshot()'); const q=await db.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query ILIKE '%update "desktop_state"%' OR query ILIKE '%insert into "desktop_state"%')`); if(q.rowCount){waiting=true;break;} await new Promise(r=>setTimeout(r,50)); }
      assert.ok(waiting,'HTTP write never reached locked row'); await db.query('COMMIT'); active=false;
      const result=await pending; assert.equal(result.status,409,JSON.stringify(result)); const row=(await req('GET')).body.row; assert.equal(row.revision,3); assert.equal(row.state.marker,'newer');
    } finally {if(active)await db.query('ROLLBACK'); if(pending)await pending.catch(()=>undefined); await db.end();}
  });
  await test('create race keeps the greatest revision and equal revisions retain compatibility',{},async()=>{
    await req('DELETE');
    const [a,b]=await Promise.all([req('PUT',{id,revision:11,state:{marker:'high'}}),req('PUT',{id,revision:10,state:{marker:'low'}})]);
    assert.equal(a.status,200); assert.ok([200,409].includes(b.status));
    let row=(await req('GET')).body.row; assert.equal(row.revision,11); assert.equal(row.state.marker,'high');
    const generation=row.generation;
    const stale=await req('PUT',{id,revision:10,state:{marker:'stale'}}); assert.equal(stale.status,409);
    row=(await req('GET')).body.row; assert.equal(row.generation,generation); assert.equal(row.state.marker,'high');
    assert.equal((await req('PUT',{id,revision:11,state:{marker:'equal'}})).status,200);
    row=(await req('GET')).body.row; assert.equal(row.state.marker,'equal'); assert.notEqual(row.generation,generation);
  });
} finally {await req('DELETE').catch(()=>undefined);finish();}
