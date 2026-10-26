/**
 * TT79 e2e — PDF signing with a PKCS#12 identity, visible signatures and the personal trust list, in the real UI
 * (Chromium 143 headless, live server). Fixtures: scripts/oracle/p12_oracle.py (cryptography) + OpenSSL -legacy.
 *  Q1  Import .p12: a wrong password is asked again ("Wrong password — try again"); modal-shortcut failure test —
 *      while the password dialog owns the keyboard, Ctrl+S and Delete never reach the document; the right password
 *      adds "Ada Signer (.p12 + 2 issuers)".
 *  Q2  page 2 → Visible, Bottom right → Sign → Ctrl+S: the saved file is valid AND trusted in pyHanko (root given),
 *      the widget sits on page 2 with a non-empty /Rect in the bottom-right quadrant; Fusion's own viewer draws it
 *      (ink inside the widget rectangle on the rendered page 2 — screenshot docs/screens/tt79-pdf-visible-sig.png).
 *  Q3  Details → "Trust this certificate" (the root) → "Identity trusted"; survives a reload; Remove → not verified.
 *  Q4  Add certificate… with an unrelated root → the signature says "Identity not verified — …" (untrusted, reason).
 *  Q5  no page errors.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { mkpdf } from "./tt52/mkpdf.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `q${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt79-pdf");
const COV = { "FF-73": "full", "FF-74": "full", "FF-75": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python";
const T = mkdtempSync(join(tmpdir(), "e2e79pdf-"));
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/pdf", encoding: "base64" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8")); }

execFileSync(PY, ["scripts/oracle/p12_oracle.py", "make", T]);
execFileSync("openssl", ["pkcs12", "-export", "-legacy", "-inkey", join(T, "leaf.key.pem"), "-in", join(T, "leaf.pem"), "-certfile", join(T, "chain.pem"), "-name", "ada", "-passout", "pass:open sesame", "-out", join(T, "ada.p12")], { stdio: "pipe" });
const docPath = `/Documents/${RUN}-agreement.pdf`;
const original = mkpdf([{ text: ["Agreement", "Page one"] }, { text: ["Page two", "Sign at the bottom right"] }]);
await upload(docPath, original);

const browser: Browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
async function openPdf() {
  await resetDesktop();
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=pdf&path=${encodeURIComponent(docPath)}`, { waitUntil: "domcontentloaded" });
  const app = page.locator('[data-testid="pdf-app"]').last();
  await app.locator('[data-testid="pdf-thumb"]').first().waitFor({ timeout: 30_000 });
  await app.locator('[data-testid="pdf-panel-sigs"]').click(); await app.locator('[data-testid="pdf-sigs"]').waitFor();
  const settled = () => app.locator('[data-testid="pdf-sigs"]').filter({ hasNotText: "Checking signatures" }).waitFor({ timeout: 20_000 });
  return { page, app, settled };
}

await test("Q1 Import .p12: wrong password asked again; Ctrl+S / Delete inert behind the dialog; identity with chain", COV, async () => {
  const { page, app } = await openPdf(); try {
    await app.locator('[data-testid="pdf-sig-import"]').setInputFiles(join(T, "ada.p12"));
    const ask = page.locator('[data-testid="ask-dialog"]'); await ask.waitFor();
    const inp = ask.locator("input").first(); await inp.fill("wrong");
    await inp.press("Control+s"); await inp.press("Delete"); await page.waitForTimeout(500);
    ok(!/Saved/.test(await app.locator('[data-testid="pdf-status"]').innerText()), "Ctrl+S saved through the dialog");
    ok(Buffer.from(await readBytes(docPath)).equals(Buffer.from(original)), "file changed on disk");
    await inp.fill("wrong"); await inp.press("Enter");
    await page.locator('[data-testid="ask-dialog"]', { hasText: "Wrong password" }).waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="ask-dialog"] input').first().fill("open sesame"); await page.locator('[data-testid="ask-dialog"] input').first().press("Enter");
    await app.locator('[data-testid="pdf-sig-identity"]').filter({ hasText: "Ada Signer (.p12 + 2 issuers)" }).waitFor({ timeout: 15_000 });
  } finally { await page.close(); }
});

let saved: Uint8Array = new Uint8Array(0);
await test("Q2 visible signature on page 2 → Ctrl+S → pyHanko valid + trusted; widget bottom-right of page 2; drawn by Fusion", COV, async () => {
  const { page, app, settled } = await openPdf(); try {
    await settled();
    await app.locator('[data-testid="pdf-page"]').nth(1).click({ position: { x: 30, y: 30 } }); // pointer-down on a page makes it current
    await app.locator('[data-testid="pdf-sig-visible"]').filter({ visible: true }).waitFor();
    ok(/page 2/.test(await app.locator('label', { has: page.locator('[data-testid="pdf-sig-visible"]') }).innerText()), "the visible option does not name page 2");
    await app.locator('[data-testid="pdf-sig-visible"]').check();
    await app.locator('[data-testid="pdf-sig-corner"]').selectOption("bottom-right");
    await app.locator('[data-testid="pdf-sig-identity"]').selectOption({ label: "Ada Signer (.p12 + 2 issuers)" });
    await app.locator('[data-testid="pdf-sig-reason"]').fill("Agreed");
    await app.locator('[data-testid="pdf-sig-sign"]').click();
    await app.locator('[data-testid="pdf-sig"][data-status="valid"]').waitFor({ timeout: 20_000 });
    ok((await app.locator('[data-testid="pdf-sig-trust"]').getAttribute("data-trust")) === "no-anchors", "trust before any anchor");
    await app.locator('[data-testid="pdf-stage"]').click({ position: { x: 5, y: 5 } }); await page.keyboard.press("Control+s");
    await app.locator('[data-testid="pdf-status"]').filter({ hasText: /Saved/ }).waitFor({ timeout: 15_000 });
    saved = await readBytes(docPath); const f = join(T, "ui-signed.pdf"); writeFileSync(f, saved);
    ok(Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original)), "original bytes are not a prefix");
    const ph = JSON.parse(execFileSync(PY, ["scripts/oracle/p12_oracle.py", "trust", f, join(T, "root.der")], { encoding: "utf8" }).trim());
    ok(ph.length === 1 && ph[0].intact && ph[0].valid && ph[0].trusted && ph[0].coverage === "ENTIRE_FILE", `pyHanko: ${JSON.stringify(ph)}`);
    const w = JSON.parse(execFileSync(PY, ["-c", `
import pikepdf, sys, json
p = pikepdf.open(sys.argv[1]); out = []
for i, pg in enumerate(p.pages):
    for a in pg.get("/Annots", []):
        if a.get("/FT") == "/Sig": out.append({"page": i, "rect": [float(x) for x in a.Rect], "box": [float(x) for x in pg.MediaBox], "ap": "/AP" in a})
print(json.dumps(out))`, f], { encoding: "utf8" }).trim());
    ok(w.length === 1 && w[0].page === 1 && w[0].ap, `widget: ${JSON.stringify(w)}`);
    const [x0, y0, x1, y1] = w[0].rect, [, , W, H] = w[0].box; ok(x0 > W / 2 && y1 < H / 2 && x1 - x0 > 100 && y1 - y0 > 40, `widget rect ${w[0].rect} not bottom-right of ${W}×${H}`);
    // Fusion's own renderer draws the appearance: the bottom-right of page 2 now has dark ink
    const canvas = app.locator('[data-testid="pdf-page"]').nth(1).locator("canvas").first();
    await canvas.scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
    const ink = await canvas.evaluate((c: HTMLCanvasElement, r: number[]) => {
      const g = c.getContext("2d")!; const sx = c.width / r[2], sy = c.height / r[3];
      const d = g.getImageData(Math.floor(r[0] * sx), Math.floor(c.height - r[4] * sy), Math.max(1, Math.floor((r[1] - r[0]) * sx)), Math.max(1, Math.floor((r[4] - r[5]) * sy))).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 300) n++; return n;
    }, [x0, x1, W, H, y1, y0]);
    ok(ink > 150, `Fusion's viewer drew only ${ink} dark pixels inside the widget`);
    // the canvas's own pixels (an element screenshot would be clipped by the window frame)
    const url = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL("image/png"));
    writeFileSync("docs/screens/tt79-pdf-visible-sig.png", Buffer.from(url.split(",")[1], "base64"));
  } finally { await page.close(); }
});

await test("Q3 Trust this certificate → Identity trusted; survives reload; Remove → not verified", COV, async () => {
  let o = await openPdf(); try {
    await o.settled(); const card = o.app.locator('[data-testid="pdf-sig"]').first();
    await card.locator('[data-testid="pdf-sig-details"]').click();
    await card.locator('[data-testid="pdf-sig-trust-cert"]').click();
    const ask = o.page.locator('[data-testid="ask-dialog"]'); await ask.waitFor(); ok(/TT79 Root CA/.test(await ask.innerText()), "confirm names the root");
    await ask.locator('[data-testid="ask-ok"]').click();
    await o.app.locator('[data-testid="pdf-sig-trust"][data-trust="trusted"]').waitFor({ timeout: 15_000 });
    ok(/TT79 Root CA/.test(await o.app.locator('[data-testid="pdf-sig-anchors"]').innerText()), "anchor not listed");
    await o.page.screenshot({ path: "docs/screens/tt79-pdf-trusted.png" });
  } finally { await o.page.close(); }
  o = await openPdf(); try {
    await o.app.locator('[data-testid="pdf-sig-trust"][data-trust="trusted"]').waitFor({ timeout: 15_000 });
    await o.app.locator('[data-testid="pdf-sig-anchor"]').first().getByRole("button", { name: /Stop trusting/ }).click();
    await o.page.locator('[data-testid="ask-ok"]').click();
    await o.app.locator('[data-testid="pdf-sig-trust"][data-trust="no-anchors"]').waitFor({ timeout: 15_000 });
  } finally { await o.page.close(); }
});

await test("Q4 Add certificate… (unrelated root) → untrusted with a reason", COV, async () => {
  const o = await openPdf(); try {
    await o.settled();
    await o.app.locator('[data-testid="pdf-sig-anchor-add"]').setInputFiles(join(T, "other_root.der"));
    await o.page.locator('[data-testid="ask-ok"]').click();
    const tr = o.app.locator('[data-testid="pdf-sig-trust"][data-trust="untrusted"]'); await tr.waitFor({ timeout: 15_000 });
    ok(/not verified — .*(not in your trusted list|no issuer)/.test(await tr.innerText()), `reason: ${await tr.innerText()}`);
    await o.app.locator('[data-testid="pdf-sig-anchor"]').first().getByRole("button", { name: /Stop trusting/ }).click(); await o.page.locator('[data-testid="ask-ok"]').click();
  } finally { await o.page.close(); }
});
await ctx.close();
await test("Q5 no page errors", COV, () => { ok(!errors.length, errors.slice(0, 3).join(" | ")); });
await browser.close();
finish();
void readFileSync;
