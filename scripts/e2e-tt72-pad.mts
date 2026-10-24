/**
 * TT72 SH-11 — the Blackout touchpad drives the presenting screen (Chromium 143, production build, real Postgres).
 * One browser context holds the normal tab (/ → state "default", host tab) and a presenting screen (/display → state
 * "display-2", host screen), so BroadcastChannel("fusion-shell") is the real transport between two real pages.
 *  1. a real mouse drag on the tab's Blackout pad moves the focused window ON DISPLAY 2 (its DOM and its persisted
 *     /api/state row) by the drag distance; the tab's own window does not move; the status names the target + window.
 *  2. keys on the Blackout screen: ArrowRight +10, Shift+ArrowDown +50, Tab cycles focus, Enter maximises, Home shows the
 *     desktop — all on display 2; the tab's own state is unchanged.
 *  3. adversary on the channel (same-origin page.evaluate): wrong recipient, 6 malformed shapes and replayed / stale
 *     sequence numbers change nothing; one fresh, well-formed message does (control).
 *  4. a proxied page (opaque-origin sandbox, the Browser's proxy mode) posting a valid pad message moves nothing.
 *  5. no presenting screen (display closed → it says goodbye): the status says so and the pad moves this tab's window.
 * Restores both desktop states and the settings it changes.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt72-pad.mts
 */
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt72-pad");
const COV = { "SH-11": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
const getSetting = async (k: string) => ((await api("GET", "/api/settings")).json.rows as { key: string; value: string }[]).find((r) => r.key === k)?.value;
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });

type W = { id: string; module: string; title: string; x: number; y: number; w: number; h: number; z: number; minimized: boolean; maximized: boolean; workspace: number; host: string; props: Record<string, unknown> };
const win = (id: string, module: string, title: string, x: number, y: number, z: number, host: string): W => ({ id, module, title, x, y, w: 520, h: 360, z, minimized: false, maximized: false, workspace: 1, host, props: {} });
const state = async (id: string) => (await api("GET", `/api/state?id=${id}`)).json.row?.state as { windows: W[]; focus: string | null } | undefined;
async function putState(id: string, windows: W[], focus: string | null) {
  const cur = await api("GET", `/api/state?id=${id}`); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  const r = await api("PUT", "/api/state", { id, revision: rev, state: { windows, focus, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, focusMode: false, nextZ: 40, viewport: { w: 1600, h: 1000 }, icons: [] } });
  ok(r.status === 200, `putState ${id}: ${r.status}`);
}
const winOf = async (id: string, w: string) => (await state(id))?.windows.find((x) => x.id === w);
const box = async (p: Page, id: string) => { const b = await p.locator(`[data-win-id="${id}"]`).boundingBox(); if (!b) throw new Error(`no box for ${id}`); return b; };

const browser: Browser = await launchChromium();
const errors: string[] = [];
const saved: [string, string][] = [];
for (const k of ["appearance.desktopView"]) saved.push([k, (await getSetting(k)) ?? ""]);
await setSetting("appearance.desktopView", "classic");
const savedDefault = (await api("GET", "/api/state?id=default")).json.row?.state;
const savedDisplay = (await api("GET", "/api/state?id=display-2")).json.row?.state;

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
let tab: Page, disp: Page;
async function openBoth() {
  disp = await ctx.newPage(); disp.on("pageerror", (e) => errors.push(`display: ${e.message}`));
  await disp.goto(`${BASE}/display`); await disp.locator('[data-win-id="dA"]').waitFor();
  tab = await ctx.newPage(); tab.on("pageerror", (e) => errors.push(`tab: ${e.message}`));
  await tab.goto(`${BASE}/`); await tab.locator('[data-win-id="tC"]').waitFor();
}
async function blackout() {
  await tab.getByRole("button", { name: "Blackout this screen" }).first().click();
  await tab.getByTestId("blackout-pad").waitFor();
}
async function drag(dx: number, dy: number, steps = 6) {
  const b = (await tab.getByTestId("blackout-pad").boundingBox())!;
  const x0 = b.x + 40, y0 = b.y + 40;
  await tab.mouse.move(x0, y0); await tab.mouse.down();
  for (let i = 1; i <= steps; i++) await tab.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps);
  await tab.mouse.up();
}

try {
  await putState("display-2", [win("dA", "notes", "Display notes", 200, 150, 20, "screen"), win("dB", "clock", "Display clock", 600, 300, 21, "screen")], "dB");
  await putState("default", [win("tC", "calculator", "Tab calculator", 100, 120, 20, "tab")], "tC");
  await openBoth();

  await test("a real drag on the tab's Blackout pad moves the focused window on display 2 (DOM + persisted); the tab's window stays", COV, async () => {
    await blackout();
    await poll(async () => /display-2/.test((await tab.getByTestId("pad-status").textContent()) ?? ""), "status names display-2");
    const b0 = await box(disp, "dB"), c0 = await box(tab, "tC");
    await drag(60, 30);
    await poll(async () => { const b = await box(disp, "dB"); return Math.abs(b.x - b0.x - 60) <= 1 && Math.abs(b.y - b0.y - 30) <= 1; }, "display-2 window moved by the drag");
    const a = await box(disp, "dA"); ok(Math.abs(a.x - 200) <= 1, `the unfocused display window did not move (${a.x})`);
    await poll(async () => /Display clock/.test((await tab.getByTestId("pad-status").textContent()) ?? ""), "ack names the moved window");
    await poll(async () => { const w = await winOf("display-2", "dB"); return w?.x === 660 && w?.y === 330; }, "display-2 row persisted at 660,330");
    eq(await tab.locator('[data-win-id="tC"]').boundingBox(), c0, "tab window box unchanged");
    const t = await winOf("default", "tC"); eq([t?.x, t?.y], [100, 120], "tab state unchanged");
  });

  await test("keys on the Blackout screen drive display 2: arrows (+Shift), Tab cycles, Enter maximises, Home shows desktop", COV, async () => {
    await tab.getByTestId("blackout").focus();
    await tab.keyboard.press("ArrowRight");
    await poll(async () => (await winOf("display-2", "dB"))?.x === 670, "ArrowRight +10");
    await tab.keyboard.press("Shift+ArrowDown");
    await poll(async () => (await winOf("display-2", "dB"))?.y === 380, "Shift+ArrowDown +50");
    await tab.keyboard.press("Tab");
    await poll(async () => (await state("display-2"))?.focus === "dA", "Tab cycles focus to dA");
    ok(await tab.getByTestId("blackout").isVisible(), "Tab did not move focus out of the Blackout screen");
    await tab.keyboard.press("Enter");
    await poll(async () => (await winOf("display-2", "dA"))?.maximized === true, "Enter maximises dA");
    await poll(async () => { const b = await box(disp, "dA"); return b.width > 1200; }, "maximised in the display DOM");
    await tab.keyboard.press("Home");
    await poll(async () => { const s = await state("display-2"); return !!s && s.windows.every((w) => w.minimized); }, "Home shows the desktop");
    await tab.keyboard.press("Home");
    await poll(async () => { const s = await state("display-2"); return !!s && s.windows.every((w) => !w.minimized); }, "Home again restores");
    const t = await state("default"); eq([t?.focus, t?.windows[0].x, t?.windows[0].maximized, t?.windows[0].minimized], ["tC", 100, false, false], "tab state unchanged");
  });

  await test("adversary on the channel: wrong recipient, malformed shapes, replayed / stale seq change nothing; a fresh message does", COV, async () => {
    await putState("display-2", [win("dA", "notes", "Display notes", 200, 150, 20, "screen"), win("dB", "clock", "Display clock", 600, 300, 21, "screen")], "dB");
    await disp.reload(); await disp.locator('[data-win-id="dB"]').waitFor();
    const before = await box(disp, "dB");
    const S = Date.now() * 10;
    const sent = await tab.evaluate((S) => {
      const ch = new BroadcastChannel("fusion-shell");
      const base = { v: 1, kind: "pad", from: "evil", to: "display-2" };
      const msgs = [
        { ...base, to: "display-3", seq: S + 1, op: { t: "move", dx: 50, dy: 0 } },
        { ...base, seq: S + 2, op: { t: "move", dx: "50", dy: 0 } },
        { ...base, seq: S + 3, op: { t: "key", key: "Delete" } },
        { ...base, seq: S + 4, op: { t: "type", text: "x" } },
        { ...base, seq: "9", op: { t: "move", dx: 50, dy: 0 } },
        { ...base, v: 2, seq: S + 5, op: { t: "move", dx: 50, dy: 0 } },
        { ...base, from: "bad id!", seq: S + 6, op: { t: "move", dx: 50, dy: 0 } },
      ];
      for (const m of msgs) ch.postMessage(m);
      ch.postMessage({ ...base, seq: S + 10, op: { t: "move", dx: 7, dy: 0 } });
      ch.postMessage({ ...base, seq: S + 10, op: { t: "move", dx: 7, dy: 0 } });
      ch.postMessage({ ...base, seq: S + 9, op: { t: "move", dx: 7, dy: 0 } });
      ch.postMessage({ ...base, seq: S + 11, op: { t: "move", dx: 9000, dy: 0 } });
      return msgs.length + 4;
    }, S);
    eq(sent, 11, "messages sent");
    await poll(async () => { const b = await box(disp, "dB"); return b.x > before.x; }, "the fresh message applied");
    await new Promise((r) => setTimeout(r, 800));
    const after = await box(disp, "dB");
    const dx = Math.round(after.x - before.x);
    eq(dx, 7 + 400, "only the fresh +7 and the clamped +400 (from 9000) applied; replay / stale / wrong-to / malformed ignored");
    ok(Math.abs(after.y - before.y) <= 1, "no vertical change");
  });

  await test("a proxied page (opaque-origin sandbox, as Browser → proxy runs it) posting a VALID pad message moves nothing", COV, async () => {
    const before = await box(disp, "dB");
    const S = Date.now() * 10 + 5_000_000;
    const ran = await tab.evaluate((S) => new Promise<string>((done) => {
      window.addEventListener("message", (e) => { if (typeof e.data === "string" && e.data.startsWith("ran:")) done(e.data); });
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals allow-downloads");
      f.srcdoc = `<script>const ch = new BroadcastChannel("fusion-shell");
        for (let i = 0; i < 5; i++) ch.postMessage({ v: 1, kind: "pad", from: "default", to: "display-2", seq: ${S} + i, op: { t: "move", dx: 120, dy: 0 } });
        parent.postMessage("ran:" + String(self.origin), "*");<\/script>`;
      document.body.appendChild(f);
      setTimeout(() => done("timeout"), 5000);
    }), S);
    eq(ran, "ran:null", "the sandboxed script ran in an opaque origin");
    await new Promise((r) => setTimeout(r, 1200));
    const after = await box(disp, "dB");
    eq([Math.round(after.x - before.x), Math.round(after.y - before.y)], [0, 0], "display window unchanged");
    await tab.evaluate(() => document.querySelectorAll("iframe[srcdoc]").forEach((f) => f.remove()));
  });

  await test("no presenting screen: the status says so and the pad moves this tab's focused window", COV, async () => {
    await disp.close({ runBeforeUnload: true });
    await poll(async () => /No presenting screen/.test((await tab.getByTestId("pad-status").textContent()) ?? ""), "status after the display said goodbye");
    const c0 = await box(tab, "tC");
    await drag(-40, 20, 4);
    await poll(async () => { const c = await box(tab, "tC"); return Math.abs(c.x - c0.x + 40) <= 1 && Math.abs(c.y - c0.y - 20) <= 1; }, "local nudge");
    await poll(async () => { const w = await winOf("default", "tC"); return w?.x === 60 && w?.y === 140; }, "tab state persisted");
    await tab.getByRole("button", { name: "Resume on this screen" }).click();
    ok(!(await tab.getByTestId("blackout").count()), "resumed");
    eq(errors, [], "page errors");
  });
} finally {
  for (const [k, v] of saved) await setSetting(k, v);
  for (const [id, st] of [["default", savedDefault], ["display-2", savedDisplay]] as const) {
    const cur = await api("GET", `/api/state?id=${id}`); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
    if (st) await api("PUT", "/api/state", { id, revision: rev, state: st }).catch(() => {});
    else await putState(id, [], null).catch(() => {});
  }
  await browser.close();
}
finish();
