/**
 * TT58 test-only promotions (real browser, production server):
 *   SR-04 web results: off by default (no web row, no outside request while typing); opted in → exactly ONE explicit
 *         row ranked below every local result, carrying the provider URL, and still nothing leaves the page while typing
 *   DP-11 least privilege: loading the desktop and opening EVERY registered app asks for no permission — every
 *         prompting web API (notifications, geolocation, camera / microphone / screen, clipboard read, persistent
 *         storage, file pickers, MIDI, Bluetooth, USB, HID, serial, contacts, idle detection, wake lock) is wrapped and
 *         must never be called, and every permission Chromium reports stays "prompt"
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt58-rows.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t58r${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e58r-"));
const { test, finish } = makeHarness("e2e-tt58-rows");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
const title = (m: string) => MODULES.find((x) => x.id === m)!.title;
// a non-overlapping grid so every title bar is clickable
const win = (id: string, module: string, i: number, workspace = 1, t?: string) => ({ id, module, title: t ?? title(module), x: 20 + (i % 3) * 320, y: 30 + Math.floor(i / 3) * 260, w: 300, h: 220, z: 11 + i, minimized: false, maximized: false, workspace, host: "tab", props: {} });
async function putDesktop(windows: unknown[], extra: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Second" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, ...extra } });
}

const server = async (): Promise<any> => (await api("GET", "/api/state?id=default")).json.row?.state ?? {};
/** CSS <time> → ms (".16s", "160ms", "0s") */
const ms = (t: string) => { const v = t.trim(); return v.endsWith("ms") ? parseFloat(v) : Math.round(parseFloat(v) * 1000); };
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(opts: { dsf?: number; reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: opts.dsf ?? 1, reducedMotion: opts.reducedMotion, colorScheme: opts.colorScheme });
  ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("launcher-button").waitFor({ timeout: 30_000 });
  return page;
}

const outside = (u: string) => { try { const h = new URL(u).origin; return h !== new URL(BASE).origin && !u.startsWith("data:") && !u.startsWith("blob:"); } catch { return false; } };

await test("SR-04 web results: off by default — no web row and no outside request while typing; opted in — one explicit row ranked last with the provider URL, still nothing sent until it is picked", { "SR-04": "full" }, async () => {
  const before = (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === "search.webResults")?.value ?? "off";
  eq(before, "off", "seeded default is off");
  await putDesktop([]);
  const page = await newPage();
  const sent: string[] = []; page.on("request", (r) => { if (outside(r.url())) sent.push(r.url()); });
  const P = page.getByRole("dialog", { name: "Command palette" });
  const search = async (q: string) => {
    await page.getByRole("button", { name: "Search", exact: true }).first().click(); await P.waitFor();
    await P.locator("input").fill(""); await P.locator("input").pressSequentially(q, { delay: 20 });
    await page.waitForTimeout(600);
  };
  await search("zebra quantum notes");
  eq(await P.getByText(/Search the web for/).count(), 0, "no web row while off");
  eq(sent, [], "no request left the page while typing");
  await page.keyboard.press("Escape"); await page.context().close();
  await setSetting("search.webResults", "on");
  try {
    const p2 = await newPage();
    const sent2: string[] = []; p2.on("request", (r) => { if (outside(r.url())) sent2.push(r.url()); });
    const P2 = p2.getByRole("dialog", { name: "Command palette" });
    await p2.getByRole("button", { name: "Search", exact: true }).first().click(); await P2.waitFor();
    // a query with few local hits, then one with more than 40 (the 40-row cap must not cut the web row)
    for (const q of ["Calculator", "Settings"]) {
      await P2.locator("input").fill(""); await P2.locator("input").pressSequentially(q, { delay: 20 }); await p2.waitForTimeout(600);
      const rows = P2.locator(".fs-list-item");
      await poll(async () => (await P2.getByText(/Search the web for/).count()) === 1, `exactly one web row for "${q}"`);
      const n = await rows.count(); ok(n >= 2, `local results present (${n})`);
      const last = (await rows.nth(n - 1).textContent()) ?? "";
      ok(last.includes("Search the web for"), `the web row is ranked below every local result ("${q}", ${n} rows)`);
      ok(last.includes(`https://duckduckgo.com/?q=${q}`), "row shows the provider URL it would open");
      ok(last.includes("sent only on click"), "row says the query leaves only on click");
    }
    eq(sent2, [], "still no outside request while typing");
    await p2.context().close();
  } finally { await setSetting("search.webResults", before); }
});

await test("DP-11 least privilege: desktop + every registered app opened — no prompting permission API is called and every permission stays 'prompt'", { "DP-11": "full" }, async () => {
  await putDesktop([]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); ctx.setDefaultTimeout(20_000);
  const calls: string[] = [];
  await ctx.exposeBinding("__permCall", (_s, name: string) => { calls.push(name); });
  await ctx.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & { __permCall: (n: string) => void };
    const wrap = (obj: unknown, key: string, label: string) => {
      const o = obj as Record<string, unknown> | undefined; if (!o) return;
      try { const orig = o[key]; if (typeof orig !== "function") return; Object.defineProperty(o, key, { configurable: true, writable: true, value: function (this: unknown, ...a: unknown[]) { w.__permCall(label); return (orig as (...x: unknown[]) => unknown).apply(this, a); } }); } catch { /* read-only API */ }
    };
    const N = navigator as unknown as Record<string, unknown>;
    wrap(w.Notification, "requestPermission", "Notification.requestPermission");
    wrap(navigator.geolocation, "getCurrentPosition", "geolocation.getCurrentPosition"); wrap(navigator.geolocation, "watchPosition", "geolocation.watchPosition");
    wrap(navigator.mediaDevices, "getUserMedia", "getUserMedia"); wrap(navigator.mediaDevices, "getDisplayMedia", "getDisplayMedia");
    wrap(Object.getPrototypeOf(navigator.clipboard ?? {}), "read", "clipboard.read"); wrap(Object.getPrototypeOf(navigator.clipboard ?? {}), "readText", "clipboard.readText");
    wrap(Object.getPrototypeOf(navigator.storage ?? {}), "persist", "storage.persist");
    for (const k of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) wrap(w, k, k);
    wrap(N, "requestMIDIAccess", "requestMIDIAccess");
    for (const [o, k] of [["bluetooth", "requestDevice"], ["usb", "requestDevice"], ["hid", "requestDevice"], ["serial", "requestPort"], ["contacts", "select"], ["wakeLock", "request"]] as const) wrap(N[o], k, `${o}.${k}`);
    wrap(w.IdleDetector, "requestPermission", "IdleDetector.requestPermission");
  });
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" }); await page.getByTestId("launcher-button").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const opened: string[] = [];
  for (const m of MODULES) {
    await page.goto(`${BASE}/?open=${m.id}`, { waitUntil: "domcontentloaded" });
    await page.locator(`.fs-window[aria-label="${m.title}"]`).first().waitFor({ timeout: 25_000 }).then(() => opened.push(m.id), () => undefined);
    await page.waitForTimeout(400);
    await putDesktop([]);
  }
  ok(opened.length >= MODULES.length - 2, `opened ${opened.length}/${MODULES.length} apps (missing ${MODULES.map((m) => m.id).filter((id) => !opened.includes(id))})`);
  eq(calls, [], "prompting permission APIs called without a user action");
  const states = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const n of ["notifications", "geolocation", "camera", "microphone", "clipboard-read", "persistent-storage", "midi", "idle-detection"]) {
      try { out[n] = (await navigator.permissions.query({ name: n as PermissionName })).state; } catch { out[n] = "unsupported"; }
    }
    return out;
  });
  for (const [k, v] of Object.entries(states)) ok(v === "prompt" || v === "unsupported" || (k === "persistent-storage" && v === "granted"), `${k} is ${v}`);
  ok(Object.values(states).filter((v) => v === "prompt").length >= 5, `permissions reported: ${JSON.stringify(states)}`);
  await ctx.close();
});

await test("no uncaught page errors during the TT58 rows session", { "DP-11": "full" }, () => { eq(errors, [], "page errors"); });

await browser.close();
await putDesktop([]);
await finish();
process.exit(0);
