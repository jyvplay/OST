/**
 * TT51 e2e — Slides as a real PowerPoint editor, in the real UI (Chromium 143 headless):
 *  - corpus decks open with every slide in the rail and the file's text, tables, charts and shapes drawn;
 *  - edit title text (double-click), bold a selected word, add speaker notes, duplicate + hide a slide, insert a text
 *    box, move a shape by dragging → Ctrl+S → python-pptx (independent reader) sees exactly those edits, the
 *    validator finds no problems, and every part the edits did not touch keeps its original bytes;
 *  - the slide show is full-window, advances with the keyboard / clicks, SKIPS hidden slides and ends with Escape;
 *  - legacy .fdeck outlines open as real decks and save as .pptx;
 *  - modal-shortcut failure test: while the Save-as dialog, the slide show or the notes field owns the keyboard,
 *    Delete / Backspace / Ctrl+Z / Ctrl+D never delete the selected shape or touch the slides.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt51-slides.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { openZip } from "../src/lib/office/zipkit.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `s${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt51-slides");
const COV = { "FF-23": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/pptx";
const tmp = mkdtempSync(join(tmpdir(), "e2e51-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array, mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation") { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, "base64")); }
const probe = (p: string, runs = false) => JSON.parse(execFileSync(PY, ["scripts/oracle/pptx_probe.py", ...(runs ? ["--runs"] : []), p], { encoding: "utf8" }).trim());
const validate = (p: string) => JSON.parse(execFileSync(PY, ["scripts/oracle/pptx_validate.py", p], { encoding: "utf8" }).trim()) as { ok: boolean; problems: string[] };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openDeck(path: string) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=slides&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Slides"]').first();
  await dlg.locator('[aria-label="Slides editor"]').waitFor({ timeout: 25_000 });
  await dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').first().waitFor({ timeout: 25_000 });
  const editor = dlg.locator('[aria-label="Slides editor"]');
  const canvas = dlg.locator('[aria-label$=" canvas"]');
  const rail = dlg.locator('[role=listbox][aria-label="Slides"] [role=option]');
  const shapes = () => canvas.locator(".fs-slide > [data-addr]:not([aria-hidden])"); // the selection overlay is aria-hidden
  const save = async () => { await editor.focus(); await page.keyboard.press("Control+s"); await dlg.getByRole("status").filter({ hasText: /Saved .*lossless/ }).waitFor({ timeout: 15_000 }); };
  return { page, dlg, editor, canvas, rail, shapes, save, close: () => ctx.close() };
}

await test("corpus decks open in the real UI with every slide in the rail and the file's content drawn: shapes.pptx (6 slides, preset shapes + text), table_test.pptx (a table with its cell text), bar-chart.pptx (chart drawn from its cache as SVG), backgrounds.pptx", COV, async () => {
  for (const [f, n] of [["shapes.pptx", 6], ["table_test.pptx", 1], ["bar-chart.pptx", 1], ["backgrounds.pptx", 4]] as const) {
    const src = `/Documents/${RUN}-${f}`; await upload(src, readFileSync(join(CORPUS, f)));
    const s = await openDeck(src);
    eq(await s.rail.count(), n, `${f} rail`);
    const o = probe(join(CORPUS, f)); const firstText = (o.slides[0].shapes as { text?: string[]; table?: string[][][] }[]).flatMap((x) => [...(x.text ?? []), ...(x.table ?? []).flat(2)]).find((t) => t.trim());
    if (firstText) ok((await s.canvas.innerText()).replace(/\s+/g, " ").includes(firstText.replace(/\v/g, " ").replace(/\s+/g, " ").trim().slice(0, 20)), `${f}: canvas lacks "${firstText}"`);
    if (f === "table_test.pptx") ok(await s.canvas.locator("table td").count() >= 4, "table cells drawn");
    if (f === "bar-chart.pptx") { await s.canvas.locator("svg rect").first().waitFor({ timeout: 10_000 }); ok(await s.canvas.locator('[data-kind="chart"] svg').count() === 1, "chart svg"); }
    if (f === "shapes.pptx") ok(await s.canvas.locator("svg path").count() >= 3, "preset outlines drawn");
    await s.page.screenshot({ path: join(SHOTS, `e2e51-${f.replace(".pptx", "")}.png`) });
    await s.close();
  }
});

await test("edit → save → python-pptx: retype the title by double-click, bold one word through the toolbar, add speaker notes, duplicate and hide a slide, insert a text box, drag a shape — the saved file carries exactly those edits, validates, and untouched parts keep their bytes", COV, async () => {
  const src = `/Documents/${RUN}-edit.pptx`; const orig = readFileSync(join(CORPUS, "SampleShow.pptx")); await upload(src, orig);
  const s = await openDeck(src);
  // title: double-click the first shape and retype
  const title = s.shapes().first(); await title.dblclick();
  const ta = s.dlg.locator('textarea[aria-label="Edit shape text"]'); await ta.waitFor();
  await ta.fill("Quarterly Review 2026"); 
  // bold "Review": select it in the textarea and press the toolbar button
  await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(10, 16); });
  await s.dlg.getByRole("button", { name: "Bold" }).click();
  await s.editor.focus(); await s.page.keyboard.press("Escape").catch(() => undefined);
  await s.canvas.click({ position: { x: 5, y: 5 } }); // commit + deselect
  // notes
  const notes = s.dlg.locator('textarea[aria-label="Speaker notes"]'); await notes.fill("Talk track: thank the team ✓"); await s.editor.focus();
  // duplicate slide 1 → slide 2 is the copy; hide it
  await s.dlg.getByRole("button", { name: "Duplicate" }).click(); eq(await s.rail.count(), 3, "after duplicate");
  await s.dlg.getByRole("button", { name: "Hide", exact: true }).click();
  ok((await s.rail.nth(1).getAttribute("aria-label"))?.includes("hidden"), "slide 2 hidden");
  // back to slide 1, insert a text box, type into it
  await s.rail.nth(0).click();
  await s.dlg.getByRole("button", { name: "Text box" }).click(); await ta.waitFor(); await ta.fill("Inserted by e2e"); await s.canvas.click({ position: { x: 5, y: 5 } });
  // drag the subtitle (second shape) 60px right / 30px down
  const sub = s.shapes().nth(1); const bb = (await sub.boundingBox())!; const cbb = (await s.canvas.boundingBox())!;
  await s.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await s.page.mouse.down(); await s.page.mouse.move(bb.x + bb.width / 2 + 60, bb.y + bb.height / 2 + 30, { steps: 6 }); await s.page.mouse.up();
  const emuPerPx = 9144000 / cbb.width;
  await s.page.screenshot({ path: join(SHOTS, "e2e51-edit.png") });
  await s.save();
  const out = await readBytes(src); const p = join(tmp, "edit.pptx"); writeFileSync(p, out);
  const v = validate(p); ok(v.ok, v.problems.join("; "));
  const o = probe(p, true);
  eq(o.slides.length, 3, "slides"); eq(o.slides.map((x: { hidden: boolean }) => x.hidden), [false, true, false], "hidden flags");
  const s0 = o.slides[0].shapes as { name: string; geo: number[]; text: unknown[][] }[];
  eq(s0[0].text.map((pp) => pp[0]), ["Quarterly Review 2026"], "title text");
  const runs = s0[0].text[0][3] as unknown[][];
  eq(runs.map((r) => r[0]), ["Quarterly ", "Review", " 2026"], "runs split at the selection"); ok(runs[1][1] === true && runs[0][1] !== true && runs[2][1] !== true, `bold only on "Review": ${JSON.stringify(runs)}`);
  eq(o.slides[0].notes, "Talk track: thank the team ✓", "notes");
  ok(s0.some((x) => JSON.stringify(x.text.map((pp) => pp[0])) === JSON.stringify(["Inserted by e2e"])), "text box saved");
  const origSub = probe(join(CORPUS, "SampleShow.pptx")).slides[0].shapes[1].geo as number[];
  const dx = s0[1].geo[0] - origSub[0], dy = s0[1].geo[1] - origSub[1];
  ok(Math.abs(dx - 60 * emuPerPx) < 3 * emuPerPx && Math.abs(dy - 30 * emuPerPx) < 3 * emuPerPx, `drag moved by ${dx},${dy} EMU (expected ≈${60 * emuPerPx},${30 * emuPerPx})`);
  eq(o.slides[1].shapes.map((x: { text: unknown[][] }) => x.text.map((pp) => pp[0])), [["Quarterly Review 2026"], probe(join(CORPUS, "SampleShow.pptx")).slides[0].shapes[1].text], "duplicate = slide 1 as it was when duplicated (new title, before the text box / drag)");
  // byte-identity of everything the edits did not touch
  const zo = openZip(new Uint8Array(orig)), zn = openZip(out); const changed: string[] = [];
  for (const e of zo.entries) { const a = await zo.read(e.name), b = await zn.read(e.name).catch(() => null); if (!b || Buffer.compare(Buffer.from(a!), Buffer.from(b)) !== 0) changed.push(e.name); }
  const allowed = /^(\[Content_Types\]\.xml|docProps\/core\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/slides\/(_rels\/)?slide1\.xml(\.rels)?|ppt\/notesSlides\/(_rels\/)?notesSlide1\.xml(\.rels)?)$/;
  ok(changed.every((c) => allowed.test(c)), `parts changed that no edit touched: ${changed.filter((c) => !allowed.test(c)).join(", ")}`);
  await s.close();
});

await test("slide show: Present opens a full-window show at the first visible slide; → / Space / click advance, ← goes back, HIDDEN slides are skipped, Escape ends and returns to the editor", COV, async () => {
  const src = `/Documents/${RUN}-show.pptx`; await upload(src, readFileSync(join(CORPUS, "shapes.pptx")));
  const s = await openDeck(src);
  await s.rail.nth(1).click(); await s.dlg.getByRole("button", { name: "Hide", exact: true }).click(); // hide slide 2
  await s.dlg.getByRole("button", { name: /Present/ }).click();
  const show = s.page.locator('[role=dialog][aria-label^="Slide show"]'); await show.waitFor();
  eq(await show.getAttribute("aria-label"), "Slide show, slide 1", "starts at 1");
  const vp = s.page.viewportSize()!; const sb = (await show.boundingBox())!; ok(sb.width >= vp.width - 2 && sb.height >= vp.height - 2, "full window");
  await s.page.keyboard.press("ArrowRight"); eq(await show.getAttribute("aria-label"), "Slide show, slide 3", "hidden slide 2 skipped");
  await s.page.keyboard.press(" "); eq(await show.getAttribute("aria-label"), "Slide show, slide 4", "space advances");
  await s.page.keyboard.press("ArrowLeft"); eq(await show.getAttribute("aria-label"), "Slide show, slide 3", "back");
  await show.click(); eq(await show.getAttribute("aria-label"), "Slide show, slide 4", "click advances");
  await s.page.screenshot({ path: join(SHOTS, "e2e51-show.png") });
  await s.page.keyboard.press("Escape"); await show.waitFor({ state: "detached" });
  eq(await s.rail.count(), 6, "no slide touched by the show");
  await s.close();
});

await test("modal-shortcut failure test: with a shape selected, Delete / Backspace / Ctrl+Z / Ctrl+D pressed while the Save-as dialog, the slide show or the notes field has the keyboard never delete the shape, undo, or duplicate a slide; the same keys on the canvas do", COV, async () => {
  const src = `/Documents/${RUN}-modal.pptx`; await upload(src, readFileSync(join(CORPUS, "shapes.pptx")));
  const s = await openDeck(src); const n0 = await s.shapes().count(); ok(n0 >= 3, `shapes ${n0}`);
  const pick = async () => { // the largest shape (shape 1 on this slide is a zero-height connector)
    const boxes = await s.shapes().evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const [x, y, w, h] = boxes.sort((a, b) => b[2] * b[3] - a[2] * a[3])[0]; await s.page.mouse.click(x + w / 2, y + h / 2);
    ok(await s.canvas.locator("[aria-hidden][data-addr]").count() === 1, "pick selected nothing");
  };
  // a zero-height line is still selectable through its hit band
  { const line = await s.shapes().evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }).find((r) => r[3] < 2 && r[2] > 20));
    if (line) { await s.page.mouse.click(line[0] + line[2] / 2, line[1] + 2); ok(await s.canvas.locator("[aria-hidden][data-addr]").count() === 1, "zero-height line not selectable"); await s.page.keyboard.press("Escape"); } }
  // 1. Save-as dialog open
  await pick(); await s.dlg.getByRole("button", { name: "Save as…" }).click();
  const dia = s.dlg.locator('[role=dialog][aria-label="Save as"]'); await dia.waitFor();
  for (const k of ["Delete", "Backspace", "Control+z", "Control+d"]) await s.page.keyboard.press(k);
  eq(await s.shapes().count(), n0, "dialog: shapes"); eq(await s.rail.count(), 6, "dialog: slides");
  await s.page.keyboard.press("Escape"); await dia.waitFor({ state: "detached" });
  // 2. notes field focused
  await pick(); const notes = s.dlg.locator('textarea[aria-label="Speaker notes"]'); await notes.click(); await notes.type("abc");
  for (const k of ["Backspace", "Delete", "Control+z", "Control+d"]) await s.page.keyboard.press(k);
  eq(await s.shapes().count(), n0, "notes: shapes"); eq(await s.rail.count(), 6, "notes: slides");
  // 3. slide show open
  await s.editor.focus(); await pick(); await s.dlg.getByRole("button", { name: /Present/ }).click();
  const show = s.page.locator('[role=dialog][aria-label^="Slide show"]'); await show.waitFor();
  for (const k of ["Delete", "Control+z", "Control+d"]) await s.page.keyboard.press(k);
  await s.page.keyboard.press("Escape"); await show.waitFor({ state: "detached" });
  eq(await s.shapes().count(), n0, "show: shapes"); eq(await s.rail.count(), 6, "show: slides");
  // control: the same keys on the canvas DO act
  await pick(); await s.page.keyboard.press("Delete"); eq(await s.shapes().count(), n0 - 1, "Delete on canvas removes the shape");
  await s.page.keyboard.press("Control+z"); eq(await s.shapes().count(), n0, "Ctrl+Z restores it");
  await s.page.keyboard.press("Control+d"); eq(await s.rail.count(), 7, "Ctrl+D duplicates");
  await s.close();
});

await test("legacy .fdeck outline opens as a real PowerPoint deck (titles, bullets, notes) and Save writes a .pptx that python-pptx reads", COV, async () => {
  const src = `/Documents/${RUN}-legacy.fdeck`;
  await upload(src, new TextEncoder().encode(JSON.stringify({ title: "Legacy deck", slides: [{ title: "Hello", body: ["one", "two"], notes: "say hi" }, { title: "Bye", body: ["three"], notes: "" }] })), "application/json");
  const s = await openDeck(src); eq(await s.rail.count(), 2, "slides");
  ok((await s.canvas.innerText()).includes("Hello"), "title drawn");
  await s.editor.focus(); await s.page.keyboard.press("Control+s");
  const dia = s.dlg.locator('[role=dialog][aria-label="Save as"]'); await dia.waitFor();
  const dest = `/Documents/${RUN}-legacy.pptx`; await dia.locator("input").fill(dest); await dia.getByRole("button", { name: "Save" }).click();
  await s.dlg.getByRole("status").filter({ hasText: /Saved .*lossless/ }).waitFor({ timeout: 15_000 });
  const p = join(tmp, "legacy.pptx"); writeFileSync(p, await readBytes(dest));
  const v = validate(p); ok(v.ok, v.problems.join("; "));
  const o = probe(p); eq(o.slides.map((x: { shapes: { text: string[] }[] }) => x.shapes.map((y) => y.text)), [[["Hello"], ["one", "two"]], [["Bye"], ["three"]]], "content"); eq(o.slides[0].notes, "say hi", "notes");
  await s.close();
});

await test("no page errors in any Slides session", COV, async () => { ok(errors.length === 0, errors.join("\n")); });

await browser.close();
finish();
