/** Real browser clipboard API with actual permission grants and native UI
 * capture; no history/React injection, replacement transport or fake clock. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { expect } from "playwright/test";
import type { Page, Locator } from "playwright";
import pg from "pg";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt134-workflows-clipboard");
const RUN = `tt134-clips-${Date.now().toString(36)}`, DIR = `/Documents/${RUN}`, ids = new Set<number>(), errors: string[] = [];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); let vaultId: number | null = null;
async function clipboard(fn: (page: Page, win: Locator) => Promise<void>, custom = false) {
  if (!custom) await fx.windows("clipboard"); const ctx = await fx.context({ permissions: ["clipboard-read", "clipboard-write"] }), page = await ctx.newPage(); page.on("pageerror", e => errors.push(e.message));
  try { await fx.ready(page, "clipboard"); const win = page.locator('[data-win-id="w1"]'); await expect(win.getByRole("button", { name: "Capture system clipboard now", exact: true })).toBeEnabled(); await fn(page, win); }
  catch (error) { mkdirSync("docs/screens/tt134-workflow-failures", { recursive: true }); await page.screenshot({ path: `docs/screens/tt134-workflow-failures/${RUN}-${Date.now()}.png` }).catch(() => undefined); throw error; }
  finally { await ctx.close(); }
}
async function capture(page: Page, win: Locator, text: string) {
  // The actual browser clipboard is the outside input fixture; the user-facing
  // capture button is the only route that adds it to Fusion history.
  await page.bringToFront(); await page.evaluate(text => navigator.clipboard.writeText(text), text); await win.getByRole("button", { name: "Capture system clipboard now", exact: true }).click();
  // Wait for the complete actual capture, not a common first line that may
  // already exist. A later insertion may legitimately change ordinal locators.
  const item = win.getByRole("listitem").filter({ hasText: text }).first(); await expect(item.locator(".fs-mono")).toHaveText(text); return item;
}
async function openTools(item: Locator) { const detail = item.locator("details"); if (await detail.getAttribute("open") === null) await detail.locator("summary").click(); return detail; }
async function ask(page: Page, value: string, ok: string) { const dialog = page.getByTestId("ask-dialog"); await dialog.waitFor(); await dialog.getByTestId("ask-input-value").fill(value); await dialog.getByRole("button", { name: ok, exact: true }).click(); await expect(dialog).toHaveCount(0); }
try {
  await fx.api("POST", "/api/fs", { op: "mkdir", path: DIR });
  await test("CB-04: native inspector exposes full exact text and copies only the real Unicode selection; source remains intact", { "CB-04": "full" }, () => clipboard(async (page, win) => {
    const text = "head🧭tail\nsecond line", item = await capture(page, win, text); await (await openTools(item)).getByRole("button", { name: "Inspect", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Inspect clipboard text", exact: true }), area = dialog.getByLabel("Full clipboard text"); await expect(area).toHaveValue(text); await expect(dialog).toContainText(`${text.length} UTF-16 code units`); await expect(dialog.getByRole("button", { name: "Copy selected text", exact: true })).toBeDisabled();
    await dialog.getByLabel("Clipboard selection start").fill("4"); await dialog.getByLabel("Clipboard selection end").fill("6"); await dialog.getByRole("button", { name: "Select range", exact: true }).click(); assert.equal(await area.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd)), "🧭"); mkdirSync("docs/screens/tt134-workflows-native", { recursive: true }); await dialog.screenshot({ path: "docs/screens/tt134-workflows-native/clipboard-inspector.png", animations: "disabled" }); await dialog.getByRole("button", { name: "Copy selected text", exact: true }).click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("🧭"); await expect(area).toHaveValue(text); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(item.locator(".fs-mono")).toHaveText(text);
  }));
  await test("CB-04 patch attack: CRLF excerpts retain source bytes; bisected Unicode ranges refuse; async focus loss cannot strand Escape", { "CB-04": "full" }, () => clipboard(async (page, win) => {
    const text = "head🧭tail\r\nsecond line", item = await capture(page, win, text); await (await openTools(item)).getByRole("button", { name: "Inspect", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Inspect clipboard text", exact: true }), area = dialog.getByLabel("Full clipboard text"); await expect(area).toHaveValue(text.replace(/\r\n?/g, "\n"));
    await dialog.getByLabel("Clipboard selection start").fill("5"); await dialog.getByLabel("Clipboard selection end").fill("6"); await dialog.getByRole("button", { name: "Select range", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("valid Unicode"); await expect(dialog.getByRole("button", { name: "Copy selected text", exact: true })).toBeDisabled();
    await dialog.getByLabel("Clipboard selection start").fill("10"); await dialog.getByLabel("Clipboard selection end").fill("12"); await dialog.getByRole("button", { name: "Select range", exact: true }).click();
    await dialog.getByRole("button", { name: "Copy selected text", exact: true }).click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("\r\ns"); await expect(dialog.getByRole("button", { name: "Copy selected text", exact: true })).toBeEnabled();
    console.log("Actual post-copy native focus:", await page.evaluate(() => ({ tag: document.activeElement?.tagName, inside: !!document.activeElement?.closest("[data-workflow-dialog]") })));
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); assert.equal(await item.locator(".fs-mono").textContent(), text);
    const old = await win.boundingBox(); await page.keyboard.press("Meta+ArrowRight"); await expect.poll(async () => (await win.boundingBox())?.x).not.toBe(old!.x);
  }));
  await test("CB-05: editing creates a new native clipboard/history copy while retaining the original text and pin", { "CB-05": "full" }, () => clipboard(async (page, win) => {
    const original = await capture(page, win, "Original μ text"); await original.getByRole("button", { name: /^Pin/ }).click(); await (await openTools(original)).getByRole("button", { name: "Edit copy", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Edit a clipboard copy", exact: true }); await dialog.getByLabel("Edited clipboard copy").fill("Edited 🧭\nnew line"); await dialog.getByRole("button", { name: "Add edited copy", exact: true }).click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Edited 🧭\nnew line"); await dialog.getByRole("button", { name: "Close", exact: true }).click(); await expect(win.getByRole("listitem")).toHaveCount(2); await expect(win.locator('[data-pinned="1"] .fs-mono')).toHaveText("Original μ text");
  }));
  await test("CB-06: save a clipboard entry through its real form into a separately indexed public note; blank title cannot commit", { "CB-06": "full" }, () => clipboard(async (page, win) => {
    const text = "Clipboard note μ 🧭\n<script>literal</script>", item = await capture(page, win, text); await (await openTools(item)).getByRole("button", { name: "Save as note…", exact: true }).click(); const dialog = page.getByTestId("ask-dialog"); await dialog.getByTestId("ask-input-value").fill(" "); await dialog.getByRole("button", { name: "Create note", exact: true }).click(); await expect(page.getByTestId("ask-error")).toBeVisible();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/notes" && r.request().method() === "POST"); await dialog.getByTestId("ask-input-value").fill(`${RUN} saved note`); await dialog.getByRole("button", { name: "Create note", exact: true }).click(); const result = await response; assert.equal(result.status(), 200); const row = (await result.json()).row; ids.add(row.id); assert.equal(row.body, text); assert.equal(row.tags, "clipboard"); assert.equal((await pool.query("select body from index_docs where source='note' and ref=$1", [String(row.id)])).rows[0].body, text); await expect(item.locator(".fs-mono")).toHaveText(text);
  }));
  await test("CB-07: create-only public file transfer preserves exact bytes; Private paths and an existing-file overwrite are refused", { "CB-07": "full" }, () => clipboard(async (page, win) => {
    const text = "File μ 🧭\nexact text", path = `${DIR}/saved.txt`, item = await capture(page, win, text), tools = await openTools(item); await tools.getByRole("button", { name: "Save as file…", exact: true }).click(); const dialog = page.getByTestId("ask-dialog"); await dialog.getByTestId("ask-input-value").fill("/Private/never.txt"); await dialog.getByRole("button", { name: "Create file", exact: true }).click(); await expect(page.getByTestId("ask-error")).toContainText("Private");
    let response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/fs" && r.request().method() === "POST" && r.request().postDataJSON()?.op === "writeIfUnchanged"); await dialog.getByTestId("ask-input-value").fill(path); await dialog.getByRole("button", { name: "Create file", exact: true }).click(); assert.equal((await response).status(), 200); const before = (await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node; assert.equal(before.content, text); assert.equal(before.size, Buffer.byteLength(text));
    response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/fs" && r.request().method() === "POST" && r.request().postDataJSON()?.op === "writeIfUnchanged"); await tools.getByRole("button", { name: "Save as file…", exact: true }).click(); await ask(page, path, "Create file"); assert.equal((await response).status(), 409); const after = (await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node; assert.equal(after.sha256, before.sha256); assert.equal(after.version, before.version);
  }));
  await test("CB-08: check two real captures and compare their exact changed lines; one capture cannot launch a comparison", { "CB-08": "full" }, () => clipboard(async (page, win) => {
    await capture(page, win, "same\nold 🧭\nend"); await expect(win.getByRole("button", { name: /Compare checked/ })).toBeDisabled(); await capture(page, win, "same\nnew μ\nend"); const boxes = win.getByRole("checkbox", { name: /^Compare clipboard entry/ }); await boxes.nth(0).check(); await expect(boxes.nth(0)).toBeChecked(); await expect(win.getByRole("button", { name: /Compare checked/ })).toHaveText("Compare checked (1/2)"); await boxes.nth(1).check(); await expect(boxes.nth(1)).toBeChecked(); await expect(win.getByRole("button", { name: /Compare checked/ })).toHaveText("Compare checked (2/2)"); await win.getByRole("button", { name: /Compare checked/ }).click(); const dialog = page.getByRole("dialog", { name: "Clipboard text comparison", exact: true }); await expect(dialog.getByTestId("text-difference")).toContainText("old 🧭"); await expect(dialog.getByTestId("text-difference")).toContainText("new μ"); await expect(dialog).toContainText("not a minimal diff"); await page.keyboard.press("Tab"); assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true); await page.keyboard.press("Escape"); await expect(win.getByRole("listitem")).toHaveCount(2);
  }));
  await test("CB-08 patch attack: repeated native keyboard/pointer toggles keep both independent checks and release comparison focus", { "CB-08": "full" }, () => clipboard(async (page, win) => {
    await capture(page, win, "toggle source one"); await capture(page, win, "toggle source two");
    const boxes = win.getByRole("checkbox", { name: /^Compare clipboard entry/ }), compare = win.getByRole("button", { name: /Compare checked/ });
    for (const index of [0, 1]) { const target = await boxes.nth(index).boundingBox(); assert.ok(target && target.width >= 24 && target.height >= 24, "comparison check has a real 24px hit target"); }
    for (let i = 0; i < 6; i++) {
      await boxes.nth(0).press("Space"); await boxes.nth(1).press("Space");
      await expect(boxes.nth(0)).toBeChecked(); await expect(boxes.nth(1)).toBeChecked(); await expect(compare).toHaveText("Compare checked (2/2)");
      await compare.click(); const dialog = page.getByRole("dialog", { name: "Clipboard text comparison", exact: true });
      await expect(dialog).toContainText("toggle source one"); await expect(dialog).toContainText("toggle source two");
      if (i === 0) { mkdirSync("docs/screens/tt134-workflows-native", { recursive: true }); await dialog.screenshot({ path: "docs/screens/tt134-workflows-native/clipboard-comparison.png", animations: "disabled" }); }
      await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(compare).toBeFocused();
      await boxes.nth(1).click(); await boxes.nth(0).click(); await expect(boxes.nth(0)).not.toBeChecked(); await expect(boxes.nth(1)).not.toBeChecked(); await expect(compare).toHaveText("Compare checked (0/2)");
    }
    await expect(win.getByRole("listitem")).toHaveCount(2);
  }));
  await test("CB-08 readiness attack: a checked identity stays checked when same-prefix native captures arrive", { "CB-08": "full" }, () => clipboard(async (page, win) => {
    for (let i = 0; i < 4; i++) {
      const a = await capture(page, win, `shared prefix\nidentity ${i} A`), first = a.getByRole("checkbox");
      await first.check(); await expect(first).toBeChecked();
      const b = await capture(page, win, `shared prefix\nidentity ${i} B`), second = b.getByRole("checkbox");
      await expect(first).toBeChecked(); await expect(second).not.toBeChecked();
      await expect(win.getByRole("button", { name: /Compare checked/ })).toHaveText("Compare checked (1/2)");
      await second.check(); await expect(first).toBeChecked(); await expect(second).toBeChecked();
      await win.getByRole("button", { name: /Compare checked/ }).click();
      const dialog = page.getByRole("dialog", { name: "Clipboard text comparison", exact: true });
      await expect(dialog).toContainText(`identity ${i} A`); await expect(dialog).toContainText(`identity ${i} B`);
      await page.keyboard.press("Escape"); await first.uncheck(); await second.uncheck();
      await expect(first).not.toBeChecked(); await expect(second).not.toBeChecked();
    }
  }));
  await test("Sensitive native Vault copy is masked and every new inspect/edit/export/compare command is disabled", { "CB-04": "partial", "CB-05": "partial", "CB-06": "partial", "CB-07": "partial", "CB-08": "partial" }, async () => {
    const preflight = await fetch(fx.BASE + "/api/fs?op=stat&path=%2FSystem%2Fvault.fvault"); const current = await preflight.json(); assert.ok(preflight.status === 404 || !current.node, "Sensitive native drill requires no existing user vault; refusing to overwrite one");
    const state = await fx.api("GET", "/api/state?id=default"); await fx.api("PUT", "/api/state", { id: "default", revision: Number(state.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "clipboard", title: "Clipboard", x: 18, y: 16, w: 700, h: 810, z: 10, workspace: 1, props: {} }, { id: "w2", module: "vault", title: "Vault", x: 740, y: 16, w: 730, h: 810, z: 11, workspace: 1, props: {} }], focus: "w2", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
    await clipboard(async (page, win) => {
      const vault = page.locator('[data-win-id="w2"]'); await vault.getByLabel("Passphrase", { exact: true }).fill(`${RUN} owned native passphrase`); await vault.getByRole("button", { name: "Create", exact: true }).click(); await vault.getByRole("button", { name: "Add item", exact: true }).waitFor(); vaultId = (await fx.api("GET", "/api/fs?op=stat&path=%2FSystem%2Fvault.fvault")).node.id;
      await vault.getByRole("button", { name: "Add item", exact: true }).click(); const dialog = page.getByTestId("ask-dialog"); await dialog.getByTestId("ask-input-title").fill(`${RUN} owned item`); await dialog.getByTestId("ask-input-username").fill("owned-user"); await dialog.getByTestId("ask-input-secret").fill(`${RUN} owned secret`); await dialog.getByRole("button", { name: "Add", exact: true }).click(); await vault.getByRole("button", { name: "Copy", exact: true }).click();
      const entry = win.getByRole("listitem").filter({ hasText: "sensitive · masked" }); await entry.waitFor(); const tools = await openTools(entry); for (const name of ["Inspect", "Edit copy", "Save as note…", "Save as file…"]) await expect(tools.getByRole("button", { name, exact: true })).toBeDisabled(); await expect(entry.getByRole("checkbox")).toBeDisabled(); assert.equal((await win.innerText()).includes(`${RUN} owned secret`), false);
    }, true);
  });
  await test("Real emergency chord remains active while the new clipboard modal owns normal shortcuts", { "CB-04": "partial" }, () => clipboard(async (page, win) => {
    const entry = await capture(page, win, "Emergency-owned test text"); await (await openTools(entry)).getByRole("button", { name: "Inspect", exact: true }).click(); await page.getByRole("dialog", { name: "Inspect clipboard text", exact: true }).waitFor(); await page.keyboard.press("Control+Alt+Shift+Backspace"); await page.waitForURL("about:blank"); assert.equal(await page.locator("textarea").count(), 0);
  }));
  await test("Native clipboard workflows emitted no unhandled browser exceptions", {}, () => assert.deepEqual(errors, []));
} finally {
  await fx.close(); await pool.query("delete from index_docs where source='note' and ref=any($1::text[])", [[...ids].map(String)]); await pool.query("delete from notes where id=any($1::int[])", [[...ids]]); await pool.query("delete from index_docs where source='file' and (ref=$1 or starts_with(ref,$1||'/'))", [DIR]); await pool.query("delete from vfs_versions where path=$1 or starts_with(path,$1||'/')", [DIR]); await pool.query("delete from vfs_nodes where path=$1 or starts_with(path,$1||'/')", [DIR]);
  if (vaultId !== null) { await pool.query("delete from vfs_versions where path in (select path from vfs_nodes where id=$1 and path='/System/vault.fvault')", [vaultId]); await pool.query("delete from index_docs where source='file' and ref='/System/vault.fvault'"); await pool.query("delete from vfs_nodes where id=$1 and path='/System/vault.fvault'", [vaultId]); }
  await pool.end(); finish();
}
