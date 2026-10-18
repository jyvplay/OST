/**
 * Suite "e2e-tt30" (TT30): the built-in Narrator screen reader (AX-14).
 *  1. Oracle: our accessible names / roles vs Chromium's accessibility tree (CDP) for every visible control,
 *     heading, landmark, image and table part, in all 40 modules × 3 layouts. Thresholds declared up front:
 *     names ≥ 98 %, roles ≥ 99 %. Mismatches are printed verbatim.
 *  2. Oracle sensitivity: three source mutants (bundled from mutated source by esbuild) must be caught.
 *  3. Behaviour on the real page: toggle chord, focus + dialog context, typing echo, live regions (polite queued vs
 *     assertive interrupting), Narrator-key cursor (heading / item / landmark), Ctrl stops speech, speed, help,
 *     captions-only mode. Speech is observed by wrapping window.speechSynthesis.speak / cancel (the real calls still
 *     go through). Headless Chromium here has no voices (speak → "synthesis-failed"), so AUDIBLE output is not
 *     verified — only what the Narrator asks the browser to say, at which rate, and when it interrupts.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt30.mts
 */
import type { Page } from "playwright";
import { makeHarness } from "./harness.mts";
import { launchChromium } from "./browser-launch.mts";
import { compareWithChromium, type AxRow, type Mutation } from "./ax-oracle.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt30");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
const KEYS = ["appearance.layout", "accessibility.narrator", "accessibility.narratorRate", "accessibility.narratorCaptions", "accessibility.narratorSpeech", "accessibility.narratorVoice", "shell.shortcutPreset"];
const saved: Record<string, string> = {};
for (const r of (await api("GET", "/api/settings")).rows as { key: string; value: string }[]) if (KEYS.includes(r.key)) saved[r.key] = r.value;
const set = (k: string, v: string) => api("PUT", "/api/settings", { key: k, value: v });
const getSetting = async (k: string) => ((await api("GET", "/api/settings")).rows as { key: string; value: string }[]).find((r) => r.key === k)?.value;

const MODULES = ["files", "editor", "find", "terminal", "notes", "browser", "media", "capture", "lens", "beam", "together", "messages", "vault", "privacy", "backup", "alerts", "monitor", "calculator", "settings", "spec", "clock", "planner", "devices", "share", "routines", "clipboard", "storage", "localdisk", "imageedit", "vector", "writer", "slides", "sheet", "contacts", "tables", "whiteboard", "peek", "video", "music", "maps"];
const win = (id: string, module: string, i: number) => ({ id, module, title: module, x: 30 + i * 28, y: 30 + i * 18, w: 880, h: 580, z: 11 + i, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
async function desktop(windows: ReturnType<typeof win>[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows, focus: windows.at(-1)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 60 } });
}
const browser = await launchChromium();
async function boot(windows: ReturnType<typeof win>[], spy = false): Promise<Page> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(/(youtube|ytimg|vimeo|soundcloud|spotify|openstreetmap)\./i, (r) => r.fulfill({ status: 204, body: "" }));
  if (spy) await ctx.addInitScript(() => {
    // observe (not replace) the browser's speech calls: record, then let the real call proceed
    const log: { op: "speak" | "cancel"; text?: string; rate?: number; t: number }[] = [];
    (window as unknown as { __speech: typeof log }).__speech = log;
    const ss = window.speechSynthesis;
    if (!ss) return;
    const speak = ss.speak.bind(ss), cancel = ss.cancel.bind(ss);
    ss.speak = (u: SpeechSynthesisUtterance) => { log.push({ op: "speak", text: u.text, rate: u.rate, t: performance.now() }); speak(u); };
    ss.cancel = () => { log.push({ op: "cancel", t: performance.now() }); cancel(); };
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await sleep(2500);
  return page;
}
const speech = (p: Page) => p.evaluate(() => (window as unknown as { __speech: { op: string; text?: string; rate?: number }[] }).__speech.slice());
const captions = (p: Page) => p.locator('[data-testid="narrator-line"]').allInnerTexts();
async function waitCaption(p: Page, re: RegExp, ms = 3000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const c = await captions(p); const hit = c.find((x) => re.test(x)); if (hit) return hit; await sleep(60); }
  throw new Error(`no caption matching ${re}; last captions: ${JSON.stringify(await captions(p))}`);
}
const fmt = (r: AxRow) => `[${r.where}] ${r.tag} ours=${JSON.stringify(r.ours)} chromium=${JSON.stringify({ name: r.chromium.name, role: r.chromium.role })} ${r.html.slice(0, 120)}`;

try {
  await test("oracle: our accessible names and roles agree with Chromium's accessibility tree in all 40 modules × 3 layouts (thresholds declared up front: names ≥ 98 %, roles ≥ 99 %)", { "AX-14": "full" }, async () => {
    let n = 0, nameOk = 0, roleOk = 0;
    const nameMis: AxRow[] = [], roleMis: AxRow[] = [];
    const batches: string[][] = [];
    for (let i = 0; i < MODULES.length; i += 7) batches.push(MODULES.slice(i, i + 7));
    for (const layout of ["fusion", "business", "art"]) {
      await set("appearance.layout", layout);
      for (const b of batches) {
        const page = await boot(b.map((m, i) => win(`w${i}`, m, i)));
        const r = await compareWithChromium(page);
        await page.context().close();
        n += r.compared; nameOk += r.compared - r.nameMismatch.length; roleOk += r.compared - r.roleMismatch.length;
        nameMis.push(...r.nameMismatch); roleMis.push(...r.roleMismatch);
      }
    }
    const nA = nameOk / n, rA = roleOk / n;
    console.log(`    oracle: ${n} element comparisons; names ${(nA * 100).toFixed(2)} % (${nameMis.length} differ), roles ${(rA * 100).toFixed(2)} % (${roleMis.length} differ)`);
    for (const m of nameMis.slice(0, 15)) console.log("    name ≠ " + fmt(m));
    for (const m of roleMis.slice(0, 15)) console.log("    role ≠ " + fmt(m));
    ok(n >= 3000, `too few comparisons (${n}) — the scan did not see the modules`);
    ok(nA >= 0.98, `names agree ${(nA * 100).toFixed(2)} % < 98 %`);
    ok(rA >= 0.99, `roles agree ${(rA * 100).toFixed(2)} % < 99 %`);
  });

  await test("oracle sensitivity: three mutants of the narrator source are caught (aria-label ignored → names < 98 %; buttons as generic → roles < 99 %; CSS text-transform ignored → the uppercase headings differ)", { "AX-14": "full" }, async () => {
    await set("appearance.layout", "fusion");
    const page = await boot(["settings", "files", "sheet", "notes"].map((m, i) => win(`w${i}`, m, i)));
    const M1: Mutation[] = [{ file: "narrator-core.ts", from: 'const label = norm(a("aria-label") ?? "");', to: 'const label = "";' }];
    const M2: Mutation[] = [{ file: "narrator-core.ts", from: 'case "button": return "button";', to: 'case "button": return "generic";' }];
    const M3: Mutation[] = [{ file: "narrator-dom.ts", from: 'if (tt === "uppercase") return t.toUpperCase();', to: 'if (tt === "uppercase") return t;' }];
    const base = await compareWithChromium(page);
    const r1 = await compareWithChromium(page, "body", M1);
    const r2 = await compareWithChromium(page, "body", M2);
    const r3 = await compareWithChromium(page, "body", M3);
    await page.context().close();
    console.log(`    baseline names ${(base.nameAgree * 100).toFixed(1)} % roles ${(base.roleAgree * 100).toFixed(1)} %; M1 names ${(r1.nameAgree * 100).toFixed(1)} %; M2 roles ${(r2.roleAgree * 100).toFixed(1)} %; M3 name mismatches ${r3.nameMismatch.length}`);
    ok(base.nameAgree >= 0.98 && base.roleAgree >= 0.99, "baseline must pass on the same page");
    ok(r1.nameAgree < 0.98, "M1 (aria-label ignored) not caught");
    ok(r2.roleAgree < 0.99, "M2 (button → generic) not caught");
    ok(r3.nameMismatch.length > base.nameMismatch.length && r3.nameMismatch.some((m) => m.chromium.name === m.chromium.name.toUpperCase() && m.ours.name !== m.chromium.name), "M3 (text-transform ignored) not caught");
  });

  await test("behaviour: the toggle chord turns Narrator on (spoken + captioned + saved); Tab focus is announced with name and role and the cursor box surrounds the focused element; entering a window announces its dialog context; typing is echoed", { "AX-14": "full" }, async () => {
    await set("appearance.layout", "fusion"); await set("accessibility.narrator", "off"); await set("accessibility.narratorRate", "1"); await set("accessibility.narratorSpeech", "on"); await set("accessibility.narratorCaptions", "on"); await set("shell.shortcutPreset", "hybrid");
    // TT32: this suite checks the SYSTEM engine path (speechSynthesis calls); "auto" would hand a voiceless browser
    // to Fusion Voice, which e2e-tt32 covers
    await set("accessibility.narratorVoice", "system");
    const page = await boot([win("n1", "notes", 0)], true);
    await page.mouse.click(700, 880 - 300); // a neutral spot so the page has keyboard focus
    await page.keyboard.press("Control+Meta+Enter");
    await waitCaption(page, /^Narrator on\./);
    ok((await speech(page)).some((s) => s.op === "speak" && /^Narrator on\./.test(s.text ?? "")), "start not spoken");
    for (let i = 0; i < 40 && (await getSetting("accessibility.narrator")) !== "on"; i++) await sleep(100);
    ok((await getSetting("accessibility.narrator")) === "on", "toggle not saved");
    // focus a dock / taskbar button from outside the window
    const btn = page.locator('footer[aria-label="Shelf"] button, nav[data-testid=dock] button').first();
    await btn.focus();
    const name = (await btn.getAttribute("aria-label")) ?? (await btn.innerText());
    const cap = await waitCaption(page, new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 20)}.*button`));
    console.log(`    focus caption: "${cap}"`);
    const box = await page.locator('[data-testid="narrator-cursor"]').boundingBox();
    const bb = await btn.boundingBox();
    ok(box && bb && box.x <= bb.x && box.y <= bb.y && box.x + box.width >= bb.x + bb.width && box.y + box.height >= bb.y + bb.height, `cursor box ${JSON.stringify(box)} does not surround ${JSON.stringify(bb)}`);
    // enter the Notes window: its dialog context is announced first
    const field = page.locator('[data-win-id="n1"]').locator("input, textarea").first();
    await field.focus();
    const c2 = await waitCaption(page, /dialog\./);
    console.log(`    window entry caption: "${c2}"`);
    ok(/notes|Notes/.test(c2.split("dialog")[0]), "dialog context lacks the window name");
    await page.keyboard.type("q");
    await waitCaption(page, /^q$/);
    await page.context().close();
  });

  await test("behaviour: live regions — a polite status is queued without interrupting, an assertive alert interrupts (cancel before speak); aria-busy holds back; Ctrl alone stops speech", { "AX-14": "full" }, async () => {
    await set("accessibility.narrator", "on");
    const page = await boot([], true);
    await waitCaption(page, /^Narrator on\./);
    await page.evaluate(() => {
      const mk = (attrs: Record<string, string>) => { const d = document.createElement("div"); for (const [k, v] of Object.entries(attrs)) d.setAttribute(k, v); d.style.cssText = "position:fixed;left:0;top:0;font-size:12px"; document.body.appendChild(d); return d; };
      (window as unknown as Record<string, HTMLElement>).__st = mk({ role: "status", id: "t-st" });
      (window as unknown as Record<string, HTMLElement>).__al = mk({ role: "alert", id: "t-al" });
      (window as unknown as Record<string, HTMLElement>).__bz = mk({ "aria-live": "polite", "aria-busy": "true", id: "t-bz" });
    });
    await sleep(300);
    const before = (await speech(page)).length;
    await page.evaluate(() => { (window as unknown as Record<string, HTMLElement>).__st.textContent = "3 files copied"; });
    await waitCaption(page, /^3 files copied$/);
    let log = (await speech(page)).slice(before);
    const iP = log.findIndex((s) => s.text === "3 files copied");
    ok(iP >= 0 && (iP === 0 || log[iP - 1].op !== "cancel"), `polite status interrupted: ${JSON.stringify(log)}`);
    const b2 = (await speech(page)).length;
    await page.evaluate(() => { (window as unknown as Record<string, HTMLElement>).__al.textContent = "Disk almost full"; });
    await waitCaption(page, /^Disk almost full$/);
    log = (await speech(page)).slice(b2);
    const iA = log.findIndex((s) => s.text === "Disk almost full");
    ok(iA > 0 && log[iA - 1].op === "cancel", `assertive alert did not interrupt: ${JSON.stringify(log)}`);
    await page.evaluate(() => { (window as unknown as Record<string, HTMLElement>).__bz.textContent = "loading half"; });
    await sleep(500);
    ok(!(await captions(page)).includes("loading half"), "busy region was announced");
    const b3 = (await speech(page)).length;
    await page.keyboard.press("Control");
    log = (await speech(page)).slice(b3);
    ok(log.length === 1 && log[0].op === "cancel", `Ctrl did not stop speech: ${JSON.stringify(log)}`);
    await page.context().close();
  });

  await test("behaviour: Narrator key + H / Shift+H / Right move the cursor through the focused window (headings, items) without moving focus; W says where you are; = speeds up (saved, next utterance faster); F1 lists commands and Esc returns focus; captions-only mode stops speech but keeps captions", { "AX-14": "full" }, async () => {
    await set("accessibility.narrator", "on"); await set("accessibility.narratorRate", "1"); await set("accessibility.narratorSpeech", "on");
    const page = await boot([win("s1", "settings", 0)], true);
    await waitCaption(page, /^Narrator on\./);
    await page.locator('[data-win-id="s1"]').locator("button, input").first().focus();
    await sleep(200);
    const chord = async (key: string) => { await page.keyboard.down("Insert"); await page.keyboard.press(key); await page.keyboard.up("Insert"); await sleep(120); };
    await chord("KeyH");
    const h1 = await waitCaption(page, /heading level \d$/);
    const cur1 = await page.locator('[data-testid="narrator-cursor"]').boundingBox();
    await chord("KeyH");
    const h2 = (await captions(page)).at(-1)!;
    ok(/heading level \d$/.test(h2) && h2 !== h1, `second heading jump: ${h2}`);
    const cur2 = await page.locator('[data-testid="narrator-cursor"]').boundingBox();
    ok(cur1 && cur2 && Math.abs(cur2.y - cur1.y) + Math.abs(cur2.x - cur1.x) > 4, "cursor box did not move with the heading jump");
    await chord("Shift+KeyH");
    ok((await captions(page)).at(-1) === h1, "Shift+H did not return to the previous heading");
    await chord("ArrowRight");
    const nx = (await captions(page)).at(-1)!;
    ok(nx && nx !== h1, "Right did not move to the next item");
    console.log(`    cursor: "${h1}" → "${h2}" ← back; next item "${nx}"`);
    await chord("KeyW");
    ok(/settings|Settings/.test((await captions(page)).at(-1)!), "where-am-I lacks the window");
    // focus must not have moved with the Narrator cursor (reading is non-destructive)
    ok(await page.evaluate(() => !!document.activeElement?.closest('[data-win-id="s1"]')), "cursor moved focus");
    await chord("Equal");
    for (let i = 0; i < 30 && (await getSetting("accessibility.narratorRate")) !== "1.25"; i++) await sleep(100);
    ok((await getSetting("accessibility.narratorRate")) === "1.25", "rate not saved");
    await chord("ArrowRight");
    const last = (await speech(page)).filter((s) => s.op === "speak").at(-1)!;
    ok(Math.abs((last.rate ?? 0) - 1.25) < 1e-6, `next utterance rate ${last.rate}`);
    const focusedBefore = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
    await chord("F1");
    await page.locator('[data-testid="narrator-help"]').waitFor({ timeout: 3000 });
    ok((await page.locator('[data-testid="narrator-help"] tr').count()) >= 17, "help lists fewer commands than defined");
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="narrator-help"]').waitFor({ state: "detached", timeout: 3000 });
    ok((await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))) === focusedBefore, "focus not returned after the command list");
    await set("accessibility.narratorSpeech", "off");
    await page.reload(); await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined); await sleep(2000);
    await page.locator('[data-win-id="s1"]').locator("button, input").first().focus();
    await waitCaption(page, /button|edit|check box|radio/);
    ok(!(await speech(page)).some((s) => s.op === "speak"), "captions-only mode still spoke");
    ok(/captions only/i.test(await page.locator('[data-testid="narrator-captions"]').innerText()), "captions-only mode not indicated");
    await page.context().close();
  });

  await test("behaviour: the toggle chord turns Narrator off (says so, captions and cursor disappear, saved); the Mac preset uses Cmd+F5; the Settings checkbox reflects and drives the same setting", { "AX-14": "full" }, async () => {
    await set("accessibility.narrator", "on"); await set("accessibility.narratorSpeech", "on"); await set("shell.shortcutPreset", "hybrid");
    let page = await boot([], true);
    await waitCaption(page, /^Narrator on\./);
    await page.keyboard.press("Control+Meta+Enter");
    await page.locator('[data-testid="narrator-captions"]').waitFor({ state: "detached", timeout: 3000 });
    ok((await speech(page)).some((s) => s.text === "Narrator off."), "stop not spoken");
    for (let i = 0; i < 30 && (await getSetting("accessibility.narrator")) !== "off"; i++) await sleep(100);
    ok((await getSetting("accessibility.narrator")) === "off", "off not saved");
    ok((await page.locator('[data-testid="narrator-cursor"]').count()) === 0, "cursor box left behind");
    await page.context().close();
    await set("shell.shortcutPreset", "mac");
    page = await boot([win("s2", "settings", 0)], true);
    await page.keyboard.press("Meta+F5");
    await waitCaption(page, /^Narrator on\./);
    const cb = page.locator('[data-testid="settings-narrator-on"]');
    await cb.scrollIntoViewIfNeeded();
    ok(await cb.isChecked(), "Settings checkbox does not reflect the setting");
    await cb.click();
    await page.locator('[data-testid="narrator-captions"]').waitFor({ state: "detached", timeout: 3000 });
    await page.context().close();
  });
} finally {
  for (const [k, v] of Object.entries(saved)) await set(k, v);
  if (!("accessibility.narratorVoice" in saved)) await set("accessibility.narratorVoice", "auto");
  await desktop([]);
  await browser.close();
}
finish();
