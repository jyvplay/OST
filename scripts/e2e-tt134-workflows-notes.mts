/** Native Notes controls/downloads + actual HTTP/SQL. No injected app state,
 * replaced routes, clocks or services. Desktop fixture uses the public state API. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "playwright/test";
import type { Page, Locator } from "playwright";
import pg from "pg";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt134-workflows-notes");
const RUN = `tt134-notes-${Date.now().toString(36)}`, ids = new Set<number>(), templates = new Set<string>(), errors: string[] = [];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
async function create(title: string, body = "", tags = "") { const row = (await fx.api("POST", "/api/notes", { title, body, tags })).row; ids.add(row.id); return row; }
async function row(id: number) { return (await fx.api("GET", `/api/notes?id=${id}`)).row; }
async function notes(fn: (page: Page, win: Locator) => Promise<void>) {
  await fx.windows("notes"); const context = await fx.context(), page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  try { await fx.ready(page, "notes"); const win = page.locator('[data-win-id="w1"]'); await win.getByLabel("Note title", { exact: true }).waitFor(); await fn(page, win); }
  catch (error) { mkdirSync("docs/screens/tt134-workflow-failures", { recursive: true }); await page.screenshot({ path: `docs/screens/tt134-workflow-failures/${RUN}-${Date.now()}.png` }).catch(() => undefined); writeFileSync(`docs/evidence/${RUN}-${Date.now()}-ui.txt`, (await page.locator("body").innerText()).slice(0, 18000)); throw error; }
  finally { await context.close(); }
}
async function choose(win: Locator, title: string) { await win.getByLabel("Filter notes", { exact: true }).fill(title); await win.getByLabel("Notes list").getByRole("button").filter({ hasText: title }).first().click(); await expect(win.getByLabel("Note title", { exact: true })).toHaveValue(title); }
async function tools(win: Locator) { const more = win.getByTestId("note-editor").locator("details").first(); if (await more.getAttribute("open") === null) await more.locator(":scope > summary").click(); const tools = win.getByTestId("note-tools"); if (await tools.getAttribute("open") === null) await tools.locator(":scope > summary").click(); return tools; }
async function library(win: Locator) { const node = win.getByTestId("note-library"); if (await node.getAttribute("open") === null) await node.locator(":scope > summary").click(); return node; }
async function ask(page: Page, values: Record<string, string>, ok: string) { const dialog = page.getByTestId("ask-dialog"); await dialog.waitFor(); for (const [name, value] of Object.entries(values)) await dialog.getByTestId(`ask-input-${name}`).fill(value); await dialog.getByRole("button", { name: ok, exact: true }).click(); await expect(dialog).toHaveCount(0); }
async function save(page: Page, win: Locator) { const done = page.waitForResponse(r => new URL(r.url()).pathname === "/api/notes" && r.request().method() === "PUT"); await win.getByRole("button", { name: "Save", exact: true }).click(); assert.equal((await done).status(), 200); await expect(win.getByTestId("note-editor").getByText("saved", { exact: true })).toBeVisible(); }
async function batchResult(page: Page, action: () => Promise<void>) { const done = page.waitForResponse(r => new URL(r.url()).pathname === "/api/notes/batch" && r.request().method() === "POST"); await action(); const result = await done; assert.equal(result.status(), 200); const data = await result.json(); data.rows.forEach((row: any) => ids.add(row.id)); return data.rows; }
try {
  const portable = await create(`${RUN} portable`, 'exact\r\nμ 🧭 <script>literal</script>\n', "one,two");
  await test("NT-19: native collection download/file import round-trips fields into new indexed IDs; invalid/cancelled import changes nothing", { "NT-19": "full" }, () => notes(async (page, win) => {
    await choose(win, portable.title); const lib = await library(win); await win.getByLabel(`Check note: ${portable.title}`, { exact: true }).check();
    const download = page.waitForEvent("download"); await lib.getByRole("button", { name: "Export checked JSON", exact: true }).click(); const file = await download; const text = readFileSync((await file.path())!, "utf8"); const payload = JSON.parse(text);
    assert.deepEqual(payload.notes, [{ title: portable.title, body: portable.body, tags: portable.tags, pinned: false }]); assert.equal("id" in payload.notes[0], false);
    const before = (await fx.api("GET", "/api/notes")).rows.length;
    await lib.getByLabel("Import note collection").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...payload, notes: [{ ...payload.notes[0], id: portable.id }] })) }); await expect(lib.getByRole("alert")).toContainText("identities"); assert.equal((await fx.api("GET", "/api/notes")).rows.length, before);
    await lib.getByLabel("Import note collection").setInputFiles({ name: "copies.json", mimeType: "application/json", buffer: Buffer.from(text) }); await page.getByTestId("ask-dialog").getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal((await fx.api("GET", "/api/notes")).rows.length, before);
    const imported = await batchResult(page, async () => { await lib.getByLabel("Import note collection").setInputFiles({ name: "copies.json", mimeType: "application/json", buffer: Buffer.from(text) }); await ask(page, {}, "Import copies"); });
    assert.notEqual(imported[0].id, portable.id); assert.equal(imported[0].body, portable.body); assert.equal((await row(portable.id)).revision, portable.revision); assert.equal((await pool.query("select body from index_docs where source='note' and ref=$1", [String(imported[0].id)])).rows[0].body, portable.body);
  }));
  const a = await create(`${RUN} merge A`, "Saved A"), b = await create(`${RUN} merge B`, "Saved B");
  await test("NT-20: merge checked saved snapshots into a new note; an unsaved source draft and both original records remain exact", { "NT-20": "full" }, () => notes(async (page, win) => {
    await choose(win, a.title); await win.getByLabel("Note body").fill("unsaved source draft"); await win.getByLabel("Filter notes", { exact: true }).fill(`${RUN} merge`);
    const first = win.getByLabel(`Check note: ${a.title}`, { exact: true }), second = win.getByLabel(`Check note: ${b.title}`, { exact: true });
    await first.check(); await second.check(); await expect(first).toBeChecked(); await expect(second).toBeChecked();
    for (const check of [first, second]) { const target = await check.boundingBox(); assert.ok(target && target.width >= 24 && target.height >= 24, "collection check has a real 24px hit target"); }
    // Patch attack: both independent controlled check values must survive actual
    // native keyboard toggles, not just a transient input.checked observation.
    await first.press("Space"); await second.press("Space"); await expect(first).not.toBeChecked(); await expect(second).not.toBeChecked();
    await second.press("Space"); await first.press("Space"); await expect(first).toBeChecked(); await expect(second).toBeChecked(); const lib = await library(win);
    const merged = await batchResult(page, async () => { await lib.getByRole("button", { name: "Merge checked…", exact: true }).click(); await ask(page, { value: `${RUN} merged result` }, "Create merged note"); });
    assert.ok(merged[0].body.includes("Saved A")); assert.ok(merged[0].body.includes("Saved B")); assert.ok(!merged[0].body.includes("unsaved source draft")); await expect(win.getByLabel("Note body")).toHaveValue("unsaved source draft"); assert.equal((await row(a.id)).body, "Saved A"); assert.equal((await row(b.id)).body, "Saved B");
    await win.getByLabel(`Check note: ${b.title}`, { exact: true }).uncheck(); await expect(lib.getByRole("button", { name: "Merge checked…", exact: true })).toBeDisabled();
  }));
  const split = await create(`${RUN} split`, "original source");
  await test("NT-21: split the current draft at real top-level headings, ignore fenced headings, preserve every source character and support cancellation", { "NT-21": "full" }, () => notes(async (page, win) => {
    await choose(win, split.title); const body = `Prelude\n# ${RUN} One\nfirst\n\`\`\`\n# fenced\n\`\`\`\n# ${RUN} Two\nlast\n`; await win.getByLabel("Note body").fill(body); const t = await tools(win);
    await t.getByRole("button", { name: "Split at headings…", exact: true }).click(); await page.getByTestId("ask-cancel").click(); assert.equal((await row(split.id)).body, "original source");
    const sections = await batchResult(page, async () => { await t.getByRole("button", { name: "Split at headings…", exact: true }).click(); await ask(page, {}, "Create sections"); });
    assert.equal(sections.length, 3); assert.equal(sections.map((section: any) => section.body).join(""), body); await expect(win.getByLabel("Note body")).toHaveValue(body); assert.equal((await row(split.id)).body, "original source");
  }));
  const replace = await create(`${RUN} replace`, "alpha 🧭 alpha ALPHA");
  await test("NT-22: native find-next selects/wraps actual textarea matches; literal replace saves exact Unicode and empty find is refused", { "NT-22": "full" }, () => notes(async (page, win) => {
    await choose(win, replace.title); const t = await tools(win); await t.getByLabel("Find in note", { exact: true }).fill("alpha"); await t.getByRole("button", { name: "Find next", exact: true }).click();
    assert.equal(await win.getByLabel("Note body").evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd)), "alpha"); const first = await win.getByLabel("Note body").evaluate((node: HTMLTextAreaElement) => node.selectionStart);
    await t.getByRole("button", { name: "Find next", exact: true }).click(); const second = await win.getByLabel("Note body").evaluate((node: HTMLTextAreaElement) => node.selectionStart); assert.notEqual(first, second);
    await t.getByLabel("Replace in note", { exact: true }).fill("$&"); await t.getByRole("button", { name: "Replace all", exact: true }).click(); await expect(win.getByLabel("Note body")).toHaveValue("$& 🧭 $& ALPHA"); await save(page, win); assert.equal((await row(replace.id)).body, "$& 🧭 $& ALPHA");
    await t.getByLabel("Find in note", { exact: true }).fill(""); await t.getByRole("button", { name: "Replace all", exact: true }).click(); await expect(t.getByRole("alert")).toContainText("Find needs"); assert.equal((await row(replace.id)).body, "$& 🧭 $& ALPHA");
  }));
  const link = await create(`${RUN} link`, "LEFT🧭RIGHT");
  await test("NT-23: real selection + link form inserts a safe encoded Markdown anchor; active schemes fail without altering the draft", { "NT-23": "full" }, () => notes(async (page, win) => {
    await choose(win, link.title); const t = await tools(win), area = win.getByLabel("Note body"); await area.focus(); await area.press("Control+Home"); for (let i = 0; i < 4; i++) await area.press("ArrowRight"); await area.press("Shift+ArrowRight");
    await t.getByRole("button", { name: "Insert link…", exact: true }).click(); const dialog = page.getByTestId("ask-dialog"); await dialog.getByTestId("ask-input-label").fill("Compass"); await dialog.getByTestId("ask-input-url").fill("javascript:alert(1)"); await dialog.getByRole("button", { name: "Insert link", exact: true }).click(); await expect(page.getByTestId("ask-error")).toBeVisible(); await expect(area).toHaveValue("LEFT🧭RIGHT");
    await dialog.getByTestId("ask-input-url").fill("https://example.com/a(b)"); await dialog.getByTestId("ask-input-label").fill("bad\u0001label"); await dialog.getByRole("button", { name: "Insert link", exact: true }).click(); await expect(page.getByTestId("ask-error")).toBeVisible(); await expect(area).toHaveValue("LEFT🧭RIGHT"); await dialog.getByTestId("ask-input-label").fill("Compass"); await dialog.getByRole("button", { name: "Insert link", exact: true }).click(); await expect(area).toHaveValue("LEFT[Compass](https://example.com/a%28b%29)RIGHT"); await save(page, win); await win.getByRole("button", { name: "Preview", exact: true }).click(); await expect(win.getByTestId("note-preview").getByRole("link", { name: "Compass", exact: true })).toHaveAttribute("href", "https://example.com/a%28b%29");
  }));
  const table = await create(`${RUN} table`, "");
  await test("NT-24: table builder validates dimensions; native saved preview renders escaped cells/alignment without interpreting HTML", { "NT-24": "full" }, () => notes(async (page, win) => {
    await choose(win, table.title); const t = await tools(win); await t.getByRole("button", { name: "Insert table…", exact: true }).click(); const dialog = page.getByTestId("ask-dialog"); await dialog.getByTestId("ask-input-columns").fill("17"); await dialog.getByRole("button", { name: "Insert table", exact: true }).click(); await expect(page.getByTestId("ask-error")).toBeVisible(); await expect(win.getByLabel("Note body")).toHaveValue("");
    await dialog.getByTestId("ask-input-columns").fill("2"); await dialog.getByRole("button", { name: "Insert table", exact: true }).click(); assert.ok((await win.getByLabel("Note body").inputValue()).includes("| Column 1 | Column 2 |"));
    const source = "| left \\| pipe | right |\n| :--- | ---: |\n| <img src=x onerror=alert(1)> | **bold** |\n"; await win.getByLabel("Note body").fill(source); await save(page, win); await win.getByRole("button", { name: "Preview", exact: true }).click(); const grid = win.getByRole("table", { name: "Markdown table" }); await expect(grid.getByRole("columnheader").first()).toHaveText("left | pipe"); await expect(grid.getByRole("cell").first()).toContainText("<img"); assert.equal(await grid.locator("img,script,iframe").count(), 0); assert.equal(await grid.getByRole("columnheader").nth(1).evaluate(el => getComputedStyle(el).textAlign), "right"); assert.equal((await row(table.id)).body, source); mkdirSync("docs/screens/tt134-workflows-native", { recursive: true }); await win.screenshot({ path: "docs/screens/tt134-workflows-native/notes-table.png", animations: "disabled" });
  }));
  const template = await create(`${RUN} template source`, "Hello {{title}}\n{{date}} {{time}}\n{{evil()}}", "tag{{date}}");
  await test("NT-25: save a real VFS template and instantiate its local text tokens into a distinct indexed note without rewriting source/template", { "NT-25": "full" }, () => notes(async (page, win) => {
    await choose(win, template.title); const t = await tools(win), name = `${RUN} personal`; templates.add(`/System/NoteTemplates/${name}.json`);
    const written = page.waitForResponse(r => new URL(r.url()).pathname === "/api/fs" && r.request().method() === "POST" && r.request().postDataJSON()?.op === "writeIfUnchanged"); await t.getByRole("button", { name: "Save template…", exact: true }).click(); await ask(page, { value: name }, "Save template"); assert.equal((await written).status(), 200); await expect(t.getByRole("status")).toContainText("Template saved");
    const before = (await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(`/System/NoteTemplates/${name}.json`)}`)).node; const lib = await library(win); await lib.getByRole("button", { name: "Templates", exact: true }).click(); const title = `${RUN} instantiated`;
    const created = await batchResult(page, async () => { await lib.getByRole("button", { name, exact: true }).click(); await ask(page, { value: title }, "Create note"); }); assert.equal(created[0].title, title); assert.match(created[0].body, new RegExp(`^Hello ${title}\\n\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\n\\{\\{evil\\(\\)\\}\\}$`)); assert.equal((await row(template.id)).body, template.body); assert.equal((await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(before.path)}`)).node.sha256, before.sha256);
    await t.getByRole("button", { name: "Save template…", exact: true }).click(); await ask(page, { value: name }, "Save template"); await expect(t.getByRole("alert")).toBeVisible(); assert.equal((await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(before.path)}`)).node.sha256, before.sha256);
  }));
  const compare = await create(`${RUN} comparison`, "saved old");
  await test("NT-26: compare with a real concurrent saved winner; modal contains keyboard focus/blocks live tiling and never silently accepts its revision", { "NT-26": "full", "NT-08": "partial", "NT-10": "partial" }, () => notes(async (page, win) => {
    await choose(win, compare.title); await win.getByLabel("Note body").fill("my unsaved draft"); await fx.api("PUT", "/api/notes", { id: compare.id, expectedRevision: compare.revision, body: "external saved winner" });
    // Prove the same real shortcut is active before testing its modal refusal.
    await win.getByRole("button", { name: "Outline", exact: true }).focus(); const initial = await win.boundingBox(); await page.keyboard.press("Meta+ArrowRight"); await expect.poll(async () => (await win.boundingBox())?.x).not.toBe(initial!.x); const geometry = await win.boundingBox();
    const t = await tools(win); await t.getByRole("button", { name: "Compare saved body", exact: true }).click(); const dialog = page.getByRole("dialog", { name: /Saved revision/ }); await dialog.waitFor(); await expect(dialog.getByTestId("text-difference")).toContainText("external saved winner"); await expect(dialog).toContainText("my unsaved draft"); mkdirSync("docs/screens/tt134-workflows-native", { recursive: true }); await dialog.screenshot({ path: "docs/screens/tt134-workflows-native/notes-saved-comparison.png", animations: "disabled" });
    await page.keyboard.press("Meta+ArrowLeft"); await page.keyboard.press("Control+s"); assert.deepEqual(await win.boundingBox(), geometry); assert.equal((await row(compare.id)).body, "external saved winner");
    for (let i = 0; i < 4; i++) { await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab"); assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true); }
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(t.getByRole("button", { name: "Compare saved body", exact: true })).toBeFocused();
    // New patch-specific attack: a second async opening, pointer close, and
    // an actual post-close shortcut prove focus ownership and hold release.
    await t.getByRole("button", { name: "Compare saved body", exact: true }).click(); await dialog.waitFor(); await dialog.getByRole("button", { name: "Close", exact: true }).click(); await expect(t.getByRole("button", { name: "Compare saved body", exact: true })).toBeFocused(); await page.keyboard.press("Meta+ArrowLeft"); await expect.poll(async () => (await win.boundingBox())?.x).not.toBe(geometry!.x);
    await expect(win.getByLabel("Note body")).toHaveValue("my unsaved draft"); await win.getByRole("button", { name: "Save", exact: true }).click(); await expect(win.getByRole("alert").filter({ hasText: "changed in another window" })).toBeVisible(); assert.equal((await row(compare.id)).body, "external saved winner");
  }));
  const crlf = await create(`${RUN} CRLF range`, "first\r\nhead🧭tail\r\nlast");
  await test("NT-22/23 patch attack: a CRLF source find selects the visible Unicode match and link replacement preserves every other source byte", { "NT-22": "full", "NT-23": "full" }, () => notes(async (page, win) => {
    await choose(win, crlf.title); const t = await tools(win), body = win.getByLabel("Note body");
    await t.getByLabel("Find in note").fill("🧭"); await t.getByRole("button", { name: "Find next", exact: true }).click();
    assert.equal(await body.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd)), "🧭");
    await t.getByRole("button", { name: "Insert link…", exact: true }).click(); await ask(page, { label: "compass", url: "https://github.com/" }, "Insert link"); await save(page, win);
    assert.equal((await row(crlf.id)).body, crlf.body.replace("🧭", "[compass](https://github.com/)"));
  }));
  const tasks = await create(`${RUN} tasks`, `- [ ] ${RUN} open\n\`\`\`\n- [ ] ${RUN} fenced\n\`\`\`\n- [x] ${RUN} finished`);
  await test("NT-27: cross-note saved task rollup ignores fences, commits exact task markers and rejects a stale row instead of overwriting a real winner", { "NT-27": "full" }, () => notes(async (page, win) => {
    await choose(win, tasks.title); const lib = await library(win); await lib.getByRole("button", { name: "Tasks", exact: true }).click(); const board = lib.getByTestId("note-task-board"); await expect(board.getByText(`${RUN} fenced`, { exact: true })).toHaveCount(0);
    const done = page.waitForResponse(r => new URL(r.url()).pathname === "/api/notes" && r.request().method() === "PUT"); await board.getByLabel(`Complete task: ${RUN} open`, { exact: true }).click(); assert.equal((await done).status(), 200); assert.equal((await row(tasks.id)).body, tasks.body.replace("- [ ]", "- [x]")); await expect(board.getByLabel(`Complete task: ${RUN} open`, { exact: true })).toHaveCount(0);
    await board.getByLabel("Include completed tasks").check(); const winner = await row(tasks.id); await fx.api("PUT", "/api/notes", { id: winner.id, expectedRevision: winner.revision, body: winner.body + "\nexternal winner" }); await board.getByLabel(`Reopen task: ${RUN} open`, { exact: true }).click(); await expect(win.getByRole("alert").filter({ hasText: "changed in another window" })).toBeVisible(); assert.ok((await row(tasks.id)).body.endsWith("external winner"));
  }));
  const shifted = await create(`${RUN} shifted tasks`, `- [ ] ${RUN} guarded-line`);
  await test("NT-27 patch attack: an own Save inserting a line cannot retarget the old rollup checkbox to another source line", { "NT-27": "full" }, () => notes(async (page, win) => {
    await choose(win, shifted.title); await win.getByLabel("Note body").fill(`prefix\n${shifted.body}`); const lib = await library(win); await lib.getByRole("button", { name: "Tasks", exact: true }).click(); await lib.getByLabel(`Complete task: ${RUN} guarded-line`, { exact: true }).click(); await page.getByTestId("close-confirm-save").click(); await expect(win.getByRole("alert").filter({ hasText: "task source changed" })).toBeVisible(); assert.equal((await row(shifted.id)).body, `prefix\n${shifted.body}`);
    await lib.getByLabel(`Complete task: ${RUN} guarded-line`, { exact: true }).click(); await expect.poll(async () => (await row(shifted.id)).body).toBe(`prefix\n${shifted.body.replace("[ ]", "[x]")}`);
  }));
  await test("Large-text patch attack: the real async comparison heading follows saved 125/200 percent settings and remains closeable", { "AX-09": "partial", "NT-26": "partial" }, async () => {
    const savedScale = (await fx.api("GET", "/api/settings")).rows.find((setting: { key: string }) => setting.key === "appearance.textScale").value;
    try {
      for (const scale of [125, 200]) {
        await fx.api("PUT", "/api/settings", { key: "appearance.textScale", value: String(scale) });
        await notes(async (page, win) => {
          await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fs-ts").trim())).toBe(String(scale / 100));
          await choose(win, compare.title); const t = await tools(win); await t.getByRole("button", { name: "Compare saved body", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: /Saved revision/ }); await dialog.waitFor();
          await expect(dialog.getByRole("heading")).toHaveCSS("font-size", `${18 * scale / 100}px`); await expect(dialog.getByRole("heading")).toContainText(" vs current draft");
          await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
          if (scale === 200) { mkdirSync("docs/screens/tt134-workflows-native", { recursive: true }); await dialog.screenshot({ path: "docs/screens/tt134-workflows-native/notes-large-text-dialog.png", animations: "disabled" }); }
          await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(t.getByRole("button", { name: "Compare saved body", exact: true })).toBeFocused();
        });
      }
    } finally { await fx.api("PUT", "/api/settings", { key: "appearance.textScale", value: savedScale }); }
  });
  await test("Native Notes workflow pages emitted no unhandled browser exceptions", {}, () => assert.deepEqual(errors, []));
} finally {
  await fx.close();
  await pool.query("delete from index_docs where source='note' and ref=any($1::text[])", [[...ids].map(String)]); await pool.query("delete from notes where id=any($1::int[])", [[...ids]]);
  for (const path of templates) { await pool.query("delete from index_docs where source='file' and ref=$1", [path]); await pool.query("delete from vfs_nodes where path=$1", [path]); }
  await pool.end(); finish();
}
