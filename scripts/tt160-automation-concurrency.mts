import assert from "node:assert/strict";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.BASE || !process.env.DATABASE_URL) throw new Error("exclusive disposable BASE and DATABASE_URL required");
const {test,finish}=makeHarness("tt160-automation-concurrency");
const client=new pg.Client({connectionString:process.env.DATABASE_URL}); await client.connect();
const tokens:string[]=[]; const base=process.env.BASE;
async function mint() { const r=await fetch(base+"/api/automation/tokens",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"TT160 concurrency",scopes:["run"]})}); assert.equal(r.status,201); const j=await r.json(); tokens.push(j.id); return j.token as string; }
async function submit(token:string) { const r=await fetch(base+"/api/automation",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify({commands:"open notes"})}); return {status:r.status,body:await r.json()}; }
try {
 await test("concurrent requests share one per-token rate budget",{},async()=>{
  const initial=await client.query("SELECT count(*)::int n FROM automation_runs WHERE status='queued'"); assert.equal(initial.rows[0].n,0,"requires empty disposable queue");
  const token=await mint();
  const answers=await Promise.all(Array.from({length:40},()=>submit(token)));
  assert.equal(answers.filter(a=>a.status===201).length,30,"exactly 30 enqueues permitted");
  assert.equal(answers.filter(a=>a.status===429).length,10,"remaining requests throttled");
  const count=await client.query("SELECT count(*)::int n FROM automation_runs WHERE token_id=$1 AND status='queued'",[tokens[0]]); assert.equal(count.rows[0].n,30);
 });
 await test("global queue capacity holds across distinct tokens",{},async()=>{
  await client.query("DELETE FROM automation_runs WHERE token_id=ANY($1::text[])",[tokens]);
  const group=await Promise.all(Array.from({length:3},()=>mint()));
  const answers=await Promise.all(group.flatMap(token=>Array.from({length:20},()=>submit(token))));
  assert.equal(answers.filter(a=>a.status===201).length,50,"exact queue capacity accepted");
  assert.equal(answers.filter(a=>a.status===503).length,10,"excess refuses");
  const count=await client.query("SELECT count(*)::int n FROM automation_runs WHERE status='queued'"); assert.equal(count.rows[0].n,50);
 });
 await test("revocation while admission waits prevents enqueue",{},async()=>{
  await client.query("DELETE FROM automation_runs WHERE token_id=ANY($1::text[])",[tokens]);
  const token=await mint(); const id=tokens[tokens.length-1];
  const lock=new pg.Client({connectionString:process.env.DATABASE_URL}); await lock.connect();
  await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(5198676,160)");
  const pending=submit(token);
  try {
   const until=Date.now()+10000; let waiting=0;
   do { const q=await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND lower(query) LIKE '%pg_advisory_xact_lock%'"); waiting=q.rows[0].n; if(waiting) break; await new Promise(r=>setTimeout(r,50)); } while(Date.now()<until);
   assert.ok(waiting,"the enqueue must reach the real database lock before revocation");
   const res=await fetch(base+`/api/automation/tokens?id=${id}`,{method:"DELETE"}); assert.equal(res.status,200);
  } finally {await lock.query("COMMIT"); await lock.end();}
  const response=await pending; assert.equal(response.status,401,"revocation must be rechecked after lock acquisition");
  const rows=await client.query("SELECT count(*)::int n FROM automation_runs WHERE token_id=$1",[id]); assert.equal(rows.rows[0].n,0);
 });
} finally { if(tokens.length) { await client.query("DELETE FROM automation_runs WHERE token_id=ANY($1::text[])",[tokens]); await client.query("DELETE FROM audit_log WHERE actor=ANY($1::text[])",[tokens.map(t=>`automation:${t}`)]); await client.query("DELETE FROM automation_tokens WHERE id=ANY($1::text[])",[tokens]); } await client.end(); finish(); }
