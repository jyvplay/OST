/** Native Find controls/downloads/previews and genuine SQL/crypto fixtures.
 * No request interception, substituted database, app-state injection or clocks. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { expect } from "playwright/test";
import type { Page, Locator } from "playwright";
import pg from "pg";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt134-workflows-find");
const RUN = `tt134-find-${Date.now().toString(36)}`, DIR = `/Documents/${RUN}`, ids = new Set<number>(), errors: string[] = [];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); const privateOwned = new Set<number>();
async function file(path: string, content: string) { await fx.api("POST", "/api/fs", { op: "write", path, content, mime: "text/plain" }); }
async function create(title: string, body: string) { const row = (await fx.api("POST", "/api/notes", { title, body, tags: "" })).row; ids.add(row.id); return row; }
async function find(fn: (page: Page, win: Locator) => Promise<void>, custom = false) {
  if (!custom) await fx.windows("find"); const ctx = await fx.context(), page = await ctx.newPage(); page.on("pageerror", e => errors.push(e.message));
  try { await fx.ready(page, "find"); const win = page.locator('[data-win-id="w1"]'); await win.getByLabel("Search query", { exact: true }).waitFor(); await fn(page, win); }
  catch (error) { mkdirSync("docs/screens/tt134-workflow-failures", { recursive: true }); await page.screenshot({ path: `docs/screens/tt134-workflow-failures/${RUN}-${Date.now()}.png` }).catch(() => undefined); throw error; }
  finally { await ctx.close(); }
}
async function base(win: Locator, source = "file", scope = DIR, query = RUN) { await win.getByLabel("Search source", { exact: true }).selectOption(source); await win.getByLabel("Scope", { exact: true }).fill(scope); await win.getByLabel("Match strategy", { exact: true }).selectOption("literal"); await win.getByLabel("Search query", { exact: true }).fill(query); }
async function resources(win: Locator) { const details = win.getByTestId("find-resource-filters"); if (await details.getAttribute("open") === null) await details.locator("summary").click(); return details; }
async function search(page: Page, win: Locator) { const done = page.waitForResponse(r => new URL(r.url()).pathname === "/api/search" && new URL(r.url()).searchParams.has("q")); await win.getByRole("button", { name: "Search", exact: true }).click(); const response = await done; assert.equal(response.status(), 200); await expect(win.getByText("Searching…", { exact: true })).toHaveCount(0); return response.json(); }
async function refs(win: Locator) { return win.getByTestId("find-results").locator("[data-reference]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-reference"))); }
async function ask(page: Page, value: string, ok: string) { const dialog = page.getByTestId("ask-dialog"); await dialog.waitFor(); await dialog.getByTestId("ask-input-value").fill(value); await dialog.getByRole("button", { name: ok, exact: true }).click(); await expect(dialog).toHaveCount(0); }
const early = `${DIR}/early.txt`, late = `${DIR}/late.txt`, hidden = `${DIR}/archive_%/hidden.txt`, sibling = `${DIR}/archive_%sibling/visible.txt`;
const earlyText = `${RUN} 🧭`, lateText = `${RUN} ` + "z".repeat(100);
try {
  await file(early, earlyText); await file(late, lateText); await file(hidden, `${RUN} hidden`); await file(sibling, `${RUN} sibling`);
  await pool.query("update vfs_nodes set updated_at='2020-02-29T10:00:00Z' where path=$1 or starts_with(path,$1||'/')", [DIR]); await pool.query("update vfs_nodes set updated_at='2024-01-01T00:00:00Z' where path=$1", [late]);
  const byteNote = await create(`${RUN} bytes`, `${RUN} note 🧭`), formula = await create(`=SUM(1,2) ${RUN} CSV`, `${RUN} export\r\nquoted \" μ 🧭`);
  await test("SR-20: real UTC controls constrain canonical modification days and replay with every resource field after a reload", { "SR-20": "full", "SV-02": "partial", "SR-19": "partial" }, () => find(async (page, win) => {
    await base(win); const r = await resources(win); await r.getByLabel("Modified on or after UTC", { exact: true }).fill("2020-02-29"); await r.getByLabel("Modified before UTC", { exact: true }).fill("2020-03-01"); await search(page, win); assert.deepEqual(new Set(await refs(win)), new Set([early, hidden, sibling]));
    await r.getByLabel("Minimum content bytes").fill("1"); await r.getByLabel("Maximum content bytes").fill("500"); await r.getByLabel("Exclude search folder").fill(`${DIR}/archive_%`); await search(page, win); assert.deepEqual(new Set(await refs(win)), new Set([early, sibling])); mkdirSync("docs/screens/tt134-workflows-native", { recursive: true }); await win.screenshot({ path: "docs/screens/tt134-workflows-native/find-resources.png", animations: "disabled" });
    const name = `${RUN} resources`; await win.getByRole("button", { name: "Save this search", exact: true }).click(); await ask(page, name, "Save search"); await page.reload({ waitUntil: "domcontentloaded" }); await win.getByRole("button", { name, exact: true }).click();
    await expect(win.getByLabel("Scope", { exact: true })).toHaveValue(DIR); await expect(win.getByLabel("Search source")).toHaveValue("file"); await expect(win.getByLabel("Modified on or after UTC")).toHaveValue("2020-02-29"); await expect(win.getByLabel("Modified before UTC")).toHaveValue("2020-03-01"); await expect(win.getByLabel("Minimum content bytes")).toHaveValue("1"); await expect(win.getByLabel("Maximum content bytes")).toHaveValue("500"); await expect(win.getByLabel("Exclude search folder")).toHaveValue(`${DIR}/archive_%`);
    await resources(win); await win.getByLabel("Modified before UTC").fill("2020-02-29"); await win.getByRole("button", { name: "Search", exact: true }).click(); await expect(win.getByRole("alert")).toContainText("must precede"); await expect(win.getByRole("button", { name: "Export results JSON", exact: true })).toHaveCount(0);
  }));
  await test("SR-21: inclusive byte controls distinguish Unicode file bytes and note-body bytes; bad intervals cannot search or export stale results", { "SR-21": "full" }, () => find(async (page, win) => {
    await base(win); const r = await resources(win), bytes = String(Buffer.byteLength(earlyText)); await r.getByLabel("Minimum content bytes").fill(bytes); await r.getByLabel("Maximum content bytes").fill(bytes); await search(page, win); assert.deepEqual(await refs(win), [early]);
    await win.getByLabel("Search source").selectOption("note"); await win.getByLabel("Scope", { exact: true }).fill(""); const noteBytes = String(Buffer.byteLength(byteNote.body)); await r.getByLabel("Minimum content bytes").fill(noteBytes); await r.getByLabel("Maximum content bytes").fill(noteBytes); await search(page, win); assert.deepEqual(await refs(win), [String(byteNote.id)]);
    await r.getByLabel("Minimum content bytes").fill("20"); await r.getByLabel("Maximum content bytes").fill("19"); await win.getByRole("button", { name: "Search", exact: true }).click(); await expect(win.getByRole("alert")).toContainText("must not exceed"); await win.getByLabel("Search source").selectOption("setting"); await expect(r.getByLabel("Minimum content bytes")).toHaveValue(""); await expect(r.getByLabel("Maximum content bytes")).toBeDisabled();
  }));
  await test("SR-22: native query-folder exclusion removes only the literal subtree, composes with scope, and works in live metadata", { "SR-22": "full" }, () => find(async (page, win) => {
    await base(win); const r = await resources(win); await r.getByLabel("Exclude search folder").fill(`${DIR}/archive_%`); await search(page, win); let list = await refs(win); assert.ok(!list.includes(hidden)); assert.ok(list.includes(sibling)); assert.ok(list.includes(early));
    await win.getByLabel("Search mode").selectOption("metadata"); await search(page, win); list = await refs(win); assert.ok(!list.includes(hidden)); assert.ok(list.includes(sibling));
    await r.getByLabel("Exclude search folder").fill("/a/../b"); await win.getByRole("button", { name: "Search", exact: true }).click(); await expect(win.getByRole("alert")).toContainText("dot segments");
  }));
  await test("Filter-state patch attack: native text/regex/case/order controls retain their independent scalar values without another host search", { "SR-14": "partial" }, () => find(async (page, win) => {
    const requests: string[] = []; page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/api/search" && url.searchParams.has("q")) requests.push(request.url()); });
    await base(win); await search(page, win); const initial = new Set([early, late, hidden, sibling]); assert.deepEqual(new Set(await refs(win)), initial); assert.equal(requests.length, 1);
    const pattern = win.getByLabel("Filter results by pattern"), regex = win.getByLabel("regex", { exact: true }), sensitive = win.getByLabel("case", { exact: true }), order = win.getByLabel("Result order");
    for (let i = 0; i < 3; i++) {
      await pattern.fill("EARLY"); await regex.check(); await sensitive.check(); await order.selectOption("reference");
      await expect(pattern).toHaveValue("EARLY"); await expect(regex).toBeChecked(); await expect(sensitive).toBeChecked(); await expect(order).toHaveValue("reference"); await expect(win.getByTestId("find-results").locator("[data-reference]")).toHaveCount(0);
      await pattern.fill("early"); await expect.poll(() => refs(win)).toEqual([early]);
      await regex.uncheck(); await sensitive.uncheck(); await order.selectOption("title"); await pattern.fill("");
      await expect(regex).not.toBeChecked(); await expect(sensitive).not.toBeChecked(); await expect(order).toHaveValue("title"); await expect.poll(async () => new Set(await refs(win))).toEqual(initial);
    }
    assert.equal(requests.length, 1, "local presentation controls do not issue a new host query");
  }));
  await test("SR-23: real JSON/CSV downloads contain the current visible ordered hit and completed query, independently parsed; editing query invalidates export", { "SR-23": "full" }, () => find(async (page, win) => {
    await base(win, "note", ""); await search(page, win); await win.getByLabel("Filter results by pattern").fill("CSV"); await expect(win.getByTestId("find-results").locator("[data-reference]")).toHaveCount(1); await win.getByLabel("Result order").selectOption("reference");
    let download = page.waitForEvent("download"); await win.getByRole("button", { name: "Export results JSON", exact: true }).click(); const json = JSON.parse(readFileSync((await (await download).path())!, "utf8")); assert.equal(json.input.q, RUN); assert.equal(json.input.filter, "CSV"); assert.equal(json.input.sort, "reference"); assert.equal(json.hits.length, 1); assert.equal(json.hits[0].ref, String(formula.id)); assert.equal(json.hits[0].title, formula.title); assert.equal(json.hits[0].snippet, formula.body);
    download = page.waitForEvent("download"); await win.getByRole("button", { name: "Export results CSV", exact: true }).click(); const csvPath = (await (await download).path())!; const records = JSON.parse(execFileSync("python3", ["-c", "import csv,sys,json; print(json.dumps(list(csv.reader(open(sys.argv[1],encoding='utf-8',newline='')))))", csvPath], { encoding: "utf8" })); assert.equal(records.length, 2); assert.equal(records[1][2], "'" + formula.title); assert.equal(records[1][3], formula.body);
    await win.getByLabel("Search query", { exact: true }).fill("changed pending query"); await expect(win.getByRole("button", { name: "Export results JSON", exact: true })).toHaveCount(0);
  }));
  await test("SR-24: actual result preview fetches fresh bounded text safely, restores focus, and reports a now-missing result instead of its stale snippet", { "SR-24": "full" }, () => find(async (page, win) => {
    await base(win); await search(page, win); const fresh = "Current <script>window.__tt134Preview=1</script> 🧭"; await file(early, fresh);
    const button = win.getByRole("button", { name: "Preview result: early.txt", exact: true }); await button.click(); let dialog = page.getByRole("dialog", { name: "Preview: early.txt", exact: true }); await expect(dialog.getByTestId("find-preview-body")).toHaveText(fresh); assert.equal(await dialog.locator("script,img,iframe").count(), 0); assert.equal(await page.evaluate(() => (window as any).__tt134Preview), undefined); mkdirSync("docs/screens/tt134-workflows-native", { recursive: true }); await dialog.screenshot({ path: "docs/screens/tt134-workflows-native/find-current-preview.png", animations: "disabled" }); await page.keyboard.press("Escape"); await expect(button).toBeFocused();
    await fx.api("POST", "/api/fs", { op: "trash", path: early }); await button.click(); dialog = page.getByRole("dialog", { name: "Preview: early.txt", exact: true }); await expect(dialog.getByRole("alert")).toContainText("unavailable"); await expect(dialog.getByTestId("find-preview-body")).toHaveCount(0); await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }));
  const pages: any[] = [];
  for (let i = 0; i < 75; i += 32) { const result = await fx.api("POST", "/api/notes/batch", { notes: Array.from({ length: Math.min(32, 75 - i) }, (_, j) => ({ title: `${RUN} page ${String(i + j).padStart(3, "0")}`, body: `${RUN} page-only-needle` })) }); pages.push(...result.rows); result.rows.forEach((r: any) => ids.add(r.id)); }
  await test("SR-25: native continuation retrieves the second real page, deduplicates fixed-index rows, keeps one history entry and invalidates after changing input", { "SR-25": "full" }, () => find(async (page, win) => {
    await base(win, "note", "", `${RUN} page-only-needle`); await search(page, win); assert.equal((await refs(win)).length, 50); const next = win.getByRole("button", { name: "Load next 50 public literal results", exact: true }); const response = page.waitForResponse(r => new URL(r.url()).searchParams.get("offset") === "50"); await next.click(); assert.equal((await response).status(), 200); await expect(win.getByTestId("find-results").locator("[data-reference]")).toHaveCount(75); assert.deepEqual(new Set(await refs(win)), new Set(pages.map(row => String(row.id)))); await expect(next).toHaveCount(0);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.recent-searches.v1") ?? "[]")); assert.equal(history.length, 1); await win.getByLabel("Search query", { exact: true }).fill("new query"); await expect(win.getByTestId("find-results").locator("[data-reference]")).toHaveCount(0); await expect(next).toHaveCount(0);
  }));
  await test("Private resource-filter refusal never sends the query to the host, in text and metadata modes", { "SR-20": "partial", "SR-21": "partial", "SR-22": "partial", "SR-25": "partial" }, () => find(async (page, win) => {
    const sent: string[] = []; page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/api/search" && url.searchParams.get("q")?.includes(RUN)) sent.push(request.url()); });
    await base(win, "file", "/Private", `${RUN} private-filter`); const r = await resources(win); await r.getByLabel("Minimum content bytes").fill("1"); await win.getByRole("button", { name: "Search", exact: true }).click(); await expect(win.getByRole("alert")).toContainText("unavailable for Private/RAM"); assert.deepEqual(sent, []); await win.getByLabel("Search mode").selectOption("metadata"); await win.getByRole("button", { name: "Search", exact: true }).click(); await expect(win.getByRole("alert")).toContainText("unavailable for Private/RAM"); assert.deepEqual(sent, []);
  }));
  await test("Private export uses real encrypted storage/local search, explicit plaintext consent/cancel and actual lock clearing; Private preview stays disabled", { "SR-23": "full", "SR-24": "partial" }, async () => {
    // Refuse to overwrite an existing volume; this exclusive drill owns only
    // the genuinely new VFS rows created between these two database snapshots.
    const priorIds = new Set<number>((await pool.query("select id from vfs_nodes")).rows.map(row => Number(row.id)));
    const original = await fx.api("GET", "/api/state?id=default"); await fx.api("PUT", "/api/state", { id: "default", revision: Number(original.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "find", title: "Find", x: 18, y: 16, w: 700, h: 810, z: 10, workspace: 1, props: {} }, { id: "w2", module: "privacy", title: "Privacy", x: 740, y: 16, w: 730, h: 810, z: 11, workspace: 1, props: {} }], focus: "w2", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
    try { await find(async (page, win) => {
      const privacy = page.locator('[data-win-id="w2"]'); await privacy.getByTestId("pp1").waitFor(); await privacy.getByTestId("pp1").fill(`${RUN} five actual owned volume words`); await privacy.getByTestId("pp2").fill(`${RUN} five actual owned volume words`); await privacy.getByTestId("create").click(); await privacy.getByTestId("lock").waitFor();
      const privateNeedle = `private-only-${crypto.randomUUID()}`, content = `${RUN} ${privateNeedle} privately encrypted literal text`, path = `/Private/${RUN}/secret.txt`;
      const stored = await page.evaluate(async ({ content, path }) => { const r = await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path, content, mime: "text/plain" }) }); return { status: r.status, body: await r.json() }; }, { content, path }); assert.equal(stored.status, 200, JSON.stringify(stored.body));
      const sent: string[] = []; page.on("request", request => { const u = new URL(request.url()); if ([...u.searchParams.values(), decodeURIComponent(u.href), request.postData() ?? ""].some(value => value.includes(privateNeedle))) sent.push(request.url()); });
      await base(win, "file", "/Private", privateNeedle); await win.getByRole("button", { name: "Search", exact: true }).click(); await expect(win.getByTestId("find-results").locator("[data-reference]")).toHaveCount(1); assert.deepEqual(sent, []); await expect(win.getByRole("button", { name: "Preview result: secret.txt", exact: true })).toBeDisabled();
      let downloads = 0; page.on("download", () => downloads++); await win.getByRole("button", { name: "Export results JSON", exact: true }).click(); await expect(page.getByTestId("ask-dialog")).toContainText("unencrypted"); await page.getByTestId("ask-cancel").click(); assert.equal(downloads, 0);
      const download = page.waitForEvent("download"); await win.getByRole("button", { name: "Export results JSON", exact: true }).click(); await page.getByTestId("ask-ok").click(); const data = JSON.parse(readFileSync((await (await download).path())!, "utf8")); assert.equal(data.input.scope, "/Private"); assert.ok(data.hits[0].snippet.includes(privateNeedle));
      await privacy.getByTestId("lock").click(); await expect(win.getByTestId("find-results").locator("[data-reference]")).toHaveCount(0); await expect(win.getByRole("button", { name: "Export results JSON", exact: true })).toHaveCount(0); assert.equal(await page.evaluate(() => localStorage.getItem("fusion.recent-searches.v1")), null);
      const host = await pool.query("select id,content from vfs_nodes");
      for (const item of host.rows) if (!priorIds.has(Number(item.id))) assert.equal(String(item.content).includes(privateNeedle), false, "new encrypted host records do not contain fixture plaintext");
    }, true); } finally { const after = await pool.query("select id from vfs_nodes"); for (const row of after.rows) if (!priorIds.has(Number(row.id))) privateOwned.add(Number(row.id)); }
  });
  await test("Native Find workflows emitted no unhandled browser exceptions", {}, () => assert.deepEqual(errors, []));
} finally {
  await fx.close(); await pool.query("delete from index_docs where source='note' and ref=any($1::text[])", [[...ids].map(String)]); await pool.query("delete from notes where id=any($1::int[])", [[...ids]]); await pool.query("delete from index_docs where source='file' and (ref=$1 or starts_with(ref,$1||'/') or ref in (select path from vfs_nodes where id=any($2::int[])))", [DIR, [...privateOwned]]); await pool.query("delete from vfs_versions where path=$1 or starts_with(path,$1||'/') or path in (select path from vfs_nodes where id=any($2::int[]))", [DIR, [...privateOwned]]); await pool.query("delete from vfs_nodes where path=$1 or starts_with(path,$1||'/') or id=any($2::int[])", [DIR, [...privateOwned]]); await pool.end(); finish();
}
