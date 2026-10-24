/**
 * TT65 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-49 Track Changes in every story through the UI: Track changes → Header & footer: edit a line → Apply → the page's
 *         header shows struck / inserted runs; an edit cutting into a page field is refused (alert, page unchanged) and
 *         Ctrl+Z then undoes the REAL last edit (the refused attempt leaves no phantom undo step), Ctrl+Y redoes it;
 *         Notes panel edit → "recorded as tracked changes"; Review lists Header / Footnote 1 items by place; rejecting
 *         the footnote items one by one and Accept all → Save → the saved bytes are checked by the independent lxml oracle
 *         (scripts/oracle/docx_stories.py: header = the edit, footnote = the original, no revision left, ids unique,
 *         python-docx opens) and the ECMA-376 XSDs.
 * Ground truth: saved bytes read back through /api/fs and parsed by lxml — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt65.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { blankWord, writeWord, readWord, allParas } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { setHf } from "../src/lib/office/hdrftr.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t65${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e65-"));
const { test, finish } = makeHarness("e2e-tt65");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
const upload = async (path: string, bytes: Uint8Array, mime: string) => { const up = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(up.status === 200, "upload " + path); };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const put = (b: Uint8Array, ext: string) => { const f = join(tmp, `o${Date.now()}${Math.random().toString(36).slice(2)}.${ext}`); writeFileSync(f, b); return f; };
type View = [string, string | null][];
type Oracle = { stories: Record<string, { revisions: unknown[]; accept: View; reject: View }>; ids_unique: boolean; opens: boolean | string };
const oracle = (b: Uint8Array): Oracle => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_stories.py", put(b, "docx")], { encoding: "utf8" }));
const storyOf = (o: Oracle, prefix: string) => o.stories[Object.keys(o.stories).find((k) => k.startsWith(prefix))!];

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const views = (await api("GET", "/api/settings")).json.rows as { key: string; value: string }[];
const prevView = views.find((r) => r.key === "appearance.desktopView")?.value ?? "classic";
await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });

await test("FF-49 Track Changes in every story in the UI: tracked header Apply (struck / inserted runs on the page), a field-cutting edit refused with no phantom undo step (Ctrl+Z / Ctrl+Y), tracked Notes edit, Review by place, reject footnote items singly + Accept all → Save → lxml oracle + XSD", { "FF-49": "full" }, async () => {
  const d = await blankWord("stories"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Body text here.");
  E.insertNote(d, { pid: p0.id, off: 4 }, "footnote", "We recieve it today.");
  setHf(d, "header", "default", [{ text: "Draft {PAGE} of {NUMPAGES}", align: "center" }, { text: "Quarterly" }]);
  const orig = await writeWord(await readWord(await writeWord(d)));
  const oO = oracle(orig);
  const path = `/Documents/${RUN}-stories.docx`; await upload(path, orig, DOCX);
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 30_000 });
  const body = dlg.getByTestId("writer-body"); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  const hdr = dlg.locator(".wpage").first().locator(".whdr");
  const hdrText = async () => (await hdr.innerText()).replace(/\s+/g, " ").trim();
  const before = await hdrText();
  ok(before.startsWith("Draft 1 of 1"), `header drawn: ${before}`);
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  await dlg.getByTestId("writer-track").click(); await dlg.getByTestId("writer-track-chip").waitFor();
  // header: tracked edit through the panel
  await dlg.getByRole("button", { name: "Header & footer", exact: true }).click();
  const panel = dlg.getByTestId("hf-panel"); await panel.waitFor();
  await panel.getByLabel("header line 1", { exact: true }).fill("Final {PAGE} of {NUMPAGES}");
  await panel.getByRole("button", { name: "Apply header" }).click();
  await poll(async () => (await hdr.locator(".wrev-del").count()) > 0 && (await hdr.locator(".wrev-ins").count()) > 0, "struck and inserted runs drawn in the page header");
  const del = (await hdr.locator(".wrev-del").allInnerTexts()).join(""), ins = (await hdr.locator(".wrev-ins").allInnerTexts()).join("");
  eq([del, ins], ["Drft", "Finl"], "the minimal tracked change: Dr→Fin, ft→l (the 'a' is kept)");
  const afterEdit = await hdrText();
  // refused: cutting into {PAGE} while tracking — alert, nothing changes
  await panel.getByLabel("header line 1", { exact: true }).fill("Final {PAG of {NUMPAGES}");
  await panel.getByRole("button", { name: "Apply header" }).click();
  const alert = panel.getByTestId("hf-refusal"); await alert.waitFor();
  ok((await alert.innerText()).includes("can't be recorded as tracked changes"), "refusal says why");
  eq(await hdrText(), afterEdit, "page header unchanged by the refused edit");
  // no phantom undo step: Ctrl+Z undoes the REAL header edit (back to the original), Ctrl+Y brings it back
  await body.locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+z");
  await poll(async () => (await hdrText()) === before && (await hdr.locator(".wrev-ins").count()) === 0, "Ctrl+Z restores the original header");
  await page.keyboard.press("Control+y");
  await poll(async () => (await hdr.locator(".wrev-ins").count()) > 0, "Ctrl+Y redoes the tracked header edit");
  // notes: tracked edit
  await dlg.getByRole("button", { name: "Notes", exact: true }).click();
  const fn1 = dlg.getByTestId("writer-notes").getByLabel("Footnote 1 text"); await fn1.waitFor();
  await fn1.fill("We receive it tomorrow."); await page.keyboard.press("Control+Enter");
  await dlg.getByTestId("writer-status").filter({ hasText: "recorded as tracked changes" }).waitFor();
  // review by place
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  const list = dlg.getByTestId("writer-changes");
  const where = async () => list.getByTestId("writer-change-where").allInnerTexts();
  await poll(async () => { const w = await where(); return w.some((x) => x.startsWith("Header")) && w.some((x) => x.startsWith("Footnote 1")); }, "Review lists Header and Footnote 1 changes");
  const maxBtn = dlg.getByRole("button", { name: /^Maximise/ }).first();
  await maxBtn.click(); await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/screens/tt65-writer-story-review.png" });
  await maxBtn.click(); await page.waitForTimeout(400);
  const fnItems = list.locator("[role=listitem]").filter({ has: page.getByTestId("writer-change-where").filter({ hasText: "Footnote 1" }) });
  for (let k = 0; k < 20 && (await fnItems.count()) > 0; k++) { await fnItems.first().getByRole("button", { name: /^Reject/ }).click(); await page.waitForTimeout(120); }
  eq(await fnItems.count(), 0, "every footnote change rejected");
  ok((await where()).every((x) => x.startsWith("Header")), "only header changes left");
  await dlg.getByRole("button", { name: "Accept all", exact: true }).click();
  await poll(async () => (await list.locator("[role=listitem]").count()) === 0 && (await hdr.locator(".wrev-ins, .wrev-del").count()) === 0, "all accepted, page header clean");
  ok((await hdrText()).startsWith("Final 1 of 1"), `accepted header drawn: ${await hdrText()}`);
  await body.locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const saved = new Uint8Array(await read(path));
  const o = oracle(saved);
  ok(o.opens === true && o.ids_unique, `oracle soundness ${o.opens} ${o.ids_unique}`);
  eq(storyOf(o, "header:").accept, [["Final 1 of 1", "center"], ["Quarterly", null]], "header = the accepted edit");
  eq(storyOf(o, "footnote:1").accept, storyOf(oO, "footnote:1").accept, "footnote = the original (rejected)");
  eq(Object.values(o.stories).reduce((n, s) => n + s.revisions.length, 0), 0, "no revision left in any story");
  const x = Object.values(JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", put(saved, "docx")], { encoding: "utf8" })))[0] as { ok: boolean; parts: Record<string, string[]> };
  ok(x.ok, `XSD: ${JSON.stringify(Object.entries(x.parts).filter(([, e]) => e.length))}`);
  await page.context().close();
});

await test("no page errors during the TT65 session", { "FF-49": "full" }, async () => { eq(errors, [], "page errors"); });

await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
// test hygiene (TT64): this run's /Documents files go (Tabletop card overflow otherwise)
for (const n of ((await api("GET", "/api/fs?op=list&path=/Documents")).json?.nodes ?? []) as { name: string; path: string }[]) if (n.name.startsWith(RUN)) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
await browser.close();
await finish();
process.exit(0);
