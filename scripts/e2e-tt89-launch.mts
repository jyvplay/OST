/** Actual Chromium + OPFS + Fusion HTTP/PostgreSQL; LaunchQueue delivery is explicitly synthetic, not an OS/PWA-install test. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing launch browser tests without TT89_DISPOSABLE_DATABASE=1 for a disposable server/database.");
const { test, finish } = makeHarness("e2e-tt89-launch");
const partial = { "SH-13": "partial" } as const;
const protocol = { ...partial, "AU-03": "partial" } as const;
const BASE = process.env.BASE ?? "http://localhost:3000";
const RUN = `tt89-launch-${Date.now().toString(36)}`;
const name = `${RUN}.md`;
const paths = [name, `${RUN} 2.md`, `${RUN} 3.md`, `${RUN}-cancel.txt`, `${RUN}-binary.txt`, `${RUN}-big.txt`, `${RUN}-queued1.txt`, `${RUN}-queued2.txt`].map((n) => `/Documents/${n}`);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`); return json;
};
const fs = (op: string, path: string, extra: Record<string, unknown> = {}) => api("POST", "/api/fs", { op, path, ...extra });
const read = async (path: string) => (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node;
const oldDesktop = await api("GET", "/api/state?id=default");
const rev = Number(oldDesktop.row?.revision ?? 1) + 1000;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); ctx.setDefaultTimeout(15_000);
// This shim only delivers synthetic events; file handles are real Chromium OPFS handles.
await ctx.addInitScript(() => {
  const w = window as any;
  w.__initialLaunchUrl = location.href;
  Object.defineProperty(window, "launchQueue", { configurable: true, value: { setConsumer: (consumer: unknown) => { w.__deliverLaunch = consumer; } } });
  const nav = navigator as any;
  w.__protocolRequests = [];
  if (typeof nav.registerProtocolHandler === "function") {
    const native = nav.registerProtocolHandler.bind(nav);
    nav.registerProtocolHandler = (scheme: string, url: string) => { w.__protocolRequests.push(["register", scheme, url]); return native(scheme, url); };
  }
});
const page = await ctx.newPage(); const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const waitBoot = () => page.waitForFunction(() => typeof (window as any).__deliverLaunch === "function", null, { timeout: 35_000 });
const deliver = (files: string[] = [], target?: string) => page.evaluate(({ names, target }) => {
  const w = window as any; w.__deliverLaunch({ targetURL: target ?? location.origin + "/", files: names.map((n: string) => w.__handles[n]) });
}, { names: files, target });
const createLocal = (files: { name: string; text?: string; bytes?: number[]; size?: number }[]) => page.evaluate(async ({ dir, files }) => {
  const w = window as any; w.__handles ??= {};
  const root = await navigator.storage.getDirectory(); const folder = await root.getDirectoryHandle(dir, { create: true });
  for (const spec of files) {
    const h = await folder.getFileHandle(spec.name, { create: true }); const writer = await h.createWritable();
    if (spec.bytes) await writer.write(new Uint8Array(spec.bytes));
    else if (spec.size) await writer.write(new Uint8Array(spec.size).fill(65));
    else await writer.write(spec.text ?? "");
    await writer.close(); w.__handles[spec.name] = h;
  }
}, { dir: RUN, files });
const ask = () => page.getByTestId("ask-dialog");
const currentDialogs = async (title: string) => page.getByRole("dialog", { name: title, exact: true }).count();
try {
  await test("cold browser navigation opens a documented protocol intent and suppresses its duplicate queue delivery", protocol, async () => {
    const target = `${BASE}/?cmd=${encodeURIComponent("web+fusion://open?app=files")}`;
    await page.goto(target, { waitUntil: "domcontentloaded" }); await waitBoot();
    await page.getByRole("dialog", { name: "Files", exact: true }).first().waitFor();
    const count = await currentDialogs("Files");
    await deliver([], target); await page.waitForTimeout(250); assert.equal(await currentDialogs("Files"), count);
    await deliver([], target);
    await page.getByRole("dialog", { name: "Files", exact: true }).nth(count).waitFor();
  });
  await test("focus-existing synthetic launches restrict origin, action and app ids", protocol, async () => {
    const before = await currentDialogs("Settings");
    for (const target of ["https://evil.invalid/?open=settings", `${BASE}/?open=settings&path=/Private/x`, `${BASE}/?cmd=${encodeURIComponent("web+fusion://delete?app=settings")}`]) await deliver([], target);
    await page.waitForTimeout(250); assert.equal(await currentDialogs("Settings"), before);
    await deliver([], `${BASE}/?open=settings`); await page.getByRole("dialog", { name: "Settings", exact: true }).nth(before).waitFor();
  });
  await test("default-app guide changes platform, reports limits, and sends a real browser protocol request without claiming acceptance", { "ST-03": "partial", "SH-13": "partial" }, async () => {
    const settings = page.getByRole("dialog", { name: "Settings", exact: true }).last();
    await settings.getByRole("tab", { name: "Default apps" }).click();
    const guide = settings.getByTestId("default-apps-guide");
    await guide.getByText(/cannot inspect or change system-wide/i).waitFor(); await guide.getByText(/Android Settings/).waitFor();
    await guide.getByLabel("Device platform").selectOption("windows"); await guide.getByText(/Windows Settings/).waitFor();
    await guide.getByLabel("Device platform").selectOption("mac"); await guide.getByText(/Finder/).waitFor();
    await guide.getByLabel("Device platform").selectOption("linux"); await guide.getByText(/desktop environment/).waitFor();
    await guide.getByText(/not proof of an installed or registered handler/i).waitFor();
    const button = guide.getByRole("button", { name: "Ask browser to handle web+fusion links" });
    if (await button.isEnabled()) {
      await button.click(); await guide.getByRole("status").getByText(/Request sent|Browser request failed/).waitFor();
      const calls = await page.evaluate(() => (window as any).__protocolRequests);
      assert.deepEqual(calls, [["register", "web+fusion", `${new URL(BASE).origin}/?cmd=%s`]]);
      assert.doesNotMatch(await guide.getByRole("status").innerText(), /registered successfully|is the default/i);
    } else await guide.getByText(/registration is not available/i).waitFor();
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await guide.evaluate(async (el) => (await (window as any).axe.run(el, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.filter((v: any) => v.impact === "critical" || v.impact === "serious").map((v: any) => v.id));
    assert.deepEqual(violations, []);
  });
  await test("modal cancellation and shortcuts never copy a selected OPFS file", partial, async () => {
    const cancel = `${RUN}-cancel.txt`; await createLocal([{ name: cancel, text: "do not send this" }]);
    let writes = 0; const watcher = (request: any) => { if (request.method() === "POST" && request.url().endsWith("/api/fs") && request.postData()?.includes(cancel)) writes++; };
    page.on("request", watcher); await deliver([cancel]); await ask().getByText(/sends a plaintext copy to its server/i).waitFor();
    await page.keyboard.press("Control+f"); await page.keyboard.press("Delete");
    assert.equal(await ask().count(), 1); assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.getAttribute("data-testid")), "ask-cancel");
    await ask().getByRole("button", { name: "Cancel" }).click(); await ask().waitFor({ state: "hidden" }); await page.waitForTimeout(250);
    page.off("request", watcher); assert.equal(writes, 0);
    const stat = await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(`/Documents/${cancel}`)}`); assert.equal(stat.node, null);
  });
  await test("selected UTF-8 OPFS file imports to a copy, defeats a real concurrent create, and opens in Editor", partial, async () => {
    await fs("write", paths[0], { content: "existing original" });
    await createLocal([{ name, text: "\uFEFFlaunch café 🐚\n" }]);
    let injected = false;
    const intercept = async (route: any) => {
      const req = route.request(); let b: any; try { b = JSON.parse(req.postData() ?? "{}"); } catch { b = {}; }
      if (!injected && req.method() === "POST" && (b.op === "writeIfUnchanged" || b.op === "write") && b.path === paths[1]) {
        injected = true; await fs("write", paths[1], { content: "concurrent creator" });
      }
      await route.continue();
    };
    await page.route("**/api/fs", intercept);
    try {
      await deliver([name]); await ask().getByRole("button", { name: "Copy and open" }).click();
      await page.getByText(/local file\(s\) copied to \/Documents/i).waitFor();
      assert.equal(injected, true); assert.equal((await read(paths[0])).content, "existing original"); assert.equal((await read(paths[1])).content, "concurrent creator");
      const editor = page.getByRole("dialog", { name: `${RUN} 3.md`, exact: true }); await editor.waitFor({ timeout: 30_000 });
      const saved = await read(paths[2]); assert.equal(saved.content, "\uFEFFlaunch café 🐚\n"); assert.equal(saved.encoding, "utf8");
      const local = await page.evaluate(async (n) => (await (window as any).__handles[n].getFile()).text(), name); assert.equal(local, "launch café 🐚\n");
      await editor.locator("textarea").first().waitFor(); assert.equal(await editor.locator("textarea").first().inputValue(), "\uFEFFlaunch café 🐚\n");
    } finally { await page.unroute("**/api/fs", intercept); }
  });
  await test("back-to-back launch requests obtain separate, ordered consent", partial, async () => {
    const first = `${RUN}-queued1.txt`, second = `${RUN}-queued2.txt`;
    await createLocal([{ name: first, text: "must not copy" }, { name: second, text: "copy second" }]);
    await deliver([first]); await deliver([second]);
    await ask().waitFor(); const firstAsk = await ask().getAttribute("data-ask-id");
    await ask().getByRole("button", { name: "Cancel" }).click();
    await page.waitForFunction((id) => !!document.querySelector('[data-testid="ask-dialog"]') && document.querySelector('[data-testid="ask-dialog"]')?.getAttribute("data-ask-id") !== id, firstAsk);
    await ask().getByRole("button", { name: "Copy and open" }).click();
    await page.getByRole("dialog", { name: second, exact: true }).waitFor();
    assert.equal((await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(paths[6])}`)).node, null);
    assert.equal((await read(paths[7])).content, "copy second");
  });
  await test("unsupported binary, NUL, excessive size and excessive launch count are refused", partial, async () => {
    const binary = `${RUN}-binary.txt`, big = `${RUN}-big.txt`;
    await createLocal([{ name: binary, bytes: [255, 254, 0] }, { name: big, size: 1024 * 1024 + 1 }]);
    await deliver([binary, big]); await ask().getByRole("button", { name: "Copy and open" }).click();
    await page.getByText(/0 copied; 2 skipped/).waitFor();
    for (const p of [paths[4], paths[5]]) assert.equal((await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(p)}`)).node, null);
    await deliver(Array(9).fill(binary)); await page.getByText(/Open at most 8 files per launch/).waitFor(); assert.equal(await ask().count(), 0);
  });
  await test("amnesic session refuses launch file copies before consent or any host write", { ...partial, "SC-13": "partial" }, async () => {
    await page.goto(`${BASE}/?amnesia=1`, { waitUntil: "domcontentloaded" }); await waitBoot(); await page.getByTestId("amnesic-badge").first().waitFor();
    const cancel = `${RUN}-cancel.txt`; await createLocal([{ name: cancel, text: "amnesia sensitive" }]);
    let writes = 0; const watcher = (r: any) => { if (r.method() === "POST" && r.url().endsWith("/api/fs")) writes++; }; page.on("request", watcher);
    await deliver([cancel]); await page.getByText(/unavailable in an amnesic session; nothing was copied/i).waitFor(); await page.waitForTimeout(250); page.off("request", watcher);
    assert.equal(writes, 0); assert.equal(await ask().count(), 0);
    assert.equal((await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(`/Documents/${cancel}`)}`)).node, null);
  });
  await test("launch browser session has no uncaught page errors", partial, () => assert.deepEqual(errors, []));
} finally {
  await page.evaluate(async (dir) => { const root = await navigator.storage.getDirectory(); await root.removeEntry(dir, { recursive: true }).catch(() => undefined); }, RUN).catch(() => undefined);
  await ctx.close(); await browser.close();
  for (const path of paths) await fs("purge", path).catch(() => undefined);
  const current = await api("GET", "/api/state?id=default");
  if (oldDesktop.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 0) + 1000, state: oldDesktop.row.state }).catch(() => undefined);
}
finish();
