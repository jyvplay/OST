/**
 * TT61 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-43 Writer note editing keeps formatting: a footnote with bold / italic / underlined runs (written by lxml) is edited
 *         in the Notes panel; the saved bytes are read by the independent lxml probe (docx_noteruns.py) — the bold and
 *         italic words keep their formatting, the edit is exact, the reference mark leads the note
 *   FF-42 completion: a header misspelling is underlined ON THE PAGE (a spelling highlight range inside the page header
 *         box, on every page that shows the header) — before TT61 only the pane listed it
 *   FF-44 Writer cell revisions: w:cellIns / w:cellDel markers (written by lxml) are listed as "[Table cell]" in the Review
 *         pane; Accept on the deletion removes the cell from the page; Reject All on the rest; the saved file is checked
 *         by the oracle (docx_tblrev.py: tables, grid_ok, no markers left)
 * Ground truth: saved bytes read back through /api/fs and parsed by lxml / python-docx — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt61.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { blankWord, readWord, writeWord, allParas, rowsOf, cellsOf } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t61${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e61-"));
const { test, finish } = makeHarness("e2e-tt61");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Second" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const upload = async (path: string, bytes: Uint8Array) => { const up = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: DOCX }); ok(up.status === 200, "upload " + path); };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
async function openWriter(path: string) {
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 30_000 });
  const body = dlg.getByTestId("writer-body"); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  return { page, dlg, body };
}
const views = (await api("GET", "/api/settings")).json.rows as { key: string; value: string }[];
const prevView = views.find((r) => r.key === "appearance.desktopView")?.value ?? "classic";
await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });

await test("FF-43 Writer: editing a formatted footnote in the Notes panel keeps its bold / italic / underline (lxml reads the saved runs); the edit is exact and the reference mark still leads", { "FF-43": "full" }, async () => {
  const d = await blankWord("n"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Claim.");
  E.insertNote(d, { pid: p0.id, off: 6 }, "footnote", "placeholder");
  const plain = join(tmp, "plain.docx"), rich = join(tmp, "rich.docx");
  writeFileSync(plain, await writeWord(d));
  execFileSync(PY, ["scripts/oracle/docx_noteruns.py", "format", plain, rich]);
  const path = `/Documents/${RUN}-note.docx`; await upload(path, new Uint8Array(readFileSync(rich)));
  const { page, dlg } = await openWriter(path);
  await dlg.getByRole("button", { name: "Notes", exact: true }).click();
  const fn1 = dlg.getByTestId("writer-notes").getByLabel("Footnote 1 text");
  eq(await fn1.inputValue(), "See Smith in Journal of Tests, 2026.\nSecond line here.", "panel text");
  await fn1.fill("See Smithson in the Journal of Tests, 2025.\nSecond line here.");
  await fn1.press("Control+Enter");
  await dlg.getByTestId("writer-status").filter({ hasText: "Footnote updated" }).waitFor();
  ok(!/plain text/.test(await dlg.getByTestId("writer-status").innerText()), "no plain-text fallback reported");
  await page.screenshot({ path: "docs/screens/tt61-writer-note-formatting.png" });
  await dlg.getByTestId("writer-body").locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const f = join(tmp, "note-out.docx"); writeFileSync(f, await read(path));
  const pr = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_noteruns.py", "probe", f], { encoding: "utf8" })).footnote["1"];
  eq(pr[0].runs, [[" See ", false, false, false], ["Smithson", true, false, false], [" in the ", false, false, false], ["Journal of Tests", false, true, false], [", 2025.", false, false, false]], "P1 runs (lxml)");
  eq(pr[1].runs, [["Second ", false, false, false], ["line", false, false, true], [" here.", false, false, false]], "P2 runs (lxml)");
  ok(pr[0].ref && pr[0].refFirst, "reference mark leads");
  await page.context().close();
});

await test("FF-42 completion: a header misspelling is underlined on the page itself — a spelling highlight range lies inside the page header box on every page (2 pages), and disappears after Change", { "FF-42": "full" }, async () => {
  const fx = join(tmp, "hdr.docx");
  execFileSync(PY, ["-c", `import docx
from docx.enum.text import WD_BREAK
d = docx.Document(); d.add_paragraph("Body text is fine.")
d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
d.add_paragraph("Second page.")
d.sections[0].header.paragraphs[0].add_run("Quarterly headr")
d.save("${fx}")`]);
  const path = `/Documents/${RUN}-hdr.docx`; await upload(path, new Uint8Array(readFileSync(fx)));
  const { page, dlg } = await openWriter(path);
  await poll(async () => Number(await dlg.locator(".wdoc").getAttribute("data-spell-issues")) === 1, "1 issue (the header)", 25_000);
  const marks = () => page.evaluate(() => {
    const h = (globalThis as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights.get("fusion-spell");
    const out: { text: string; page: string | null; inHeader: boolean }[] = [];
    for (const r of h ?? []) { const el = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement) as Element; out.push({ text: r.toString(), page: el.closest("[data-page]")?.getAttribute("data-page") ?? null, inHeader: !!el.closest(".whdr") }); }
    return out;
  });
  await poll(async () => (await marks()).length === 2, "two marks (one per page header)", 15_000);
  const m = await marks();
  eq(m.map((x) => [x.text, x.inHeader]), [["headr", true], ["headr", true]], "marked in the header boxes");
  eq(m.map((x) => x.page).sort(), ["1", "2"], "on both pages");
  await page.screenshot({ path: "docs/screens/tt61-writer-header-underline.png" });
  await dlg.getByTestId("writer-body").locator("p[data-pid]").first().click(); await page.keyboard.press("F7");
  const pane = dlg.getByTestId("writer-spell-panel"); await pane.waitFor();
  await poll(async () => /in Header/.test(await pane.getByTestId("spell-count").innerText()), "header issue in pane");
  await pane.getByLabel("Change to").fill("header"); await pane.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => (await marks()).length === 0, "marks gone after the fix", 15_000);
  await page.context().close();
});

await test("FF-44 Writer cell revisions in the UI: lxml-written cellIns / cellDel listed as [Table cell]; Accept the deletion removes the cell on the page; Reject All removes the inserted cell; saved file passes the oracle (tables, grid_ok, no markers)", { "FF-44": "full" }, async () => {
  const d = await blankWord("c"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Cells below.");
  const t = E.insertTableAfter(d, p0.id, 2, 3)!;
  rowsOf(t).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `R${ri}C${ci}`)));
  const a = join(tmp, "cells.docx"), b = join(tmp, "cells-m.docx"); writeFileSync(a, await writeWord(d));
  execFileSync(PY, ["scripts/oracle/docx_tblrev.py", "markcells", a, b, "0,0,1,del,701", "0,1,2,ins,702"]);
  const path = `/Documents/${RUN}-cells.docx`; await upload(path, new Uint8Array(readFileSync(b)));
  const { page, dlg, body } = await openWriter(path);
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  const items = dlg.getByTestId("writer-changes").locator("[role=listitem]").filter({ hasText: "[Table cell]" });
  await poll(async () => (await items.count()) === 2, "two cell changes listed");
  eq(await body.locator("td.wcell-del").allInnerTexts(), ["R0C1"], "the deleted cell is tinted on the page");
  eq(await body.locator("td.wcell-ins").allInnerTexts(), ["R1C2"], "the inserted cell is tinted on the page");
  await page.screenshot({ path: "docs/screens/tt61-writer-cell-revisions.png" });
  await items.filter({ hasText: "Deleted" }).first().getByRole("button", { name: /^Accept/ }).click();
  await poll(async () => (await body.locator("td").filter({ hasText: /^R0C1$/ }).count()) === 0, "accepted deletion: the cell is gone from the page");
  await poll(async () => (await items.count()) === 1, "one cell change left");
  await items.first().getByRole("button", { name: /^Reject/ }).click();
  await poll(async () => (await body.locator("td").filter({ hasText: /^R1C2$/ }).count()) === 0, "rejected insertion: the cell is gone");
  await body.locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const f = join(tmp, "cells-out.docx"); writeFileSync(f, await read(path));
  const o = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", f], { encoding: "utf8" }));
  eq(o.tables, [[["R0C0", "R0C2"], ["R1C0", "R1C1"]]], "python-docx tables");
  ok(o.grid_ok && o.tcpr_ok && o.order_ok && o.opens === true, `oracle soundness ${JSON.stringify([o.grid_errors, o.tcpr_errors, o.order_errors, o.opens])}`);
  eq(o.cells, [], "no markers left");
  await page.context().close();
});

await test("no page errors during the suite", { "FF-43": "full" }, async () => { eq(errors, [], "page errors"); });

await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
await browser.close();
finish();
