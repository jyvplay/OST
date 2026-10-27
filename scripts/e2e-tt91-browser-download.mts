/** Destructive fixture writes. Requires an EXCLUSIVE disposable server/database. Remote content is real PyPI;
 * route interception is explicitly used only to force a concurrent VFS writer and fault/cancellation scenarios. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing browser download fixture writes without TT89_DISPOSABLE_DATABASE=1 and an explicit exclusive matching disposable server/database.");
const BASE = process.env.BASE ?? "http://localhost:3999", TARGET = "https://pypi.org/sponsors/";
const { test, finish } = makeHarness("e2e-tt91-browser-download");
const covers = { "PR-07m": "partial" } as const;
const req = async (method: string, path: string, data?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const paths = ["/Downloads/sponsors.html", "/Downloads/sponsors 2.html", "/Downloads/sponsors 3.html"];
const ownedPaths = [...paths, "/Downloads/sponsors 4.html"];
const isFs = (url: URL) => url.pathname === "/api/fs";
const isRaw = (url: URL) => url.pathname.endsWith("/__raw");
const pathState = async (p: string) => req("GET", `/api/fs?op=stat&path=${encodeURIComponent(p)}`);
const created = new Set<string>();
let browser: Browser | undefined, ctx: BrowserContext | undefined, page: Page | undefined;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const oldDesktop = await req("GET", "/api/state?id=default"), oldView = await req("GET", "/api/settings");
const view = oldView.json.rows?.find((x: { key: string }) => x.key === "appearance.desktopView")?.value;
try {
  // Never consume/delete an existing fixture. This cannot protect another concurrent user: exclusive access is required.
  for (const p of ownedPaths) {
    const s = await pathState(p); if (s.status !== 200 || s.json.node) throw new Error(`Fixture path is unavailable: ${p}`);
    for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
      if ((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 LIMIT 1`, [p])).rowCount) throw new Error(`Fixture ${p} is occupied in ${table}`);
  }
  // These paths were all absent, and the disposable server is exclusive; clean
  // them even when a failed assertion happens after an acknowledged write.
  for (const p of ownedPaths) created.add(p);
  const mkdir = await req("POST", "/api/fs", { op: "mkdir", path: "/Downloads" }); assert.equal(mkdir.status, 200);
  const seed = await req("POST", "/api/fs", { op: "writeIfUnchanged", path: paths[0], content: "original-user-file", encoding: "utf8", mime: "text/plain", expected: null });
  assert.equal(seed.status, 200); created.add(paths[0]);
  assert.equal((await db.query("SELECT content FROM vfs_nodes WHERE path=$1", [paths[0]])).rows[0]?.content, "original-user-file", "server/database mismatch");
  if (view && view !== "classic") assert.equal((await req("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" })).status, 200);
  const old = await req("GET", "/api/state?id=default"), rev = Number(old.json.row?.revision ?? 1) + 1000;
  const tab = { id: "t1", url: TARGET, title: "pypi.org", group: "", pinned: false, asleep: false };
  const win = { id: "b1", module: "browser", title: "Browser", x: 8, y: 8, w: 1420, h: 840, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { tabs: [tab], active: "t1", proxyAll: true } };
  assert.equal((await req("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [win], focus: "b1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } })).status, 200);
  browser = await launchChromium(); ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("wp-save").waitFor({ timeout: 40000 });
  await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some((f) => f.src.includes("/api/wp/s/") && f.src.includes("pypi.org")), null, { timeout: 40000 });
  const p = page;
  await test("real PyPI bytes: a concurrent HTTP create after listing forces a retry without overwriting either file", covers, async () => {
    let interfered = false;
    const handler = async (route: Route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (["writeIfUnchanged", "write"].includes(body?.op) && body.path === paths[1] && !interfered) {
          interfered = true;
          const other = await req("POST", "/api/fs", { op: "writeIfUnchanged", path: paths[1], content: "concurrent-user-file", encoding: "utf8", mime: "text/plain", expected: null });
          assert.equal(other.status, 200); created.add(paths[1]);
        }
      }
      await route.continue();
    };
    await p.route(isFs, handler);
    try {
      // Capture exactly the response the app consumes. CDP's getResponseBody is
      // not reliable for this streamed response, so clone it in Chromium instead.
      await p.evaluate(() => {
        const original = window.fetch;
        (window as any).__tt91Capture = true;
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          const response = await original(...args);
          const input = args[0], url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if ((window as any).__tt91Capture && new URL(url, location.href).pathname.endsWith("/__raw")) {
            (window as any).__tt91Capture = false;
            (window as any).__tt91Raw = response.clone().arrayBuffer().then(async (body) => ({ size: body.byteLength,
              hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body))).map((x) => x.toString(16).padStart(2, "0")).join("") }));
          }
          return response;
        };
      });
      await p.getByTestId("wp-save").click();
      await p.waitForFunction(() => { const n = document.querySelector('[data-testid="wp-note"]'); return n?.getAttribute("data-phase") === "idle" && /Saved to Files|Not saved|Save not confirmed/.test(n.textContent ?? ""); }, null, { timeout: 40000 });
      const note = await p.getByTestId("wp-note").innerText();
      assert.equal(interfered, true, "the competing create was not attempted"); assert.match(note, /Saved to Files.*sponsors 3\.html/);
      created.add(paths[2]);
      const source = await p.evaluate(async () => (window as any).__tt91Raw) as { size: number; hash: string }; assert.ok(source.size > 1000);
      const rows = (await db.query("SELECT path,content,encoding,mime,version FROM vfs_nodes WHERE path=ANY($1::text[]) ORDER BY path", [paths])).rows;
      assert.equal(rows.length, 3);
      const map = new Map(rows.map((x) => [x.path, x]));
      assert.equal(map.get(paths[0]).content, "original-user-file"); assert.equal(map.get(paths[1]).content, "concurrent-user-file");
      assert.equal(map.get(paths[2]).encoding, "base64"); assert.equal(map.get(paths[2]).mime, "text/html");
      const stored = Buffer.from(map.get(paths[2]).content, "base64");
      assert.equal(stored.length, source.size); assert.equal(createHash("sha256").update(stored).digest("hex"), source.hash);
      assert.ok(rows.every((x) => x.version === 1));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM vfs_versions WHERE path=ANY($1::text[])", [paths])).rows[0].n, 0);
    } finally { await p.unroute(isFs, handler); }
  });
  await test("saved file is discoverable via the real Files window", covers, async () => {
    await p.getByTestId("wp-open-downloads").click();
    const files = p.getByRole("dialog", { name: "Files", exact: true }).last(); await files.waitFor({ timeout: 15000 });
    await files.getByRole("option", { name: /sponsors 3\.html/ }).waitFor({ timeout: 15000 });
    await files.getByRole("button", { name: "Close window" }).first().click();
  });
  await test("a real >8 MiB PyPI package streamed through the proxy is refused with no extra file", covers, async () => {
    const meta = JSON.parse(execFileSync("curl", ["--fail", "--silent", "--show-error", "https://pypi.org/pypi/numpy/json"], { maxBuffer: 8 << 20 }).toString());
    const wheel = (meta.urls as { url: string; size: number }[]).filter((x) => x.size > 9 * 1048576 && x.size < 20 * 1048576).sort((a, b) => a.size - b.size)[0];
    assert.ok(wheel, "PyPI provided a package between 9 and 20 MiB"); console.log(`    real upstream: ${wheel.size} bytes from files.pythonhosted.org`);
    const handler = async (route: Route) => { const u = new URL(route.request().url()); u.searchParams.set("u", wheel.url); await route.continue({ url: u.toString() }); };
    await p.route(isRaw, handler);
    try {
      await p.getByTestId("wp-save").click();
      await p.getByTestId("wp-note").getByText(/Not saved:.*8 MiB/i).waitFor({ timeout: 60000 });
      assert.equal((await pathState("/Downloads/sponsors 4.html")).json.node, null);
    } finally { await p.unroute(isRaw, handler); }
  });
  await test("cancelling a stalled fetch writes nothing; the UI distinguishes cancellation from commit", covers, async () => {
    let release!: () => void, arrived!: () => void;
    const seen = new Promise<void>((resolve) => { arrived = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handler = async (route: Route) => { arrived(); await held; await route.abort().catch(() => undefined); };
    await p.route(isRaw, handler);
    try {
      await p.getByTestId("wp-save").click(); await seen;
      await p.getByTestId("wp-save-cancel").click();
      await p.getByTestId("wp-note").getByText(/Cancelled before saving; no file was written/).waitFor({ timeout: 10000 });
      assert.equal((await pathState("/Downloads/sponsors 4.html")).json.node, null);
    } finally { release(); await p.unroute(isRaw, handler); }
  });
  await test("a remote HTTP error is reported and never creates a file", covers, async () => {
    const handler = async (route: Route) => { await route.fulfill({ status: 404, body: "remote not found" }); };
    await p.route(isRaw, handler);
    try {
      await p.getByTestId("wp-save").click();
      await p.getByTestId("wp-note").getByText(/Not saved: Remote download failed \(HTTP 404\)/).waitFor({ timeout: 10000 });
      assert.equal((await pathState("/Downloads/sponsors 4.html")).json.node, null);
    } finally { await p.unroute(isRaw, handler); }
  });
  await test("a committed write with its acknowledgement lost is reported as unknown, not as a definite failure", covers, async () => {
    let committedPath = "";
    const handler = async (route: Route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        if (body?.op === "writeIfUnchanged") {
          assert.ok(ownedPaths.includes(body.path)); const committed = await req("POST", "/api/fs", body); assert.equal(committed.status, 200);
          committedPath = body.path; await route.abort("failed"); return;
        }
      }
      await route.continue();
    };
    await p.route(isFs, handler);
    try {
      await p.getByTestId("wp-save").click();
      await p.waitForFunction(() => { const n = document.querySelector('[data-testid="wp-note"]'); return n?.getAttribute("data-phase") === "idle" && /Save not confirmed|Not saved|Saved to Files/.test(n.textContent ?? ""); }, null, { timeout: 40000 });
      assert.match(await p.getByTestId("wp-note").innerText(), /Save not confirmed; check \/Downloads before retrying/);
      assert.ok(committedPath); assert.equal((await db.query("SELECT count(*)::int n FROM vfs_nodes WHERE path=$1", [committedPath])).rows[0].n, 1);
    } finally { await p.unroute(isFs, handler); if (committedPath) await req("POST", "/api/fs", { op: "purge", path: committedPath }); }
  });
  await test("restarting amnesic while the download is stalled does not publish it or permit a conditional host write", covers, async () => {
    let release!: () => void, arrived!: () => void;
    const seen = new Promise<void>((resolve) => { arrived = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handler = async (route: Route) => { arrived(); await held; await route.abort().catch(() => undefined); };
    await p.route(isRaw, handler);
    try {
      await p.getByTestId("wp-save").click(); await seen;
      await p.keyboard.press("Control+Space");
      const palette = p.getByRole("dialog", { name: "Command palette" }); await palette.waitFor();
      await palette.getByRole("button", { name: "apps", exact: true }).click();
      await palette.locator("input").fill("Privacy");
      await palette.locator(".fs-list-item").filter({ has: p.getByText("Privacy", { exact: true }) }).first().click();
      const panel = p.getByTestId("privacy").first(); await panel.waitFor({ timeout: 15000 });
      await panel.getByRole("tab", { name: "Amnesia", exact: true }).click();
      const navigated = p.waitForURL(/\?amnesia=1/, { timeout: 20000 });
      await panel.getByTestId("restart-amnesic").click(); await navigated;
      await p.getByTestId("amnesic-badge").first().waitFor({ timeout: 30000 });
      release();
      const refused = await p.evaluate(async (path) => {
        const r = await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "writeIfUnchanged", path, content: "must not persist", encoding: "utf8", expected: null }) });
        return r.status;
      }, ownedPaths[3]);
      assert.equal(refused, 423);
      assert.equal((await db.query("SELECT count(*)::int n FROM vfs_nodes WHERE path=$1", [ownedPaths[3]])).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int n FROM vfs_versions WHERE path=$1", [ownedPaths[3]])).rows[0].n, 0);
    } finally { release(); await p.unroute(isRaw, handler); }
  });
} finally {
  await ctx?.close().catch(() => undefined); await browser?.close().catch(() => undefined);
  for (const path of created) {
    await req("POST", "/api/fs", { op: "purge", path }).catch(() => undefined);
    // VFS purge normally removes history; include only this exclusive test's known paths if failure left orphans.
    await db.query("DELETE FROM vfs_versions WHERE path=$1", [path]).catch(() => undefined);
  }
  const current = await req("GET", "/api/state?id=default").catch(() => null);
  if (current && oldDesktop.json.row?.state) await req("PUT", "/api/state", { id: "default", revision: Number(current.json.row?.revision ?? 0) + 1000, state: oldDesktop.json.row.state }).catch(() => undefined);
  if (view && view !== "classic") await req("PUT", "/api/settings", { key: "appearance.desktopView", value: view }).catch(() => undefined);
  await db.end();
}
finish();
