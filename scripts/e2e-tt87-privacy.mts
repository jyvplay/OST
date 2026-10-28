/** Real-browser regression for TT87 conditional writes crossing privacy boundaries.
 * Uses unique plaintext fixtures on the isolated test DB and always purges them.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `tt87guard${Date.now().toString(36)}`;
const paths = [`/Documents/${RUN}-amnesia.txt`, `/Private/${RUN}-private.txt`];
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const { test, finish } = makeHarness("e2e-tt87-privacy");
const hostCount = async (path: string) => (await db.query("select count(*)::int n from vfs_nodes where path=$1", [path])).rows[0].n;
const conditional = async (path: string) => page.evaluate(async (p) => {
  const r = await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "writeIfUnchanged", path: p, content: "privacy regression fixture", expected: null }) });
  return { status: r.status, body: await r.json() };
}, path);
try {
  await test("TT87 amnesia refuses conditional writes before they reach PostgreSQL", { "SC-13": "partial", "BK-02": "partial" }, async () => {
    await page.goto(`${BASE}/?amnesia=1`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("amnesic-badge").first().waitFor({ timeout: 30_000 });
    const r = await conditional(paths[0]);
    const n = await hostCount(paths[0]);
    assert.equal(r.status, 423, `expected refusal; status=${r.status}, host rows=${n}`);
    assert.equal(n, 0, "amnesic fixture reached the host");
  });
  await test("TT87 conditional writes cannot create plaintext inside locked Persistent Storage", { "SC-10": "partial" }, async () => {
    await page.goto(`${BASE}/?open=privacy`, { waitUntil: "domcontentloaded" });
    // Wait for the client Privacy module, not the server-rendered launcher: the fetch guard is installed by client JS.
    await page.getByTestId("privacy").first().waitFor({ timeout: 30_000 });
    const r = await conditional(paths[1]);
    const n = await hostCount(paths[1]);
    assert.equal(r.status, 422, `expected refusal; status=${r.status}, host rows=${n}`);
    assert.equal(n, 0, "plaintext private fixture reached the host");
  });
  await test("TT87 LocalDisk explicitly blocks folder access in amnesic mode", { "SC-13": "partial", "BK-02": "partial" }, async () => {
    await page.goto(`${BASE}/?amnesia=1&open=localdisk`, { waitUntil: "domcontentloaded" });
    const win = page.getByRole("dialog", { name: "Local Disk" }).first();
    await win.waitFor({ timeout: 30_000 });
    await win.getByText(/unavailable in amnesic mode/i).waitFor({ timeout: 10_000 });
    assert.equal(await win.getByRole("button", { name: /Mount local folder/i }).count(), 0);
  });
} finally {
  await ctx.close(); await browser.close();
  for (const path of paths) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path }) }).catch(() => undefined);
  await db.end();
}
finish();
