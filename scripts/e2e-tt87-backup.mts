/** Real Chromium, WebCrypto, downloads, file chooser, two tabs, HTTP and PostgreSQL-backed shell. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("e2e-tt87-backup");
const BASE = process.env.BASE ?? "http://localhost:3999";
const pass = "TT87-private-passphrase-correct";
const requests: string[] = [], errors: string[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json(); if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`); return json;
};
const getTheme = async () => (await api("GET", "/api/settings")).rows.find((r: any) => r.key === "appearance.theme").value;
const setTheme = (value: string) => api("PUT", "/api/settings", { key: "appearance.theme", value });
const initialTheme = await getTheme();
const oldDesktop = await api("GET", "/api/state?id=default");
const rev = Number(oldDesktop.row?.revision ?? 1) + 1000;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
await setTheme("light");
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
ctx.setDefaultTimeout(20_000);
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => { if (r.method() !== "GET") requests.push(`${r.url()}\n${r.postData() ?? ""}`); });
const backup = (p: Page) => p.getByRole("dialog", { name: "Backup", exact: true }).last();
const report = () => backup(page).getByTestId("backup-report");
let encrypted: Buffer | null = null, plain: Buffer | null = null;
let other: Page | null = null;

try {
  await test("BK-03 UI builds a settings-only snapshot, verifies it and downloads both plaintext and authenticated encrypted files", { "BK-03": "full", "BK-06": "partial" }, async () => {
    await page.goto(`${BASE}/?open=backup`, { waitUntil: "domcontentloaded" });
    await backup(page).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await backup(page).getByRole("button", { name: "Build config bundle" }).click();
    await report().getByText(/settings.*snapshot checksum verified/).waitFor();
    await backup(page).getByRole("button", { name: "Verify digests" }).click();
    await report().getByText(/complete snapshot checksum/).waitFor();
    const [dl] = await Promise.all([page.waitForEvent("download"), backup(page).getByRole("button", { name: "Download plain" }).click()]);
    plain = readFileSync((await dl.path())!);
    const decoded = JSON.parse(plain.toString("utf8"));
    assert.equal(decoded.kind, "config"); assert.deepEqual(decoded.entries, []); assert.deepEqual(decoded.notes, []);
    assert.equal(decoded.settings.find((s: any) => s.key === "appearance.theme").value, "light");
    await backup(page).getByLabel("Bundle passphrase").fill(pass);
    const [enc] = await Promise.all([page.waitForEvent("download"), backup(page).getByRole("button", { name: "Download encrypted" }).click()]);
    encrypted = readFileSync((await enc.path())!);
    const env = JSON.parse(encrypted.toString("utf8"));
    assert.equal(env.format, "fusion-encrypted-bundle-2"); assert.equal(env.envelope.cipher, "AES-GCM-256");
    assert.ok(!encrypted.includes(Buffer.from(pass)) && !encrypted.includes(Buffer.from("appearance.theme")), "encrypted download leaks passphrase or plaintext key");
  });

  await test("BK-03 wrong passphrase, ciphertext mutation and plain checksum tampering are refused before any restore request", { "BK-03": "full", "BK-06": "partial" }, async () => {
    assert.ok(encrypted && plain);
    await backup(page).getByLabel("Bundle passphrase").fill("wrong-password");
    let before = requests.filter((s) => s.includes("/api/backup")).length;
    await backup(page).getByTestId("backup-file").setInputFiles({ name: "backup.enc.json", mimeType: "application/json", buffer: encrypted! });
    await report().getByText(/Import failed:.*authentication failed/i).waitFor();
    assert.equal(requests.filter((s) => s.includes("/api/backup")).length, before);
    await backup(page).getByLabel("Bundle passphrase").fill(pass);
    const changed = JSON.parse(encrypted!.toString("utf8"));
    const d = changed.envelope.data as string; const i = Math.floor(d.length / 2); changed.envelope.data = d.slice(0, i) + (d[i] === "A" ? "B" : "A") + d.slice(i + 1);
    before = requests.filter((s) => s.includes("/api/backup")).length;
    await backup(page).getByTestId("backup-file").setInputFiles({ name: "tamper.enc.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(changed)) });
    await report().getByText(/Import failed:.*authentication failed/i).waitFor();
    assert.equal(requests.filter((s) => s.includes("/api/backup")).length, before);
    const changedPlain = JSON.parse(plain!.toString("utf8"));
    changedPlain.settings.find((s: any) => s.key === "appearance.theme").value = "dark";
    await backup(page).getByTestId("backup-file").setInputFiles({ name: "tamper.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(changedPlain)) });
    await report().getByText(/Import failed:.*checksum mismatch/i).waitFor();
    assert.equal(requests.filter((s) => s.includes("/api/backup")).length, before);
  });

  await test("BK-03 encrypted UI restore previews, can cancel, applies settings live in two tabs and never posts the passphrase", { "BK-03": "full", "BK-06": "partial" }, async () => {
    assert.ok(encrypted);
    await setTheme("dark");
    await page.reload({ waitUntil: "domcontentloaded" }); await backup(page).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    other = await ctx.newPage(); other.on("pageerror", (e) => errors.push(e.message));
    await other.goto(BASE, { waitUntil: "domcontentloaded" });
    await other.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await backup(page).getByLabel("Bundle passphrase").fill(pass);
    const file = { name: "backup.enc.json", mimeType: "application/json", buffer: encrypted! };
    await backup(page).getByTestId("backup-file").setInputFiles(file);
    let preview = backup(page).getByTestId("backup-preview"); await preview.waitFor();
    assert.match(await preview.innerText(), /1 settings to change/);
    assert.equal(await getTheme(), "dark");
    await preview.getByRole("button", { name: "Cancel restore" }).click();
    assert.equal(await getTheme(), "dark");
    await backup(page).getByTestId("backup-file").setInputFiles(file);
    preview = backup(page).getByTestId("backup-preview"); await preview.waitFor();
    await preview.getByRole("button", { name: "Restore now" }).click();
    await report().getByText(/Restore committed/).waitFor();
    assert.equal(await getTheme(), "light");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await other.waitForFunction(() => document.documentElement.dataset.theme === "light");
    assert.ok(requests.every((s) => !s.includes(pass)), "passphrase left the browser in a request");
  });

  await test("BK-03 stale preview is refused visibly; the concurrently changed value is kept", { "BK-03": "full" }, async () => {
    assert.ok(plain);
    await backup(page).getByTestId("backup-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: plain! });
    const p = backup(page).getByTestId("backup-preview"); await p.waitFor();
    await setTheme("dark");
    await p.getByRole("button", { name: "Restore now" }).click();
    await report().getByText(/destination changed since preview/i).waitFor();
    assert.equal(await getTheme(), "dark");
  });

  await test("BK-03 backup controls have a keyboard-accessible chooser and no serious or critical axe violations", { "BK-03": "partial", "AX-01": "partial" }, async () => {
    const chooser = backup(page).getByRole("button", { name: "Choose bundle…" });
    // The cross-tab test left a second page open; keyboard input belongs to the foreground tab.
    await page.bringToFront();
    await chooser.focus(); assert.equal(await chooser.evaluate((el) => el === document.activeElement), true);
    const [fileChooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
    assert.ok(fileChooser);
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await backup(page).evaluate(async (el) => (await (window as any).axe.run(el, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations
      .filter((v: any) => v.impact === "critical" || v.impact === "serious").map((v: any) => `${v.id}: ${v.help}`));
    assert.deepEqual(violations, []);
  });
  await test("TT87 browser session has no uncaught page errors", { "BK-03": "partial" }, () => { assert.deepEqual(errors, []); });
} finally {
  await ctx.close(); await browser.close();
  await setTheme(initialTheme).catch(() => undefined);
  const current = await api("GET", "/api/state?id=default");
  if (oldDesktop.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 0) + 1000, state: oldDesktop.row.state }).catch(() => undefined);
}
finish();
