import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import pg from "pg";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable database and BASE required");
const base = process.env.BASE;
const { test, finish } = makeHarness("e2e-tt151");
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return r.json();
}
const browser = await launchChromium();
async function open(module: string) {
  const cur = await api("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 10, y: 10, w: 1000, h: 760, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(base!, { waitUntil: "domcontentloaded" });
  const win = page.locator('[data-win-id="w1"]');
  await win.waitFor();
  await page.waitForFunction(id => (document.querySelector('[data-win-id="w1"]')?.getAttribute("aria-label") ?? "").toLowerCase().includes(id), module, { timeout: 25000 });
  return { context, page, win, errors };
}
await test("Beam renders and bounds local QR data and refuses overflow", {}, async () => {
  const { context, page, win, errors } = await open("beam");
  try {
    const input = win.getByTestId("qr-input");
    await input.fill("https://example.org/test");
    const svg = win.getByTestId("qr-canvas").locator("svg");
    await svg.waitFor();
    const box = await svg.boundingBox(); assert.ok(box && box.width <= 132 * 2);
    assert.equal(await svg.locator("path").count(), 1);
    await page.screenshot({ path: "/tmp/tt151-beam.png" });
    await input.fill("x".repeat(214));
    await win.getByText(/do not fit|too (?:long|large)|capacity|exceed/i).first().waitFor();
    assert.equal(await svg.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
await test("Vault session codes reject malformed URIs and disappear on lock", {}, async () => {
  const probe = await fetch(base + "/api/fs?op=read&path=%2FSystem%2Fvault.fvault");
  const found = await probe.json();
  assert.equal(found.ok, false, "test requires an empty disposable vault; refuses to overwrite an existing one");
  const { context, page, win, errors } = await open("vault");
  let vaultId: number | null = null;
  try {
    await win.getByLabel("Passphrase").fill("disposable-test-passphrase");
    await win.getByRole("button", { name: "Create", exact: true }).click();
    const uri = win.getByTestId("otp-uri"); await uri.waitFor();
    vaultId = (await api("GET", "/api/fs?op=stat&path=%2FSystem%2Fvault.fvault")).node.id;
    await uri.fill("otpauth://totp/%FF?secret=JBSWY3DPEHPK3PXP");
    await win.getByTestId("otp-add").click();
    await win.getByText("invalid label encoding").waitFor();
    await uri.fill("otpauth://totp/Test:alice?secret=JBSWY3DPEHPK3PXP&issuer=Test");
    await win.getByTestId("otp-add").click();
    const code = win.getByTestId("otp-code"); await code.waitFor();
    assert.match(await code.innerText(), /^\d{6}$/);
    assert.equal(await uri.inputValue(), "");
    await page.screenshot({ path: "/tmp/tt151-vault.png" });
    await win.getByRole("button", { name: "Lock", exact: true }).click();
    assert.equal(await code.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    if (vaultId !== null) {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      try {
        await pool.query("delete from vfs_versions where path in (select path from vfs_nodes where id=$1 and path='/System/vault.fvault')", [vaultId]);
        await pool.query("delete from index_docs where source='file' and ref='/System/vault.fvault' and exists (select 1 from vfs_nodes where id=$1 and path='/System/vault.fvault')", [vaultId]);
        await pool.query("delete from vfs_nodes where id=$1 and path='/System/vault.fvault'", [vaultId]);
      } finally { await pool.end(); }
    }
  }
});
await browser.close();
await finish();
