/** Actual production UI -> same-origin SSH bridge -> real OpenSSH daemon and
 * system shell. Not the asyncssh command oracle. A separate OpenSSH client
 * probe validates the daemon before this suite. Keys stay in ignored .cache.
 * Scope: Ed25519 login/host verification, real PTY ANSI/Unicode/input/resize,
 * native clipboard paste and explicit disconnect; not every SSH algorithm. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "playwright/test";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
import { FrameParser } from "../src/lib/ssh-client.ts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt133-openssh");
const port = Number(process.env.TT133_SSH_NATIVE_PORT ?? 2222), errors: string[] = [];
const keyRoot = process.env.TT133_SSH_NATIVE_KEYS ?? ".cache/tt133-native-ssh";
const expectedFingerprint = execFileSync("ssh-keygen", ["-lf", `${keyRoot}/host_ed25519.pub`], { encoding: "utf8" }).trim().split(/\s+/)[1];
await fx.windows("ssh");
const context = await fx.context({ permissions: ["clipboard-read", "clipboard-write"] }), page = await context.newPage();
page.on("pageerror", e => errors.push(e.message));
const win = page.locator('[data-win-id="w1"]'), input = win.getByTestId("ssh-input"), log = win.getByRole("log", { name: "Remote terminal" });
let connected = false;
async function command(text: string) { assert.ok(connected, "native SSH login did not succeed"); await input.focus(); await page.keyboard.insertText(text); await page.keyboard.press("Enter"); }
const state = () => fx.api("GET", "/api/ssh");
try {
  await fx.api("POST", "/api/ssh", { op: "forget", host: "127.0.0.1", port });
  await fx.ready(page, "ssh");
  await test("Real OpenSSH: Ed25519 login cannot start before the native UI fingerprint equals independent ssh-keygen; trust once does not persist the host key", { "TD-03": "partial" }, async () => {
    await win.getByLabel("User", { exact: true }).fill("user"); await win.getByLabel("Host", { exact: true }).fill("127.0.0.1"); await win.getByLabel("Port", { exact: true }).fill(String(port));
    await win.getByLabel("Paste a key", { exact: true }).check();
    await win.getByLabel("Private key", { exact: true }).fill(readFileSync(`${keyRoot}/client_ed25519`, "utf8"));
    await win.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(win.getByTestId("ssh-fingerprint")).toHaveText(expectedFingerprint, { timeout: 20_000 });
    assert.equal((await state()).sessions.filter((s: any) => s.state === "ready").length, 0);
    await win.getByRole("button", { name: "Trust once", exact: true }).click();
    await expect(win.getByRole("button", { name: "Remote files", exact: true })).toBeEnabled({ timeout: 20_000 });
    connected = true;
    await command("export LANG=C.UTF-8 LC_ALL=C.UTF-8; PS1='tt133-native$ '; printf '\\033[2J\\033[HNATIVE_OPENSSH_READY\\n'");
    await expect(log).toContainText("NATIVE_OPENSSH_READY", { timeout: 15_000 });
    assert.equal((await state()).knownHosts.entries.some((e: any) => e.hosts === `[127.0.0.1]:${port}`), false);
  });
  await test("Real shell ANSI + UTF-8: red text, combining mark, CJK and emoji render as safe spans, not HTML", { "TD-03": "partial" }, async () => {
    await command("printf '\\033[2J\\033[H\\033[31mNATIVE_RED\\033[0m μ é 界🧭 <script>literal</script>\\n'");
    await expect(log).toContainText("NATIVE_RED μ é 界🧭 <script>literal</script>");
    const red = log.locator("span").filter({ hasText: "NATIVE_RED" }).first();
    assert.equal(await red.evaluate(el => getComputedStyle(el).color), "rgb(224, 86, 108)");
    assert.equal(await log.locator("script,img,iframe").count(), 0);
  });
  await test("Native ResizeObserver/font-size publication reaches the real PTY: stty rows equal rendered rows; size changes do not corrupt later input", { "SSH-01": "partial", "TD-03": "partial" }, async () => {
    const before = await log.locator("[data-row]").count();
    // Fit debounces real resize traffic by 120 ms. Observe its actual ordered
    // control POST acknowledgement, not an arbitrary delay or a fake timer.
    const acknowledgement = page.waitForResponse(response => {
      const request = response.request(), bytes = request.postDataBuffer();
      if (request.method() !== "POST" || !/\/api\/ssh\/[a-f0-9]+$/.test(new URL(request.url()).pathname) || !bytes) return false;
      return new FrameParser().push(bytes).some(frame => frame.type === 1 && JSON.parse(new TextDecoder().decode(frame.payload)).t === "resize");
    });
    await win.getByTestId("ssh-font-up").click();
    await expect.poll(() => log.locator("[data-row]").count()).not.toBe(before);
    const resized = await acknowledgement; assert.equal(resized.status(), 200); await resized.finished();
    await command("printf '\\033[2J\\033[H'; printf 'NATIVE_TTY='; stty size");
    await expect(log).toContainText(/NATIVE_TTY=\d+ \d+/);
    const text = await log.innerText(), match = /NATIVE_TTY=(\d+) (\d+)/.exec(text)!;
    assert.equal(Number(match[1]), await log.locator("[data-row]").count()); assert.ok(Number(match[2]) >= 20);
    await command("printf 'RESIZE_INPUT_OK\\n'"); await expect(log).toContainText("RESIZE_INPUT_OK");
  });
  await test("Native terminal Ctrl+Shift+V clipboard paste preserves Unicode; Ctrl+V still belongs to the real TTY", { "TD-03": "partial" }, async () => {
    assert.ok(connected);
    await page.evaluate(async text => navigator.clipboard.writeText(text), "printf 'NATIVE_CLIPBOARD_μ🧭\\n'");
    // Ctrl+V is terminal quote-next (0x16), not the desktop paste shortcut.
    // Preserve it: the real TTY must echo a quoted CR, then Ctrl+C cancels it.
    await input.focus(); await page.keyboard.press("Control+v"); await page.keyboard.press("Enter");
    await expect(log).toContainText("^M"); await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+Shift+v"); await page.keyboard.press("Enter");
    await expect(log).toContainText("NATIVE_CLIPBOARD_μ🧭");
    mkdirSync("docs/screens/tt133-native", { recursive: true });
    await win.screenshot({ path: "docs/screens/tt133-native/openssh.png" });
  });
  await test("Real OpenSSH SFTP: native upload, independent disk read, browser download and VFS copy preserve binary bytes; rename and two-step delete affect only the selected remote file", { "TD-03": "partial" }, async () => {
    assert.ok(connected);
    const folder = resolve(keyRoot, `transfer-${Date.now().toString(36)}`), name = `tt133-native-transfer-${Date.now().toString(36)}.bin`, renamed = `tt133-native-renamed-${Date.now().toString(36)}.bin`;
    const content = Buffer.concat([Buffer.from("Native SFTP μ 🧭\n"), Buffer.from(Array.from({ length: 65_537 }, (_, i) => i % 256))]);
    mkdirSync(folder); // an actual directory owned solely by this case, not a fake SFTP service
    try {
      await win.getByRole("button", { name: "Remote files", exact: true }).click();
      const pane = win.getByTestId("sftp-pane"), location = pane.getByLabel("Remote folder", { exact: true });
      await expect(location).not.toHaveValue(""); await expect(pane.getByRole("button", { name: "New folder", exact: true })).toBeEnabled();
      await location.fill(folder); await location.press("Enter"); await expect(pane).toContainText("Empty folder");
      await pane.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/octet-stream", buffer: content });
      await expect(pane.getByRole("status")).toContainText(`Uploaded ${name}`, { timeout: 20_000 });
      assert.deepEqual(readFileSync(`${folder}/${name}`), content, "independent filesystem must see the exact uploaded binary bytes");
      const download = page.waitForEvent("download"); await pane.getByRole("link", { name: `Download ${name}`, exact: true }).click();
      assert.deepEqual(readFileSync((await (await download).path())!), content, "native browser download must match the independent remote file");
      await pane.getByRole("button", { name: `Save ${name} to Fusion`, exact: true }).click();
      await expect(pane.getByRole("status")).toContainText(`Saved to /Downloads/${name}`);
      const saved = (await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Downloads/${name}`)}`)).node;
      assert.deepEqual(Buffer.from(saved.content, saved.encoding === "base64" ? "base64" : "utf8"), content, "VFS copy must match remote bytes");
      await pane.getByRole("button", { name: `Rename ${name}`, exact: true }).click();
      const dialog = page.getByTestId("ask-dialog"); await dialog.locator("input").fill(renamed); await dialog.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(pane.getByRole("status")).toContainText(`Renamed to ${renamed}`); assert.equal(existsSync(`${folder}/${name}`), false); assert.deepEqual(readFileSync(`${folder}/${renamed}`), content);
      await pane.getByRole("button", { name: `Delete ${renamed}`, exact: true }).click(); assert.equal(existsSync(`${folder}/${renamed}`), true, "first delete only arms confirmation");
      await pane.getByRole("button", { name: `Confirm delete ${renamed}`, exact: true }).click(); await expect(pane.getByRole("status")).toContainText(`Deleted ${renamed}`); assert.equal(existsSync(`${folder}/${renamed}`), false);
      await win.screenshot({ path: "docs/screens/tt133-native/openssh-sftp.png" });
      await win.getByRole("button", { name: "Remote files", exact: true }).click();
    } finally {
      rmSync(folder, { recursive: true, force: true });
      // This uniquely named test copy is never a user file in this disposable DB.
      if (await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Downloads/${name}`)}`).catch(() => null)) {
        await fx.api("POST", "/api/fs", { op: "trash", path: `/Downloads/${name}` });
        await fx.api("POST", "/api/fs", { op: "purge", path: `/Downloads/${name}` });
      }
    }
  });
  await test("Explicit Disconnect closes the actual native SSH session and returns to the connection form", { "TD-03": "partial" }, async () => {
    assert.ok(connected); await win.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(win.getByLabel("Connect over SSH")).toBeVisible();
    await expect.poll(async () => (await state()).sessions.filter((s: any) => s.host === "127.0.0.1" && s.port === port).length).toBe(0);
    connected = false;
  });
  await test("No uncaught browser exceptions during native OpenSSH checks", {}, () => assert.deepEqual(errors, []));
} finally {
  if (connected) await win.getByRole("button", { name: "Disconnect", exact: true }).click().catch(() => undefined);
  await context.close(); await fx.close(); finish();
}
