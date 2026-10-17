/**
 * TT20 visual inspection: Privacy ▸ Persistent Storage backup (made + verified) and the amnesic "Unsaved work" list.
 * Creates a throwaway volume (refuses if one exists) and deletes it afterwards.
 * Run: BASE=http://localhost:3999 DATABASE_URL=… node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt20.mts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const PASS = "visual check passphrase five words";
const api = (method: string, path: string, body?: unknown) => fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
if ((await api("GET", "/api/fs?op=read&path=/Private/.keyslots.json")).status !== 404) { console.error("a volume exists — refusing"); process.exit(2); }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
async function desktop() {
  const cur = await (await api("GET", "/api/state?id=default")).json(); const rev = Number(cur.row?.revision ?? 1) + 1000;
  const w = { id: "wp", module: "privacy", title: "Privacy", x: 300, y: 40, w: 820, h: 800, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} };
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [w], focus: "wp", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on("dialog", (d) => void d.accept());
const root = () => page.locator('[data-testid="privacy"]').first();
try {
  await desktop();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await root().locator('[data-testid="pp1"]').fill(PASS, { timeout: 30_000 });
  await root().locator('[data-testid="pp2"]').fill(PASS);
  await root().locator('[data-testid="create"]').click();
  await root().getByRole("button", { name: "I have saved it" }).click({ timeout: 30_000 });
  for (const [p, c] of [["/Private/Taxes/2026 return.txt", "draft"], ["/Private/Journal/october.md", "# notes"], ["/Private/photo.txt", "x".repeat(5000)]]) {
    await page.evaluate(async ([p2, c2]) => { await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: p2, content: c2 }) }); }, [p, c]);
  }
  const [dl] = await Promise.all([page.waitForEvent("download"), root().locator('[data-testid="backup-download"]').click()]);
  const file = join(mkdtempSync(join(tmpdir(), "shots20-")), dl.suggestedFilename()); await dl.saveAs(file);
  await root().locator('[data-testid="backup-file"]').first().setInputFiles(file);
  await root().locator('[data-testid="backup-verify"]').click();
  await root().locator('[data-testid="backup-report"]').getByText(/Backup OK/).waitFor({ timeout: 20_000 });
  await root().locator('[data-testid="backup-download"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/screenshots/tt20-privacy-backup.png" });

  await desktop();
  await page.goto(BASE + "/?amnesia=1", { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="amnesic-badge"]').click({ timeout: 30_000 });
  await root().locator('[data-testid="unlock-pass"]').fill(PASS, { timeout: 30_000 });
  await root().locator('[data-testid="unlock"]').click();
  await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 30_000 });
  for (const p of ["/Documents/letter draft.docx", "/Downloads/boarding-pass.pdf"]) {
    await page.evaluate(async (p2) => { await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: p2, content: "unsaved work ".repeat(200) }) }); }, p);
  }
  await root().getByRole("tab", { name: "Amnesia", exact: true }).click();
  await root().locator('[data-testid="ram-files"]').waitFor({ timeout: 10_000 });
  await root().locator('[data-testid="ram-files"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/screenshots/tt20-amnesic-unsaved.png" });
  console.log("shots written");
} finally {
  await db.query("delete from vfs_versions where path like '/Private/%'");
  await db.query("delete from vfs_nodes where path like '/Private/%'");
  await db.end(); await browser.close();
}
