/** Real Chromium: create/download, both unlock paths, negative inputs and a PostgreSQL-backed restore. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { sealText } from "../src/lib/crypto.ts";

const { test, finish } = makeHarness("e2e-tt88-recovery");
const BASE = process.env.BASE ?? "http://localhost:3999";
const pass = "TT88 local passphrase 🐚";
const requests: string[] = [], errors: string[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`); return j;
};
const getTheme = async () => (await api("GET", "/api/settings")).rows.find((r: any) => r.key === "appearance.theme").value;
const setTheme = (v: string) => api("PUT", "/api/settings", { key: "appearance.theme", value: v });
const initialTheme = await getTheme(), oldDesktop = await api("GET", "/api/state?id=default");
const rev = Number(oldDesktop.row?.revision ?? 1) + 1000;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
await setTheme("light");
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
ctx.setDefaultTimeout(20_000);
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => { if (r.method() !== "GET") requests.push(`${r.url()}\n${r.postData() ?? ""}`); });
const app = () => page.getByRole("dialog", { name: "Backup", exact: true }).last();
const report = () => app().getByTestId("backup-report");
const postCount = () => requests.filter((s) => s.includes("/api/backup")).length;
let key = "", encrypted: Buffer, independentPlain = "";
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const pythonOracle = (operation: "open" | "seal", value: object) => JSON.parse(execFileSync(PY, ["scripts/oracle/recovery_crypto.py"], {
  input: JSON.stringify({ operation, passphrase: pass, recovery: key, ...value }), encoding: "utf8",
}));
const upload = (buffer: Buffer) => app().getByTestId("backup-file").setInputFiles({ name: "recover.json", mimeType: "application/json", buffer });

try {
  await test("BK-06 generate and confirm a user-held key before downloading a real recovery-key archive", { "BK-06": "full" }, async () => {
    await page.goto(`${BASE}/?open=backup`, { waitUntil: "domcontentloaded" });
    await app().waitFor({ timeout: 30_000 });
    await app().getByRole("button", { name: "Build config bundle" }).click();
    await report().getByText(/snapshot checksum verified/).waitFor();
    await app().getByLabel("Bundle passphrase").fill(pass);
    await app().getByRole("button", { name: "Generate recovery key" }).click();
    key = (await app().getByTestId("backup-recovery-key").innerText()).trim();
    assert.match(key, /^FSR1(?:-[0-9A-F]{8}){8}$/);
    const download = app().getByRole("button", { name: "Download with recovery key" });
    assert.equal(await download.isDisabled(), true);
    await app().getByLabel("Confirm saved recovery key").fill("not the key");
    assert.equal(await download.isDisabled(), true);
    await app().getByLabel("Confirm saved recovery key").fill(key.toLowerCase());
    assert.equal(await download.isEnabled(), true);
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await app().evaluate(async (el) => (await (window as any).axe.run(el, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations
      .filter((v: any) => v.impact === "critical" || v.impact === "serious").map((v: any) => v.id));
    assert.deepEqual(violations, []);
    const [dl] = await Promise.all([page.waitForEvent("download"), download.click()]);
    encrypted = readFileSync((await dl.path())!);
    const envelope = JSON.parse(encrypted.toString("utf8"));
    assert.equal(envelope.format, "fusion-recovery-bundle-1");
    // Cross the browser boundary: independent Python decrypts Chromium's actual download.
    independentPlain = pythonOracle("open", { bundle: envelope }).plaintext;
    assert.equal(JSON.parse(independentPlain).settings.find((s: any) => s.key === "appearance.theme").value, "light");
    assert.ok(!encrypted.includes(Buffer.from(key)) && !encrypted.includes(Buffer.from(pass)) && !encrypted.includes(Buffer.from("appearance.theme")));
    await app().getByTestId("backup-recovery-key").waitFor({ state: "detached" });
  });
  await test("BK-06 wrong key, wrong passphrase and cross-slot tampering fail locally before any preview request", { "BK-06": "full" }, async () => {
    await app().getByLabel("Decrypt with").selectOption("recovery");
    await app().getByLabel("Recovery key for restore").fill(key.replace(/[0-9A-F](?=$)/, (v) => v === "0" ? "1" : "0"));
    let n = postCount(); await upload(encrypted!);
    await report().getByText(/Import failed:.*authentication failed/i).waitFor(); assert.equal(postCount(), n);
    await app().getByLabel("Decrypt with").selectOption("passphrase");
    await app().getByLabel("Bundle passphrase").fill("incorrect password");
    n = postCount(); await upload(encrypted!);
    await report().getByText(/Import failed:.*authentication failed/i).waitFor(); assert.equal(postCount(), n);
    const changed = JSON.parse(encrypted!.toString("utf8"));
    const raw = Buffer.from(changed.passWrapped, "base64"); raw[0] ^= 1; changed.passWrapped = raw.toString("base64");
    await app().getByLabel("Decrypt with").selectOption("recovery");
    await app().getByLabel("Recovery key for restore").fill(key);
    n = postCount(); await upload(Buffer.from(JSON.stringify(changed)));
    await report().getByText(/Import failed:.*authentication failed/i).waitFor(); assert.equal(postCount(), n);
    const legacy = { format: "fusion-encrypted-bundle-2", envelope: await sealText(independentPlain, pass) };
    n = postCount(); await upload(Buffer.from(JSON.stringify(legacy)));
    await report().getByText(/no recovery-key slot/i).waitFor(); assert.equal(postCount(), n);
  });
  await test("BK-06 recovery key previews, cancels and then restores settings with the real server", { "BK-06": "full" }, async () => {
    await setTheme("dark");
    await app().getByLabel("Recovery key for restore").fill(key);
    await upload(encrypted!);
    let preview = app().getByTestId("backup-preview"); await preview.waitFor();
    assert.equal(await getTheme(), "dark");
    await preview.getByRole("button", { name: "Cancel restore" }).click(); assert.equal(await getTheme(), "dark");
    await app().getByLabel("Recovery key for restore").fill(key);
    await upload(encrypted!); preview = app().getByTestId("backup-preview"); await preview.waitFor();
    await preview.getByRole("button", { name: "Restore now" }).click();
    await report().getByText(/Restore committed/).waitFor();
    assert.equal(await getTheme(), "light");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  });
  await test("BK-06 the original passphrase independently opens the same downloaded file", { "BK-06": "full" }, async () => {
    await setTheme("dark");
    await app().getByLabel("Decrypt with").selectOption("passphrase");
    await app().getByLabel("Bundle passphrase").fill(pass);
    await upload(encrypted!);
    const preview = app().getByTestId("backup-preview"); await preview.waitFor();
    await preview.getByRole("button", { name: "Restore now" }).click();
    await report().getByText(/Restore committed/).waitFor(); assert.equal(await getTheme(), "light");
  });
  await test("BK-06 Chromium opens an independently encrypted Python archive and can cancel its preview", { "BK-06": "full" }, async () => {
    const independent = pythonOracle("seal", { plaintext: independentPlain });
    await app().getByLabel("Decrypt with").selectOption("recovery");
    await app().getByLabel("Recovery key for restore").fill(key);
    await upload(Buffer.from(JSON.stringify(independent)));
    const preview = app().getByTestId("backup-preview"); await preview.waitFor();
    await preview.getByRole("button", { name: "Cancel restore" }).click();
    assert.equal(await getTheme(), "light");
  });
  await test("BK-06 secrets are not in captured request bodies or persistent browser storage, and key display is cleared", { "BK-06": "partial" }, async () => {
    assert.ok(requests.every((s) => !s.includes(key) && !s.includes(pass)), "credential entered an observed HTTP request");
    const storage = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage), cookies: document.cookie }));
    assert.ok(!storage.includes(key) && !storage.includes(pass), "credential entered local/session storage or cookies");
    assert.equal(await app().getByTestId("backup-recovery-key").count(), 0);
    assert.deepEqual(errors, []);
  });
} finally {
  await ctx.close(); await browser.close(); await setTheme(initialTheme).catch(() => undefined);
  const current = await api("GET", "/api/state?id=default");
  if (oldDesktop.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 0) + 1000, state: oldDesktop.row.state }).catch(() => undefined);
}
finish();
