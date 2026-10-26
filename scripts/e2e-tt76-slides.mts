/**
 * TT76 e2e — Slides transitions + animations in the real UI (Chromium 143 headless, production build on :3999):
 *  E1 author: select shapes, open Motion, choose Push "From left" 1.5 s + advance after 4 s, add Fly In (from left) on
 *     click and Fade with previous → play-order badges on the stage → Ctrl+S → the lxml oracle reads exactly that from
 *     the saved file (AlternateContent p14:dur + Fallback spd, presetIDs / subtypes / nodeTypes), XSD finds no new error
 *  E2 undo: Ctrl+Z after Remove brings the effect back; the list follows the document
 *  E3 show: Preview starts the show on this slide; animated shapes start hidden; → plays the first build step with the
 *     Fly In animation (CSS), → again advances to the next slide through its transition (outgoing + incoming layers);
 *     ← steps back fully built
 *  E4 foreign effects: a deck whose effects Fusion does not model lists them as "(kept)"; changing only the transition
 *     and saving keeps every one of them (oracle: same presetIDs / targets / groups)
 *  E5 modal-shortcut test: typing Delete / Backspace / Ctrl+D in the Motion panel's fields never deletes the selected
 *     shape or duplicates a slide; in the show Delete does nothing to the deck
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt76-slides.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `m${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt76-slides");
const COV = { "FF-23": "full", "FF-63": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const J = (v: unknown) => JSON.stringify(v);
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/pptx";
const tmp = mkdtempSync(join(tmpdir(), "e2e76s-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function saved(path: string): Promise<string> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); const f = join(tmp, path.split("/").pop()!); writeFileSync(f, Buffer.from(r.json.node.content, "base64")); return f; }
type OxE = { group: number; sub: number; presetID: string; presetClass: string; presetSubtype: string; nodeType: string; spid: string; delay: string };
type OxS = { transition: { choice: { dur: string; spd: string; advTm: string | null; child: string; attrs: Record<string, string> } | null; fallback: { spd: string; child: string; attrs: Record<string, string>; advTm: string | null } | null; ac: boolean } | null; effects: OxE[]; idsUnique: boolean; dangling: string[] };
const oracle = (f: string) => (JSON.parse(execFileSync(PY, ["scripts/oracle/pptx_motion.py", f], { encoding: "utf8" }))[f]) as { pptx_ok: true | string; slides: Record<string, OxS> };
const xsdSlideErrors = (f: string) => { const r = JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", f], { encoding: "utf8", maxBuffer: 64 << 20 }))[f] as { parts: Record<string, string[]> }; return Object.entries(r.parts).filter(([p, e]) => /slides\/slide\d+\.xml/.test(p) && e.length).map(([p, e]) => `${p}: ${e[0].replace(/line \d+: /, "")}`); };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openDeck(path: string) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=slides&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Slides"]').last();
  await dlg.locator('[aria-label="Slides editor"]').waitFor({ timeout: 25_000 });
  await dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').first().waitFor({ timeout: 25_000 });
  const editor = dlg.locator('[aria-label="Slides editor"]');
  const canvas = dlg.locator('[aria-label$=" canvas"]');
  const shapes = () => canvas.locator(".fs-slide > [data-addr]:not([aria-hidden])");
  const panel = dlg.getByTestId("motion-panel");
  const save = async () => { await editor.focus(); await page.keyboard.press("Control+s"); await dlg.getByRole("status").filter({ hasText: /Saved .*lossless/ }).waitFor({ timeout: 15_000 }); };
  const openMotion = async () => { await dlg.getByTestId("slides-motion").click(); await panel.waitFor(); };
  const fx = () => panel.locator('[data-testid^="motion-fx-"]').filter({ has: page.locator('[data-testid^="motion-fx-trigger-"]') });
  const secs = async (testid: string, v: string) => { const i = panel.getByTestId(testid); await i.fill(v); await i.press("Enter"); };
  return { page, dlg, editor, canvas, shapes, panel, save, openMotion, fx, secs, close: () => ctx.close() };
}
const firstSlide = "ppt/slides/slide1.xml";

const SRC1 = `/Documents/${RUN}-motion.pptx`;
await test("E1 author transition + animations in the Motion panel → Ctrl+S → lxml reads exactly what was authored", COV, async () => {
  await upload(SRC1, readFileSync(join(CORPUS, "SampleShow.pptx")));
  const s = await openDeck(SRC1);
  await s.openMotion();
  await s.panel.getByTestId("motion-trans-kind").selectOption("push");
  await s.panel.getByTestId("motion-trans-opt").selectOption("r"); // r = moves right = "From left"
  await s.secs("motion-trans-dur", "1.5");
  await s.panel.getByTestId("motion-adv-after").check(); await s.secs("motion-adv-secs", "4");
  ok((await s.panel.getByTestId("motion-trans-desc").innerText()).startsWith("Push · 1.5 s · advance on click or after 4 s"), await s.panel.getByTestId("motion-trans-desc").innerText());
  // effect 1: Fly In from left on the first shape (on click)
  await s.shapes().nth(0).click({ position: { x: 8, y: 8 } });
  await s.panel.getByTestId("motion-add-kind").selectOption("fly"); await s.panel.getByTestId("motion-add-from").selectOption("l");
  await s.panel.getByTestId("motion-add").click();
  // effect 2: Fade on the second shape, With previous, 0.25 s delay
  await s.shapes().nth(1).click({ position: { x: 8, y: 8 } });
  await s.panel.getByTestId("motion-add-kind").selectOption("fade"); await s.panel.getByTestId("motion-add").click();
  await s.panel.getByTestId("motion-fx-trigger-1").selectOption("with"); await s.secs("motion-fx-delay-1", "0.25");
  ok(await s.fx().count() === 2, `rows ${await s.fx().count()}`);
  ok(await s.canvas.getByTestId("motion-badge").count() === 2, "play-order badges");
  await s.page.screenshot({ path: join(SHOTS, "e2e76-motion-panel.png") });
  await s.save(); await s.close();
  const f = await saved(SRC1); const o = oracle(f); ok(o.pptx_ok === true, `python-pptx ${o.pptx_ok}`);
  const sl = o.slides[firstSlide]; const t = sl.transition!;
  ok(t?.ac && t.choice?.dur === "1500" && t.choice.child === "push" && t.choice.attrs.dir === "r" && t.fallback?.spd === "slow" && t.fallback.advTm === "4000", `transition ${J(t)}`);
  const e = sl.effects.map((x) => [x.presetID, x.presetSubtype, x.nodeType, x.delay, x.group]);
  ok(J(e) === J([["2", "8", "clickEffect", "0", 0], ["10", "0", "withEffect", "250", 0]]), `effects ${J(e)}`);
  ok(sl.idsUnique && !sl.dangling.length, "ids / dangling");
  const base = new Set(xsdSlideErrors(join(CORPUS, "SampleShow.pptx"))); const nw = xsdSlideErrors(f).filter((x) => !base.has(x)); ok(!nw.length, `new XSD errors ${nw.slice(0, 2).join("; ")}`);
});

await test("E2 remove + undo / redo: the effect list follows the document", COV, async () => {
  const s = await openDeck(SRC1); await s.openMotion();
  ok(await s.fx().count() === 2, `reopened rows ${await s.fx().count()}`);
  await s.panel.getByTestId("motion-fx-del-0").click(); ok(await s.fx().count() === 1, "removed");
  await s.editor.focus(); await s.page.keyboard.press("Control+z"); await s.page.waitForTimeout(150);
  ok(await s.fx().count() === 2, `undo ${await s.fx().count()}`);
  await s.page.keyboard.press("Control+y"); await s.page.waitForTimeout(150); ok(await s.fx().count() === 1, "redo");
  await s.close();
});

await test("E3 show: Preview → shapes wait hidden → → plays Fly In (CSS animation) → → next slide enters through its transition → ← steps back built", COV, async () => {
  const s = await openDeck(SRC1); await s.openMotion();
  // the next slide gets a Wipe so slide 1 → 2 has a transition to observe
  await s.dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').nth(1).click();
  await s.panel.getByTestId("motion-trans-kind").selectOption("wipe");
  await s.dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').nth(0).click();
  await s.panel.getByTestId("motion-preview").click();
  const stage = s.page.getByTestId("show-stage"); await stage.waitFor();
  ok(await stage.getAttribute("data-step") === "0", `step ${await stage.getAttribute("data-step")}`);
  const inc = s.page.getByTestId("show-incoming");
  const hidden = await inc.locator(".fs-slide > [data-addr]").evaluateAll((els) => els.map((e) => getComputedStyle(e).visibility));
  ok(hidden.filter((v) => v === "hidden").length === 2, `two shapes wait hidden: ${J(hidden)}`);
  await s.page.keyboard.press("ArrowRight");
  await s.page.waitForFunction(() => document.querySelector('[data-testid="show-stage"]')?.getAttribute("data-step") === "1");
  const anim = await inc.locator(".fs-slide > [data-addr]").evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
  ok(anim.includes("fsfx-fly") && anim.includes("fsfx-fade"), `animations ${J(anim)}`);
  await s.page.waitForTimeout(250); await s.page.screenshot({ path: join(SHOTS, "e2e76-show-build.png") });
  await s.page.waitForTimeout(900);
  const vis = await inc.locator(".fs-slide > [data-addr]").evaluateAll((els) => els.map((e) => getComputedStyle(e).visibility));
  ok(!vis.includes("hidden"), `all built ${J(vis)}`);
  await s.page.keyboard.press("ArrowRight"); await s.page.getByTestId("show-outgoing").waitFor({ timeout: 3000 });
  const tr = await s.page.getByTestId("show-incoming").evaluate((e) => getComputedStyle(e).animationName); ok(tr === "fstr-clip-in", `transition anim ${tr}`);
  // mid-wipe the clip must be an intermediate inset (inset → none is not interpolable: that once made the wipe a 50 % cut)
  await s.page.waitForTimeout(120);
  const clip = await s.page.getByTestId("show-incoming").evaluate((e) => getComputedStyle(e).clipPath);
  const pct = Number(/inset\(0px 0px 0px ([\d.]+)%\)/.exec(clip)?.[1] ?? /inset\(0(?:px)? 0(?:px)? 0(?:px)? ([\d.]+)%\)/.exec(clip)?.[1] ?? NaN);
  ok(pct > 3 && pct < 97, `mid-wipe clip ${clip}`);
  await s.page.screenshot({ path: join(SHOTS, "e2e76-show-transition.png") });
  await s.page.keyboard.press("ArrowLeft"); await s.page.waitForTimeout(200);
  ok(await s.page.getByTestId("show-stage").getAttribute("data-step") === "1", "back on slide 1, built");
  ok(await s.page.locator('[role=dialog][aria-label^="Slide show, slide 1"]').count() === 1, "slide 1");
  await s.page.keyboard.press("Escape"); await s.close();
});

await test("E4 a deck with effects Fusion does not model: listed as kept; editing only the transition keeps every effect", COV, async () => {
  const src = `/Documents/${RUN}-foreign.pptx`; const orig = join(CORPUS, "45541_Footer.pptx"); await upload(src, readFileSync(orig));
  const before = oracle(orig).slides[firstSlide].effects;
  ok(before.length >= 1, "corpus deck has effects");
  const s = await openDeck(src); await s.openMotion();
  ok(await s.fx().count() === before.length, `rows ${await s.fx().count()} vs ${before.length}`);
  ok((await s.panel.innerText()).includes("(kept)"), "kept label");
  await s.panel.getByTestId("motion-trans-kind").selectOption("fade");
  await s.page.screenshot({ path: join(SHOTS, "e2e76-foreign.png") });
  await s.save(); await s.close();
  const after = oracle(await saved(src)).slides[firstSlide];
  ok(J(after.effects.map((x) => [x.presetID, x.presetClass, x.spid, x.group, x.nodeType])) === J(before.map((x) => [x.presetID, x.presetClass, x.spid, x.group, x.nodeType])), `effects changed ${J(after.effects)}`);
  ok(after.transition?.choice?.child === "fade" && after.idsUnique && !after.dangling.length, `transition ${J(after.transition)}`);
});

await test("E5 modal-shortcut test: Delete / Backspace / Ctrl+D typed in Motion fields or during the show never delete the shape or duplicate a slide", COV, async () => {
  const s = await openDeck(SRC1); await s.openMotion();
  const n0 = await s.shapes().count(); const slides0 = await s.dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').count();
  await s.shapes().nth(0).click({ position: { x: 8, y: 8 } });
  const delay = s.panel.getByTestId("motion-fx-delay-0"); await delay.click();
  for (const k of ["Delete", "Backspace", "Control+d", "Backspace"]) await s.page.keyboard.press(k);
  await delay.press("Escape");
  ok(await s.shapes().count() === n0, `shape deleted from a field (${await s.shapes().count()} vs ${n0})`);
  ok(await s.dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').count() === slides0, "slide duplicated from a field");
  await s.panel.getByTestId("motion-preview").click(); await s.page.getByTestId("show-stage").waitFor();
  for (const k of ["Delete", "Control+d", "Control+z"]) await s.page.keyboard.press(k);
  await s.page.keyboard.press("Escape"); await s.page.waitForTimeout(200);
  ok(await s.shapes().count() === n0 && await s.dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').count() === slides0, "the show let a shortcut through");
  ok(await s.fx().count() === 2, `effects intact (${await s.fx().count()})`);
  await s.close();
});

await test("E7 presenter view (CA-02): the audience window gets the deck and follows the console; clicks on the audience advance the presenter; notes / next / timer on the console; End closes the audience", { "CA-02": "full", "FF-23": "full" }, async () => {
  const s = await openDeck(SRC1);
  const popP = s.page.context().waitForEvent("page");
  await s.dlg.getByTestId("slides-presenter").click();
  const aud = await popP; aud.on("pageerror", (e) => errors.push(`audience: ${e.message}`));
  const con = s.page.getByTestId("presenter-console"); await con.waitFor();
  await aud.locator('[data-testid="audience"][data-phase="live"]').waitFor({ timeout: 15_000 });
  await s.page.locator('[data-testid="presenter-audience"][data-state="connected"]').waitFor({ timeout: 5000 });
  ok((await s.page.getByTestId("presenter-notes").innerText()).includes("I am the notes of the first slide"), "notes on the console");
  ok((await s.page.getByTestId("presenter-next-label").innerText()).startsWith("Next: build 1 of 1"), await s.page.getByTestId("presenter-next-label").innerText());
  ok(await aud.getByTestId("show-stage").getAttribute("data-step") === "0", "audience at step 0");
  ok(!(await aud.locator("body").innerText()).includes("I am the notes"), "notes leaked to the audience");
  await s.page.keyboard.press("ArrowRight");
  await aud.waitForFunction(() => document.querySelector('[data-testid="show-stage"]')?.getAttribute("data-step") === "1", undefined, { timeout: 5000 });
  await s.page.waitForTimeout(700); await s.page.screenshot({ path: join(SHOTS, "e2e76-presenter-console.png") });
  // a click on the audience screen asks the presenter to advance → slide 2 on both
  await aud.locator('[data-testid="audience"]').click();
  await aud.locator('[data-testid="audience"][data-slide="1"]').waitFor({ timeout: 5000 });
  ok((await s.page.getByTestId("presenter-pos").innerText()).startsWith("Slide 2 of 2"), await s.page.getByTestId("presenter-pos").innerText());
  await aud.waitForTimeout(700); await aud.screenshot({ path: join(SHOTS, "e2e76-audience.png") });
  ok(/^\d+:\d\d$/.test(await s.page.getByTestId("presenter-timer").innerText()), "timer");
  await s.page.getByTestId("presenter-prev").click(); await aud.locator('[data-testid="audience"][data-slide="0"]').waitFor({ timeout: 5000 });
  const closed = aud.waitForEvent("close", { timeout: 5000 });
  await s.page.getByTestId("presenter-end").click(); await closed;
  ok(await con.count() === 0, "console still open");
  await s.close();
});

await test("E6 no page errors during the Slides motion run", COV, () => { ok(!errors.length, errors.slice(0, 3).join("\n")); });
await browser.close();
finish();
