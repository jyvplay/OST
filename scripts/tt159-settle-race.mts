import assert from "node:assert/strict";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("exclusive disposable BASE and DATABASE_URL required");
const { test, finish } = makeHarness("tt159-settle-race");
const locker = new pg.Client({connectionString: process.env.DATABASE_URL}), observer = new pg.Client({connectionString: process.env.DATABASE_URL});
await locker.connect(); await observer.connect(); let id = 0;
try {
 await test("concurrent conflicting settlements preserve a single terminal result and audit", {}, async () => {
   const inserted = await observer.query("INSERT INTO automation_runs (token_id, actions, status) VALUES ($1, $2::jsonb, 'queued') RETURNING id", ["tt159-test", JSON.stringify([{cmd:"open",arg:"notes"}])]); id=inserted.rows[0].id;
   await locker.query("BEGIN"); await locker.query("SELECT id FROM automation_runs WHERE id=$1 FOR UPDATE", [id]);
   const post = async (ok: boolean) => { const r=await fetch(process.env.BASE + "/api/automation", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({settleId:id,ok,result:ok?"tt159-success":"tt159-failure"}) }); return { status:r.status, body:await r.json() }; };
   const both=Promise.all([post(true),post(false)]);
   try {
     const until=Date.now()+12000; let waiting=0;
     do { const r=await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND lower(query) LIKE '%update%automation_runs%'"); waiting=r.rows[0].n; if(waiting>=2) break; await new Promise(r=>setTimeout(r,50)); } while(Date.now()<until);
     assert.ok(waiting>=2, `both real HTTP updates must be blocked by the row lock, observed ${waiting}`);
   } finally { await locker.query("COMMIT"); }
   const replies=await both; assert.deepEqual(replies.map(x=>x.status),[200,200]);
   assert.equal(replies.filter(x=>x.body.unchanged===true).length,1,"exactly one request wins");
   assert.equal(replies[0].body.run.status,replies[1].body.run.status,"both responses report the same terminal result");
   const actual=await observer.query("SELECT status,result FROM automation_runs WHERE id=$1",[id]);
   assert.equal(replies[0].body.run.status,actual.rows[0].status);
   const audits=await observer.query("SELECT action,detail FROM audit_log WHERE actor='automation' AND action IN ('automation.done','automation.failed') AND detail LIKE $1",[`run ${id}:%`]);
   assert.equal(audits.rows.length,1,"one terminal audit entry"); assert.equal(audits.rows[0].action,`automation.${actual.rows[0].status}`);
   const repeat=await post(actual.rows[0].status!=="done"); assert.equal(repeat.body.unchanged,true); assert.equal(repeat.body.run.result,actual.rows[0].result);
 });
 await test("audit write failure rolls back the terminal status", {}, async () => {
   const suffix = `${process.pid}_${Date.now()}`;
   const fn = `tt159_fail_${suffix}`, trigger = `tt159_trigger_${suffix}`;
   const row = await observer.query("INSERT INTO automation_runs (token_id, actions, status) VALUES ($1, '[]'::jsonb, 'queued') RETURNING id", ["tt159-audit-fault"]);
   const faultId = row.rows[0].id;
   try {
     await observer.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor = 'automation' AND NEW.detail LIKE 'run ${faultId}:%' THEN RAISE EXCEPTION 'TT159 audit fault'; END IF; RETURN NEW; END $$`);
     await observer.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
     const response = await fetch(process.env.BASE + "/api/automation", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({settleId:faultId,ok:true,result:"tt159 rollback"})});
     assert.equal(response.status,500,"audit failure must be reported");
     const after = await observer.query("SELECT status, result, finished_at FROM automation_runs WHERE id=$1", [faultId]);
     assert.deepEqual(after.rows[0], {status:"queued", result:"", finished_at:null}, "transaction must roll back the status");
   } finally {
     await observer.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_log`);
     await observer.query(`DROP FUNCTION IF EXISTS ${fn}()`);
     await observer.query("DELETE FROM automation_runs WHERE id=$1", [faultId]);
   }
 });
} finally { try { await locker.query("ROLLBACK"); } catch {} if(id) { await observer.query("DELETE FROM audit_log WHERE actor='automation' AND detail LIKE $1",[`run ${id}:%`]); await observer.query("DELETE FROM automation_runs WHERE id=$1",[id]); } await locker.end(); await observer.end(); finish(); }
