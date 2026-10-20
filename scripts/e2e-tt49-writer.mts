/**
 * TT49 real-browser suite for Writer HEADER & FOOTER editing (Playwright + headless Chromium 143 against the production
 * server). Real clicks/typing in the Header & footer panel → the paged view (per-page numbers drawn from the live PAGE /
 * NUMPAGES fields) → Save → bytes checked by python-docx (scripts/oracle/docx_hf.py, independent of our reader).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt49-writer.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `hf${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt49-writer");
const COV = { "FF-22": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/docx";
const tmp = mkdtempSync(join(tmpdir(), "e2e49w-"));
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8")); }
type Para = { text: string; align: string | null; fields: string[]; pictures: number };
type Slot = { linked: boolean; paras?: Para[] };
const hf = (bytes: Uint8Array, name: string) => { const f = join(tmp, name); writeFileSync(f, bytes); const o = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/docx_hf.py", f], { encoding: "utf8" }).trim()); ok(!o.error, `python-docx: ${o.error}`); return o.sections.at(-1) as { firstPage: boolean; header: Slot; footer: Slot; firstHeader: Slot; firstFooter: Slot }; };

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
const pagesOf = async (dlg: Locator) => Number((await dlg.locator('[data-testid="writer-pages"]').innerText()).replace(/\D+/g, ""));
const pageTexts = async (dlg: Locator, cls: "whdr" | "wftr") => dlg.locator(`.wpage`).evaluateAll((ps, c) => ps.map((p) => (p.querySelector(`.${c}`) as HTMLElement | null)?.innerText.trim() ?? null), cls);
/** the status may still read "Saved" from an earlier save — wait for the dirty marker to clear instead */
async function save(dlg: Locator) {
  const b = dlg.locator('[data-testid="writer-save"]');
  await dlg.locator('[data-testid="writer-save"]', { hasText: "Save •" }).waitFor({ timeout: 5_000 });
  await b.click();
  await dlg.page().waitForFunction((el) => el?.textContent === "Save", await b.elementHandle(), { timeout: 15_000 });
  await dlg.locator('[data-testid="writer-status"]', { hasText: "Saved" }).waitFor({ timeout: 15_000 });
}
/** a multi-page document with no header/footer, generated by python-docx (input only — assertions use the oracle / DOM) */
function longDoc(): Uint8Array {
  const f = join(tmp, "long.docx");
  execFileSync(PY, ["-c", `import docx,sys\nd=docx.Document()\nfor i in range(90): d.add_paragraph(f"Paragraph {i+1}: " + "lorem ipsum dolor sit amet " * 6)\nd.save(sys.argv[1])`, f]);
  return new Uint8Array(readFileSync(f));
}

await test("add a footer 'Page {PAGE} of {NUMPAGES}' and a header through the panel: every page box draws its own number; saved file → python-docx sees live PAGE/NUMPAGES fields", COV, async () => {
  const path = `/Documents/${RUN}-long.docx`; await upload(path, longDoc());
  const { page, dlg, panel, close } = await openWriter(path);
  const n = await pagesOf(dlg); ok(n >= 3, `pages=${n}`);
  eq(await dlg.locator(".wpage .whdr").count(), 0, "no header before");
  ok((await panel.innerText()).includes("has no header yet"), "empty-state hint");
  await panel.getByRole("button", { name: "Add line" }).click();
  const l1 = panel.getByLabel("header line 1", { exact: true }); await l1.fill("Quarterly report");
  await panel.getByLabel("header line 1 alignment").selectOption("right");
  await panel.getByRole("button", { name: "Apply header" }).click();
  await panel.getByRole("tab", { name: "Footer" }).click();
  await panel.getByRole("button", { name: "Add line" }).click();
  const f1 = panel.getByLabel("footer line 1", { exact: true }); await f1.fill("Page ");
  await f1.press("End"); await panel.getByRole("button", { name: "Insert page number" }).click();
  await f1.press("End"); await f1.pressSequentially(" of "); await panel.getByRole("button", { name: "Insert page count" }).click();
  eq(await f1.inputValue(), "Page {PAGE} of {NUMPAGES}", "panel text");
  await panel.getByLabel("footer line 1 alignment").selectOption("center");
  await panel.getByRole("button", { name: "Apply footer" }).click();
  await page.waitForTimeout(500);
  const N = await pagesOf(dlg);
  eq(await pageTexts(dlg, "wftr"), Array.from({ length: N }, (_, i) => `Page ${i + 1} of ${N}`), "footer per page");
  eq(await pageTexts(dlg, "whdr"), Array.from({ length: N }, () => "Quarterly report"), "header per page");
  eq(await dlg.locator(".wpage .wftr p").first().evaluate((e) => getComputedStyle(e).textAlign), "center", "footer centred");
  eq(await dlg.locator(".wpage .whdr p").first().evaluate((e) => getComputedStyle(e).textAlign), "right", "header right-aligned");
  await save(dlg);
  const s = hf(await readBytes(path), "long-saved.docx");
  eq(s.footer.paras?.map((p) => [p.text, p.fields.join(), p.align?.split(" ")[0]]), [["Page 1 of 1", "PAGE,NUMPAGES", "CENTER"]], "oracle footer");
  eq(s.header.paras?.map((p) => [p.text, p.align?.split(" ")[0]]), [["Quarterly report", "RIGHT"]], "oracle header");
  await close();
});

await test("edit a real Word header (POI bug57031.docx): the change shows on every page, Undo restores the original on the pages AND in the panel, the saved file keeps the other header lines", COV, async () => {
  const path = `/Documents/${RUN}-57031.docx`; await upload(path, new Uint8Array(readFileSync(join(CORPUS, "bug57031.docx"))));
  const { page, dlg, panel, close } = await openWriter(path);
  const before = await pageTexts(dlg, "whdr"); ok(before.length >= 2 && before.every((t) => t !== null), `headers ${before}`);
  const input = panel.locator('[data-testid="hf-line"] input').first(); const orig = await input.inputValue();
  await input.fill("Edited header {PAGE}"); await panel.getByRole("button", { name: "Apply header" }).click(); await page.waitForTimeout(400);
  const after = await pageTexts(dlg, "whdr");
  ok(after.every((t, i) => t!.includes(`Edited header ${i + 1}`)), `per-page edited headers ${JSON.stringify(after)}`);
  await dlg.getByRole("button", { name: "Undo", exact: true }).click(); await page.waitForTimeout(400);
  eq(await pageTexts(dlg, "whdr"), before, "undo restores the page headers");
  eq(await input.inputValue(), orig, "undo restores the panel line");
  await input.fill("Edited header {PAGE}"); await panel.getByRole("button", { name: "Apply header" }).click();
  await save(dlg);
  const o0 = hf(new Uint8Array(readFileSync(join(CORPUS, "bug57031.docx"))), "57031-orig.docx"), o1 = hf(await readBytes(path), "57031-saved.docx");
  eq(o1.header.paras![0].text, "Edited header 1", "oracle edited line"); eq(o1.header.paras![0].fields, ["PAGE"], "PAGE field");
  eq(o1.header.paras!.slice(1), o0.header.paras!.slice(1), "other header lines unchanged");
  eq(o1.footer, o0.footer, "footer unchanged");
  await close();
});

await test("different first page: the checkbox adds First-page tabs; page 1 draws the cover header, later pages the default header; python-docx agrees after save; unticking restores", COV, async () => {
  const path = `/Documents/${RUN}-first.docx`; await upload(path, longDoc());
  const { page, dlg, panel, close } = await openWriter(path);
  await panel.getByRole("button", { name: "Add line" }).click(); await panel.getByLabel("header line 1", { exact: true }).fill("Running head");
  await panel.getByRole("button", { name: "Apply header" }).click();
  await panel.getByLabel("Different first page").check();
  await panel.getByRole("tab", { name: "First-page header" }).click();
  await panel.getByRole("button", { name: "Add line" }).click(); await panel.getByLabel("First-page header line 1", { exact: true }).fill("COVER");
  await panel.getByRole("button", { name: "Apply First-page header" }).click(); await page.waitForTimeout(400);
  const h = await pageTexts(dlg, "whdr"); eq(h[0], "COVER", "page 1"); ok(h.slice(1).every((t) => t === "Running head"), `later pages ${JSON.stringify(h)}`);
  await save(dlg);
  const s = hf(await readBytes(path), "first-saved.docx");
  ok(s.firstPage, "titlePg"); eq(s.firstHeader.paras?.map((p) => p.text), ["COVER"], "oracle first header"); eq(s.header.paras?.map((p) => p.text), ["Running head"], "oracle default header");
  await panel.getByLabel("Different first page").uncheck(); await page.waitForTimeout(400);
  ok((await pageTexts(dlg, "whdr")).every((t) => t === "Running head"), "unticked → default header everywhere");
  await close();
});

await test("locked content: a header line holding a picture is shown 'kept as is' (no input); adding a line beside it saves with the picture intact; Remove unlinks the header", COV, async () => {
  const file = "issue_51265_3.docx"; const src = new Uint8Array(readFileSync(join(CORPUS, file)));
  const path = `/Documents/${RUN}-pic.docx`; await upload(path, src);
  const { page, dlg, panel, close } = await openWriter(path);
  const rows = panel.locator('[data-testid="hf-line"]'); ok(await rows.count() >= 1, "rows");
  ok((await rows.first().innerText()).includes("kept as is"), `locked row: ${await rows.first().innerText()}`);
  eq(await rows.first().locator("input").count(), 0, "no input on a locked line");
  await panel.getByRole("button", { name: "Add line" }).click();
  const n = await rows.count(); await rows.nth(n - 1).locator("input").fill("Confidential");
  await panel.getByRole("button", { name: "Apply header" }).click(); await save(dlg);
  const o0 = hf(src, "pic-orig.docx"), o1 = hf(await readBytes(path), "pic-saved.docx");
  const pics = (s: Slot) => (s.paras ?? []).reduce((a, p) => a + p.pictures, 0);
  ok(pics(o0.header) >= 1 && pics(o1.header) === pics(o0.header), `pictures ${pics(o0.header)} → ${pics(o1.header)}`);
  eq(o1.header.paras!.at(-1)!.text, "Confidential", "added line");
  await panel.getByRole("button", { name: "Remove header", exact: true }).click(); await page.waitForTimeout(300);
  eq(await dlg.locator(".wpage .whdr").count(), 0, "no header drawn after Remove");
  await save(dlg); ok(hf(await readBytes(path), "pic-removed.docx").header.linked, "python-docx: header no longer referenced");
  await close();
});

await test("no page errors; uploads cleaned up", COV, async () => {
  eq(errors, [], "page errors");
  const list = await api("GET", "/api/fs?op=list&path=/Documents");
  for (const n of (list.json.nodes ?? []) as { path: string }[]) if (n.path.includes(RUN)) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
});

await browser.close();
await finish();
