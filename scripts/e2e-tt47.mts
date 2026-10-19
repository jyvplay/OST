/**
 * TT47 e2e — Spreadsheet Class-A view/edit/save in the real UI (Chromium 143 headless):
 *  - theme colours and imported conditional formats (cellIs, 3-colour scale) render in the grid;
 *  - a CF rule added through the panel (≥ with its value box; 3-colour scale) shows immediately and is
 *    written into the original .xlsx by Save (lossless patch), verified by the independent oracle
 *    (scripts/oracle/xlsx_cf.py: openpyxl + lxml + colorsys) and by openpyxl's cell diff.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt47.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `x${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt47");
const COV = { "FF-20": "full", "FF-21": "full", "FF-11": "full", "PR-11": "partial" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", XCORPUS = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "e2e47-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "base64")); }

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openSheetFile(path: string) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
  await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (ref: string) => dlg.locator(`[data-cell="${ref}"]`);
  const tab = async (name: string) => { await dlg.locator('button[title="Double-click to rename"]').filter({ hasText: new RegExp(`^${name}$`) }).click(); };
  return { page, dlg, cell, tab, close: () => ctx.close() };
}
const css = (l: Locator, prop: "backgroundColor" | "color") => l.evaluate((e, p) => getComputedStyle(e)[p as "color"], prop);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

await test("Spreadsheet renders theme colours and imported conditional formats (cellIs on a theme-tinted dxf; 3-colour scale with percentile midpoint)", COV, async () => {
  const src = `/Documents/${RUN}-view.xlsx`;
  await upload(src, new Uint8Array(readFileSync(join(XCORPUS, "ConditionalFormattingSamples.xlsx"))));
  const s = await openSheetFile(src);
  await s.tab("Products1");
  await s.cell("D7").waitFor({ timeout: 15_000 });
  eq(await css(s.cell("D7"), "backgroundColor"), rgb("#dce6f2"), "D7 (192.1 < 500) gets the theme-tinted rule fill");
  ok((await css(s.cell("D3"), "backgroundColor")) !== rgb("#dce6f2"), "D3 (1148) does not match the lt 500 rule");
  await s.tab("Category sales");
  await s.cell("G3").waitFor({ timeout: 15_000 });
  // expected colours from the importer + evaluator, independently checked against openpyxl in tt47-sheet
  const wb = readXlsxWorkbook(readFileSync(join(XCORPUS, "ConditionalFormattingSamples.xlsx"))); wb.recalculate();
  const vals: [string, number][] = []; for (let r = 2; r <= 21; r++) { const v = wb.valueAt("Category sales", 6, r); if (typeof v === "number") vals.push([`G${r + 1}`, v]); }
  vals.sort((a, b) => a[1] - b[1]);
  const lo = vals[0][0], hi = vals[vals.length - 1][0];
  await s.cell(lo).scrollIntoViewIfNeeded(); eq(await css(s.cell(lo), "backgroundColor"), rgb("#c00000"), `${lo} (minimum) is the scale's min colour`);
  await s.cell(hi).scrollIntoViewIfNeeded(); eq(await css(s.cell(hi), "backgroundColor"), rgb("#0070c0"), `${hi} (maximum) is the scale's max colour`);
  const midRef = vals[Math.floor(vals.length / 2)][0];
  await s.cell(midRef).scrollIntoViewIfNeeded();
  const mid = (await css(s.cell(midRef), "backgroundColor")).match(/\d+/g)!.map(Number);
  ok(mid[0] > 150 && mid[1] > 150 && mid[2] < 150, `${midRef} (median) is near the yellow midpoint, got rgb(${mid})`);
  await s.page.screenshot({ path: join(SHOTS, "e2e47-cf-scale.png") });
  await s.close();
  const t = `/Documents/${RUN}-theme.xlsx`;
  await upload(t, new Uint8Array(readFileSync(join(XCORPUS, "Themes2.xlsx"))));
  const s2 = await openSheetFile(t);
  await s2.cell("B6").waitFor({ timeout: 15_000 });
  eq(await css(s2.cell("B6"), "color"), rgb("#4f81bd"), "B6 font <color theme=\"4\"/> = accent1");
  eq(await css(s2.cell("E5"), "backgroundColor"), rgb("#002060"), "E5 fill");
  await s2.page.screenshot({ path: join(SHOTS, "e2e47-theme.png") });
  await s2.close();
});

await test("Spreadsheet: add '≥ 1000' and a 3-colour scale through the panel → shown at once → Save writes them into the original .xlsx (independent CF oracle + openpyxl cell diff)", COV, async () => {
  const src = `/Documents/${RUN}-edit.xlsx`;
  const orig = new Uint8Array(readFileSync(join(XCORPUS, "ConditionalFormattingSamples.xlsx")));
  await upload(src, orig);
  const s = await openSheetFile(src);
  await s.tab("Products1");
  await s.cell("D3").click(); await s.cell("D8").click({ modifiers: ["Shift"] });
  await s.dlg.getByRole("button", { name: "Cond. format" }).click();
  const panel = s.dlg.locator('[data-testid="cf-panel"]');
  await panel.getByLabel("Rule type").selectOption("ge");
  const val = panel.getByLabel("Rule value"); await val.waitFor({ timeout: 3000 }); // the ≥ option has a value box (TT46 bug: it had none)
  await val.fill("1000");
  await panel.getByLabel("Rule fill").evaluate((e) => { const i = e as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(i, "#14532d"); i.dispatchEvent(new Event("input", { bubbles: true })); });
  await panel.getByRole("button", { name: "Add rule" }).click();
  await panel.locator('[data-testid="cf-rule"][data-range="D3:D8"]').waitFor({ timeout: 5000 });
  eq(await css(s.cell("D3"), "backgroundColor"), rgb("#14532d"), "D3 (1148 ≥ 1000) shows the new rule at once");
  eq(await css(s.cell("D7"), "backgroundColor"), rgb("#dce6f2"), "D7 keeps the imported lt 500 rule");
  // 3-colour scale on F3:F12
  await s.cell("F3").click(); await s.cell("F12").click({ modifiers: ["Shift"] });
  await panel.getByLabel("Rule type").selectOption("scale3");
  await panel.getByLabel("Scale midpoint colour").waitFor({ timeout: 3000 });
  await panel.getByRole("button", { name: "Add rule" }).click();
  await panel.locator('[data-testid="cf-rule"][data-range="F3:F12"]').waitFor({ timeout: 5000 });
  await s.page.screenshot({ path: join(SHOTS, "e2e47-cf-edit.png") });
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  const status = s.dlg.locator('[data-testid="sheet-status"]');
  await status.filter({ hasText: "lossless" }).waitFor({ timeout: 15_000 });
  await s.close();
  const saved = await readBytes(src);
  const a = join(tmp, "orig.xlsx"), b = join(tmp, "saved.xlsx"); writeFileSync(a, orig); writeFileSync(b, saved);
  const cf = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_cf.py"], { input: b, encoding: "utf8" }).trim());
  ok(!cf.error, cf.error);
  ok(cf.rules.some((r: unknown[]) => JSON.stringify(r) === JSON.stringify(["Products1", "D3:D8", "ge", 1000, null, "#14532d", "#bbf7d0"])), `oracle sees the new ≥ rule: ${JSON.stringify(cf.rules.filter((r: unknown[]) => r[0] === "Products1"))}`);
  ok(cf.rules.some((r: unknown[]) => JSON.stringify(r) === JSON.stringify(["Products1", "D3:D23", "lt", 500, null, "#dce6f2", null])), "imported lt 500 rule still there");
  const back = readXlsxWorkbook(Buffer.from(saved));
  const sc = back.condFormats.find((r) => r.sheet === "Products1" && r.range === "F3:F12");
  ok(sc && sc.kind === "scale" && sc.scaleMid && sc.scaleAt === "min|percentile:50|max", `3-colour scale written: ${JSON.stringify(sc)}`);
  const pr = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_patch_probe.py"], { input: `${a}\t${b}\n`, encoding: "utf8" }).trim());
  ok(pr.ok, `openpyxl load: ${pr.error}`);
  eq(pr.diff, [], "no cell changed");
  eq(pr.partsLost, [], "no part lost");
  eq(Object.keys(pr.styleDiff), [], "no cell style drift");
});

/* ---------------------------------------------------------------- TT47: password-protected Office files */
const DCORPUS = "/home/user/tools/corpus/docx";
const isCfb = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
async function openApp(mod: "writer" | "sheet", path: string) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=${mod}&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator(`[role=dialog][aria-label="${mod === "writer" ? "Writer" : "Spreadsheet"}"]`).first();
  return { page, dlg, ask: page.locator('[data-testid="ask-dialog"]'), close: () => ctx.close() };
}

await test("Writer opens a password-protected .docx (Agile): masked prompt, wrong password keeps the dialog with an alert, shortcuts can't act behind the modal, right password opens it", COV, async () => {
  const src = `/Documents/${RUN}-protected.docx`; const enc = new Uint8Array(readFileSync(join(DCORPUS, "bug53475-password-is-pass.docx")));
  await upload(src, enc);
  const w = await openApp("writer", src);
  await w.ask.waitFor({ timeout: 25_000 });
  ok(/password-protected/.test(await w.ask.innerText()), "prompt explains the file is protected");
  const input = w.ask.locator('[data-testid="ask-input-value"]');
  eq(await input.getAttribute("type"), "password", "password field is masked");
  await input.fill("Pass"); await input.press("Enter");
  await w.ask.locator('[data-testid="ask-error"]').waitFor({ timeout: 10_000 });
  ok(/not correct/.test(await w.ask.locator('[data-testid="ask-error"]').innerText()), "wrong-password alert");
  // modal shortcut adversary: Ctrl+S / Ctrl+W pressed inside the password dialog must not reach the Writer or the Shell
  await input.press("Control+s"); await input.press("Control+w"); await w.page.waitForTimeout(800);
  ok(await w.ask.isVisible(), "password dialog still open after Ctrl+S / Ctrl+W");
  ok(await w.dlg.isVisible(), "Writer window not closed behind the modal");
  ok(sameBytes(await readBytes(src), enc), "nothing was written while the modal was open");
  await input.fill("pass"); await input.press("Enter");
  await w.dlg.locator('[data-testid="writer-body"] [data-pid]').first().waitFor({ timeout: 25_000 });
  ok(/password protected document/.test(await w.dlg.locator('[data-testid="writer-body"]').innerText()), "decrypted document text shown");
  ok(/password-protected \(agile, integrity verified\)/.test(await w.dlg.locator('[data-testid="writer-status"]').innerText()), "status names the scheme and integrity check");
  await w.page.screenshot({ path: join(SHOTS, "e2e47-protected-docx.png") });
  // edit, then Save: must ask for an unencrypted copy under a DIFFERENT name; Escape writes nothing
  await w.dlg.locator('[data-testid="writer-body"] [data-pid]').first().click(); await w.page.keyboard.press("End"); await w.page.keyboard.type(" Edited.");
  await w.dlg.locator('[data-testid="writer-save"]').click();
  await w.ask.waitFor({ timeout: 10_000 });
  ok(/unencrypted copy/i.test(await w.ask.innerText()), "save asks to confirm an unencrypted copy");
  const pathIn = w.ask.locator('[data-testid="ask-input-value"]');
  ok((await pathIn.inputValue()).endsWith("(unencrypted).docx"), `suggested name ${await pathIn.inputValue()}`);
  await pathIn.fill(src); await pathIn.press("Enter");
  ok(/different name/.test(await w.ask.locator('[data-testid="ask-error"]').innerText()), "overwriting the protected original is refused in the dialog");
  await pathIn.press("Escape"); await w.ask.waitFor({ state: "hidden", timeout: 5_000 });
  ok(sameBytes(await readBytes(src), enc), "Escape: protected original unchanged");
  await w.dlg.locator('[data-testid="writer-save"]').click(); await w.ask.waitFor({ timeout: 10_000 });
  const copy = `/Documents/${RUN}-protected-copy.docx`;
  await w.ask.locator('[data-testid="ask-input-value"]').fill(copy); await w.ask.locator('[data-testid="ask-input-value"]').press("Enter");
  await w.dlg.locator('[data-testid="writer-status"]', { hasText: /^Saved \// }).waitFor({ timeout: 15_000 }); // not "Not saved —"
  const out = await readBytes(copy); ok(out[0] === 0x50 && out[1] === 0x4b, "copy is a plain .docx");
  const { docText, readWord } = await import("../src/lib/office/wordml.ts");
  ok(/Edited\./.test(docText(await readWord(out))), "edit present in the unencrypted copy");
  ok(sameBytes(await readBytes(src), enc), "protected original still byte-identical after saving the copy");
  await w.close();
});

await test("Spreadsheet opens a password-protected .xlsx (Standard), saves only an explicit unencrypted copy; server refuses plaintext over an encrypted file; cancel never overwrites", COV, async () => {
  const src = `/Documents/${RUN}-protected.xlsx`; const enc = new Uint8Array(readFileSync(join(XCORPUS, "protected_passtika.xlsx")));
  await upload(src, enc);
  const s = await openApp("sheet", src);
  await s.ask.waitFor({ timeout: 25_000 });
  await s.ask.locator('[data-testid="ask-input-value"]').fill("tika"); await s.ask.locator('[data-testid="ask-input-value"]').press("Enter");
  await s.dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const { decryptOffice } = await import("../src/lib/office/offcrypto.ts");
  const plain = decryptOffice(enc, "tika").bytes; const wb = readXlsxWorkbook(Buffer.from(plain));
  const { sheetToJson } = await import("../src/lib/formula/xlsx.ts");
  const hit = sheetToJson(wb.sheet()).cells.find((c) => /^[A-Za-z][\w .]{2,}$/.test(c.input)); // tika: A1 "This is an Encrypted Excel spreadsheet."
  const probe = hit?.ref ?? "", want = hit?.input ?? "";
  ok(probe, "decrypted workbook has a text cell");
  ok((await s.dlg.locator(`[data-cell="${probe}"]`).innerText()).includes(want), `${probe} shows "${want}"`);
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.ask.waitFor({ timeout: 10_000 }); ok(/unencrypted copy/i.test(await s.ask.innerText()), "save confirms an unencrypted copy");
  const copy = `/Documents/${RUN}-protected-copy.xlsx`;
  await s.ask.locator('[data-testid="ask-input-value"]').fill(copy); await s.ask.locator('[data-testid="ask-input-value"]').press("Enter");
  await s.dlg.locator('[data-testid="sheet-status"]', { hasText: /^saved \// }).waitFor({ timeout: 20_000 });
  const out = await readBytes(copy); ok(out[0] === 0x50 && out[1] === 0x4b, "copy is a plain .xlsx");
  ok(readXlsxWorkbook(Buffer.from(out)).sheets.size === wb.sheets.size, "copy has every sheet");
  ok(sameBytes(await readBytes(src), enc), "protected original byte-identical");
  await s.close();
  // server-side guard (defence in depth)
  const r1 = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(out).toString("base64") });
  ok(r1.status >= 400 && /password-protected/.test(JSON.stringify(r1.json)), `upload of plaintext over the protected file refused (${r1.status})`);
  const r2 = await api("POST", "/api/sheet", { op: "patchXlsxToVfs", source: copy, dest: src, workbook: (await api("POST", "/api/sheet", { op: "importXlsx", path: copy })).json.workbook });
  ok(r2.status >= 400 && /password-protected/.test(JSON.stringify(r2.json)), `lossless patch over the protected file refused (${r2.status})`);
  ok(isCfb(await readBytes(src)) && sameBytes(await readBytes(src), enc), "still encrypted after both attempts");
  // cancel path: Escape at the password prompt, then Save — must ask (never write a blank workbook over the original)
  const s2 = await openApp("sheet", src);
  await s2.ask.waitFor({ timeout: 25_000 }); await s2.ask.locator('[data-testid="ask-input-value"]').press("Escape");
  await s2.dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  await s2.dlg.getByRole("button", { name: "Save workbook" }).click(); await s2.page.waitForTimeout(1500);
  ok(sameBytes(await readBytes(src), enc), "cancelled open + Save left the protected original unchanged");
  await s2.close();
});

await test("no uncaught page errors during the Spreadsheet session", COV, () => { eq(errors, [], "page errors"); });
await browser.close();
// hygiene: remove this run's uploads/saves so repeated runs don't pile up desktop icons and tabletop cards
{
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) if (n.path.startsWith(`/Documents/${RUN}-`)) {
    for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
  }
}
await finish();
process.exit(0);
