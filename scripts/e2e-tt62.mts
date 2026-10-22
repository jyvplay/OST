/**
 * TT62 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-44 completion — Writer vertical-merge revisions (w:cellMerge, ECMA-376 §17.13.5.3) written by lxml
 *   (docx_tblrev.py markcells … merge:NEW:ORIG) show the proposed merge on the page (a td spanning 2 rows), are listed as
 *   "[Table cell merge]" with a detail naming both states, and resolve: Reject on each puts the cells back unmerged; Accept
 *   all keeps the merge. Ground truth: saved bytes read back through /api/fs and parsed by the lxml oracle
 *   (docx_tblrev.py vmerges / tcpr_ok) and the ECMA-376 XSD oracle (ooxml_xsd.py) — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt62.mts
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
const RUN = `t62${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e62-"));
const { test, finish } = makeHarness("e2e-tt62");
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

async function mergeDoc(name: string) {
  const d = await blankWord("m"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Merge review below.");
  const t = E.insertTableAfter(d, p0.id, 3, 2)!;
  rowsOf(t).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `R${ri}C${ci}`)));
  const a = join(tmp, `${name}.docx`), b = join(tmp, `${name}-m.docx`); writeFileSync(a, await writeWord(d));
  execFileSync(PY, ["scripts/oracle/docx_tblrev.py", "markcells", a, b, "0,0,0,merge:rest:none,801", "0,1,0,merge:cont:none,802"]);
  const path = `/Documents/${RUN}-${name}.docx`; await upload(path, new Uint8Array(readFileSync(b)));
  return path;
}
async function saveAndRead(page: Page, dlg: ReturnType<Page["locator"]>, body: ReturnType<Page["locator"]>, path: string, name: string) {
  await body.locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const f = join(tmp, `${name}-out.docx`); writeFileSync(f, await read(path));
  const vm = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", "vmerges", f, "asis"], { encoding: "utf8" }));
  const o = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", f], { encoding: "utf8" }));
  const x = JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", f], { encoding: "utf8" }))[f];
  return { vm, o, x };
}

await test("FF-44 Writer vertical-merge revisions in the UI: the proposed merge is drawn (rowspan 2), both cellMerge changes are listed with their states; Reject each → cells unmerged on the page and in the saved file (lxml oracle + XSD)", { "FF-44": "full" }, async () => {
  const path = await mergeDoc("vmrej");
  const { page, dlg, body } = await openWriter(path);
  await poll(async () => (await body.locator('td[rowspan="2"]').count()) === 1, "the proposed merge is drawn: one cell spans two rows");
  eq((await body.locator('td[rowspan="2"]').innerText()).trim().split(/\s+/)[0], "R0C0", "the restart cell spans");
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  const items = dlg.getByTestId("writer-changes").locator("[role=listitem]").filter({ hasText: "[Table cell merge]" });
  await poll(async () => (await items.count()) === 2, "two merge changes listed");
  const details = await dlg.getByTestId("writer-changes").getByTestId("writer-change-detail").allInnerTexts();
  ok(details.some((t) => /starts a vertical merge \(was: not merged\)/.test(t)) && details.some((t) => /continues the merge above \(was: not merged\)/.test(t)), "details: " + details);
  eq(await items.locator("b").allInnerTexts(), ["Cell merge", "Cell merge"], "merge changes are labelled as such");
  await page.screenshot({ path: "docs/screens/tt62-writer-cell-merge.png" });
  await items.first().getByRole("button", { name: /^Reject/ }).click();
  await poll(async () => (await items.count()) === 1, "one merge change left");
  await items.first().getByRole("button", { name: /^Reject/ }).click();
  await poll(async () => (await items.count()) === 0, "no merge change left");
  await poll(async () => (await body.locator("td[rowspan]").count()) === 0 && (await body.locator("td").filter({ hasText: /^R1C0$/ }).count()) === 1, "unmerged on the page: R1C0 visible again");
  const { vm, o, x } = await saveAndRead(page, dlg, body, path, "vmrej");
  eq(vm, { tables: [[[null, null], [null, null], [null, null]]], cellMerge: 0 }, "saved: no vertical merge, no marker");
  ok(o.tcpr_ok && o.opens === true, `oracle ${JSON.stringify([o.tcpr_errors, o.opens])}`);
  ok(x.ok, "XSD " + JSON.stringify(x.parts).slice(0, 400));
  await page.context().close();
});

await test("FF-44: Accept all on the same proposal keeps the merge — saved file has restart / continue and no marker (lxml oracle + XSD); the page still spans", { "FF-44": "full" }, async () => {
  const path = await mergeDoc("vmacc");
  const { page, dlg, body } = await openWriter(path);
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  const items = dlg.getByTestId("writer-changes").locator("[role=listitem]").filter({ hasText: "[Table cell merge]" });
  await poll(async () => (await items.count()) === 2, "two merge changes listed");
  await dlg.getByRole("button", { name: "Accept all", exact: true }).click();
  await poll(async () => (await items.count()) === 0, "accepted");
  eq(await body.locator('td[rowspan="2"]').count(), 1, "still spans on the page");
  const { vm, x } = await saveAndRead(page, dlg, body, path, "vmacc");
  eq(vm, { tables: [[["restart", null], ["continue", null], [null, null]]], cellMerge: 0 }, "saved: merge kept, marker gone");
  ok(x.ok, "XSD " + JSON.stringify(x.parts).slice(0, 400));
  await page.context().close();
});

await test("no page errors during the suite", { "FF-44": "full" }, async () => { eq(errors, [], "page errors"); });
await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
await browser.close();
await finish();
