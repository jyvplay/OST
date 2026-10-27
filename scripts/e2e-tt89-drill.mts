/** Actual Chromium file chooser, downloaded encrypted archive, Web Crypto, API and isolated PostgreSQL. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing drill browser tests without TT89_DISPOSABLE_DATABASE=1 for a disposable server/database.");
const { test, finish } = makeHarness("e2e-tt89-drill");
const partial = { "BK-05": "partial" } as const;
const BASE = process.env.BASE ?? "http://localhost:3000";
const keyName = "fusion.backup.drill-health.v1", pass = "TT89-drill-private-password 🐚";
const requests: string[] = [], errors: string[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`); return j;
};
const getTheme = async () => (await api("GET", "/api/settings")).rows.find((r: any) => r.key === "appearance.theme").value;
const setTheme = (value: string) => api("PUT", "/api/settings", { key: "appearance.theme", value });
const initialTheme = await getTheme(), oldDesktop = await api("GET", "/api/state?id=default");
const rev = Number(oldDesktop.row?.revision ?? 1) + 1000;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
await setTheme("light");
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }); ctx.setDefaultTimeout(20_000);
const page = await ctx.newPage();
// Register interception before navigation; enabling it concurrently with a keyboard
// press can race the Chromium CDP command even when the DOM input was clicked.
page.on("filechooser", () => {});
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => { if (r.method() !== "GET") requests.push(`${r.url()}\n${r.postData() ?? ""}`); });
const app = () => page.getByRole("dialog", { name: "Backup", exact: true }).last();
const report = () => app().getByTestId("backup-drill-report");
const health = () => app().getByTestId("backup-drill-health");
const postCount = () => requests.filter((s) => s.includes("/api/backup")).length;
const upload = (buffer: Buffer, name = "selected-backup.json") => app().getByTestId("backup-drill-file").setInputFiles({ name, mimeType: "application/json", buffer });
let encrypted: Buffer, plain: Buffer, recovery = "";

try {
  await test("a real downloaded recovery-key archive is selected and the drill controls are keyboard accessible", partial, async () => {
    await page.goto(`${BASE}/?open=backup`, { waitUntil: "domcontentloaded" });
    await app().waitFor({ timeout: 30_000 }); await health().getByText(/No drill recorded/).waitFor();
    await app().getByRole("button", { name: "Build config bundle" }).click();
    await app().getByTestId("backup-report").getByText(/snapshot checksum verified/).waitFor();
    const [p] = await Promise.all([page.waitForEvent("download"), app().getByRole("button", { name: "Download plain" }).click()]);
    plain = readFileSync((await p.path())!);
    await app().getByLabel("Bundle passphrase").fill(pass);
    await app().getByRole("button", { name: "Generate recovery key" }).click();
    recovery = (await app().getByTestId("backup-recovery-key").innerText()).trim();
    await app().getByLabel("Confirm saved recovery key").fill(recovery);
    const [e] = await Promise.all([page.waitForEvent("download"), app().getByRole("button", { name: "Download with recovery key" }).click()]);
    encrypted = readFileSync((await e.path())!);
    await app().getByTestId("backup-report").getByText(/Recovery-key encrypted download started/i).waitFor();
    await page.bringToFront(); const chooser = app().getByRole("button", { name: "Choose backup to drill…" });
    assert.equal(await chooser.isEnabled(), true);
    await chooser.focus(); assert.equal(await chooser.evaluate((el) => el === document.activeElement), true);
    await page.evaluate(() => {
      (window as any).__tt89Keys = [];
      for (const type of ["keydown", "keyup", "click", "focusin"]) window.addEventListener(type, (e) => {
        (window as any).__tt89Keys.push({ type, target: (e.target as Element)?.outerHTML?.slice(0, 150), key: "key" in e ? (e as KeyboardEvent).key : "", prevented: e.defaultPrevented });
      }, true);
    });
    try { const [event] = await Promise.all([page.waitForEvent("filechooser", { timeout: 6_000 }), page.keyboard.press("Enter")]); assert.ok(event); }
    catch (error) { console.log("filechooser event trace:", await page.evaluate(() => (window as any).__tt89Keys)); throw error; }
  });
  await test("wrong password and modified ciphertext fail locally, do not post, and set failed status", partial, async () => {
    await app().getByLabel("Bundle passphrase").fill("incorrect password");
    let n = postCount(); await upload(encrypted!); await report().getByText(/Drill failed.*authentication failed/i).waitFor();
    assert.equal(postCount(), n); await health().getByText(/Last drill failed/).waitFor();
    await app().getByLabel("Bundle passphrase").fill(pass);
    const changed = JSON.parse(encrypted!.toString("utf8")); const bytes = Buffer.from(changed.data, "base64"); bytes[0] ^= 1; changed.data = bytes.toString("base64");
    n = postCount(); await upload(Buffer.from(JSON.stringify(changed))); await report().getByText(/Drill failed.*authentication failed/i).waitFor(); assert.equal(postCount(), n);
  });
  await test("real encrypted-file drill reads scratch state, confirms rollback, keeps live settings unchanged and persists only non-secret status", partial, async () => {
    await setTheme("dark"); await app().getByLabel("Bundle passphrase").fill(pass);
    await upload(encrypted!); await report().getByText(/Drill passed:.*rollback confirmed/i).waitFor();
    await health().getByText(/Last selected backup passed/).waitFor(); assert.equal(await getTheme(), "dark");
    const status = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), keyName))!);
    assert.equal(status.lastAttempt.kind, "config"); assert.equal(status.lastAttempt.outcome, "passed"); assert.ok(status.lastAttempt.settings > 0);
    assert.equal(status.lastSuccess, status.lastAttempt.at);
    const stored = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage), cookies: document.cookie }));
    assert.ok(!stored.includes(pass) && !stored.includes(recovery) && !stored.includes("selected-backup.json") && !stored.includes("appearance.theme"));
    assert.ok(requests.every((r) => !r.includes(pass) && !r.includes(recovery)));
  });
  await test("status survives reload and updates in a second same-origin tab", partial, async () => {
    await page.reload({ waitUntil: "domcontentloaded" }); await app().waitFor({ timeout: 30_000 }); await health().getByText(/Last selected backup passed/).waitFor();
    const other = await ctx.newPage();
    try {
      await other.goto(`${BASE}/?open=backup`, { waitUntil: "domcontentloaded" });
      const window = other.getByRole("dialog", { name: "Backup", exact: true }).last(); await window.waitFor({ timeout: 30_000 });
      await window.getByTestId("backup-drill-health").getByText(/Last selected backup passed/).waitFor();
      await page.evaluate((k) => {
        const s = JSON.parse(localStorage.getItem(k)!); s.lastAttempt.at = "2020-01-01T00:00:00.000Z"; s.lastSuccess = s.lastAttempt.at; localStorage.setItem(k, JSON.stringify(s));
      }, keyName);
      await window.getByTestId("backup-drill-health").getByText(/Monthly drill due/).waitFor();
    } finally { await other.close(); }
    await page.bringToFront(); await page.reload({ waitUntil: "domcontentloaded" }); await app().waitFor({ timeout: 30_000 }); await health().getByText(/Monthly drill due/).waitFor();
  });
  await test("recovery key opens the same saved archive for a drill and is absent from requests", partial, async () => {
    await app().getByLabel("Decrypt with").selectOption("recovery"); await app().getByLabel("Recovery key for restore").fill(recovery);
    await upload(encrypted!); await report().getByText(/Drill passed:.*rollback confirmed/i).waitFor();
    assert.equal(await app().getByLabel("Recovery key for restore").inputValue(), "");
    assert.ok(requests.every((r) => !r.includes(recovery))); assert.equal(await getTheme(), "dark");
  });
  await test("checksum tampering and a bad key change the latest state to failed, without erasing last success", partial, async () => {
    const old = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), keyName))!);
    await app().getByLabel("Recovery key for restore").fill(recovery.replace(/[0-9A-F](?=$)/, (x) => x === "0" ? "1" : "0"));
    let n = postCount(); await upload(encrypted!); await report().getByText(/Drill failed.*authentication failed/i).waitFor(); assert.equal(postCount(), n);
    await health().getByText(/Last drill failed/).waitFor();
    const failed = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), keyName))!); assert.equal(failed.lastSuccess, old.lastSuccess);
    await app().getByLabel("Decrypt with").selectOption("passphrase");
    const tampered = JSON.parse(plain!.toString("utf8")); tampered.settings[0].value += "tamper";
    n = postCount(); await upload(Buffer.from(JSON.stringify(tampered))); await report().getByText(/Drill failed.*checksum mismatch/i).waitFor(); assert.equal(postCount(), n);
  });
  await test("legacy file receives a partial result and a future local clock is not called healthy", partial, async () => {
    const text = "legacy", path = "/tt89-legacy", hash = createHash("sha256").update(text).digest("hex"), at = "2026-01-01T00:00:00.000Z";
    const legacy = { version: "fusion-bundle-1", exportedAt: at, kind: "data", entries: [{ path, kind: "file", mime: "text/plain", encoding: "utf8", content: text, size: text.length, tags: "", sha256: hash }], manifest: [{ path, sha256: hash, size: text.length }], notes: [], settings: [] };
    await upload(Buffer.from(JSON.stringify(legacy))); await report().getByText(/Partial drill:.*Legacy metadata/i).waitFor();
    await health().getByText(/Last drill was partial/).waitFor();
    await page.evaluate((k) => {
      const s = JSON.parse(localStorage.getItem(k)!); s.lastAttempt.at = "2099-01-01T00:00:00.000Z"; localStorage.setItem(k, JSON.stringify(s));
    }, keyName);
    await page.reload({ waitUntil: "domcontentloaded" }); await app().waitFor({ timeout: 30_000 }); await health().getByText(/Check the device clock/).waitFor();
  });
  await test("amnesic session refuses the drill and writes neither HTTP requests nor persistent health metadata", { "BK-05": "partial", "SC-13": "partial" }, async () => {
    const before = await page.evaluate((k) => localStorage.getItem(k), keyName); const n = postCount();
    await page.goto(`${BASE}/?amnesia=1&open=backup`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("amnesic-badge").first().waitFor({ timeout: 30_000 }); await app().waitFor({ timeout: 30_000 });
    await upload(plain!); await report().getByText(/unavailable in an amnesic/i).waitFor(); assert.equal(postCount(), n);
    // Navigate out of amnesia to inspect actual, unshadowed localStorage.
    await page.goto(`${BASE}/?open=backup`, { waitUntil: "domcontentloaded" }); await app().waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), keyName), before);
  });
  await test("drill UI has no serious or critical axe violations and no uncaught page errors", { "BK-05": "partial", "AX-01": "partial" }, async () => {
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await app().evaluate(async (el) => (await (window as any).axe.run(el, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations
      .filter((v: any) => v.impact === "critical" || v.impact === "serious").map((v: any) => `${v.id}: ${v.help}`));
    assert.deepEqual(violations, []); assert.deepEqual(errors, []);
  });
} finally {
  await ctx.close(); await browser.close(); await setTheme(initialTheme).catch(() => undefined);
  const current = await api("GET", "/api/state?id=default");
  if (oldDesktop.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 0) + 1000, state: oldDesktop.row.state }).catch(() => undefined);
}
finish();
