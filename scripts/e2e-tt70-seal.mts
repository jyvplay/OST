/**
 * TT70 FF-15 sealed recovery drafts of password-protected documents, in the real UI (Chromium 143, production build).
 * TT69 kept NO draft for protected documents; now the draft is sealed with the document's password.
 *  1. Writer: an encrypted .docx is unlocked and edited → the draft on the server is an encrypted container (no typed
 *     text, CFB magic); msoffcrypto-tool (HMAC verified) decrypts it with the password and python-docx reads the edit.
 *     Close says a draft is kept; Don't save; reopening (password) offers Restore; Restore asks NOTHING more (the
 *     window's password opens it); Save writes the file still encrypted (msoffcrypto + python-docx) and clears the draft.
 *  2. Spreadsheet — adversary: the password is CHANGED after the draft (P1 → P2 by another save). Reopening with P2
 *     cannot open the P1 draft silently, so Restore asks; a wrong password keeps the dialog open with an inline alert;
 *     Cancel puts the banner back; P1 restores the edit; Save keeps the file's CURRENT protection (P2 opens it, P1 does
 *     not) and openpyxl reads the restored cell.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt70-seal.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { encryptOffice } from "../src/lib/office/offcrypto.ts";
import { decodeDraft, draftPathFor } from "../src/lib/doc-lifecycle.ts";
import { DRAFT_ENTRY } from "../src/lib/office/draft-seal.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t70${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e70-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const { test, finish } = makeHarness("e2e-tt70-seal");
const FULL = { "FF-15": "full", "FF-20": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const readNode = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return r.status === 200 && r.json?.node ? r.json.node as { content: string; encoding?: string } : null; };
const bytesOf = async (path: string) => { const n = await readNode(path); if (!n) throw new Error(`missing ${path}`); return Buffer.from(n.content, n.encoding === "base64" ? "base64" : "utf8"); };
const purge = async (p: string) => { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); };
const upload = async (path: string, bytes: Uint8Array, mime: string) => { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(r.status < 300, `upload ${r.status}`); };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const py = (code: string, ...args: string[]) => execFileSync(PY, ["-c", code, ...args], { encoding: "utf8" }).trim();
const docxText = (file: string) => py("import docx,sys; print('\\n'.join(p.text for p in docx.Document(sys.argv[1]).paragraphs))", file);
const xlsxCell = (file: string, ref: string) => py("import openpyxl,sys,json; wb=openpyxl.load_workbook(sys.argv[1]); print(json.dumps(wb.active[sys.argv[2]].value))", file, ref);
const isCfb = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
function msoff(bytes: Uint8Array, pw: string): { ok: boolean; file?: string; error?: string } {
  const i = join(tmp, `m${Math.random().toString(36).slice(2)}`), o = i + ".out"; writeFileSync(i, bytes);
  const r = JSON.parse(execFileSync(PY, ["scripts/oracle/msoff_decrypt.py"], { input: `${i}\t${pw}\t${o}\n` }).toString().trim());
  return r.ok ? { ok: true, file: o } : { ok: false, error: r.error };
}

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const ask = (page: Page) => page.getByTestId("ask-dialog");
async function answer(page: Page, pw: string, expectClose = true) {
  await ask(page).waitFor({ timeout: 25_000 });
  await ask(page).getByTestId("ask-input-value").fill(pw); await ask(page).getByTestId("ask-input-value").press("Enter");
  if (expectClose) await ask(page).waitFor({ state: "hidden", timeout: 20_000 });
}
const confirmBox = (page: Page) => page.getByTestId("close-confirm");
const cleanup: string[] = [];

/* ------------------------------------------------------------------ 1. Writer */
await test("Writer: a protected .docx keeps a SEALED draft (msoffcrypto + python-docx read it with the password; no plaintext on the server); Restore asks nothing more; Save stays encrypted and clears the draft", FULL, async () => {
  const P1 = `Seal-${RUN}-ü`;
  const local = join(tmp, "base.docx");
  py("import docx,sys; d=docx.Document(); d.add_paragraph('Alpha protected paragraph'); d.save(sys.argv[1])", local);
  const docPath = `/Documents/${RUN}-prot.docx`; cleanup.push(docPath);
  await upload(docPath, encryptOffice(new Uint8Array(readFileSync(local)), P1), DOCX);
  const dp = draftPathFor("writer", docPath); cleanup.push(dp);
  await putDesktop(); let page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(docPath)}`, { waitUntil: "domcontentloaded" });
  await answer(page, P1);
  let dlg = page.locator('[role=dialog][aria-label="Writer"]').first();
  let body = dlg.locator('[data-testid="writer-body"]'); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  await body.locator("[data-pid]").filter({ hasText: "Alpha protected" }).first().click(); await page.keyboard.press("End");
  const mark = ` SEALED${RUN}`; await page.keyboard.type(mark);
  await poll(async () => !!(await readNode(dp)), "a draft is written for the protected document", 20_000);
  const rawRecord = (await readNode(dp))!.content;
  const d = decodeDraft(rawRecord, "writer"); ok(d, "draft decodes");
  eq(d!.encoding, "sealed", "encoding");
  ok(!rawRecord.includes(mark.trim()) && !rawRecord.includes(P1), "the record on the server has neither the typed text nor the password");
  const sealed = Buffer.from(d!.payload, "base64"); ok(isCfb(sealed), "the payload is an encrypted Office (CFB) container");
  ok(!sealed.includes(Buffer.from(mark.trim())), "no typed text in the sealed bytes");
  const m = msoff(sealed, P1); ok(m.ok, `msoffcrypto opens the draft with the password: ${m.error}`);
  ok(docxText(m.file!).includes(`Alpha protected paragraph${mark}`), "python-docx reads the edit inside the decrypted draft");
  ok(!msoff(sealed, "wrong").ok, "msoffcrypto refuses the wrong password");
  await dlg.getByRole("button", { name: "Close window" }).first().click();
  await confirmBox(page).waitFor();
  ok(/recovery draft is kept/.test(await confirmBox(page).innerText()), "the dialog now says a draft is kept (TT69: 'no recovery draft')");
  await page.getByTestId("close-confirm-discard").click();
  await poll(async () => (await page.locator('[role=dialog][aria-label="Writer"]').count()) === 0, "closed without saving");
  ok(await readNode(dp), "the sealed draft survives Don't save");
  await page.context().close();
  // reopen: the file asks for its password; Restore then asks nothing more
  await putDesktop(); page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(docPath)}`, { waitUntil: "domcontentloaded" });
  await answer(page, P1);
  dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); body = dlg.locator('[data-testid="writer-body"]');
  await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  await dlg.getByTestId("recover-banner").waitFor();
  await dlg.getByTestId("recover-restore").click();
  await poll(async () => (await body.innerText()).includes(mark.trim()), "restored text visible", 20_000);
  eq(await ask(page).count(), 0, "no password prompt for the draft: the window's password opened it");
  ok(/Save •/.test(await dlg.getByTestId("writer-save").innerText()), "restored = unsaved");
  await dlg.getByTestId("writer-save").click();
  await poll(async () => !(await readNode(dp)), "Save deletes the draft", 20_000);
  const saved = await bytesOf(docPath); ok(isCfb(saved), "the saved file is still encrypted (restoring did not drop the protection)");
  const s = msoff(saved, P1); ok(s.ok, `msoffcrypto opens the saved file: ${s.error}`);
  ok(docxText(s.file!).includes(`Alpha protected paragraph${mark}`), "python-docx reads the restored + saved paragraph");
  await page.context().close();
});

/* ------------------------------------------------------------------ 2. Spreadsheet, password changed since the draft */
await test("Spreadsheet adversary: password changed P1→P2 after the draft — Restore asks; a wrong password shows an inline alert; Cancel keeps the banner; P1 restores; Save keeps the CURRENT protection (P2 opens, P1 does not; openpyxl reads the cell)", FULL, async () => {
  const P1 = `One-${RUN}`, P2 = `Two-${RUN}`;
  const wb = new Workbook(); wb.sheet().setCell(0, 0, "1"); wb.recalculate();
  const plain = writeXlsxWorkbook(wb);
  const src = `/Documents/${RUN}-prot.xlsx`; cleanup.push(src);
  await upload(src, encryptOffice(new Uint8Array(plain), P1), XLSX);
  const dp = draftPathFor("sheet", src); cleanup.push(dp);
  await putDesktop(); let page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  await answer(page, P1);
  let dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  await cell("B1").click(); await page.keyboard.type("7731"); await page.keyboard.press("Enter");
  await poll(async () => (await cell("B1").innerText()).trim() === "7731", "B1 edited");
  await poll(async () => !!(await readNode(dp)), "a sealed draft is written for the protected workbook", 20_000);
  const d = decodeDraft((await readNode(dp))!.content, "sheet"); ok(d, "decodes"); eq(d!.encoding, "sealed", "encoding");
  const sealed = Buffer.from(d!.payload, "base64"); ok(isCfb(sealed), "CFB container");
  const m = msoff(sealed, P1); ok(m.ok, `msoffcrypto opens the sheet draft: ${m.error}`);
  const json = py("import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode('utf-8'))", m.file!, DRAFT_ENTRY);
  ok(json.includes("7731"), "Python's zipfile reads the edit out of the decrypted draft JSON");
  await dlg.getByRole("button", { name: "Close window" }).first().click();
  await confirmBox(page).waitFor(); await page.getByTestId("close-confirm-discard").click();
  await poll(async () => (await page.locator('[role=dialog][aria-label="Spreadsheet"]').count()) === 0, "closed");
  await page.context().close();
  // someone re-protects the file with P2
  await upload(src, encryptOffice(new Uint8Array(plain), P2), XLSX);
  await putDesktop(); page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  await answer(page, P2);
  dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const banner = dlg.getByTestId("recover-banner"); await banner.waitFor();
  ok(/changed since/.test(await banner.innerText()), "flagged: the file changed since the draft");
  await dlg.getByTestId("recover-restore").click();
  await ask(page).waitFor({ timeout: 20_000 });
  ok(/recovery draft .* is password-protected/i.test(await ask(page).innerText()), "the prompt names the draft");
  eq(await ask(page).getByTestId("ask-input-value").getAttribute("type"), "password", "masked");
  await answer(page, "wrong-" + RUN, false);
  await ask(page).getByTestId("ask-error").waitFor({ timeout: 20_000 });
  ok(/not correct/.test(await ask(page).getByTestId("ask-error").innerText()), "inline alert for a wrong password; dialog stays open");
  await page.screenshot({ path: join(SHOTS, "tt70-sealed-draft-prompt.png") });
  await page.keyboard.press("Escape");
  await ask(page).waitFor({ state: "hidden" });
  await banner.waitFor({ timeout: 10_000 });
  eq((await cell("B1").innerText()).trim(), "", "nothing restored on Cancel");
  await dlg.getByTestId("recover-restore").click();
  await answer(page, P1);
  await poll(async () => (await cell("B1").innerText()).trim() === "7731", "P1 restores the edit", 20_000);
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  await dlg.locator('[data-testid="sheet-status"]', { hasText: /^saved \/.* encrypted with your password/ }).waitFor({ timeout: 25_000 });
  const saved = await bytesOf(src); ok(isCfb(saved), "still encrypted");
  ok(!msoff(saved, P1).ok, "the draft's old password does NOT open the saved file");
  const s = msoff(saved, P2); ok(s.ok, `the file's current password P2 opens it: ${s.error}`);
  writeFileSync(join(tmp, "saved.xlsx"), readFileSync(s.file!));
  eq(xlsxCell(join(tmp, "saved.xlsx"), "B1"), "7731", "openpyxl reads the restored cell");
  eq(xlsxCell(join(tmp, "saved.xlsx"), "A1"), "1", "the original cell is kept");
  await poll(async () => !(await readNode(dp)), "Save deletes the draft", 20_000);
  await page.context().close();
});

for (const p of cleanup) await purge(p).catch(() => undefined);
await browser.close();
if (errors.length) console.log("page errors:", errors.slice(0, 5));
finish();
