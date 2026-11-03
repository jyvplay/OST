/** Real production UI + HTTP + PostgreSQL. No route fulfilment, fake clocks,
 * fake devices, mocked storage, replacement workers or injected app internals. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect } from "playwright/test";
import type { Locator, Page } from "playwright";
import pg from "pg";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
import { noteDraftKey } from "../src/lib/note-drafts.ts";
import { EMPTY_SEARCH, searchInput } from "../src/lib/search-query.ts";
import { noteToMarkdown } from "../src/lib/note-export.ts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt133-notes-find");
const RUN = `tt133-${Date.now().toString(36)}`, DIR = `/Documents/${RUN}`;
const notes = new Set<number>(), paths = new Set<string>(), errors: string[] = [];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
async function create(title: string, body = "", tags = "") {
  const r = await fx.api("POST", "/api/notes", { title, body, tags }); notes.add(r.row.id); return r.row;
}
async function write(path: string, content: string, mime = "text/plain") { await fx.api("POST", "/api/fs", { op: "write", path, content, mime }); paths.add(path); }
async function choose(win: Locator, title: string) {
  await win.getByLabel("Notes list").getByRole("button").filter({ hasText: title }).first().click(); await expect(win.getByLabel("Note title", { exact: true })).toHaveValue(title);
}
async function withModule(id: string, fn: (page: Page, win: Locator) => Promise<void>) {
  await fx.windows(id); const ctx = await fx.context(); const page = await ctx.newPage(); page.on("pageerror", e => errors.push(e.message));
  try { await fx.ready(page, id); const win = page.locator('[data-win-id="w1"]'); await win.getByLabel(id === "notes" ? "Note title" : "Search query", { exact: true }).waitFor(); await fn(page, win); }
  finally { await ctx.close(); }
}
async function search(page: Page, win: Locator) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/search" && new URL(r.url()).searchParams.has("q") && r.request().method() === "GET");
  await win.getByLabel("Search query", { exact: true }).press("Enter"); const r = await response; assert.equal(r.status(), 200); const data = await r.json();
  await expect(win.getByText("Searching…", { exact: true })).toHaveCount(0); return data;
}
async function more(win: Locator) { const el = win.getByTestId("note-editor").locator("details").first(); if (await el.getAttribute("open") === null) await el.locator(":scope > summary").click(); }
async function confirm(page: Page, label: string) { const ask = page.getByTestId("ask-dialog"); await ask.waitFor(); await ask.getByRole("button", { name: label, exact: true }).click(); await expect(ask).toHaveCount(0); }
try {
  const a = await create(`${RUN} Guard A`, "saved A"), b = await create(`${RUN} Guard B`, "saved B");
  await test("NT-08: changing notes asks; Cancel preserves all edits, Save commits before navigation and no delayed draft resurrects", { "NT-08": "full" }, () => withModule("notes", async (page, win) => {
    await choose(win, a.title); await win.getByLabel("Note body").fill("edited A μ 🧭"); await win.getByLabel("Notes list").getByRole("button").filter({ hasText: b.title }).click();
    const dialog = page.getByTestId("close-confirm"); await dialog.waitFor(); await dialog.getByTestId("close-confirm-cancel").click();
    await expect(win.getByLabel("Note body")).toHaveValue("edited A μ 🧭"); assert.equal((await fx.api("GET", `/api/notes?id=${a.id}`)).row.body, "saved A");
    await win.getByLabel("Notes list").getByRole("button").filter({ hasText: b.title }).click(); await dialog.getByTestId("close-confirm-save").click();
    await expect(win.getByLabel("Note title")).toHaveValue(b.title); assert.equal((await fx.api("GET", `/api/notes?id=${a.id}`)).row.body, "edited A μ 🧭");
    await page.waitForTimeout(450); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), noteDraftKey("w1", a.id)), null);
  }));
  await test("NT-08: New and window Close cannot silently destroy dirty Notes; cancel both native UI actions", { "NT-08": "full" }, () => withModule("notes", async (page, win) => {
    await choose(win, b.title); await win.getByLabel("Note body").fill("keep this dirty text");
    await win.getByRole("button", { name: "New", exact: true }).click(); await page.getByTestId("close-confirm-cancel").click(); await expect(win.getByLabel("Note body")).toHaveValue("keep this dirty text");
    await win.getByRole("button", { name: "Close window", exact: true }).click(); await page.getByTestId("close-confirm-cancel").click(); await expect(win).toBeVisible(); await expect(win.getByLabel("Note body")).toHaveValue("keep this dirty text");
  }));
  const recover = await create(`${RUN} Recovery`, "saved original");
  await test("NT-09: a real sessionStorage draft survives reload, restores exact text with its old revision, and Save clears it", { "NT-09": "full" }, () => withModule("notes", async (page, win) => {
    await choose(win, recover.title); await win.getByLabel("Note body").fill("recovered\n🧭 \"literal\"\n"); const key = noteDraftKey("w1", recover.id);
    await page.waitForFunction(key => !!sessionStorage.getItem(key), key); await page.reload({ waitUntil: "domcontentloaded" }); await choose(win, recover.title);
    await win.getByTestId("note-recovery").waitFor(); await expect(win.getByLabel("Note body")).toBeDisabled(); await win.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect(win.getByLabel("Note body")).toHaveValue("recovered\n🧭 \"literal\"\n"); await win.getByLabel("Note body").press("Control+s"); await expect(win.getByTestId("note-editor").getByText("saved", { exact: true })).toBeVisible();
    assert.equal((await fx.api("GET", `/api/notes?id=${recover.id}`)).row.body, "recovered\n🧭 \"literal\"\n"); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), null);
  }));
  const stale = await create(`${RUN} Conflict`, "before");
  await test("NT-10: another real HTTP writer wins; stale UI save is refused, editor text remains, and confirmed Reload obtains the winner", { "NT-10": "full" }, () => withModule("notes", async (page, win) => {
    await choose(win, stale.title); await win.getByLabel("Note body").fill("my unsaved text"); await fx.api("PUT", "/api/notes", { id: stale.id, expectedRevision: stale.revision, body: "other window committed" });
    await win.getByRole("button", { name: "Save", exact: true }).click(); await win.getByRole("alert").filter({ hasText: "changed in another window" }).waitFor(); await expect(win.getByLabel("Note body")).toHaveValue("my unsaved text");
    assert.equal((await fx.api("GET", `/api/notes?id=${stale.id}`)).row.body, "other window committed"); await win.getByRole("button", { name: "Reload note", exact: true }).click(); await confirm(page, "Reload note"); await expect(win.getByLabel("Note body")).toHaveValue("other window committed");
  }));
  await test("NT-09 patch attack: temporarily blank titles are recoverable editing states, and Discard draft does not write the note", { "NT-09": "full" }, () => withModule("notes", async (page, win) => {
    await choose(win, b.title); await win.getByLabel("Note title").fill(""); await win.getByLabel("Note body").fill("unfinished title edit"); const key = noteDraftKey("w1", b.id);
    await page.waitForFunction(key => JSON.parse(sessionStorage.getItem(key) ?? "null")?.value.title === "", key); await page.reload({ waitUntil: "domcontentloaded" }); await choose(win, b.title);
    await win.getByTestId("note-recovery").waitFor(); await win.getByRole("button", { name: "Discard draft", exact: true }).click(); await expect(win.getByLabel("Note title")).toHaveValue(b.title); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), null);
    assert.equal((await fx.api("GET", `/api/notes?id=${b.id}`)).row.body, "saved B");
  }));
  const filtered = await create(`${RUN} Ｆｕｓｉｏｎ`, "Blue sky", "travel,blue");
  await test("NT-11: local full-text filtering composes with stored-tag filtering, preserves selection, and has a real empty state", { "NT-11": "full" }, () => withModule("notes", async (_page, win) => {
    await choose(win, filtered.title); await win.getByLabel("Filter notes", { exact: true }).fill("fusion TRAVEL"); await expect(win.getByLabel("Notes list").getByRole("button")).toHaveCount(1);
    await win.getByLabel("Filter notes by tag").selectOption("blue"); await expect(win.getByLabel("Notes list").getByRole("button")).toHaveCount(1);
    await win.getByLabel("Filter notes", { exact: true }).fill("not-in-any-note-8937"); await expect(win.getByText("No matching notes", { exact: true })).toBeVisible(); await expect(win.getByLabel("Note title")).toHaveValue(filtered.title);
  }));
  const markdown = await create(`${RUN} Markdown`, "# Top\n**bold** *em* `code` ~~old~~\n<script>window.__tt133Injected=1</script>\n![image](https://example.test/never-image.png)\n[blocked](javascript:alert(1))\n[web](https://example.test/)\n```html\n<img onerror=alert(1)>\n```\n");
  await test("NT-12: preview renders a safe Markdown subset without executing raw HTML, loading remote images, or enabling javascript links", { "NT-12": "full" }, () => withModule("notes", async (page, win) => {
    const external: string[] = []; page.on("request", r => { if (r.url().includes("example.test")) external.push(r.url()); }); await choose(win, markdown.title); await win.getByRole("button", { name: "Preview", exact: true }).click(); const view = win.getByTestId("note-preview");
    await expect(view.getByRole("heading", { name: "Top", exact: true })).toBeVisible(); await expect(view.locator("strong")).toHaveText("bold"); await expect(view.locator("em")).toHaveText("em"); await expect(view.locator("del")).toHaveText("old");
    assert.equal(await view.locator("img,script,iframe,style").count(), 0); assert.equal(await view.getByRole("link", { name: "blocked", exact: true }).count(), 0); assert.equal(await view.getByRole("link", { name: "web", exact: true }).getAttribute("rel"), "noopener noreferrer nofollow");
    assert.equal(await page.evaluate(() => (window as any).__tt133Injected), undefined); assert.deepEqual(external, []); await win.getByRole("button", { name: "Edit", exact: true }).click(); await expect(win.getByLabel("Note body")).toHaveValue(markdown.body);
  }));
  await test("NT-13: native file input imports fatal UTF-8 Markdown into a persisted indexed note; invalid UTF-8 cannot add a note", { "NT-13": "full" }, () => withModule("notes", async (_page, win) => {
    const body = `# ${RUN} Imported\r\nExact μ 🧭 body\r\n`; await win.getByLabel("Import Markdown note").setInputFiles({ name: "import.md", mimeType: "text/markdown", buffer: Buffer.from(body) }); await expect(win.getByLabel("Note title")).toHaveValue(`${RUN} Imported`); await expect(win.getByLabel("Note body")).toHaveValue(body.replace(/\r\n/g, "\n"));
    const rows = (await fx.api("GET", "/api/notes")).rows, imported = rows.find((n: any) => n.title === `${RUN} Imported`); notes.add(imported.id); assert.equal(imported.body, body);
    const before = rows.length; await win.getByLabel("Import Markdown note").setInputFiles({ name: "bad.md", mimeType: "text/markdown", buffer: Buffer.from([255, 254]) }); await win.getByRole("alert").filter({ hasText: "UTF-8" }).waitFor(); assert.equal((await fx.api("GET", "/api/notes")).rows.length, before);
  }));
  const target = await create(`${RUN} Target`, "target body"), source = await create(`${RUN} Links`, `Go [[${RUN} Target|Destination]].`);
  const ambiguousFirst = await create(`${RUN} Ambiguous`, "first"), ambiguousSecond = await create(`${RUN} Ambiguous`, "second"); const ambiguous = await create(`${RUN} Ambiguous source`, `[[${RUN} Ambiguous]] [[Missing ${RUN}]]`);
  await test("NT-14: real wiki navigation and reverse backlinks open the correct notes; absent and ambiguous destinations cannot choose an arbitrary record", { "NT-14": "full" }, () => withModule("notes", async (_page, win) => {
    await choose(win, source.title); await win.getByRole("button", { name: "[[Destination]]", exact: true }).click(); await expect(win.getByLabel("Note title")).toHaveValue(target.title);
    await win.getByRole("button", { name: `Backlink: ${source.title}`, exact: true }).click(); await expect(win.getByLabel("Note title")).toHaveValue(source.title); await choose(win, ambiguous.title);
    await expect(win.getByRole("button", { name: `[[${RUN} Ambiguous]]`, exact: true })).toBeDisabled(); await expect(win.getByRole("button", { name: `[[Missing ${RUN}]] — no such note`, exact: true })).toBeDisabled();
    const duplicates = win.getByLabel("Notes list").getByRole("button").filter({ hasText: ambiguousFirst.title }).filter({ hasNotText: ambiguous.title });
    await expect(duplicates).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      await duplicates.nth(index).click(); await expect(win.getByLabel("Note body")).toHaveValue(/^(first|second)$/);
      await expect(win.getByRole("button", { name: `Backlink: ${ambiguous.title}`, exact: true })).toHaveCount(0);
    }
  }));
  const shadow = await create(`${RUN} Shadow identity`, "shadow body");
  await test("NT-14 saved-identity attack: an unsaved rename keeps the real backlink, and borrowing another saved title cannot impersonate its destination", { "NT-14": "partial" }, () => withModule("notes", async (_page, win) => {
    await choose(win, target.title); await win.getByLabel("Note title", { exact: true }).fill(target.title + " draft rename");
    await expect(win.getByRole("button", { name: `Backlink: ${source.title}`, exact: true })).toBeVisible();
    await win.getByLabel("Note title", { exact: true }).fill(target.title);
    await choose(win, shadow.title); await win.getByLabel("Note title", { exact: true }).fill(target.title);
    await expect(win.getByRole("button", { name: `Backlink: ${source.title}`, exact: true })).toHaveCount(0);
    assert.equal((await fx.api("GET", `/api/notes?id=${shadow.id}`)).row.title, shadow.title);
  }));
  const outline = await create(`${RUN} Outline`, `# Start\n${"Paragraph line\n".repeat(120)}   ## Near end\nEnd text\n`);
  await test("NT-15: outline is clickable, fence-aware and shares exact preview line IDs, including indented headings far below the fold", { "NT-15": "full" }, () => withModule("notes", async (_page, win) => {
    await choose(win, outline.title); await win.getByRole("button", { name: "Outline", exact: true }).click(); const nav = win.getByRole("navigation", { name: "Note outline" }); await expect(nav.getByRole("button")).toHaveCount(2); await nav.getByRole("button", { name: "Near end", exact: true }).click();
    const heading = win.getByTestId("note-preview").getByRole("heading", { name: "Near end", exact: true }); await expect(heading).toBeInViewport(); assert.ok(await win.getByTestId("note-preview").evaluate(el => el.scrollTop) > 0);
  }));
  const excerpt = await create(`${RUN} Excerpt source`, "Alpha 🧭 beta\nOmega");
  await test("NT-16: native textarea selection creates an exact independent note, leaves its source unchanged, and an empty selection cannot extract", { "NT-16": "full" }, () => withModule("notes", async (page, win) => {
    await choose(win, excerpt.title); await more(win); const extract = win.getByRole("button", { name: "Extract selection", exact: true }); await expect(extract).toBeDisabled(); const area = win.getByLabel("Note body"); await area.focus(); await area.press("Control+Home"); for (let i = 0; i < 6; i++) await area.press("ArrowRight"); for (let i = 0; i < 6; i++) await area.press("Shift+ArrowRight");
    await expect(extract).toBeEnabled(); await extract.click(); const ask = page.getByTestId("ask-dialog"); await ask.getByRole("textbox").fill(`${RUN} Excerpt result`); await confirm(page, "Create note"); await expect(win.getByLabel("Note title")).toHaveValue(`${RUN} Excerpt result`); await expect(win.getByLabel("Note body")).toHaveValue("🧭 beta");
    const made = (await fx.api("GET", "/api/notes")).rows.find((n: any) => n.title === `${RUN} Excerpt result`); notes.add(made.id); assert.equal(made.body, "🧭 beta"); assert.equal((await fx.api("GET", `/api/notes?id=${excerpt.id}`)).row.body, excerpt.body);
  }));
  const task = await create(`${RUN} Tasks`, "# Plan\n- [ ] μ task\nUnrelated text\n- [X] done\n");
  await test("NT-17: interactive checklist checks and unchecks the right source marker; saving/reopening preserves other lines exactly", { "NT-17": "full" }, () => withModule("notes", async (_page, win) => {
    await choose(win, task.title); await win.getByRole("button", { name: "Preview", exact: true }).click(); const check = win.getByRole("checkbox", { name: "Complete task: μ task", exact: true }); await check.check(); await expect(check).toBeChecked(); await win.getByRole("button", { name: "Save", exact: true }).click(); await expect(win.getByTestId("note-editor").getByText("saved", { exact: true })).toBeVisible();
    assert.equal((await fx.api("GET", `/api/notes?id=${task.id}`)).row.body, task.body.replace("[ ]", "[x]")); await check.uncheck(); await win.getByRole("button", { name: "Save", exact: true }).click(); await expect(win.getByTestId("note-editor").getByText("saved", { exact: true })).toBeVisible(); assert.equal((await fx.api("GET", `/api/notes?id=${task.id}`)).row.body, task.body);
  }));
  await test("NT-18: an actual browser download is self-contained UTF-8 Markdown, includes unsaved text and cannot write a VFS file", { "NT-18": "full" }, () => withModule("notes", async (page, win) => {
    await choose(win, markdown.title); await win.getByLabel("Note body").fill("download this unsaved 🧭 body"); await more(win); const writes: string[] = []; page.on("request", r => { if (new URL(r.url()).pathname === "/api/fs" && r.method() !== "GET") writes.push(r.url()); });
    const exportStarted = Date.now(), pending = page.waitForEvent("download"); await win.getByRole("button", { name: "Download .md", exact: true }).click(); const download = await pending, path = await download.path(); assert.ok(path); assert.ok(download.suggestedFilename().endsWith(".md"));
    const text = readFileSync(path!, "utf8"), timestamp = /^exported: (.+)$/m.exec(text)?.[1]; assert.ok(timestamp); const exportedAt = new Date(timestamp!); assert.ok(exportedAt.getTime() >= exportStarted && exportedAt.getTime() <= Date.now(), "export date is a real current timestamp"); assert.equal(text, noteToMarkdown({ ...markdown, body: "download this unsaved 🧭 body" }, exportedAt)); assert.deepEqual(writes, []); assert.equal((await fx.api("GET", `/api/notes?id=${markdown.id}`)).row.body, markdown.body);
  }));
  await write(`${DIR}/Zeta.md`, `${RUN} literal %_ one  two`); await write(`${DIR}/Alpha.TXT`, `${RUN} literal %_ one gap two`); const hitNote = await create("Alpha note", `${RUN} literal %_ one  two`);
  await test("SR-13: the actual source control changes the native request and excludes other kinds, including an empty wrong source", { "SR-13": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search query", { exact: true }).fill(RUN); await win.getByLabel("Search source").selectOption("file"); await win.getByLabel("Scope", { exact: true }).fill(DIR); let data = await search(page, win); assert.equal(data.hits.length, 2); assert.ok(data.hits.every((h: any) => h.source === "file"));
    await win.getByLabel("Scope", { exact: true }).fill(""); await win.getByLabel("Search source").selectOption("note"); data = await search(page, win); assert.ok(data.hits.some((h: any) => h.ref === String(hitNote.id))); assert.ok(data.hits.every((h: any) => h.source === "note"));
    await win.getByLabel("Search source").selectOption("setting"); data = await search(page, win); assert.equal(data.hits.length, 0); await expect(win.getByTestId("find-results").locator("button.fs-list-item")).toHaveCount(0);
  }));
  await test("SR-14: title and reference orders rearrange only the returned result set deterministically", { "SR-14": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search query", { exact: true }).fill(RUN); await win.getByLabel("Scope", { exact: true }).fill(DIR); await search(page, win); const results = win.getByTestId("find-results").locator("button.fs-list-item"); await expect(results).toHaveCount(2);
    await win.getByLabel("Result order").selectOption("title"); assert.ok((await results.nth(0).innerText()).startsWith("Alpha.TXT")); await win.getByLabel("Result order").selectOption("reference"); assert.ok((await results.nth(0).innerText()).includes(`${DIR}/Alpha.TXT`)); await expect(results).toHaveCount(2);
  }));
  await test("SR-15: literal matching keeps internal whitespace and SQL wildcard characters literal, without ranked/fuzzy matches", { "SR-15": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Scope", { exact: true }).fill(DIR); await win.getByLabel("Match strategy").selectOption("literal"); await win.getByLabel("Search query", { exact: true }).fill("%_ one  two"); let data = await search(page, win); assert.equal(data.hits.length, 1); assert.equal(data.hits[0].ref, `${DIR}/Zeta.md`); assert.equal(data.hits[0].how, "literal"); assert.equal(typeof data.hits[0].rank, "number");
    await win.getByLabel("Search query", { exact: true }).fill("%_ one three"); data = await search(page, win); assert.equal(data.hits.length, 0);
  }));
  await test("SR-16: file suffix control is case-insensitive and literal, and a non-file source disables/clears it", { "SR-16": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Scope", { exact: true }).fill(DIR); await win.getByLabel("Search query", { exact: true }).fill(RUN); await win.getByLabel("File extension").fill("TXT"); const data = await search(page, win); assert.deepEqual(data.hits.map((h: any) => h.ref), [`${DIR}/Alpha.TXT`]);
    await win.getByLabel("Search source").selectOption("note"); await expect(win.getByLabel("File extension")).toBeDisabled(); await expect(win.getByLabel("File extension")).toHaveValue("");
  }));
  await test("SR-17: native confirmation cancels without a rebuild, then a real confirmed rebuild preserves source bytes", { "SR-17": "full" }, () => withModule("find", async (page, win) => {
    const posts: string[] = []; page.on("request", r => { if (new URL(r.url()).pathname === "/api/search" && r.method() === "POST") posts.push(r.postData() ?? ""); });
    await win.locator("summary").filter({ hasText: "Search details" }).click(); await win.getByRole("button", { name: "Rebuild index", exact: true }).click(); await confirm(page, "Cancel"); assert.equal(posts.length, 0);
    await win.getByRole("button", { name: "Rebuild index", exact: true }).click(); await confirm(page, "Rebuild index"); await win.getByRole("status").filter({ hasText: /^Rebuilt/ }).waitFor(); assert.equal(posts.length, 1); assert.equal(JSON.parse(posts[0]).confirm, "REBUILD");
    assert.equal((await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(`${DIR}/Zeta.md`)}`)).node.content, `${RUN} literal %_ one  two`);
  }));
  await test("SR-18: path diagnosis shows an indexed real file, a nonexistent file, and invalid path refusal without hiding a previous diagnosis", { "SR-18": "full" }, () => withModule("find", async (_page, win) => {
    await win.locator("summary").filter({ hasText: "Search details" }).click(); await win.getByLabel("Missing file path").fill(`${DIR}/Zeta.md`); await win.getByRole("button", { name: "Why missing?", exact: true }).click(); await win.getByTestId("find-diagnosis").filter({ hasText: /^indexed/ }).waitFor();
    await win.getByLabel("Missing file path").fill(`${DIR}/absent.md`); await win.getByRole("button", { name: "Why missing?", exact: true }).click(); await win.getByTestId("find-diagnosis").filter({ hasText: /^missing/ }).waitFor();
    await win.getByLabel("Missing file path").fill("relative/../file"); await win.getByRole("button", { name: "Why missing?", exact: true }).click(); await win.getByRole("alert").filter({ hasText: "canonical absolute" }).waitFor(); await expect(win.getByTestId("find-diagnosis")).toHaveCount(0);
  }));
  await test("SR-19: Enter records complete history, Cancel keeps it, Clear deletes it and reload cannot resurrect it", { "SR-19": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search query", { exact: true }).fill(RUN); await win.getByLabel("Scope", { exact: true }).fill(DIR); await search(page, win); await expect(win.getByTestId("find-recents")).toBeVisible();
    await win.getByRole("button", { name: "Clear recent searches", exact: true }).click(); await confirm(page, "Cancel"); assert.ok(await page.evaluate(() => localStorage.getItem("fusion.recent-searches.v1")));
    await win.getByRole("button", { name: "Clear recent searches", exact: true }).click(); await confirm(page, "Clear history"); await expect(win.getByTestId("find-recents")).toHaveCount(0); assert.equal(await page.evaluate(() => localStorage.getItem("fusion.recent-searches.v1")), null);
    await page.reload({ waitUntil: "domcontentloaded" }); await win.getByLabel("Search query", { exact: true }).waitFor(); await expect(win.getByTestId("find-recents")).toHaveCount(0);
  }));
  await test("SR-19 patch attack: clearing history while a genuine PostgreSQL table lock holds a search cannot be undone by the late response", { "SR-19": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search query", { exact: true }).fill(RUN); await win.getByLabel("Match strategy").selectOption("literal"); await search(page, win);
    const lock = await pool.connect(); await lock.query("begin"); await lock.query("lock table index_docs in access exclusive mode");
    try {
      await win.getByLabel("Search query", { exact: true }).fill(`${RUN} late`); const pending = page.waitForResponse(r => new URL(r.url()).pathname === "/api/search" && new URL(r.url()).searchParams.get("q") === `${RUN} late`); await win.getByLabel("Search query", { exact: true }).press("Enter"); await win.getByText("Searching…", { exact: true }).waitFor();
      await win.getByRole("button", { name: "Clear recent searches", exact: true }).click(); await confirm(page, "Clear history"); await lock.query("commit"); assert.equal((await pending).status(), 200); await expect(win.getByText("Searching…", { exact: true })).toHaveCount(0); await expect(win.getByTestId("find-recents")).toHaveCount(0); assert.equal(await page.evaluate(() => localStorage.getItem("fusion.recent-searches.v1")), null);
    } finally { await lock.query("rollback"); lock.release(); }
  }));
  await write(`${DIR}/profile.json`, JSON.stringify({ lyrics: `${RUN} lyric needle`, artist: "Someone" }), "application/json");
  await test("SV-02: saved profiles replay every control instead of inheriting current phrase/field/source/filter state", { "SV-02": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search query", { exact: true }).fill(`${RUN} lyric`); await win.getByLabel("Scope", { exact: true }).fill(DIR); await win.getByLabel("Search mode").selectOption("metadata"); await win.getByLabel("Metadata field").fill("lyrics"); await win.getByLabel("Search source").selectOption("file"); await win.getByLabel("File extension").fill(".json"); await win.getByLabel("Result order").selectOption("reference"); await win.getByLabel("Filter results by pattern").fill("profile\\.json"); await win.getByLabel("regex", { exact: true }).check(); await win.getByLabel("case", { exact: true }).check();
    await win.getByRole("button", { name: "Save this search", exact: true }).click(); await page.getByTestId("ask-dialog").getByRole("textbox").fill("Complete profile"); await confirm(page, "Save search");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.saved-searches.v1") ?? "[]")); assert.deepEqual(searchInput(stored[0]), { ...EMPTY_SEARCH, q: `${RUN} lyric`, scope: DIR, mode: "metadata", field: "lyrics", source: "file", extension: ".json", sort: "reference", filter: "profile\\.json", regex: true, caseSensitive: true });
    await win.getByLabel("Search mode").selectOption("text"); await win.getByLabel("Exact phrase").check(); await win.getByLabel("Match strategy").selectOption("literal"); await win.getByLabel("Search query", { exact: true }).fill("different"); await win.getByLabel("Search source").selectOption("note"); await win.getByLabel("Result order").selectOption("title"); await win.getByLabel("Filter results by pattern").fill("wrong"); await win.getByLabel("regex", { exact: true }).uncheck(); await win.getByLabel("case", { exact: true }).uncheck();
    await win.getByRole("button", { name: "Complete profile", exact: true }).click(); await expect(win.getByLabel("Search mode")).toHaveValue("metadata"); await expect(win.getByLabel("Metadata field")).toHaveValue("lyrics"); await expect(win.getByLabel("File extension")).toHaveValue(".json"); await expect(win.getByLabel("Search source")).toHaveValue("file"); await expect(win.getByLabel("Result order")).toHaveValue("reference"); await expect(win.getByLabel("regex", { exact: true })).toBeChecked(); await expect(win.getByLabel("case", { exact: true })).toBeChecked();
    const data = await search(page, win); assert.ok(data.hits.some((h: any) => h.ref === `${DIR}/profile.json`)); await expect(win.getByTestId("find-results").locator("button.fs-list-item")).toHaveCount(1);
  }));
  await test("SV-03: native JSON download → delete → file import restores complete profiles; cancelled and invalid imports leave the list untouched", { "SV-03": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search query", { exact: true }).fill("portable μ profile"); await win.getByRole("button", { name: "Save this search", exact: true }).click(); await page.getByTestId("ask-dialog").getByRole("textbox").fill("Portable"); await confirm(page, "Save search"); await win.locator("summary").filter({ hasText: "Saved search files" }).click();
    const pending = page.waitForEvent("download"); await win.getByRole("button", { name: "Export searches", exact: true }).click(); const download = await pending, path = (await download.path())!; const bytes = readFileSync(path), portable = JSON.parse(bytes.toString()); assert.equal(portable.kind, "fusion.saved-searches.v2"); assert.equal(portable.searches[0].q, "portable μ profile");
    await win.getByRole("button", { name: "Delete saved search Portable", exact: true }).click(); await expect(win.getByRole("button", { name: "Portable", exact: true })).toHaveCount(0); await win.getByLabel("Import saved searches").setInputFiles({ name: "searches.json", mimeType: "application/json", buffer: bytes }); await confirm(page, "Cancel"); await expect(win.getByRole("button", { name: "Portable", exact: true })).toHaveCount(0);
    await win.getByLabel("Import saved searches").setInputFiles({ name: "searches.json", mimeType: "application/json", buffer: bytes }); await confirm(page, "Import searches"); await win.getByRole("button", { name: "Portable", exact: true }).click(); await expect(win.getByLabel("Search query", { exact: true })).toHaveValue("portable μ profile");
    const before = await page.evaluate(() => localStorage.getItem("fusion.saved-searches.v1")); await win.getByLabel("Import saved searches").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"kind":"fusion.saved-searches.v99","searches":[]}') }); await win.getByRole("alert").filter({ hasText: "supported" }).waitFor(); assert.equal(await page.evaluate(() => localStorage.getItem("fusion.saved-searches.v1")), before);
  }));
  const hang = await create(`${RUN} Regex budget`, "a".repeat(178) + "!");
  await test("Regex repair: native Worker times out hostile backtracking while the UI continues painting, then a corrected filter recovers", { "SR-10": "full" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search source").selectOption("note"); await win.getByLabel("Search query", { exact: true }).fill(hang.title); await win.getByLabel("Match strategy").selectOption("literal"); await search(page, win);
    await page.evaluate(() => { (window as any).__tt133Frames = 0; const end = performance.now() + 2000; const frame = () => { (window as any).__tt133Frames++; if (performance.now() < end) requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
    await win.getByLabel("Filter results by pattern").fill("(a+)+$"); await win.getByLabel("regex", { exact: true }).check(); await win.getByRole("alert").filter({ hasText: "timed out" }).waitFor({ timeout: 5000 }); assert.ok(await page.evaluate(() => (window as any).__tt133Frames) >= 5, "main thread stopped painting");
    await win.getByLabel("Filter results by pattern").fill("["); await win.getByRole("alert").filter({ hasText: "Invalid pattern" }).waitFor(); await win.getByLabel("Filter results by pattern").fill("Regex budget"); await expect(win.getByTestId("find-results").locator("button.fs-list-item")).toHaveCount(1);
  }));
  for (let i = 0; i < 65; i++) await write(`${DIR}/pages/${String(i).padStart(3, "0")}.json`, JSON.stringify({ marker: `${RUN}-pages` }), "application/json");
  await test("Regex patch attack: three genuine metadata pages accumulate 65 matches; all pass the worker's 50-text messages under one total budget", { "SR-10": "full", "SR-12": "partial" }, () => withModule("find", async (page, win) => {
    await win.getByLabel("Search mode").selectOption("metadata"); await win.getByLabel("Search query", { exact: true }).fill(`${RUN}-pages`); await win.getByLabel("Scope", { exact: true }).fill(`${DIR}/pages`); await win.getByLabel("File extension").fill(".json"); await search(page, win);
    for (let i = 0; i < 2; i++) { const next = page.waitForResponse(r => new URL(r.url()).pathname === "/api/search" && new URL(r.url()).searchParams.has("cursor")); await win.getByRole("button", { name: "Search next metadata page", exact: true }).click(); assert.equal((await next).status(), 200); await expect(win.getByText("Searching…", { exact: true })).toHaveCount(0); }
    await expect(win.getByTestId("find-results").locator("button.fs-list-item")).toHaveCount(65); await win.getByLabel("Filter results by pattern").fill("\\.json"); await win.getByLabel("regex", { exact: true }).check(); await expect(win.getByTestId("find-results").locator("button.fs-list-item")).toHaveCount(65); await expect(win.getByRole("alert")).toHaveCount(0);
  }));
  await test("No uncaught browser errors across Notes/Find native interaction cases", {}, () => assert.deepEqual(errors, []));
} finally {
  await fx.close(); await pool.end();
  // These IDs/paths were returned by real creates in this exclusive fixture.
  const rows = (await fx.api("GET", "/api/notes")).rows; for (const row of rows) if (notes.has(row.id) || row.title.startsWith(RUN)) await fx.api("DELETE", `/api/notes?id=${row.id}`);
  await fx.api("POST", "/api/fs", { op: "purge", path: DIR }); finish();
}
