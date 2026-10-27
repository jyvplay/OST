/** Honest calculator inventory using real Chromium + PostgreSQL; EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { evaluate } from "../src/lib/calc.ts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing calculator audit without an exclusive disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", { test, finish } = makeHarness("tt95-calculator-audit"), cov = { "PR-09": "partial" } as const;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const call = async (method: string, path: string, body?: object) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() }; };
const expression = `${randomBytes(4).readUInt32BE() % 100000000}+123457`;
const counts = async () => (await db.query("SELECT (SELECT count(*)::int FROM notes WHERE title LIKE $1 OR body LIKE $1) AS notes, (SELECT count(*)::int FROM index_docs WHERE title LIKE $1 OR body LIKE $1) AS indexed", [`%${expression}%`])).rows[0];
try {
  await test("the register labels incomplete programmer mode and nonpersistent history as partial", cov, async () => {
    const r = await call("GET", "/api/features"); assert.equal(r.status, 200); const row = r.json.rows.find((x: { code: string }) => x.code === "PR-09");
    assert.ok(row); assert.equal(row.tier, "A"); assert.equal(row.status, "partial"); assert.match(row.nuance, /in memory only/); assert.match(row.nuance, /bitwise operations.*not implemented/i);
  });
  await test("the shared evaluator handles examples but does not claim bitwise programmer operations", cov, () => {
    assert.equal(evaluate("2+2*3").text, "8"); assert.equal(evaluate("sqrt(144)").text, "12"); assert.equal(evaluate("0xff").text, "255");
    assert.equal(evaluate("0xff & 0x0f").ok, false);
  });
  const state = await call("GET", "/api/state?id=default"), rev = Number(state.json.row?.revision ?? 1) + 1000;
  assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } })).status, 200);
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await ctx.newPage();
    try {
      await page.goto(`${BASE}/?open=calculator`, { waitUntil: "domcontentloaded" });
      const dlg = page.locator('[role="dialog"][aria-label="Calculator"]').first(); await dlg.waitFor({ timeout: 30_000 });
      await test("calculator history exists in the mounted window but is not saved as a note or search row", cov, async () => {
        const before = await counts(); await dlg.getByLabel("Expression").fill(expression); await dlg.getByLabel("Expression").press("Enter");
        await dlg.getByText(expression, { exact: true }).waitFor({ timeout: 8000 }); assert.deepEqual(await counts(), before);
      });
      await test("calculator history is lost when the component remounts", cov, async () => {
        await page.reload({ waitUntil: "domcontentloaded" }); const reloaded = page.locator('[role="dialog"][aria-label="Calculator"]').first();
        await reloaded.waitFor({ timeout: 30_000 }); await reloaded.getByLabel("Expression").waitFor({ timeout: 30_000 });
        assert.equal(await reloaded.getByText(expression, { exact: true }).count(), 0);
      });
    } finally { await ctx.close(); }
  } finally { await browser.close(); }
} finally { await db.end(); finish(); }
