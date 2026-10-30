/** Real browser + disposable PostgreSQL/server regression. Never run on user data. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable database and server required");
const base = process.env.BASE;
const { test, finish } = makeHarness("e2e-tt126");
async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const browser = await launchChromium();
async function openModule(module: string) {
  const current = await request("GET", "/api/state?id=default");
  await request("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1000, h: 800, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  return { page, context };
}
await test("terminal aliases expand the command body, and inherited names do not crash", {}, async () => {
  const { page, context } = await openModule("terminal");
  try {
    const input = page.getByLabel("Terminal input");
    for (const cmd of ["alias greet=echo hello", "greet world", "constructor"]) { await input.fill(cmd); await input.press("Enter"); }
    await page.getByText("hello world", { exact: true }).waitFor();
    assert.match(await page.locator('[data-win-id="w1"]').innerText(), /constructor/);
  } finally { await context.close(); }
});
await test("vault: create, save, reuse audit, lock and reopen real encrypted data", {}, async () => {
  const path = "/System/vault.fvault";
  const existing = await fetch(base + `/api/fs?op=read&path=${encodeURIComponent(path)}`);
  if (existing.status !== 404) throw new Error("Refusing: disposable vault path is not empty");
  const { page, context } = await openModule("vault");
  try {
    const pass = page.getByLabel("Passphrase"); await pass.fill("test-passphrase-126");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("button", { name: "Add item" }).waitFor();
    for (const title of ["Mail 126", "Bank 126"]) {
      await page.getByRole("button", { name: "Add item" }).click();
      await page.getByLabel("Title", { exact: true }).fill(title);
      await page.getByLabel("Username", { exact: true }).fill("tester");
      await page.getByLabel("Secret", { exact: true }).fill("shared-test-secret");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByText(title, { exact: true }).waitFor();
    }
    const stored = await request("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`);
    assert.ok(!stored.node.content.includes("shared-test-secret"));
    await page.getByTestId("vault-audit-btn").click();
    await page.getByTestId("vault-audit").getByText(/2× shared/).waitFor();
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await pass.fill("test-passphrase-126"); await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await page.getByText("Mail 126", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("vault-audit").count(), 0);
    await page.getByRole("button", { name: "Delete", exact: true }).first().click();
    await page.getByText("Mail 126", { exact: true }).waitFor({ state: "detached" });
    await page.getByTestId("vault-audit-btn").click();
    await page.getByTestId("vault-audit").getByText("no secret is stored twice").waitFor();
  } finally {
    await context.close();
    await request("POST", "/api/fs", { op: "trash", path }).catch(() => {});
    await request("POST", "/api/fs", { op: "purge", path }).catch(() => {});
  }
});
await test("camera controls are visible without a device and report no torch", {}, async () => {
  const { page, context } = await openModule("lens");
  try {
    assert.equal(await page.getByTestId("lens-zoom").isDisabled(), true);
    assert.equal(await page.getByTestId("lens-torch").isDisabled(), true);
    await page.getByTestId("lens-torch").screenshot({ path: "/tmp/tt126-lens-torch.png" });
  } finally { await context.close(); }
});
await test("Files operation journal is named and keyboard-focusable", {}, async () => {
  const { page, context } = await openModule("files");
  try {
    const journal = page.getByRole("region", { name: "File operation journal" });
    await journal.waitFor(); await journal.focus();
    assert.equal(await journal.evaluate((el) => document.activeElement === el), true);
    await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (context: Element, options: object) => Promise<{ violations: { id: string }[] }> } }).axe;
      return (await axe.run(document.querySelector('[aria-label="File operation journal"]')!, { runOnly: ["scrollable-region-focusable"] })).violations;
    });
    assert.deepEqual(violations, []);
  } finally { await context.close(); }
});
await browser.close(); finish();
