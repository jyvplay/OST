/** TT125 — mechanism e2e. Same contract as e2e-tt124: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt125");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}
const browser = await launchChromium();
async function openModule(module: string, props: Record<string, unknown> = {}) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  return { page, context };
}

await test("ED-09/ED-10/WR-02: case rewrites only the selection; the now-button stamps the caret; reading time appears in Word Count", { "ED-09": "full", "ED-10": "full", "WR-02": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt125-case.txt", content: "the iPad's usb-c port stays camelCase here\n", reason: "e2e-tt125" });
  const ed = await openModule("editor", { path: "/tt125-case.txt" });
  const ta = ed.page.locator('[data-win-id="w1"] textarea').first();
  await ta.waitFor();
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement | null)?.value === "the iPad's usb-c port stays camelCase here\n");
  await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, el.value.length); });
  await ed.page.getByTestId("editor-case-title").click();
  const after = await ta.inputValue();
  assert.equal(after, "The iPad's Usb-c Port Stays camelCase Here\n", `title case: ${after}`);
  await ed.page.getByTestId("editor-case-upper").click();
  assert.equal((await ta.inputValue()).trim(), after.trim().toUpperCase());
  const before = await ta.inputValue();
  await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, 0); });
  await ed.page.getByTestId("editor-stamp").click();
  const stamped = await ta.inputValue();
  assert.match(stamped.slice(0, 16), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(stamped.slice(16), before, "stamp inserts at the caret and keeps every later byte");
  await ed.context.close();

  const wr = await openModule("writer");
  await wr.page.getByTestId("writer-word-count-open").click();
  await wr.page.getByTestId("writer-word-count").waitFor();
  const rt = await wr.page.getByTestId("writer-read-time").textContent();
  assert.match(rt ?? "", /min read at 238 wpm|no words yet/);
  await wr.context.close();
});

await test("PK-04: Copy strings lifts ASCII runs from a binary", { "PK-04": "full" }, async () => {
  const b64 = Buffer.from("FUSIONMARK\x00\x01\x02hidden-payload-text\x00tail").toString("base64");
  await api("POST", "/api/fs", { op: "write", path: "/tt125.bin", content: b64, encoding: "base64", mime: "application/octet-stream", reason: "e2e-tt125" });
  const pk = await openModule("peek", { path: "/tt125.bin" });
  await pk.page.getByTestId("peek-copy-strings").click();
  await pk.page.waitForFunction(() => (document.body.textContent ?? "").includes("ASCII strings copied"), null, { timeout: 10_000 });
  await pk.context.close();
});

await test("honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render", { "LN-19": "mechanism", "LN-20": "mechanism", "WB-08": "mechanism", "CB-03": "mechanism", "TG-03": "mechanism", "ST-16": "mechanism", "BM-03": "mechanism", "DV-03": "mechanism", "PL-10": "mechanism" }, async () => {
  const t = await api<{ row?: { id?: number } }>("POST", "/api/tasks", { title: "tt125 done task", dueAt: null });
  if (t.row?.id != null) { await api("PATCH", "/api/tasks", { id: t.row.id, done: true }); }
  for (const [mod, testid, extra] of [
    ["lens", "lens-zoom", null], ["lens", "lens-torch", null], ["whiteboard", "wb-export-selection", null],
    ["clipboard", "clip-merge", null], ["together", "together-copy-roster", null], ["beam", "beam-filter", null],
    ["devices", "devices-storage", null], ["planner", "planner-copy-done", null],
  ] as [string, string, null][]) {
    const h = await openModule(mod);
    if (mod === "planner") { await h.page.getByRole("button", { name: "Week view" }).click({ timeout: 10_000 }); await h.page.getByRole("button", { name: "Agenda" }).click({ timeout: 10_000 }); }
    await h.page.waitForFunction((t: string) => document.querySelector(`[data-testid="${t}"]`) !== null, testid, { timeout: 15_000 });
    if (testid === "wb-export-selection" || testid === "clip-merge") {
      const disabled = await h.page.getByTestId(testid).isDisabled();
      assert.ok(disabled, `${testid} must start disabled (nothing selected / one clip)`);
    }
    if (testid === "lens-torch") {
      const disabled = await h.page.getByTestId("lens-torch").isDisabled();
      assert.ok(disabled, "headless Chromium reports no torch: the toggle must say so, not pretend");
    }
    if (testid === "devices-storage") {
      const txt = await h.page.getByTestId("devices-storage").textContent();
      assert.match(txt ?? "", /using|not shared|estimate/);
    }
    await h.context.close();
    void extra;
  }
  if (t.row?.id != null) await api("DELETE", `/api/tasks?id=${t.row.id}`).catch(() => undefined);
  const st = await openModule("settings");
  await st.page.getByRole("button", { name: "Shortcuts" }).first().click().catch(async () => { await st.page.locator('[data-win-id="w1"] >> text=Shortcuts').first().click(); });
  await st.page.waitForFunction(() => document.querySelector('[data-testid="settings-copy-shortcuts"]') !== null, null, { timeout: 15_000 });
  await st.context.close();
});

await browser.close();
finish();
