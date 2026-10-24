/**
 * TT45 end to end — the post-quantum hybrid key exchange as the user sees it, in real Chromium against the running
 * Fusion build and two live asyncssh servers (test-only): one with asyncssh's defaults (offers the ML-KEM hybrids,
 * backed by OpenSSL's ML-KEM) and one restricted to curve25519-sha256. The status bar must say "Post-quantum" only
 * for the first. Screenshots: /tmp/tt45-pq.png, /tmp/tt45-classical.png.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import type { Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt45");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(150); } throw new Error(`timed out: ${what}`); }
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})) as Promise<Record<string, unknown>>; };
const PY = "/home/user/tools/venv/bin/python";
const D = "/tmp/tt45e-keys", ROOT = "/tmp/tt45e-root";
rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true }); rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true });
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${D}/hk`]); execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${D}/u`]);
writeFileSync(`${D}/authkeys`, readFileSync(`${D}/u.pub`, "utf8"));
const FP = execFileSync("ssh-keygen", ["-lf", `${D}/hk.pub`], { encoding: "utf8" }).split(" ")[1];
writeFileSync(`${ROOT}/remote-note.txt`, "hello from the server\n");
const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const servers: ChildProcess[] = [];
async function server(env: Record<string, string>): Promise<number> {
  const port = await freePort();
  const p = spawn(PY, ["scripts/oracle/ssh-server.py"], { env: { ...process.env, HOSTKEYS: `${D}/hk`, AUTHKEYS: `${D}/authkeys`, SFTP_ROOT: ROOT, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  servers.push(p); let err = ""; p.stderr!.on("data", (d) => { err += d; });
  await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error(`oracle did not start: ${err}`)), 15000); p.stdout!.on("data", (d) => { if (/READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  await api("POST", "/api/ssh", { op: "forget", host: "127.0.0.1", port });
  return port;
}
const PQ = await server({}), CLASSIC = await server({ KEX: "curve25519-sha256" });

const cur = await api("GET", "/api/state?id=default"); const rev = Number((cur.row as { revision?: number } | undefined)?.revision ?? 1) + 1;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows: [{ id: "t1", module: "terminal", title: "Terminal", x: 40, y: 40, w: 900, h: 480, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} }] } });

const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page: Page = await ctx.newPage();
const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
await sleep(2000);
const termText = () => page.locator('[data-testid="ssh-term"] [role="log"]').innerText().catch(() => "");

async function connectVia(port: number, first: boolean) {
  if (first) {
    const t = page.locator('input[aria-label="Terminal input"]');
    await t.click(); await t.fill(`ssh alice@127.0.0.1 -p ${port}`); await t.press("Enter");
    await page.locator('[data-testid="ssh-module"]').waitFor({ timeout: 10000 });
  } else {
    await page.locator('[aria-label="Port"]').fill(String(port));
  }
  await page.locator("label", { hasText: "Password only" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator('[data-testid="ssh-fingerprint"]').waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Trust once" }).click();
  const pw = page.locator('[role="dialog"] input[type="password"]'); await pw.waitFor({ timeout: 15000 });
  await pw.fill("pw1"); await page.getByRole("button", { name: "Continue" }).click();
  await poll(async () => /WELCOME/.test(await termText()), "remote shell rendered");
}

try {
  await test("a server offering ML-KEM (asyncssh defaults) → the session negotiates mlkem768x25519-sha256 and the status bar says Post-quantum, with an honest tooltip", { "TD-03": "full" }, async () => {
    await connectVia(PQ, true);
    const b = page.locator(".fs-badge", { hasText: "Post-quantum" }); await b.waitFor({ timeout: 5000 });
    const tip = await b.getAttribute("title") ?? "";
    ok(/mlkem768x25519-sha256/.test(tip) && /FIPS 203/.test(tip) && /BOTH/.test(tip), `tooltip: ${tip}`);
    const alg = await page.locator(".fs-badge", { hasText: "mlkem768x25519-sha256" }).innerText();
    ok(/^mlkem768x25519-sha256 · (chacha20-poly1305|aes(128|256)-(gcm|ctr)) · password$/.test(alg.trim()), `algorithm badge must read kex · cipher · auth: "${alg}"`);
    ok(await page.locator(".fs-badge", { hasText: "Classical key exchange" }).count() === 0, "no classical badge");
    await page.screenshot({ path: "/tmp/tt45-pq.png" });
    await page.getByRole("button", { name: "Disconnect" }).click();
  });
  await test("a classical-only server (KEX=curve25519-sha256) → the status bar says Classical key exchange instead — never a false post-quantum claim", { "TD-03": "full" }, async () => {
    await page.getByRole("button", { name: "Connect", exact: true }).waitFor({ timeout: 10000 });
    await connectVia(CLASSIC, false);
    const b = page.locator(".fs-badge", { hasText: "Classical key exchange" }); await b.waitFor({ timeout: 5000 });
    ok(/curve25519-sha256/.test(await b.getAttribute("title") ?? ""), "tooltip names the classical method");
    ok(await page.locator(".fs-badge", { hasText: "Post-quantum" }).count() === 0, "no post-quantum badge");
    await page.screenshot({ path: "/tmp/tt45-classical.png" });
    ok(!errors.length, `page errors: ${errors.join(" | ")}`);
  });
} finally {
  for (const port of [PQ, CLASSIC]) await api("POST", "/api/ssh", { op: "forget", host: "127.0.0.1", port });
  await browser.close(); for (const s of servers) s.kill();
}
await finish();
process.exit(0);
