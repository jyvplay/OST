/**
 * Real-browser suite: Playwright + headless Chromium against a running server.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings scripts/e2e.mts
 *
 * Fake media devices (--use-fake-device-for-media-stream) give getUserMedia a
 * synthetic camera/mic, so the Lens pipeline processes real frames. mDNS host
 * candidate obfuscation is disabled so two contexts can form a WebRTC link on
 * loopback without an mDNS responder.
 */
import { type Browser, type BrowserContext, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `e${Date.now().toString(36)}`;
const DIR = `/E2E-${RUN}`;
const { test, finish } = makeHarness("e2e");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", {
    id: "default", revision: rev,
    state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }, { id: 3, name: "Media" }],
      activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev },
  });
}

interface Watch { errors: string[]; consoleErrors: string[] }
function watch(page: Page): Watch {
  const w: Watch = { errors: [], consoleErrors: [] };
  page.on("pageerror", (e) => w.errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404|409|net::ERR/.test(m.text())) w.consoleErrors.push(m.text());
  });
  return w;
}

async function openModule(page: Page, id: string, title: string) {
  await page.goto(`${BASE}/?open=${id}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator(`[role=dialog][aria-label="${title}"]`).first();
  await dlg.waitFor({ state: "visible", timeout: 20_000 });
  return dlg;
}

const browser: Browser = await launchChromium([
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--disable-features=WebRtcHideLocalIpsWithMdns", "--autoplay-policy=no-user-gesture-required",
]);
const newCtx = async (): Promise<BrowserContext> => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await ctx.grantPermissions(["camera", "microphone", "clipboard-read", "clipboard-write", "notifications"], { origin: BASE });
  return ctx;
};

/* ------------------------------------------------------------------ smoke */
console.log("\nEvery module mounts in real Chromium without an uncaught error");
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  const w = watch(page);
  for (const m of MODULES) {
    await test(`mount: ${m.id}`, Object.fromEntries(m.implements.map((c) => [c, "partial" as const])), async () => {
      await resetDesktop();
      const before = w.errors.length;
      await openModule(page, m.id, m.title);
      await sleep(900);
      ok(await page.locator("header[role=banner]").isVisible(), "top bar vanished (shell crashed)");
      ok(w.errors.length === before, `uncaught: ${w.errors.slice(before).join(" | ")}`);
    });
  }
  await test("no non-resource console errors across all module mounts", { "DP-07": "partial" }, () => {
    ok(w.consoleErrors.length === 0, w.consoleErrors.slice(0, 5).join(" | "));
  });
  await ctx.close();
}

/* ------------------------------------------------------------ interaction */
console.log("\nInteractions");
const ctx = await newCtx();
const page = await ctx.newPage();
const w = watch(page);

await test("drag a window by its title bar; geometry is committed and persisted", { "WM-01": "full", "HW-01": "partial", "SH-08": "full" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "calculator", "Calculator");
  const b0 = (await dlg.boundingBox())!;
  const bar = dlg.locator(".fs-titlebar");
  const bb = (await bar.boundingBox())!;
  await page.mouse.move(bb.x + 60, bb.y + bb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(bb.x + 60 + i * 15, bb.y + bb.height / 2 + i * 9);
  await page.mouse.up();
  await sleep(300);
  const b1 = (await dlg.boundingBox())!;
  ok(Math.abs(b1.x - b0.x - 150) <= 3 && Math.abs(b1.y - b0.y - 90) <= 3, `moved by ${b1.x - b0.x},${b1.y - b0.y}`);
  await sleep(1500); // persistence debounce 600 ms
  const st = await api("GET", "/api/state?id=default");
  const win = st.json.row.state.windows.find((x: { module: string }) => x.module === "calculator");
  ok(win && Math.abs(win.x - (b1.x - 0)) < 200, "geometry not persisted");
  const x1 = win.x;
  await page.reload({ waitUntil: "domcontentloaded" });
  const again = page.locator('[role=dialog][aria-label="Calculator"]').first();
  await again.waitFor({ timeout: 15_000 });
  await sleep(500);
  const st2 = await api("GET", "/api/state?id=default");
  ok(st2.json.row.state.windows.find((x: { module: string }) => x.module === "calculator").x === x1, "restore changed geometry");
});

await test("keyboard tiling: Meta+ArrowLeft snaps the focused window to the left half", { "WM-02": "full", "WM-09": "full", "AX-05": "partial" }, async () => {
  const dlg = page.locator('[role=dialog][aria-label="Calculator"]').first();
  await dlg.locator(".fs-titlebar").click({ position: { x: 40, y: 10 } });
  await page.keyboard.press("Meta+ArrowLeft");
  await sleep(300);
  const b = (await dlg.boundingBox())!;
  const vw = page.viewportSize()!.width;
  ok(b.x <= 2 && Math.abs(b.width - vw / 2) <= 4, `got x=${b.x} w=${b.width}`);
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await sleep(250);
  ok(Math.abs((await dlg.boundingBox())!.x - 16) <= 2, "Meta+Shift+Arrow did not nudge 16 px");
});

await test("calculator evaluates typed input with the shared evaluator", { "PR-09": "full" }, async () => {
  const dlg = page.locator('[role=dialog][aria-label="Calculator"]').first();
  await dlg.getByLabel("Expression").fill("2+2*3");
  await dlg.getByText("= 8", { exact: true }).waitFor({ timeout: 5000 });
});

await test("palette: Ctrl+Space, typo 'noets' surfaces Notes with provenance; Enter opens it", { "SR-01": "full", "SR-03": "full" }, async () => {
  await page.keyboard.press("Control+Space");
  const pal = page.locator('[role=dialog][aria-label="Command palette"]');
  await pal.waitFor({ timeout: 5000 });
  await page.keyboard.type("noets");
  await pal.getByText("module registry").first().waitFor({ timeout: 5000 });
  ok(await pal.getByText(/Notes/).first().isVisible(), "Notes not listed");
  await page.keyboard.press("Enter");
  await page.locator('[role=dialog][aria-label="Notes"]').first().waitFor({ timeout: 8000 });
});

await test("terminal: write + cat through the journal; mv shows journal op", { "TD-01": "full", "TD-02": "full" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "terminal", "Terminal");
  const input = dlg.getByLabel("Terminal input");
  await input.fill(`write ${DIR}/t.md hello-e2e`); await input.press("Enter");
  await dlg.getByText(/wrote \d+ B/).waitFor({ timeout: 8000 });
  await input.fill(`cat ${DIR}/t.md`); await input.press("Enter");
  await dlg.locator("pre", { hasText: /^hello-e2e$/ }).waitFor({ timeout: 8000 });
  await input.fill(`mv ${DIR}/t.md ${DIR}/m.md`); await input.press("Enter");
  await dlg.getByText(/journal op #\d+ COMPLETE/).waitFor({ timeout: 8000 });
});

await test("editor: open via terminal, edit, Ctrl+S → saved and a version snapshot exists", { "PR-01": "full", "FM-18": "full", "FF-15": "partial" }, async () => {
  const term = page.locator('[role=dialog][aria-label="Terminal"]').first();
  const input = term.getByLabel("Terminal input");
  await input.fill(`open editor ${DIR}/m.md`); await input.press("Enter");
  const ed = page.locator('[role=dialog]').filter({ has: page.getByLabel(`Editing ${DIR}/m.md`) }).first();
  const ta = ed.getByLabel(`Editing ${DIR}/m.md`);
  await ta.waitFor({ timeout: 8000 });
  await ta.click(); await page.keyboard.press("End"); await page.keyboard.type(" +edit");
  await ed.getByText("unsaved").waitFor({ timeout: 3000 });
  await page.keyboard.press("Control+s");
  await ed.getByText(/^saved · sha/).waitFor({ timeout: 8000 });
  const v = await api("GET", `/api/fs?op=versions&path=${encodeURIComponent(`${DIR}/m.md`)}`);
  ok(v.json.versions.length >= 1 && v.json.versions.at(-1).content === "hello-e2e", JSON.stringify(v.json.versions.map((x: { content: string }) => x.content)));
  ok((await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`${DIR}/m.md`)}`)).json.node.content === "hello-e2e +edit", "saved content wrong");
});

await test("Files upload of a 1 MiB binary succeeds (stack-overflow base64 fix)", { "FM-01": "partial", "FM-03": "partial" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "files", "Files");
  const bytes = Buffer.alloc(1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
  await dlg.locator('input[type=file]').setInputFiles({ name: `big-${RUN}.bin`, mimeType: "application/octet-stream", buffer: bytes });
  await dlg.getByText(`big-${RUN}.bin`).waitFor({ timeout: 20_000 });
  const n = await api("GET", `/api/fs?op=stat&path=/big-${RUN}.bin`);
  ok(n.json.node?.size === 1024 * 1024, `size ${n.json.node?.size}`);
  await api("POST", "/api/fs", { op: "purge", path: `/big-${RUN}.bin` });
  ok(!w.errors.some((e) => /call stack/i.test(e)), "RangeError: call stack exceeded");
});

await test("routines: dry-run lists actions without executing; Run opens the window", { "AU-01": "full" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "routines", "Routines");
  await dlg.getByLabel("Routine name").fill(`r-${RUN}`);
  await dlg.getByLabel("Routine script").fill("open clock");
  await dlg.getByRole("button", { name: "Dry run" }).click();
  await dlg.getByText(/Dry run — nothing executed:\s*1\. open clock/).waitFor({ timeout: 4000 });
  ok(await page.locator('[role=dialog][aria-label="Clock"]').count() === 0, "dry run executed");
  await dlg.getByRole("button", { name: "Save routine" }).click();
  const row = dlg.locator("div.fs-row", { hasText: `r-${RUN}` }).last();
  await row.waitFor({ timeout: 6000 });
  await row.getByRole("button", { name: "Run" }).click();
  await page.locator('[role=dialog][aria-label="Clock"]').first().waitFor({ timeout: 6000 });
  const rs = await api("GET", "/api/routines");
  for (const r of rs.json.rows.filter((x: { name: string }) => x.name === `r-${RUN}`)) await api("DELETE", `/api/routines?id=${r.id}`);
});

await test("clock stopwatch advances from performance.now anchors", { "PR-10": "partial" }, async () => {
  const dlg = page.locator('[role=dialog][aria-label="Clock"]').first();
  const sec = dlg.locator("section", { hasText: "Stopwatch" });
  await sec.getByRole("button", { name: "Start" }).click();
  const t0 = Date.now();
  await sleep(1600);
  // The display is rAF-driven; on a loaded 2-core runner a frame can lag the anchor.
  // Contract: elapsed derives from performance.now anchors, so the reading must reach
  // >= 1.3 s and never exceed real wall time elapsed since Start (+0.3 s slack).
  let t = "", s = 0;
  for (let i = 0; i < 20; i++) {
    t = await sec.locator(".fs-mono").first().innerText();
    const [mm, rest] = t.split(":"); s = Number(mm) * 60 + Number(rest);
    if (s >= 1.3) break;
    await sleep(150);
  }
  ok(s >= 1.3 && s <= (Date.now() - t0) / 1000 + 0.3, `stopwatch read ${t} after ${(Date.now() - t0) / 1000}s`);
});

await test("Lens processes frames from a (fake) camera at > 0 fps", { "LN-01": "full", "LN-13": "partial", "LN-15": "partial" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "lens", "Lens");
  await dlg.getByRole("button", { name: "Start camera" }).click();
  // poll (TT16): on a loaded 2-CPU host the first frames can take > 4 s; the contract is still "> 0 fps"
  let txt = "";
  for (let i = 0; i < 24; i++) { await sleep(500); txt = await dlg.getByText(/\d+ fps · \d+p/).first().innerText(); if (Number(/^(\d+)/.exec(txt)![1]) > 0) break; }
  ok(Number(/^(\d+)/.exec(txt)![1]) > 0, `badge after 12 s: ${txt}`);
  await dlg.getByRole("button", { name: "Stop camera" }).click();
});

await test("governor reacts to injected long tasks", { "RG-01": "partial", "RG-04": "partial" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "monitor", "Monitor");
  for (let i = 0; i < 3; i++) { await dlg.getByRole("button", { name: /Inject a long task/ }).click(); await sleep(200); }
  await sleep(800);
  const t = await dlg.getByText(/long tasks\/min/).first().innerText();
  ok(Number(/(\d+)/.exec(t)![1]) >= 1, `governor saw: ${t}`);
});

await test("Beam lists every transport and names the missing primitive on blocked ones", { "CA-05": "partial", "DP-10": "full", "CA-03": "full", "CA-04": "full", "CA-06": "full", "CA-07": "full", "CA-10": "full", "CA-12": "full" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "beam", "Beam");
  const reasons = await dlg.getByText("Missing primitive:").count();
  ok(reasons >= 6, `only ${reasons} blocked transports explained`);
  for (const label of ["AirPlay audio (RAOP/ALAC) direct", "Google Cast (castv2) direct", "AirPlay screen mirroring (FairPlay)", "DLNA / UPnP", "Miracast", "Act as an AirPlay / Cast receiver"]) {
    ok(await dlg.getByText(label, { exact: true }).isVisible(), `missing row ${label}`);
  }
});

await test("Spec module renders the full register", { "DP-08": "partial" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "spec", "Spec");
  const n = (await api("GET", "/api/features")).json.total;
  ok(Number(n) > 250, `register size ${n}`);
  await dlg.getByText(`${n} rows`).waitFor({ timeout: 8000 });
});

await test("Overview (Meta+Q) and Blackout overlay toggle", { "WM-04": "partial", "SH-10": "partial" }, async () => {
  await page.keyboard.press("Meta+q");
  await page.locator('[role=dialog][aria-label="Overview"]').waitFor({ timeout: 4000 });
  await page.keyboard.press("Escape");
  await page.getByTitle("Blackout this screen (BlackTop)").click();
  await page.getByText(/^Blackout — this screen is a touchpad/).waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: "Resume on this screen" }).click();
});

await test("structural a11y: every window is a named dialog; no unnamed buttons", { "AX-01": "partial", "AX-02": "partial" }, async () => {
  await resetDesktop();
  for (const [id, title] of [["files", "Files"], ["settings", "Settings"], ["beam", "Beam"]] as const) {
    await page.goto(`${BASE}/?open=${id}`); await page.locator(`[role=dialog][aria-label="${title}"]`).first().waitFor({ timeout: 15000 });
  }
  await sleep(800);
  const r = await page.evaluate(() => {
    const unnamed = [...document.querySelectorAll("button")].filter((b) => !(b.getAttribute("aria-label") || b.title || b.textContent?.trim()));
    const dialogs = [...document.querySelectorAll("[role=dialog]")].filter((d) => !d.getAttribute("aria-label"));
    return { unnamed: unnamed.map((b) => b.outerHTML.slice(0, 80)), unlabeledDialogs: dialogs.length };
  });
  ok(r.unnamed.length === 0, `unnamed buttons: ${r.unnamed.slice(0, 3).join(" | ")}`);
  ok(r.unlabeledDialogs === 0, `${r.unlabeledDialogs} dialogs without a label`);
});

await test("offline write is queued, then replayed through the journal when back online", { "SH-14": "full" }, async () => {
  await resetDesktop();
  const dlg = await openModule(page, "terminal", "Terminal");
  await sleep(500);
  await ctx.setOffline(true);
  const input = dlg.getByLabel("Terminal input");
  await input.fill(`write ${DIR}/offline.md written-while-offline`); await input.press("Enter");
  await dlg.getByText(/queued for replay/).waitFor({ timeout: 8000 });
  ok((await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`${DIR}/offline.md`)}`)).status === 404, "write reached server while offline");
  await ctx.setOffline(false);
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await sleep(500);
    found = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`${DIR}/offline.md`)}`)).json.node?.content === "written-while-offline";
  }
  ok(found, "queued write never replayed");
});
await ctx.close();

/* --------------------------------------------- two-browser WebRTC bridge */
console.log("\nTwo browser contexts");
await test("WebRTC data channel between two contexts via Postgres signalling", { "CT-02": "full", "CA-09": "partial" }, async () => {
  const a = await newCtx(); const b = await newCtx();
  const pa = await a.newPage(); const pb = await b.newPage();
  const room = `R${RUN}`.toUpperCase().slice(0, 12);
  for (const p of [pa, pb]) {
    await resetDesktop();
    const d = await openModule(p, "share", "Share");
    await d.getByLabel("Room").fill(room);
  }
  await pa.locator('[role=dialog][aria-label="Share"]').getByRole("button", { name: "Join" }).click();
  await pb.locator('[role=dialog][aria-label="Share"]').getByRole("button", { name: "Join" }).click();
  await pa.getByText("bridge channel open").waitFor({ timeout: 30_000 });
  await pb.getByText("bridge channel open").waitFor({ timeout: 30_000 });
  const msg = pa.getByPlaceholder("message or text to send");
  await msg.fill(`hi-${RUN}`); await msg.press("Enter");
  await pb.getByText(`peer: hi-${RUN}`).waitFor({ timeout: 10_000 });
  await a.close(); await b.close();
});

/* ------------------------------------- widget watchdog falsification test */
console.log("\nWidget isolation (H∂: depends on the browser's site-isolation policy)");
async function hangTest(b: Browser) {
  const c = await b.newContext({ viewport: { width: 1440, height: 960 } }); const p = await c.newPage();
  const name = `e2e-hang-${RUN}.html`;
  await api("POST", "/api/fs", { op: "write", path: `/Widgets/${name}`, content: `<button onclick="while(true){}">Hang</button>` });
  const prev = (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === "shell.widgets")?.value;
  await api("PUT", "/api/settings", { key: "shell.widgets", value: "clock,stickies,system,user" });
  try {
    await resetDesktop();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    const card = p.locator(".fs-panel", { hasText: name }).first();
    await card.getByText("live").waitFor({ timeout: 20_000 });
    await p.frameLocator(`iframe[title="${name}"]`).getByRole("button", { name: "Hang" }).click({ noWaitAfter: true, timeout: 5000 }).catch(() => undefined);
    const alive = await Promise.race([p.evaluate(() => 42), sleep(4000).then(() => -1)]);
    if (alive !== 42) return { responsive: false, greyed: false };
    await card.getByText("not responding").waitFor({ timeout: 6000 });
    return { responsive: true, greyed: true };
  } finally {
    await c.close().catch(() => undefined);
    await api("PUT", "/api/settings", { key: "shell.widgets", value: prev ?? "clock,stickies,system" });
    await api("POST", "/api/fs", { op: "purge", path: `/Widgets/${name}` });
  }
}
await test("SH-05 under full site isolation (--site-per-process): hung widget greys, shell responsive", { "SH-05": "partial" }, async () => {
  const iso = await launchChromium(["--site-per-process"]);
  try { const r = await hangTest(iso); ok(r.responsive && r.greyed, JSON.stringify(r)); } finally { await iso.close(); }
});
await test("characterisation: default headless config freezes the shell (documented limitation, not a pass claim)", {}, async () => {
  const r = await hangTest(browser);
  ok(!r.responsive, "default config now isolates sandboxed frames — upgrade SH-05 and update docs");
});
await test("desktop shows sticky note widget; seeded widget has no hang button", { "PR-13": "full" }, async () => {
  const c = await newCtx(); const p = await c.newPage();
  await resetDesktop(); await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.getByLabel(/Sticky note/).first().waitFor({ timeout: 15_000 });
  const h = await api("GET", "/api/fs?op=read&path=/Widgets/hello.html");
  ok(!String(h.json.node?.content ?? "").includes("while(true)"), "footgun still seeded");
  await c.close();
});

await browser.close();
await api("POST", "/api/fs", { op: "purge", path: DIR });
finish();
