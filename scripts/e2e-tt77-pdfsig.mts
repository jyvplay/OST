/**
 * TT77 e2e — PDF signatures in the real UI (Chromium 143 headless, live server):
 *  S1  a real-world qualified signature (corpus issue16553.pdf, BER-encoded CMS, PostSignum CA) shows "Signature
 *      valid", the signer's name, and the "Identity not verified" disclaimer; Details show the chain.
 *  S2  a pyHanko-signed file with an incremental update after signing shows "Valid · changed after signing";
 *      "Open signed version" opens exactly the signed revision, which then shows "Signature valid".
 *  S3  a tampered file shows "Invalid".
 *  S4  create a device identity in the UI → Sign → Ctrl+S → the saved bytes verify in pyHanko (intact, valid,
 *      ENTIRE_FILE) and the original bytes are an exact prefix; the panel then lists our signature as valid.
 *  S5  the identity survives a reload (IndexedDB) and is offered again.
 *  S6  modal-shortcut failure test: while the "New identity" dialog owns the keyboard, Ctrl+S and Ctrl+Z never
 *      reach the document (nothing saved, no undo).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt77-pdfsig.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { mkpdf } from "./tt52/mkpdf.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `s${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt77-pdfsig");
const COV = { "FF-03": "full", "PR-08": "full", "FF-66": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/pdf";
const tmp = mkdtempSync(join(tmpdir(), "e2e77-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/pdf", encoding: "base64" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8")); }
const pyValidate = (file: string) => JSON.parse(execFileSync(PY, ["scripts/oracle/pdfsig_oracle.py", "validate", file], { encoding: "utf8" }).trim().split("\n").pop()!).pyhanko as { field: string; intact: boolean; valid: boolean; coverage: string }[];

const fx = new Map<string, string>();
for (const l of execFileSync(PY, ["scripts/oracle/pdfsig_oracle.py", "make", tmp], { encoding: "utf8" }).trim().split("\n")) { const j = JSON.parse(l); fx.set(j.name, j.file); }

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openPdf(path: string, ctx?: BrowserContext) {
  await resetDesktop();
  const c = ctx ?? await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await c.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=pdf&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const app = page.locator('[data-testid="pdf-app"]').last();
  await app.locator('[data-testid="pdf-thumb"]').first().waitFor({ timeout: 30_000 });
  const sigTab = async () => { await app.locator('[data-testid="pdf-panel-sigs"]').click(); await app.locator('[data-testid="pdf-sigs"]').waitFor(); };
  const statuses = async () => { await app.locator('[data-testid="pdf-sigs"]').filter({ hasNotText: "Checking signatures" }).waitFor({ timeout: 20_000 }); return app.locator('[data-testid="pdf-sig"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-status"))); };
  return { ctx: c, page, app, sigTab, statuses, close: () => (ctx ? page.close() : c.close()) };
}

await test("S1 real-world BER qualified signature → valid, signer, identity disclaimer, chain", COV, async () => {
  const p = `/Documents/${RUN}-czech.pdf`; await upload(p, readFileSync(join(CORPUS, "issue16553.pdf")));
  const o = await openPdf(p); try {
    await o.sigTab(); const st = await o.statuses(); ok(JSON.stringify(st) === '["valid"]', `statuses ${st}`);
    const card = o.app.locator('[data-testid="pdf-sig"]').first(); const t = await card.innerText();
    ok(/MACHULDA/.test(t), `signer missing: ${t.slice(0, 200)}`); ok(/Identity not verified/.test(t), "trust disclaimer missing");
    await card.locator('[data-testid="pdf-sig-details"]').click(); const d = await card.innerText();
    ok(/PostSignum Qualified CA 4/.test(d) && /Document hash\s*matches/.test(d) && /revocation/.test(d), `details: ${d.slice(0, 400)}`);
    await o.page.screenshot({ path: `${SHOTS}/tt77-sig-valid.png` });
    ok(/Signatures \(1\)/.test(await o.app.locator('[data-testid="pdf-panel-sigs"]').innerText()), "tab count");
  } finally { await o.close(); }
});

await test("S2 changed after signing → 'modified'; Open signed version → that revision is valid", COV, async () => {
  const p = `/Documents/${RUN}-appended.pdf`; await upload(p, readFileSync(fx.get("appended")!));
  const o = await openPdf(p); try {
    await o.sigTab(); ok(JSON.stringify(await o.statuses()) === '["modified"]', "status");
    ok(/added after signing/.test(await o.app.locator('[data-testid="pdf-sig"]').innerText()), "appended size shown");
    await o.app.locator('[data-testid="pdf-sig-revision"]').click();
    await o.app.locator('[data-testid="pdf-sig"][data-status="valid"]').waitFor({ timeout: 20_000 });
    ok(/as signed/.test(await o.app.locator('[data-testid="pdf-status"]').innerText()), "status names the signed revision");
    await o.page.screenshot({ path: `${SHOTS}/tt77-sig-revision.png` });
  } finally { await o.close(); }
});

await test("S3 tampered → Invalid", COV, async () => {
  const p = `/Documents/${RUN}-tampered.pdf`; await upload(p, readFileSync(fx.get("tampered")!));
  const o = await openPdf(p); try { await o.sigTab(); ok(JSON.stringify(await o.statuses()) === '["invalid"]', "status"); ok(/Invalid/.test(await o.app.locator('[data-testid="pdf-sig-status"]').innerText()), "badge"); }
  finally { await o.close(); }
});

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const signedPath = `/Documents/${RUN}-contract.pdf`; const original = mkpdf([{ text: ["Contract", "Party A and Party B agree."] }]);
await upload(signedPath, original);

await test("S6 modal shortcut: Ctrl+S / Ctrl+Z inside the New-identity dialog never reach the document", COV, async () => {
  const o = await openPdf(signedPath, ctx); try {
    await o.sigTab(); await o.app.locator('[data-testid="pdf-sig-new"]').click();
    const ask = o.page.locator('[data-testid="ask-dialog"]'); await ask.waitFor(); const inp = ask.locator("input").first(); await inp.fill("Zed");
    await inp.press("Control+s"); await inp.press("Control+z"); await o.page.waitForTimeout(600);
    ok(!/Saved/.test(await o.app.locator('[data-testid="pdf-status"]').innerText()), "Ctrl+S saved through the dialog");
    ok((await inp.inputValue()) !== undefined, "dialog still open"); await ask.locator("input").first().press("Escape");
    const now = await readBytes(signedPath); ok(Buffer.from(now).equals(Buffer.from(original)), "file changed on disk");
  } finally { await o.close(); }
});

await test("S4 New identity → Sign → Ctrl+S → pyHanko intact+valid+ENTIRE_FILE; panel shows ours valid", COV, async () => {
  const o = await openPdf(signedPath, ctx); try {
    await o.sigTab(); ok(JSON.stringify(await o.statuses()) === "[]", "unsigned document lists no signatures");
    await o.app.locator('[data-testid="pdf-sig-new"]').click();
    const ask = o.page.locator('[data-testid="ask-dialog"]');
    await ask.waitFor(); await ask.locator("input").first().fill("Robin Tester"); await ask.locator("input").first().press("Enter");
    await ask.waitFor(); await ask.locator("input").first().fill("robin@example.org"); await ask.locator("input").first().press("Enter");
    await o.app.locator('[data-testid="pdf-sig-identity"]').filter({ hasText: "Robin Tester" }).waitFor({ timeout: 15_000 });
    await o.app.locator('[data-testid="pdf-sig-reason"]').fill("I approve this contract");
    await o.app.locator('[data-testid="pdf-sig-sign"]').click();
    await o.app.locator('[data-testid="pdf-sig"][data-status="valid"]').waitFor({ timeout: 20_000 });
    ok(/Robin Tester/.test(await o.app.locator('[data-testid="pdf-sig"]').innerText()), "our signer shown");
    await o.page.screenshot({ path: `${SHOTS}/tt77-sig-signed.png` });
    await o.app.locator('[data-testid="pdf-stage"]').click({ position: { x: 5, y: 5 } }); await o.page.keyboard.press("Control+s");
    await o.app.locator('[data-testid="pdf-status"]').filter({ hasText: /Saved/ }).waitFor({ timeout: 15_000 });
    const saved = await readBytes(signedPath); ok(saved.length > original.length && Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original)), "original bytes are a prefix");
    const f = join(tmp, "ui-signed.pdf"); writeFileSync(f, saved); const ph = pyValidate(f);
    ok(ph.length === 1 && ph[0].intact && ph[0].valid && ph[0].coverage === "ENTIRE_FILE", `pyHanko: ${JSON.stringify(ph)}`);
  } finally { await o.close(); }
});

await test("S5 the identity survives a reload (IndexedDB) and the saved file re-validates in the UI", COV, async () => {
  const o = await openPdf(signedPath, ctx); try {
    await o.sigTab(); ok(JSON.stringify(await o.statuses()) === '["valid"]', "saved signature valid after reload");
    ok(/I approve this contract/.test(await o.app.locator('[data-testid="pdf-sig"]').innerText()), "reason kept");
    await o.app.locator('[data-testid="pdf-sig-identity"] option', { hasText: "Robin Tester" }).first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
    const opts = await o.app.locator('[data-testid="pdf-sig-identity"] option').allInnerTexts(); ok(opts.some((t) => /Robin Tester/.test(t)), `identities ${opts}`);
  } finally { await o.close(); }
});
await ctx.close();
await test("S7 no page errors", COV, () => { ok(!errors.length, errors.slice(0, 3).join(" | ")); });
await browser.close();
// hygiene: remove everything this run wrote under /Documents (files and folders named with this run's prefix) so the
// next suites (the tabletop draws every Documents file as a card) see the same desk every time
{
  const l = await fetch(`${BASE}/api/fs?op=list&path=%2FDocuments`).then((r) => r.json()).catch(() => ({})) as { nodes?: { name: string; path: string }[] };
  for (const n of l.nodes ?? []) if (n.name.startsWith(RUN)) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
}
finish();
