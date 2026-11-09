import assert from "node:assert/strict";
import pg from "pg";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt157-routines");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const ids: number[] = [];
try {
  await test("HTTP refuses malformed schedules and preserves valid schedules", {}, async () => {
    const send = async (trigger: unknown, triggerArg: unknown) => fetch(fx.BASE + "/api/routines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "TT157 HTTP", trigger, triggerArg, actions: [{ cmd: "open", arg: "notes" }] }) });
    for (const [kind, arg] of [["interval", ""], ["interval", "0"], ["interval", "Infinity"], ["time-of-day", "24:00"], ["time-of-day", "nonsense"], ["not-a-trigger", ""]]) {
      const res = await send(kind, arg); const body = await res.json(); if (body.row?.id) ids.push(body.row.id);
      assert.equal(res.status, 400, `${kind} ${arg} must be rejected`);
    }
    const res = await send("interval", "60"); const body = await res.json(); if (body.row?.id) ids.push(body.row.id);
    assert.equal(res.status, 200); assert.equal(body.row.triggerArg, "60");
    // Prevent this valid HTTP-only row from executing while testing the daemon.
    await fx.api("PATCH", "/api/routines", { id: body.row.id, enabled: false });
  });
  await test("foreground daemon skips malformed legacy rows while a valid row actually runs", {}, async () => {
    const inserted = await db.query(`INSERT INTO routines (name, trigger, trigger_arg, actions) VALUES ($1,'interval','', $2::jsonb),($3,'interval','1',$2::jsonb) RETURNING id`, ["TT157 invalid legacy", JSON.stringify([{ cmd: "open", arg: "notes" }]), "TT157 valid sentinel"]);
    const [invalid, valid] = inserted.rows.map((r: { id: number }) => r.id); ids.push(invalid, valid);
    await fx.windows("routines"); const context = await fx.context();
    try {
      const page = await context.newPage(); await fx.ready(page, "routines");
      const win = page.locator('[data-win-id="w1"]');
      await win.getByText("TT157 invalid legacy", { exact: true }).waitFor();
      await win.getByText("Invalid trigger — automatic execution paused.", { exact: false }).waitFor();
      await page.waitForFunction(async (id) => { const data = await (await fetch('/api/routines')).json(); return Boolean(data.rows.find((r: { id: number; lastRun: string | null }) => r.id === id)?.lastRun); }, valid, { timeout: 15000 });
      const rows = await fx.api<{ rows: { id: number; lastRun: string | null }[] }>("GET", "/api/routines");
      assert.equal(rows.rows.find(r => r.id === invalid)?.lastRun, null);
      await win.getByLabel("Routine trigger").selectOption("time-of-day");
      const time = win.getByLabel("Time of day"); await time.fill("24:00");
      assert.equal(await win.getByTestId("routine-save").isDisabled(), true);
      await win.getByRole("alert").getByText(/Time must be HH:MM/).waitFor();
      await time.fill("08:30"); assert.equal(await win.getByTestId("routine-save").isEnabled(), true);
      await page.screenshot({ path: "docs/screens/tt157-routines.png", animations: "disabled" });
    } finally { await context.close(); }
  });
} finally {
  if (ids.length) await db.query("DELETE FROM routines WHERE id = ANY($1::int[])", [ids]);
  await db.end(); await fx.close(); finish();
}
