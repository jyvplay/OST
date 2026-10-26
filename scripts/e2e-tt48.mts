/**
 * TT48 e2e — password-protected Office files are re-encrypted on save, in the real UI (Chromium 143 headless).
 * Independent check of every saved file: msoffcrypto-tool 6.0.0 (MIT) decrypts it WITH HMAC integrity verification
 * (scripts/oracle/msoff_decrypt.py); Writer/Spreadsheet content is then read back with our readers.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt48.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook, sheetToJson } from "../src/lib/formula/xlsx.ts";
import { decryptOffice } from "../src/lib/office/offcrypto.ts";
import { docText, readWord } from "../src/lib/office/wordml.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `y${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt48");
const COV = { "FF-20": "full", "FF-22": "full", "FF-11": "full", "PR-11": "partial" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", C = "/home/user/tools/corpus";
const tmp = mkdtempSync(join(tmpdir(), "e2e48-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const isCfb = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64") }); ok(r.status < 300, `upload ${path}: ${r.status} ${JSON.stringify(r.json)}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8")); }
/** independent decryptor with HMAC verification; returns the plaintext or the error */
function msoff(bytes: Uint8Array, pw: string): { ok: boolean; plain?: Uint8Array; error?: string } {
  const i = join(tmp, `m${Math.random().toString(36).slice(2)}`), o = i + ".out"; writeFileSync(i, bytes);
  const r = JSON.parse(execFileSync(PY, ["scripts/oracle/msoff_decrypt.py"], { input: `${i}\t${pw}\t${o}\n` }).toString().trim());
  return r.ok ? { ok: true, plain: new Uint8Array(readFileSync(o)) } : { ok: false, error: r.error };
}

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openApp(mod: "writer" | "sheet", path: string) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=${mod}&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator(`[role=dialog][aria-label="${mod === "writer" ? "Writer" : "Spreadsheet"}"]`).first();
  const ask = page.locator('[data-testid="ask-dialog"]');
  const unlock = async (pw: string) => { await ask.waitFor({ timeout: 25_000 }); await ask.locator('[data-testid="ask-input-value"]').fill(pw); await ask.locator('[data-testid="ask-input-value"]').press("Enter"); await ask.waitFor({ state: "hidden", timeout: 15_000 }); };
  const setPassword = async (pw: string, again = pw) => {
    await dlg.locator(`[data-testid="${mod === "writer" ? "writer" : "sheet"}-password"]`).click(); await ask.waitFor({ timeout: 10_000 });
    eq(await ask.locator('[data-testid="ask-input-pw"]').getAttribute("type"), "password", "new-password field masked");
    eq(await ask.locator('[data-testid="ask-input-again"]').getAttribute("type"), "password", "confirm field masked");
    await ask.locator('[data-testid="ask-input-pw"]').fill(pw); await ask.locator('[data-testid="ask-input-again"]').fill(again); await ask.locator('[data-testid="ask-ok"]').click();
  };
  return { page, dlg, ask, unlock, setPassword, close: () => ctx.close() };
}

await test("Writer: protected .docx → edit → Save re-encrypts in place (msoffcrypto + HMAC verify); reopening asks for the password and shows the edit; change password → old one refused, new one works", COV, async () => {
  const src = `/Documents/${RUN}-w.docx`; const enc = new Uint8Array(readFileSync(join(C, "docx/bug53475-password-is-pass.docx")));
  await upload(src, enc);
  const w = await openApp("writer", src); await w.unlock("pass");
  const body = w.dlg.locator('[data-testid="writer-body"]'); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  ok(/saves stay encrypted/.test(await w.dlg.locator('[data-testid="writer-status"]').innerText()), "status says saves stay encrypted");
  ok(/Password: on/.test(await w.dlg.locator('[data-testid="writer-password"]').innerText()), "Password button shows it is on");
  await body.locator("[data-pid]").first().click(); await w.page.keyboard.press("End"); await w.page.keyboard.type(" TT48-one.");
  await w.dlg.locator('[data-testid="writer-save"]').click();
  await w.dlg.locator('[data-testid="writer-status"]', { hasText: /^Saved \/.*encrypted with your password/ }).waitFor({ timeout: 20_000 });
  const s1 = await readBytes(src); ok(isCfb(s1), "saved file is an encrypted container");
  const m1 = msoff(s1, "pass"); ok(m1.ok, `msoffcrypto (HMAC verified): ${m1.error}`);
  ok(/TT48-one\./.test(docText(await readWord(m1.plain!))), "edit present in the independently decrypted file");
  ok(!msoff(s1, "Pass").ok, "wrong-case password refused by msoffcrypto");
  // second save in the same window uses the cached key: still a fresh container
  await body.locator("[data-pid]").first().click(); await w.page.keyboard.press("End"); await w.page.keyboard.type(" TT48-two.");
  await w.dlg.locator('[data-testid="writer-save"]').click();
  let s2 = s1; for (let i = 0; i < 80 && Buffer.compare(Buffer.from(s1), Buffer.from(s2)) === 0; i++) { await w.page.waitForTimeout(250); s2 = await readBytes(src); } ok(isCfb(s2) && Buffer.compare(Buffer.from(s1), Buffer.from(s2)) !== 0, "second save wrote a new container");
  ok(/TT48-two\./.test(docText(await readWord(msoff(s2, "pass").plain!))), "second edit present");
  // change the password
  await w.setPassword("n3w-Secret");
  await w.dlg.locator('[data-testid="writer-status"]', { hasText: /Password set/ }).waitFor({ timeout: 10_000 });
  await w.dlg.locator('[data-testid="writer-save"]').click();
  await w.dlg.locator('[data-testid="writer-status"]', { hasText: /^Saved \/.*encrypted with your password/ }).waitFor({ timeout: 20_000 });
  const s3 = await readBytes(src);
  ok(!msoff(s3, "pass").ok && msoff(s3, "n3w-Secret").ok, "old password refused, new password accepted (msoffcrypto)");
  await w.page.screenshot({ path: join(SHOTS, "e2e48-writer-encrypted.png") });
  await w.close();
  // reopen: prompt, new password, edit visible
  const w2 = await openApp("writer", src); await w2.unlock("n3w-Secret");
  await w2.dlg.locator('[data-testid="writer-body"] [data-pid]').first().waitFor({ timeout: 25_000 });
  ok(/TT48-one\. TT48-two\./.test(await w2.dlg.locator('[data-testid="writer-body"]').innerText()), "reopened document shows both edits");
  await w2.close();
});

await test("Writer: protect a plain .docx (mismatched confirmation refused in the dialog), then remove the password → plain .docx again; the server refused plaintext over it until removal was explicit", COV, async () => {
  const src = `/Documents/${RUN}-plain.docx`; const plain = new Uint8Array(readFileSync(join(C, "docx/52288.docx")));
  await upload(src, plain);
  const w = await openApp("writer", src);
  await w.dlg.locator('[data-testid="writer-body"] [data-pid]').first().waitFor({ timeout: 25_000 });
  await w.setPassword("abc", "abd");
  ok(/do not match/.test(await w.ask.locator('[data-testid="ask-error"]').innerText()), "mismatch shown inline");
  await w.ask.locator('[data-testid="ask-input-again"]').fill("abc"); await w.ask.locator('[data-testid="ask-ok"]').click(); await w.ask.waitFor({ state: "hidden" });
  await w.dlg.locator('[data-testid="writer-save"]').click();
  await w.dlg.locator('[data-testid="writer-status"]', { hasText: /^Saved \/.*encrypted with your password/ }).waitFor({ timeout: 20_000 });
  const e = await readBytes(src); ok(isCfb(e), "now encrypted");
  const m = msoff(e, "abc"); ok(m.ok, `msoffcrypto: ${m.error}`);
  eq(docText(await readWord(m.plain!)), docText(await readWord(plain)), "same text after encryption");
  // defence in depth: a plain upload over the now-encrypted file is refused without the explicit flag
  const r = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(plain).toString("base64") });
  ok(r.status >= 400 && /password-protected/.test(JSON.stringify(r.json)), `server refuses plaintext over it (${r.status})`);
  // remove: both fields empty
  await w.setPassword("", "");
  await w.dlg.locator('[data-testid="writer-status"]', { hasText: /Password removed/ }).waitFor({ timeout: 10_000 });
  await w.dlg.locator('[data-testid="writer-save"]').click();
  await w.dlg.locator('[data-testid="writer-status"]', { hasText: /password removed\)/ }).waitFor({ timeout: 20_000 });
  const p2 = await readBytes(src); ok(isZip(p2), "plain .docx after explicit removal");
  eq(docText(await readWord(p2)), docText(await readWord(plain)), "text unchanged");
  ok(/Password…/.test(await w.dlg.locator('[data-testid="writer-password"]').innerText()), "button back to Password…");
  await w.close();
});

await test("Spreadsheet: protected .xlsx (Standard) → edit a cell → Save re-encrypts in place as Agile (msoffcrypto + HMAC verify), lossless patch kept the other sheets; reopening shows the edit", COV, async () => {
  const src = `/Documents/${RUN}-s.xlsx`; const enc = new Uint8Array(readFileSync(join(C, "xlsx/protected_passtika.xlsx")));
  await upload(src, enc);
  const s = await openApp("sheet", src); await s.unlock("tika");
  await s.dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  ok(/Password: on/.test(await s.dlg.locator('[data-testid="sheet-password"]').innerText()), "Password button shows it is on");
  await s.dlg.locator('[data-cell="C9"]').click(); await s.page.keyboard.type("TT48 cell"); await s.page.keyboard.press("Enter");
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.dlg.locator('[data-testid="sheet-status"]', { hasText: /^saved \/.* encrypted with your password/ }).waitFor({ timeout: 25_000 });
  const out = await readBytes(src); ok(isCfb(out), "still an encrypted container");
  const m = msoff(out, "tika"); ok(m.ok, `msoffcrypto: ${m.error}`);
  const ours = decryptOffice(out, "tika"); eq([ours.method, ours.integrity], ["agile", "verified"], "Standard re-encrypted as Agile");
  const wb = readXlsxWorkbook(Buffer.from(m.plain!)); const orig = readXlsxWorkbook(Buffer.from(decryptOffice(enc, "tika").bytes));
  ok(sheetToJson(wb.sheet()).cells.some((c) => c.ref === "C9" && c.input === "TT48 cell"), "C9 edit present");
  eq(wb.sheets.size, orig.sheets.size, "sheet count");
  await s.page.screenshot({ path: join(SHOTS, "e2e48-sheet-encrypted.png") });
  // second save after another edit (cached key, patch source = previous decrypted package)
  await s.dlg.locator('[data-cell="C10"]').click(); await s.page.keyboard.type("=LEN(C9)"); await s.page.keyboard.press("Enter");
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  let out2 = out; for (let i = 0; i < 100 && Buffer.compare(Buffer.from(out), Buffer.from(out2)) === 0; i++) { await s.page.waitForTimeout(250); out2 = await readBytes(src); } const wb2 = readXlsxWorkbook(Buffer.from(msoff(out2, "tika").plain!));
  const cells2 = sheetToJson(wb2.sheet()).cells;
  ok(cells2.some((c) => c.ref === "C9" && c.input === "TT48 cell") && cells2.some((c) => c.ref === "C10" && /LEN\(C9\)/i.test(c.input)), "both edits present after the second save");
  await s.close();
  const s2 = await openApp("sheet", src); await s2.unlock("tika");
  await s2.dlg.locator('[data-cell="C9"]').waitFor({ timeout: 25_000 });
  eq((await s2.dlg.locator('[data-cell="C9"]').innerText()).trim(), "TT48 cell", "reopened C9");
  eq((await s2.dlg.locator('[data-cell="C10"]').innerText()).trim(), "9", "reopened C10 = LEN(C9)");
  await s2.close();
});

await test("Spreadsheet: protect a plain .xlsx → encrypted; remove the password → plain lossless .xlsx again (no-edit parts byte-identical to the original)", COV, async () => {
  const src = `/Documents/${RUN}-p.xlsx`; const plain = new Uint8Array(readFileSync(join(C, "xlsx/WithChart.xlsx")));
  await upload(src, plain);
  const s = await openApp("sheet", src); await s.dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  await s.setPassword("Sheet-pw ✓"); await s.ask.waitFor({ state: "hidden" });
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.dlg.locator('[data-testid="sheet-status"]', { hasText: /^saved \/.* encrypted with your password/ }).waitFor({ timeout: 25_000 });
  const e = await readBytes(src); ok(isCfb(e), "encrypted");
  const m = msoff(e, "Sheet-pw ✓"); ok(m.ok, `msoffcrypto with a non-ASCII password: ${m.error}`);
  ok(Buffer.compare(Buffer.from(m.plain!), Buffer.from(plain)) === 0, "no edits → the encrypted package is the original bytes exactly");
  await s.setPassword("", ""); await s.ask.waitFor({ state: "hidden" });
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.dlg.locator('[data-testid="sheet-status"]', { hasText: /^saved \/.* password removed/ }).waitFor({ timeout: 25_000 }); // not the dialog's "password removed — the next save…"
  const p2 = await readBytes(src); ok(isZip(p2), "plain .xlsx again");
  const st = await s.dlg.locator('[data-testid="sheet-status"]').innerText();
  ok(Buffer.compare(Buffer.from(p2), Buffer.from(plain)) === 0, `byte-identical to the original (${p2.length} vs ${plain.length}; status: ${st})`);
  await s.close();
});

await test("adversary: a cancelled unlock can neither save over nor re-protect the original; Password… on a non-.xlsx workbook is disabled", COV, async () => {
  const src = `/Documents/${RUN}-c.docx`; const enc = new Uint8Array(readFileSync(join(C, "docx/bug53475-password-is-pass.docx")));
  await upload(src, enc);
  const w = await openApp("writer", src); await w.ask.waitFor({ timeout: 25_000 }); await w.ask.locator('[data-testid="ask-input-value"]').press("Escape");
  await w.dlg.locator('[data-testid="writer-password"]').waitFor({ timeout: 25_000 });
  await w.dlg.locator('[data-testid="writer-password"]').click(); await w.page.waitForTimeout(500);
  ok(!(await w.ask.isVisible()), "no password dialog for a locked document");
  await w.page.keyboard.press("Control+s"); await w.dlg.locator('[data-testid="writer-save"]').click(); await w.page.waitForTimeout(1500);
  ok(Buffer.compare(Buffer.from(await readBytes(src)), Buffer.from(enc)) === 0, "original unchanged");
  await w.close();
  const s = await openApp("sheet", ""); await s.dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  ok(await s.dlg.locator('[data-testid="sheet-password"]').isDisabled(), "disabled for a non-.xlsx workbook");
  await s.close();
});

await test("no uncaught page errors during the TT48 sessions", COV, () => { eq(errors, [], "page errors"); });
await browser.close();
{
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) if (n.path.startsWith(`/Documents/${RUN}-`)) {
    for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
  }
}
await finish();
process.exit(0);
