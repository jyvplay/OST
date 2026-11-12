import assert from "node:assert/strict";
import { Client } from "pg";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("e2e-tt163-token-pages");
const fx = await disposableShell();
const tag = `tt163-${Date.now()}-${process.pid}`;
const ids: string[] = [];
try {
  await test("token management searches and pages all matching tokens and revokes a later result", {}, async () => {
    for (let i=0; i<11; i++) {
      const row = await fx.api<{id:string}>("POST", "/api/automation/tokens", {name:`${tag}-${String(i).padStart(2,"0")}`, scopes:["read"]});
      ids.push(row.id);
    }
    await fx.windows("routines");
    const ctx = await fx.context();
    try {
      const page=await ctx.newPage(); await fx.ready(page,"routines");
      const search=page.getByRole("searchbox",{name:"Search automation tokens"}); await search.fill(tag);
      const panel=page.getByTestId("automation-token-list");
      await page.getByText("1–8 of 11",{exact:true}).waitFor();
      assert.equal(await panel.locator('[data-token-id]').count(),8);
      assert.equal(await panel.locator(`[data-token-id="${ids[10]}"]`).count(),0);
      await page.getByRole("button",{name:"Next token page"}).focus(); await page.keyboard.press("Enter");
      await page.getByText("9–11 of 11",{exact:true}).waitFor();
      const last=panel.locator(`[data-token-id="${ids[10]}"]`); await last.getByRole("button",{name:"Revoke"}).click();
      await last.getByText("revoked",{exact:true}).waitFor();
      const all=await fx.api<{rows:{id:string;revoked:boolean}[]}>("GET","/api/automation/tokens");
      assert.equal(all.rows.find(x=>x.id===ids[10])?.revoked,true);
      assert.equal(all.rows.find(x=>x.id===ids[0])?.revoked,false);
      await page.getByRole("button",{name:"Previous token page"}).focus(); await page.keyboard.press("Space");
      await page.getByText("1–8 of 11",{exact:true}).waitFor();
      await search.fill(ids[10]); await page.getByText("1–1 of 1",{exact:true}).waitFor();
      await panel.locator(`[data-token-id="${ids[10]}"]`).getByText("revoked",{exact:true}).waitFor();
      await search.fill(`${tag}-00`); await page.getByText("1–1 of 1",{exact:true}).waitFor();
      assert.equal(await panel.locator('[data-token-id]').count(),1);
      await search.fill("nothing-matches-tt163"); await page.getByText("No matching tokens",{exact:true}).waitFor();
      await search.fill(tag); await page.getByText("1–8 of 11",{exact:true}).waitFor();
    } finally { await ctx.close(); }
  });
} finally {
  const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
  try { if(ids.length) await db.query('DELETE FROM automation_tokens WHERE id = ANY($1::text[])',[ids]); } finally { await db.end(); await fx.close(); finish(); }
}
