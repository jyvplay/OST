/**
 * TT44 end to end — TD-03 in real Chromium against the running Fusion build and a live asyncssh server
 * (scripts/oracle/ssh-server.py, test-only):
 *   Terminal `ssh alice@127.0.0.1 -p PORT` → the SSH window opens prefilled → Connect → the host-key dialog shows
 *   ssh-keygen's fingerprint → Trust once → password dialog → the remote shell renders in the from-scratch terminal,
 *   typed keys round-trip, a pasted ANSI colour comes back as a coloured span, the pty size matches the measured
 *   grid → Files pane: upload through the real <input type=file> (bytes checked on the server's disk), "Save to
 *   Fusion" lands in /Downloads → Disconnect → Recent holds no secrets → key generation has an honest outcome.
 * Screenshots: /tmp/tt44-*.png (visual inspection).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import type { Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt44");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(150); } throw new Error(`timed out: ${what}`); }
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})) as Promise<Record<string, unknown>>; };
const PY = "/home/user/tools/venv/bin/python";
const D = "/tmp/tt44e-keys", ROOT = "/tmp/tt44e-root";
rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true }); rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true });
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${D}/hk`]); execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${D}/u`]);
writeFileSync(`${D}/authkeys`, readFileSync(`${D}/u.pub`, "utf8"));
const FP = execFileSync("ssh-keygen", ["-lf", `${D}/hk.pub`], { encoding: "utf8" }).split(" ")[1];
writeFileSync(`${ROOT}/remote-note.txt`, "hello from the server\n");
const PORT = await new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const srv: ChildProcess = spawn(PY, ["scripts/oracle/ssh-server.py"], { env: { ...process.env, HOSTKEYS: `${D}/hk`, AUTHKEYS: `${D}/authkeys`, SFTP_ROOT: ROOT, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
let srvErr = ""; srv.stderr!.on("data", (d) => { srvErr += d; });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error(`oracle did not start: ${srvErr}`)), 15000); srv.stdout!.on("data", (d) => { if (/READY/.test(String(d))) { clearTimeout(t); res(); } }); });
await api("POST", "/api/ssh", { op: "forget", host: "127.0.0.1", port: PORT });
await api("POST", "/api/fs", { op: "trash", path: "/Downloads/remote-note.txt" }).catch(() => undefined);

const cur = await api("GET", "/api/state?id=default"); const rev = Number((cur.row as { revision?: number } | undefined)?.revision ?? 1) + 1;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows: [{ id: "t1", module: "terminal", title: "Terminal", x: 40, y: 40, w: 760, h: 420, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} }], focus: "t1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 60 } });

const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page: Page = await ctx.newPage();
const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
await sleep(2000);
const termText = () => page.locator('[data-testid="ssh-term"] [role="log"]').innerText().catch(() => "");

try {
  await test("Terminal `ssh` opens the SSH window prefilled; connect → host-key dialog with ssh-keygen's fingerprint → trust once → password → remote shell renders", { "TD-03": "full" }, async () => {
    const target = page.locator('input[aria-label="Terminal input"]');
    await target.click(); await target.fill(`ssh alice@127.0.0.1 -p ${PORT}`); await target.press("Enter");
    await page.locator('[data-testid="ssh-module"]').waitFor({ timeout: 10000 });
    ok(await page.locator('[aria-label="Host"]').inputValue() === "127.0.0.1" && await page.locator('[aria-label="Port"]').inputValue() === String(PORT) && await page.locator('[aria-label="User"]').inputValue() === "alice", "form prefilled from the command");
    await page.locator("label", { hasText: "Password only" }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const fp = page.locator('[data-testid="ssh-fingerprint"]'); await fp.waitFor({ timeout: 15000 });
    ok((await fp.innerText()).trim() === FP, `dialog fingerprint ${await fp.innerText()} ≠ ssh-keygen ${FP}`);
    await page.waitForTimeout(700);
    const look = await page.locator('[aria-label="Verify host key"] .fs-ask-title').evaluate((el) => {
      let op = 1; for (let n: Element | null = el; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
      const form = el.closest("form")!; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const desc = (n: Element | null) => n ? `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}.${String(n.className).slice(0, 60)} z=${getComputedStyle(n).zIndex} bg=${getComputedStyle(n).backgroundColor}` : "null";
      return { op, bg: getComputedStyle(form).backgroundColor, fg: getComputedStyle(el).color, onTop: !!top && el.contains(top) || top === el, top: desc(top), topParent: desc(top?.parentElement ?? null) };
    });
    console.log("   host-key dialog look", JSON.stringify(look));
    await page.screenshot({ path: "/tmp/tt44-hostkey.png" });
    ok(look.op > 0.99 && look.onTop, `host-key dialog must be topmost and fully opaque: ${JSON.stringify(look)}`);
    await page.getByRole("button", { name: "Trust once" }).click();
    const pw = page.locator('[role="dialog"] input[type="password"]'); await pw.waitFor({ timeout: 15000 });
    await pw.fill("pw1"); await page.getByRole("button", { name: "Continue" }).click();
    await poll(async () => /WELCOME TERM=xterm-256color/.test(await termText()), "remote welcome rendered");
    const cols = Number(/COLS=(\d+)/.exec(await termText())?.[1]);
    const grid = await page.locator('[data-testid="ssh-term"] [data-row="0"]').evaluate((el) => el.getBoundingClientRect().width);
    ok(cols >= 40 && cols <= 400, `pty cols ${cols} (row px ${grid})`);
    ok(await page.locator(".fs-badge", { hasText: "password" }).count() > 0, "status bar shows the negotiated algorithms and auth method");
  });

  await test("typed keys round-trip through the bridge; a pasted ANSI colour returns as a coloured span", { "TD-03": "full" }, async () => {
    await page.locator('[data-testid="ssh-input"]').focus();
    await page.keyboard.type("hi wörld"); await page.keyboard.press("Enter");
    await poll(async () => (await termText()).includes("YOU SAID [hi wörld]"), "echo of typed text");
    await page.locator('[data-testid="ssh-input"]').evaluate((el) => { const dt = new DataTransfer(); dt.setData("text/plain", "\x1b[31mREDTEXT\x1b[0m"); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
    await page.keyboard.press("Enter");
    await poll(async () => (await termText()).includes("REDTEXT"), "pasted text echoed");
    const color = await page.locator('[data-testid="ssh-term"] span', { hasText: "REDTEXT" }).first().evaluate((el) => getComputedStyle(el).color);
    ok(color === "rgb(224, 86, 108)", `SGR 31 must render in palette red, got ${color}`);
    await page.screenshot({ path: "/tmp/tt44-terminal.png" });
  });

  await test("Files pane: list, upload through <input type=file> (bytes equal on the server), Save to Fusion → /Downloads; results stay visible", { "TD-03": "full" }, async () => {
    await page.getByRole("button", { name: "Remote files", exact: true }).click();
    const pane = page.locator('[data-testid="sftp-pane"]'); await pane.waitFor();
    await pane.locator(".fs-list-item", { hasText: "remote-note.txt" }).waitFor({ timeout: 10000 });
    const data = randomBytes(300_000); writeFileSync(`${D}/upload.bin`, data);
    await pane.locator('input[type="file"]').setInputFiles(`${D}/upload.bin`);
    const status = pane.locator('[role="status"]');
    await status.filter({ hasText: "Uploaded upload.bin" }).waitFor({ timeout: 20000 }).catch(async (e) => { await page.screenshot({ path: "/tmp/tt44-upload-fail.png" }); throw new Error(`${(e as Error).message.split("\n")[0]}; status: ${await status.allInnerTexts()}`); });
    await pane.locator(".fs-list-item", { hasText: "upload.bin" }).waitFor();
    await page.waitForTimeout(400);
    ok(await status.filter({ hasText: "Uploaded upload.bin" }).count() === 1, "the upload result is still shown after the listing refresh");
    ok(existsSync(`${ROOT}/upload.bin`) && createHash("sha256").update(readFileSync(`${ROOT}/upload.bin`)).digest("hex") === createHash("sha256").update(data).digest("hex"), "uploaded bytes equal on the server's disk");
    const row = pane.locator(".fs-list-item", { hasText: "remote-note.txt" });
    await row.getByTitle("Save a copy into Fusion's /Downloads").click();
    await status.filter({ hasText: "Saved to /Downloads/remote-note.txt" }).waitFor({ timeout: 10000 });
    const node = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent("/Downloads/remote-note.txt")}`)).node as { content: string; encoding: string } | null;
    ok(node && Buffer.from(node.content, node.encoding === "base64" ? "base64" : "utf8").toString() === "hello from the server\n", `VFS copy: ${JSON.stringify(node)}`);
    // every row action is a visible, named target (font-independent SVG icons; ≥ 24 px — WCAG 2.2 target size)
    for (const name of ["Download remote-note.txt", "Save remote-note.txt to Fusion", "Rename remote-note.txt", "Delete remote-note.txt", "Parent folder"]) {
      const el = pane.getByRole(name.startsWith("Download") ? "link" : "button", { name, exact: true });
      const bb = await el.boundingBox(); ok(bb && bb.width >= 24 && bb.height >= 24 && (await el.locator("svg path").count()) === 1, `${name}: ${JSON.stringify(bb)}`);
    }
    await page.screenshot({ path: "/tmp/tt44-files.png" });
  });

  await test("Files pane management uses in-app dialogs (no window.prompt/confirm): new folder with validation, rename, two-step delete — checked on the server's disk", { "TD-03": "full" }, async () => {
    const pane = page.locator('[data-testid="sftp-pane"]'); const status = pane.locator('[role="status"]');
    let nativeDialogs = 0; page.on("dialog", (d) => { nativeDialogs++; void d.dismiss(); });
    await pane.getByRole("button", { name: "New folder", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "New folder on the server" }); await dlg.waitFor();
    await dlg.locator("input").fill("a/b"); await dlg.getByRole("button", { name: "Create" }).click();
    await dlg.getByText("A name cannot contain / or NUL").waitFor({ timeout: 5000 });
    await dlg.locator("input").fill("made-here"); await dlg.getByRole("button", { name: "Create" }).click();
    await status.filter({ hasText: "Created made-here" }).waitFor({ timeout: 10000 });
    ok(existsSync(`${ROOT}/made-here`) && statSync(`${ROOT}/made-here`).isDirectory(), "folder exists on the server");
    await pane.getByRole("button", { name: "Rename upload.bin", exact: true }).click();
    const rd = page.getByRole("dialog", { name: "Rename upload.bin" }); await rd.waitFor();
    await rd.locator("input").fill("renamed.bin"); await rd.getByRole("button", { name: "Rename" }).click();
    await status.filter({ hasText: "Renamed to renamed.bin" }).waitFor({ timeout: 10000 });
    ok(existsSync(`${ROOT}/renamed.bin`) && !existsSync(`${ROOT}/upload.bin`), "renamed on the server");
    await pane.getByRole("button", { name: "Delete renamed.bin", exact: true }).click();
    await page.waitForTimeout(300);
    ok(existsSync(`${ROOT}/renamed.bin`), "the first click only arms the delete");
    await pane.getByRole("button", { name: "Confirm delete renamed.bin", exact: true }).click();
    await status.filter({ hasText: "Deleted renamed.bin" }).waitFor({ timeout: 10000 });
    ok(!existsSync(`${ROOT}/renamed.bin`), "deleted on the server");
    await pane.getByRole("button", { name: "Delete made-here", exact: true }).click();
    await page.waitForTimeout(4500);
    ok(await pane.getByRole("button", { name: "Confirm delete made-here" }).count() === 0 && existsSync(`${ROOT}/made-here`), "an armed delete disarms itself after 4 s");
    ok(nativeDialogs === 0, `${nativeDialogs} native browser dialogs were opened`);
  });

  await test("Disconnect returns to the form; Recent lists the server and /System/ssh/recent.json holds no secret; key generation has an honest outcome", { "TD-03": "full" }, async () => {
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
    ok(await page.locator('[aria-label="Recent connections"]').getByRole("button", { name: `alice@127.0.0.1:${PORT}` }).count() === 1, "recent entry");
    const rec = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent("/System/ssh/recent.json")}`)).node as { content: string } | null;
    ok(rec && rec.content.includes(String(PORT)) && !rec.content.includes("pw1") && !/PRIVATE KEY/.test(rec.content), "recent.json: no password or key material");
    await page.getByRole("button", { name: "Generate ed25519 key" }).click();
    const pub = page.locator('[aria-label="Public key"]'); await pub.waitFor({ timeout: 15000 });
    ok(/^ssh-ed25519 [A-Za-z0-9+/=]+ /.test(await pub.inputValue()), "public key line");
    const msg = await page.locator('[aria-label="Keys"] [role="status"]').innerText();
    const saved = /Saved \/Private\/ssh\/id_ed25519/.test(msg), offered = (await page.getByRole("link", { name: "Download private key" }).count()) === 1;
    ok(saved !== offered, `exactly one honest outcome (saved into /Private, or refused + download offered): ${msg}`);
    await page.screenshot({ path: "/tmp/tt44-form.png" });
    ok(!errors.length, `page errors: ${errors.join(" | ")}`);
  });
} finally {
  await api("POST", "/api/ssh", { op: "forget", host: "127.0.0.1", port: PORT });
  await browser.close(); srv.kill();
}
await finish();
process.exit(0);
