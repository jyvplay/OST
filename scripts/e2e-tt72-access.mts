/**
 * TT72 SC-05 — Privacy → Device access (Chromium 143, production build, real routes).
 * Browser A runs with Chromium's own fake capture devices + auto-accept UI (--use-fake-device-for-media-stream,
 * --use-fake-ui-for-media-stream): the real getUserMedia / getDisplayMedia code paths run and are granted.
 * Browser B runs without them and without permissions: the same requests fail / are denied, as on a machine with no
 * devices or a user who says no.
 *  1. Devices → Record (mic): a live "Devices · Voice" microphone entry appears; Stop on the dashboard ends the real
 *     track, the recorder stops on its own (the Devices button returns to Record), the row gets a duration.
 *  2. Lens: Start camera → camera + microphone live; Presenter → screen live; Stop camera (stopped by the module's own
 *     code, which fires no "ended" event) ends both entries.
 *  3. refusals: no devices → "failed NotFoundError"; clipboard read without permission → "denied NotAllowedError";
 *     location without permission → "denied PermissionDenied"; with permissions both are "granted" — and the log holds
 *     no clipboard text and no coordinates; Clear empties finished entries.
 *  4. nothing about the log leaves the tab: no request body sent during the test names a module label or device kind.
 * Restores the desktop state and settings; deletes the voice recording it creates.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt72-access.mts
 */
import { type Browser, type BrowserContext, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt72-access");
const COV = { "SC-05": "full" } as const;
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
const win = (id: string, module: string, title: string, x: number, w: number, z: number) => ({ id, module, title, x, y: 40, w, h: 820, z, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
async function putDesk(windows: unknown[], focus: string | null) {
  // a still-open page from the previous test would keep syncing ITS desktop over this fixture
  for (const b of browsers.splice(0)) await b.close().catch(() => {});
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, focusMode: false, nextZ: 40, viewport: { w: 1600, h: 1000 }, icons: [] } });
}
const T0 = Date.now();
async function purgeVoice() {
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) {
    const m = /\/voice-(\d+)\./.exec(n.path);
    if (m && Number(m[1]) >= T0) for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
  }
}

const FAKE = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
const browsers: Browser[] = [];
const errors: string[] = [];
const bodies: string[] = [];
async function page(args: string[], perms: string[] = []): Promise<{ ctx: BrowserContext; p: Page }> {
  const b = await launchChromium(args); browsers.push(b);
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, permissions: perms, ...(perms.includes("geolocation") ? { geolocation: { latitude: 35.779591, longitude: -78.638176 } } : {}) });
  ctx.setDefaultTimeout(20_000);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { const d = r.postData(); if (d) bodies.push(d.slice(0, 4000)); });
  return { ctx, p };
}
const W = (p: Page, id: string) => p.locator(`[data-win-id="${id}"]`);
const rows = (p: Page) => p.locator('[data-testid="access-row"]').evaluateAll((els) => els.map((e) => ({ app: e.getAttribute("data-app"), kinds: e.getAttribute("data-kinds"), outcome: e.getAttribute("data-outcome"), text: (e.textContent ?? "").replace(/\s+/g, " ") })));
async function openAccessTab(p: Page) { await W(p, "pv").getByRole("tab", { name: "Device access" }).click(); await W(p, "pv").getByTestId("access-log").waitFor(); }

const saved: [string, string][] = [];
for (const k of ["appearance.desktopView"]) saved.push([k, (await getSetting(k)) ?? ""]);
await setSetting("appearance.desktopView", "classic");
const savedDesk = (await api("GET", "/api/state?id=default")).json.row?.state;

try {
  await test("Devices → Record: live microphone entry; Stop on the dashboard ends the real track and the recorder; row gets a duration", COV, async () => {
    await putDesk([win("dv", "devices", "Devices", 0, 760, 20), win("pv", "privacy", "Privacy", 780, 800, 21)], "pv");
    const { p } = await page(FAKE);
    await p.goto(`${BASE}/`); await W(p, "pv").waitFor();
    await openAccessTab(p);
    await W(p, "pv").getByTestId("access-live-none").waitFor();
    await W(p, "dv").getByRole("button", { name: "⏺ Record" }).click();
    await W(p, "dv").getByRole("button", { name: "⏹ Stop" }).waitFor();
    await poll(async () => (await W(p, "pv").locator('[data-testid^="access-live-"]:not([data-testid="access-live-none"])').count()) === 1, "one live entry");
    let r = await rows(p);
    eq(r.map((x) => [x.app, x.kinds, x.outcome]), [["Devices · Voice", "microphone", "granted"]], "log row");
    ok(/live/.test(r[0].text), "row says live");
    await W(p, "pv").getByRole("button", { name: "Stop" }).click();
    await W(p, "pv").getByTestId("access-live-none").waitFor();
    await W(p, "dv").getByRole("button", { name: "⏺ Record" }).waitFor({ timeout: 10_000 });
    r = await rows(p);
    ok(/\d+ s/.test(r[0].text) && !/live/.test(r[0].text), `duration shown: ${r[0].text}`);
    await poll(async () => { const l = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] }; return (l.nodes ?? []).some((n) => { const m = /\/voice-(\d+)\./.exec(n.path); return !!m && Number(m[1]) >= T0; }); }, "the recorder stopped by itself and saved its file");
  });

  await test("Lens: camera + mic live, presenter screen live; the module's own Stop camera (no 'ended' event) ends both", COV, async () => {
    await putDesk([win("ln", "lens", "Lens", 0, 760, 20), win("pv", "privacy", "Privacy", 780, 800, 21)], "pv");
    const { p } = await page(FAKE);
    await p.goto(`${BASE}/`); await W(p, "pv").waitFor();
    await openAccessTab(p);
    await W(p, "ln").getByRole("button", { name: "Start camera" }).click();
    await W(p, "ln").getByRole("button", { name: "Stop camera" }).waitFor();
    await W(p, "ln").getByRole("button", { name: "Presenter: add screen" }).click();
    await poll(async () => (await rows(p)).length === 2, "two rows");
    const r = await rows(p);
    eq(r.map((x) => [x.app, x.kinds, x.outcome]), [["Lens · presenter", "screen", "granted"], ["Lens", "camera,microphone", "granted"]], "rows newest first");
    await poll(async () => (await W(p, "pv").locator('[data-testid^="access-live-"]:not([data-testid="access-live-none"])').count()) === 2, "two live");
    await W(p, "ln").getByRole("button", { name: "Stop camera" }).click();
    await W(p, "pv").getByTestId("access-live-none").waitFor();
    for (const x of await rows(p)) ok(!/live/.test(x.text), `ended: ${x.text}`);
  });

  await test("refusals and grants are logged with the module — no clipboard text or coordinates kept; Clear empties finished rows", COV, async () => {
    await putDesk([win("dv", "devices", "Devices", 0, 380, 20), win("cb", "clipboard", "Clipboard", 390, 380, 21), win("mp", "maps", "Maps", 780, 380, 22), win("pv", "privacy", "Privacy", 1170, 430, 23)], "pv");
    const { p } = await page([]);
    await p.goto(`${BASE}/`); await W(p, "pv").waitFor();
    await openAccessTab(p);
    await W(p, "dv").getByRole("button", { name: "⏺ Record" }).click();
    await W(p, "cb").getByRole("button", { name: "Capture system clipboard now" }).click();
    await W(p, "mp").getByTestId("mp-locate").click();
    await poll(async () => (await rows(p)).length === 3, "three rows");
    const r = Object.fromEntries((await rows(p)).map((x) => [x.app, [x.kinds, x.outcome, /NotFoundError|NotAllowedError|PermissionDenied/.exec(x.text)?.[0]]]).sort());
    eq(r, { Clipboard: ["clipboard-read", "denied", "NotAllowedError"], "Devices · Voice": ["microphone", "failed", "NotFoundError"], Maps: ["location", "denied", "PermissionDenied"] }, "refusals");
    await W(p, "pv").getByRole("button", { name: "Clear" }).click();
    await poll(async () => (await rows(p)).length === 0, "cleared");

    const g = await page([], ["clipboard-read", "clipboard-write", "geolocation"]);
    const q = g.p;
    await q.goto(`${BASE}/`); await W(q, "pv").waitFor();
    const SECRET = `tt72-secret-${Date.now()}`;
    await q.evaluate((s) => navigator.clipboard.writeText(s), SECRET);
    await openAccessTab(q);
    await W(q, "cb").getByRole("button", { name: "Capture system clipboard now" }).click();
    await W(q, "mp").getByTestId("mp-locate").click();
    await poll(async () => (await rows(q)).length === 2, "two granted rows");
    const r2 = Object.fromEntries((await rows(q)).map((x) => [x.app, [x.kinds, x.outcome]]).sort());
    eq(r2, { Clipboard: ["clipboard-read", "granted"], Maps: ["location", "granted"] }, "grants");
    const panel = (await W(q, "pv").getByTestId("access-log").textContent()) ?? "";
    ok(!panel.includes(SECRET), "no clipboard text in the log");
    ok(!/35\.77|78\.63/.test(panel), "no coordinates in the log");
  });

  await test("nothing about the log leaves the tab: no request body names a logged module label or device kind", COV, async () => {
    const leaks = bodies.filter((b) => /Devices · Voice|Lens · presenter|clipboard-read|"microphone"|"camera"|"location"/.test(b));
    eq(leaks.map((b) => b.slice(0, 120)), [], "request bodies");
    ok(bodies.length > 0, `requests were observed (${bodies.length})`);
    eq(errors, [], "page errors");
  });
} finally {
  await purgeVoice().catch(() => {});
  for (const [k, v] of saved) await setSetting(k, v);
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  if (savedDesk) await api("PUT", "/api/state", { id: "default", revision: rev, state: savedDesk }).catch(() => {});
  for (const b of browsers) await b.close().catch(() => {});
}
finish();
