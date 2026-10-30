/** Real VFS + browser sorting/navigation; only in an exclusive disposable environment. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable database and server required");
const base = process.env.BASE, tag = randomBytes(8).toString("hex");
const paths = [`/Pictures/tt127-${tag}-a.png`, `/Pictures/tt127-${tag}-z.png`];
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const browser = await launchChromium(), { test, finish } = makeHarness("e2e-tt127-photos");
async function request(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`); return r.json();
}
const images = [readFileSync("docs/screens/tt118-clock.png"), readFileSync("docs/screens/tt118-calculator.png")];
let owned = false;
try {
  if ((await db.query("SELECT 1 FROM vfs_nodes WHERE path=ANY($1)", [paths])).rowCount) throw new Error("Refusing pre-existing fixture");
  // Make A the larger file, so size and name sort yield opposite orders.
  images.sort((a, b) => b.length - a.length); assert.ok(images[0].length > images[1].length);
  for (let i = 0; i < 2; i++) await request("POST", "/api/fs", { op: "writeIfUnchanged", path: paths[i], content: images[i].toString("base64"), encoding: "base64", mime: "image/png", expected: null });
  owned = true;
  const rows = await db.query("SELECT path,size FROM vfs_nodes WHERE path=ANY($1)", [paths]); assert.equal(rows.rowCount, 2, "HTTP and DATABASE_URL must match");
  const current = await request("GET", "/api/state?id=default");
  await request("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "photos", title: "Photos", x: 20, y: 16, w: 1100, h: 800, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  await test("Photos name and size selections order tiles and editor navigation", {}, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20000); await page.goto(base, { waitUntil: "domcontentloaded" });
      const picker = page.getByTestId("photos-sort"), names = paths.map((p) => p.split("/").pop()!);
      await picker.waitFor(); await page.locator(`[data-photo="${names[0]}"]`).waitFor(); await page.locator(`[data-photo="${names[1]}"]`).waitFor();
      const order = () => page.locator('[data-photo]').evaluateAll((els, expected) => els.map((e) => e.getAttribute("data-photo")).filter((n) => expected.includes(n!)), names);
      const waitOrder = (expected: string[]) => page.waitForFunction((wanted) => {
        const got = [...document.querySelectorAll("[data-photo]")].map((el) => el.getAttribute("data-photo")).filter((n) => wanted.includes(n!));
        return JSON.stringify(got) === JSON.stringify(wanted);
      }, expected);
      await picker.selectOption("name"); await waitOrder(names); assert.deepEqual(await order(), names);
      await picker.selectOption("size"); await waitOrder([names[1], names[0]]); assert.deepEqual(await order(), [names[1], names[0]]);
      await picker.selectOption("name"); await waitOrder(names); await page.locator(`[data-photo="${names[0]}"]`).click();
      const nav = page.getByRole("button", { name: "Next photo" }); await nav.waitFor();
      // No other generated test name can sort between these two unique names.
      await nav.click(); await page.getByTestId("photos-editor").getByText(names[1], { exact: true }).waitFor();
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  if (owned) for (const path of paths) { await request("POST", "/api/fs", { op: "trash", path }); await request("POST", "/api/fs", { op: "purge", path }); }
  await db.end(); finish();
}
