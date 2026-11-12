import assert from "node:assert/strict";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), {test, finish} = makeHarness("e2e-tt158-planner");
let id = 0;
try {
 await test("local planner rejects wrong secret and replay without running actions", {}, async () => {
  const row = await fx.api<{row:{id:number}}>("POST", "/api/routines", {name:"TT158 planner", trigger:"manual", actions:[{cmd:"open",arg:"notes"}]}); id = row.row.id;
  await fx.windows("routines"); const ctx = await fx.context();
  try {
   const page = await ctx.newPage(); await fx.ready(page, "routines"); const win=page.locator('[data-win-id="w1"]');
   await win.getByLabel("Planner token routine").selectOption(String(id)); await win.getByTestId("routines-token").click();
   const token = (await win.getByTestId("routines-token-value").innerText()).split(" · ")[0]; assert.match(token,/^[a-f0-9]{24}$/);
   const request = win.getByTestId("routines-request"), plan=win.getByTestId("routines-validate");
   const send=async (value?: string) => { await request.fill(JSON.stringify({routineId:String(id),origin:"https://other.example",...(value === undefined ? {} : {token:value})})); await plan.click(); };
   await send(); await win.getByText(/refused: a planner token is required/).waitFor();
   await send("not-the-secret"); await win.getByText(/refused: the token does not match/).waitFor();
   await send(token); await win.getByText(/executable: 1 step\(s\) \(local plan only; nothing ran\)/).waitFor();
   await send(token); await win.getByText(/refused: that token has already been used/).waitFor();
   const all=await fx.api<{rows:{id:number,lastRun:string|null}[]}>("GET","/api/routines"); assert.equal(all.rows.find(r=>r.id===id)?.lastRun,null);
   assert.equal(await page.locator('[aria-label="Notes"]').count(),0,"planning does not execute the action");
  } finally { await ctx.close(); }
 });
} finally { if(id) await fx.api("DELETE",`/api/routines?id=${id}`); await fx.close(); finish(); }
