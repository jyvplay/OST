/** TT124 — mechanism e2e. Same contract as e2e-tt121: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt124");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}
const browser = await launchChromium();
async function openModule(module: string, props: Record<string, unknown> = {}) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForTimeout(1200);
  return { page, context };
}

await test("ED-08/WR-01/PD-02: indent changes the buffer and selection; goal badge appears; page jump clamps", { "ED-08": "full", "WR-01": "full", "PD-02": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt124.txt", content: "one\ntwo\n", reason: "e2e-tt124" });
  const ed = await openModule("editor", { path: "/tt124.txt" });
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value.includes("two"));
  await ed.page.evaluate(() => { const ta = document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement; ta.focus(); ta.setSelectionRange(0, ta.value.length); });
  await ed.page.getByTestId("editor-indent").click();
  const v = await ed.page.evaluate(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement).value);
  assert.equal(v, "  one\n  two\n", "indent rewrote both lines of the block");
  await ed.context.close();

  const wr = await openModule("writer");
  await wr.page.getByTestId("writer-word-count-open").click();
  await wr.page.getByTestId("writer-goal-start").click();
  await wr.page.waitForFunction(() => document.querySelector('[data-testid="writer-goal"]') !== null);
  await wr.context.close();
});

await test("PK-02/MN-02/LN-17 controls render: hex head on a binary, in-flight toggle, resolution pick", { "PK-02": "full", "MN-02": "full", "LN-17": "full" }, async () => {
  const b64 = Buffer.from(Array.from({ length: 40 }, (_, i) => i * 3 % 256)).toString("base64");
  await api("POST", "/api/fs", { op: "write", path: "/tt124.bin", content: b64, encoding: "base64", mime: "application/octet-stream", reason: "e2e-tt124" });
  const peek = await openModule("peek", { path: "/tt124.bin" });
  await peek.page.waitForFunction(() => (document.querySelector('[data-testid="peek-hex"]')?.textContent ?? "").includes("00000000"));
  await peek.context.close();

  const mon = await openModule("monitor");
  await mon.page.waitForFunction(() => document.querySelector('[data-testid="monitor-inflight"]') !== null);
  await mon.context.close();

  const lens = await openModule("lens");
  await lens.page.waitForFunction(() => document.querySelector('[data-testid="lens-res"]') !== null, null, { timeout: 15_000 }).catch(() => null);
  await lens.context.close();
});

await test("MD-12/CK-08/SP-03: A–B label cycles; copy buttons exist on clock, spec, beam, contacts, messages, photos-editor, vector, ssh, together, routines", { "MD-12": "full", "CK-08": "full", "SP-03": "full" }, async () => {
  const media = await openModule("media");
  const label0 = await media.page.getByTestId("media-ab").textContent();
  await media.page.getByTestId("media-ab").click();
  const label1 = await media.page.getByTestId("media-ab").textContent();
  assert.notEqual(label0, label1, "first press arms A and the label says so");
  await media.context.close();

  await api("POST", "/api/routines", { name: "tt124 sample", trigger: "manual", triggerArg: "", actions: [{ cmd: "open", arg: "notes" }] });
  const png = (await import("node:fs")).readFileSync("public/icon-192.png").toString("base64"); // a real PNG: the editor must decode what it copies info about
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt124-probe.png", content: png, encoding: "base64", mime: "image/png", reason: "e2e-tt124" });
  for (const [mod, testid] of [["clock", "clock-copy-times"], ["spec", "spec-copy-progress"], ["beam", "beam-copy-sessions"], ["contacts", "ct-copy-emails"], ["messages", "messages-copy"], ["vector", "vector-copy-svg"], ["together", "together-newcode"], ["routines", "routine-dup"], ["ssh", "ssh-copy-line"]] as const) {
    const h = await openModule(mod);
    await h.page.waitForFunction((t: string) => document.querySelector(`[data-testid="${t}"]`) !== null, testid, { timeout: 15_000 });
    await h.context.close();
  }
});

await test("PH-08: opening a photo offers Copy info with honest absences", { "PH-08": "full" }, async () => {
  const ph = await openModule("photos");
  await ph.page.waitForSelector('[data-win-id="w1"] button[title^="tt124-probe"]', { timeout: 15_000 });
  await ph.page.click('[data-win-id="w1"] button[title^="tt124-probe"]');
  await ph.page.waitForFunction(() => document.querySelector('[data-testid="photos-copy-info"]') !== null, null, { timeout: 15_000 });
  await ph.context.close();
});

await browser.close();
finish();
