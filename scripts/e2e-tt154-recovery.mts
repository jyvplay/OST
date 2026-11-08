/** Delayed real recovery listing, isolated disposable database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { makeHarness } from "./harness.mts";
import { disposableShell } from "./tt132-fixture.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt154-recovery");
const path = `/System/Recovery/sheet_untitled-${randomBytes(12).toString("hex")}.draft`;
let owned = false;
try {
  await test("delayed recovery check signals readiness only after the real draft offer renders", {}, async () => {
    const draft = JSON.stringify({ v: 1, kind: "sheet", path: "", title: "TT154 delay probe", savedAt: 4102444800000, baseSha: null, encoding: "utf8", payload: "{}" });
    await fx.api("POST", "/api/fs", { op: "writeIfUnchanged", path, content: draft, expected: null }); owned = true;
    await fx.windows("sheet");
    const ctx = await fx.context(); const page = await ctx.newPage();
    let release!: () => void, seen!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), requested = new Promise<void>((r) => { seen = r; });
    await page.route("**/api/fs?path=*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("path") === "/System/Recovery") { seen(); await gate; }
      await route.continue();
    });
    try {
      await page.goto(fx.BASE, { waitUntil: "domcontentloaded" });
      const grid = page.getByTestId("sheet-grid"); await grid.waitFor(); await requested;
      assert.equal(await grid.getAttribute("data-recovery-checked"), "false");
      assert.equal(await page.getByTestId("recover-banner").count(), 0);
      release();
      await page.locator('[data-testid="sheet-grid"][data-recovery-checked="true"]').waitFor();
      await page.getByTestId("recover-banner").getByText(/TT154 delay probe/).waitFor();
      assert.equal((await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node.content, draft, "observing must not discard the draft");
    } finally { release(); await ctx.close(); }
  });
} finally {
  if (owned) { await fx.api("POST", "/api/fs", { op: "trash", path }); await fx.api("POST", "/api/fs", { op: "purge", path }); }
  await fx.close(); finish();
}
