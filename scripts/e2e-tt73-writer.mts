/**
 * TT73 real-browser suite: Writer header / footer PICTURES through the Header & footer panel (Playwright + headless
 * Chromium 143 against the production server). Real clicks and file input → the paged view (every page box draws the
 * picture) → Undo / Redo → Save → bytes checked by python-docx (scripts/oracle/docx_hf.py + the part's own rels).
 *  1. a typed-but-unapplied line is applied first, then the picture becomes a locked "picture" line; every page shows
 *     it; Undo removes it from every page, Redo restores it; the saved file has it in header1.xml.rels (python-docx)
 *  2. refusals: an SVG and an oversized PNG are refused with a visible reason and change nothing
 *     and the body starts below the (taller than the margin) header on the page, as in Word
 *  3. modal shortcut: while a panel line input has focus, Ctrl+Z is the input's own undo — the document's picture stays
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt73-writer.mts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t73w${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt73-writer");
const COV = { "FF-22": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e73w-"));
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8")); }
/** input files made by python (Pillow / python-docx); the assertions use the DOM and the oracles */
function longDoc(): Uint8Array {
  const f = join(tmp, "long.docx");
  execFileSync(PY, ["-c", `import docx,sys\nd=docx.Document()\nfor i in range(90): d.add_paragraph(f"Paragraph {i+1}: " + "lorem ipsum dolor sit amet " * 6)\nd.save(sys.argv[1])`, f]);
  return new Uint8Array(readFileSync(f));
}
const logo = join(tmp, "logo.png");
execFileSync(PY, ["-c", `from PIL import Image,ImageDraw\nim=Image.new("RGB",(240,80),(56,189,248))\nImageDraw.Draw(im).ellipse((10,10,70,70),fill=(251,191,36))\nim.save("${logo}")`]);
const big = join(tmp, "big.png");
execFileSync(PY, ["-c", `import os\nfrom PIL import Image\nim=Image.frombytes("RGB",(1800,1200),os.urandom(1800*1200*3))\nim.save("${big}")`]);
const svg = join(tmp, "logo.svg"); writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** python-docx: the default header's paragraphs' text and the sha256 of every image its part relates to */
const pyHeader = (bytes: Uint8Array, name: string) => { const f = join(tmp, name); writeFileSync(f, bytes); return JSON.parse(execFileSync(PY, ["-c", `import docx,sys,json,hashlib
d=docx.Document(sys.argv[1]); h=d.sections[-1].header
print(json.dumps({"linked": h.is_linked_to_previous, "text": [p.text for p in h.paragraphs], "images": [hashlib.sha256(r.target_part.blob).hexdigest() for r in h.part.rels.values() if r.reltype.endswith("/image")] if not h.is_linked_to_previous else []}))`, f], { encoding: "utf8" })) as { linked: boolean; text: string[]; images: string[] }; };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openWriter(path: string): Promise<{ page: Page; dlg: Locator; panel: Locator; close: () => Promise<void> }> {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first();
  await dlg.waitFor({ state: "visible", timeout: 25_000 });
  await dlg.locator('[data-testid="writer-body"] [data-pid]').first().waitFor({ timeout: 25_000 });
  await dlg.getByRole("button", { name: "Header & footer", exact: true }).click();
  const panel = dlg.locator('[data-testid="hf-panel"]'); await panel.waitFor();
  return { page, dlg, panel, close: () => ctx.close() };
}
const headerImgs = async (dlg: Locator) => dlg.locator(".wpage").evaluateAll((ps) => ps.map((p) => p.querySelectorAll(".whdr img").length));
async function save(dlg: Locator) {
  const b = dlg.locator('[data-testid="writer-save"]');
  await dlg.locator('[data-testid="writer-save"]', { hasText: "Save •" }).waitFor({ timeout: 5_000 });
  await b.click();
  await dlg.page().waitForFunction((el) => el?.textContent === "Save", await b.elementHandle(), { timeout: 15_000 });
  await dlg.locator('[data-testid="writer-status"]', { hasText: "Saved" }).waitFor({ timeout: 15_000 });
}

await test("header picture through the panel: the typed line is applied first, the picture becomes a locked 'picture' line, every page draws it, Undo / Redo move it on every page, and the saved file has it in the header part's own rels (python-docx sees the exact bytes)", COV, async () => {
  const path = `/Documents/${RUN}-logo.docx`; await upload(path, longDoc());
  const { page, dlg, panel, close } = await openWriter(path);
  await panel.getByRole("button", { name: "Add line" }).click();
  await panel.locator('[data-testid="hf-line"] input').first().fill("Acme Ltd — letterhead");
  await panel.locator('[data-testid="hf-picture-input"]').setInputFiles(logo);
  await panel.locator('[data-testid="hf-line"]', { hasText: "picture" }).waitFor({ timeout: 5_000 });
  const lines = await panel.locator('[data-testid="hf-line"]').count();
  ok(lines === 2, `panel lines ${lines}`);
  ok((await panel.locator('[data-testid="hf-line"] input').first().inputValue()) === "Acme Ltd — letterhead", "typed line lost");
  await page.waitForTimeout(500);
  const imgs = await headerImgs(dlg); ok(imgs.length >= 2 && imgs.every((n) => n === 1), `header pictures per page ${JSON.stringify(imgs)}`);
  const box = await dlg.locator(".wpage .whdr img").first().boundingBox(); ok(box && box.height > 10 && Math.abs(box.width / box.height - 3) < 0.05, `picture box ${JSON.stringify(box)} (240×80 logo, view zoom applies)`);
  // Word's rule: a header taller than the top margin pushes the body down — the body never runs under the logo
  const hb = await dlg.locator('.wpage[data-page="1"] .whdr').boundingBox(); const bb = await dlg.locator('[data-testid="writer-body"] [data-pid]').first().boundingBox();
  ok(hb && bb && bb.y >= hb.y + hb.height - 1, `body top ${bb?.y} overlaps the header (bottom ${hb ? hb.y + hb.height : "?"})`);
  await dlg.getByRole("button", { name: "Undo", exact: true }).click(); await page.waitForTimeout(400);
  const undone = await headerImgs(dlg); ok(undone.every((n) => n === 0), `after Undo ${JSON.stringify(undone)}`);
  await dlg.getByRole("button", { name: "Redo", exact: true }).click(); await page.waitForTimeout(400);
  const redone = await headerImgs(dlg); ok(redone.every((n) => n === 1), `after Redo ${JSON.stringify(redone)}`);
  await save(dlg);
  const o = pyHeader(await readBytes(path), "logo-saved.docx");
  const ext = execFileSync(PY, ["-c", "import zipfile,sys,re\nz=zipfile.ZipFile(sys.argv[1])\nprint(';'.join(re.findall(r'<wp:extent cx=\"(\\d+)\" cy=\"(\\d+)\"', z.read([n for n in z.namelist() if re.match(r'word/header\\d+\\.xml$', n)][0]).decode())[0]))", join(tmp, "logo-saved.docx")], { encoding: "utf8" }).trim();
  ok(ext === "2286000;762000", `saved extent ${ext} (want 240×80 px = 2286000×762000 EMU: natural size, under the one-inch cap)`);
  ok(!o.linked && o.text.includes("Acme Ltd — letterhead") && o.images.length === 1 && o.images[0] === sha(new Uint8Array(readFileSync(logo))), `python-docx header ${JSON.stringify(o)}`);
  await close();
});

await test("refusals: an SVG and a PNG over 5 MB are refused with a visible reason; no picture is added and the document stays clean", COV, async () => {
  const path = `/Documents/${RUN}-refuse.docx`; await upload(path, longDoc());
  const { page, dlg, panel, close } = await openWriter(path);
  await panel.locator('[data-testid="hf-picture-input"]').setInputFiles(svg);
  await panel.locator('[data-testid="hf-refusal"]').waitFor({ timeout: 5_000 });
  ok(/PNG, JPEG or GIF/.test(await panel.locator('[data-testid="hf-refusal"]').innerText()), "SVG refusal text");
  const sz = readFileSync(big).length; ok(sz > 5 * 1024 * 1024, `big.png is only ${sz} bytes`);
  await panel.locator('[data-testid="hf-picture-input"]').setInputFiles(big); await page.waitForTimeout(600);
  ok(/5 MB/.test(await panel.locator('[data-testid="hf-refusal"]').innerText()), "oversize refusal text");
  const imgs = await headerImgs(dlg); ok(imgs.every((n) => n === 0), `pictures after refusals ${JSON.stringify(imgs)}`);
  ok((await dlg.locator('[data-testid="writer-save"]').innerText()).trim() === "Save", "document became dirty after refusals");
  await close();
});

await test("modal shortcut: while a header line input has focus, Ctrl+Z is the input's own undo — the document's header picture and body stay", COV, async () => {
  const path = `/Documents/${RUN}-modal.docx`; await upload(path, longDoc());
  const { page, dlg, panel, close } = await openWriter(path);
  await panel.locator('[data-testid="hf-picture-input"]').setInputFiles(logo);
  await panel.locator('[data-testid="hf-line"]', { hasText: "picture" }).waitFor({ timeout: 5_000 });
  await panel.getByRole("button", { name: "Add line" }).click();
  const input = panel.locator('[data-testid="hf-line"] input').last();
  await input.click(); await page.keyboard.type("draft");
  await page.keyboard.press("Control+z"); await page.waitForTimeout(400);
  const imgs = await headerImgs(dlg); ok(imgs.every((n) => n === 1), `Ctrl+Z in the panel reached the document: ${JSON.stringify(imgs)}`);
  ok(await input.evaluate((el) => document.activeElement === el), "focus left the panel input");
  ok(await panel.locator('[data-testid="hf-line"]', { hasText: "picture" }).count() === 1, "the picture line vanished from the panel");
  await close();
});

await test("cleanup + no page errors", COV, async () => {
  ok(!errors.length, `page errors: ${errors.join(" | ")}`);
  const list = await api("GET", `/api/fs?op=list&path=${encodeURIComponent("/Documents")}`);
  for (const n of (list.json.nodes ?? []) as { path: string }[]) if (n.path.includes(RUN)) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
});

await browser.close();
await finish();
