import assert from 'node:assert/strict';
import pg from 'pg';
import {makeHarness} from './harness.mts';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.DATABASE_URL||!process.env.BASE)throw new Error('exclusive disposable BASE and DATABASE_URL required');
const {test,finish}=makeHarness('tt167-token-atomicity'), db=new pg.Client({connectionString:process.env.DATABASE_URL}), locker=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();await locker.connect();const tag=`tt167-${Date.now()}-${process.pid}`;const ids:string[]=[];
const req=async(method:string,path:string,body?:unknown)=>fetch(process.env.BASE+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const mint=async(name:string)=>{const r=await req('POST','/api/automation/tokens',{name,scopes:['read']});assert.equal(r.status,201);const data=await r.json() as {id:string};ids.push(data.id);return data.id;};
const fault=async(action:string,condition:string,run:()=>Promise<void>)=>{const suffix=`${process.pid}_${Date.now()}`, fn=`tt167_f_${suffix}`,tr=`tt167_t_${suffix}`;
 try{await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = '${action}' AND ${condition} THEN RAISE EXCEPTION 'TT167 audit fault'; END IF; RETURN NEW; END $$`);await db.query(`CREATE TRIGGER ${tr} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);await run();}
 finally{await db.query(`DROP TRIGGER IF EXISTS ${tr} ON audit_log`);await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);}};
try{
 await test('creation and audit roll back together on audit failure',{},async()=>{
  await fault('automation.token.created',`EXISTS (SELECT 1 FROM automation_tokens t WHERE t.name = '${tag}-failed' AND NEW.detail LIKE t.id || ' (%')`,async()=>{
   const r=await req('POST','/api/automation/tokens',{name:`${tag}-failed`,scopes:['read']});assert.equal(r.status,500);
   const result=await db.query('SELECT id FROM automation_tokens WHERE name=$1',[`${tag}-failed`]);assert.equal(result.rowCount,0,'no token may remain after audit failure');
  });
 });
 await test('revocation and audit roll back together on audit failure',{},async()=>{
  const id=await mint(`${tag}-revoke-fault`);
  await fault('automation.token.revoked',`NEW.detail = '${id}'`,async()=>{
   const before=await db.query('SELECT secret_hash,revoked_at FROM automation_tokens WHERE id=$1',[id]);
   const r=await req('DELETE',`/api/automation/tokens?id=${id}`);assert.equal(r.status,500);
   const after=await db.query('SELECT secret_hash,revoked_at FROM automation_tokens WHERE id=$1',[id]);assert.deepEqual(after.rows,before.rows,'failed audit must not revoke or erase the hash');
  });
 });
 await test('concurrent revocations produce one event and one unchanged result',{},async()=>{
  const id=await mint(`${tag}-race`);await locker.query('BEGIN');await locker.query('SELECT id FROM automation_tokens WHERE id=$1 FOR UPDATE',[id]);
  const both=Promise.all([req('DELETE',`/api/automation/tokens?id=${id}`),req('DELETE',`/api/automation/tokens?id=${id}`)]);
  try{const until=Date.now()+12000;let waiting=0;do{const r=await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND lower(query) LIKE '%automation_tokens%'");waiting=r.rows[0].n;if(waiting>=2)break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<until);assert.ok(waiting>=2,`expected two lock waiters; got ${waiting}`);}finally{await locker.query('COMMIT');}
  const responses=await both;assert.deepEqual(responses.map(r=>r.status),[200,200]);const data=await Promise.all(responses.map(r=>r.json() as Promise<{alreadyRevoked?:boolean}>));assert.equal(data.filter(x=>x.alreadyRevoked===true).length,1);
  const audit=await db.query("SELECT id FROM audit_log WHERE action='automation.token.revoked' AND detail=$1",[id]);assert.equal(audit.rowCount,1);
  const row=await db.query('SELECT secret_hash,revoked_at FROM automation_tokens WHERE id=$1',[id]);assert.equal(row.rows[0].secret_hash,'');assert.ok(row.rows[0].revoked_at);
 });
 await test('committed revocation denies the token and repeat preserves audit and timestamp',{},async()=>{
  const r=await req('POST','/api/automation/tokens',{name:`${tag}-success`,scopes:['read']});assert.equal(r.status,201);const created=await r.json() as {id:string;token:string};ids.push(created.id);
  const read=()=>fetch(process.env.BASE+'/api/automation',{headers:{authorization:`Bearer ${created.token}`}});
  assert.equal((await read()).status,200);const first=await req('DELETE',`/api/automation/tokens?id=${created.id}`);assert.equal(first.status,200);
  const state=await db.query('SELECT secret_hash,revoked_at FROM automation_tokens WHERE id=$1',[created.id]);assert.equal(state.rows[0].secret_hash,'');assert.ok(state.rows[0].revoked_at);
  assert.equal((await read()).status,401);const repeat=await req('DELETE',`/api/automation/tokens?id=${created.id}`);assert.equal(repeat.status,200);assert.equal((await repeat.json() as {alreadyRevoked?:boolean}).alreadyRevoked,true);
  const after=await db.query('SELECT revoked_at FROM automation_tokens WHERE id=$1',[created.id]);assert.equal(after.rows[0].revoked_at.getTime(),state.rows[0].revoked_at.getTime());
  const audits=await db.query("SELECT action,detail FROM audit_log WHERE (action='automation.token.revoked' AND detail=$1) OR (action='automation.token.created' AND split_part(detail,' ',1)=$1)",[created.id]);assert.equal(audits.rowCount,2);assert.ok(audits.rows.every(a=>!a.detail.includes(created.token)), 'audit must not contain the bearer token');
 });
}finally{try{await locker.query('ROLLBACK');}catch{}const all=await db.query('SELECT id FROM automation_tokens WHERE name LIKE $1',[`${tag}%`]);for(const row of all.rows)if(!ids.includes(row.id))ids.push(row.id);if(ids.length){await db.query("DELETE FROM audit_log WHERE (action='automation.token.revoked' AND detail = ANY($1::text[])) OR (action='automation.token.created' AND split_part(detail,' ',1) = ANY($1::text[]))",[ids]);await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]);}await locker.end();await db.end();finish();}
