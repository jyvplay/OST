/**
 * Real-browser suite "e2e-browser" (TT16): the Fusion Browser's tab/session features over a production server.
 * The sandbox has no general internet, so frames show the honest "refuses to be embedded / probe failed" state; these
 * tests exercise the tab model, session restore safety, shortcuts and per-site delegation UI — not page rendering.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-browser.mts
 */
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-browser");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
async function putDesktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows[0] as { id?: string })?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const win = (props: Record<string, unknown>) => ({ id: "wb1", module: "browser", title: "Browser", x: 40, y: 40, w: 1300, h: 760, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
const browser: Browser = await launchChromium();
const errors: string[] = [];
async function open(windows: unknown[]): Promise<{ page: Page; root: Locator; close: () => Promise<void> }> {
  await putDesktop(windows);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const root = page.locator('[data-testid="browser"]').first();
  await root.waitFor({ timeout: 25_000 });
  return { page, root, close: () => ctx.close() };
}
const attr = (root: Locator, k: string) => root.getAttribute(`data-${k}`);
const waitAttr = async (page: Page, root: Locator, k: string, f: (v: string | null) => boolean, m: string) => { for (let i = 0; i < 50; i++) { if (f(await attr(root, k))) return; await page.waitForTimeout(100); } throw new Error(`${m}: data-${k}=${await attr(root, k)}`); };

await test("hostile saved session: javascript:, same-origin and credential URLs are dropped on restore; no frame ever points at the shell origin", { "PR-07": "full", "PR-07r": "partial" }, async () => {
  const s = await open([win({ tabs: [
    { id: "t1", url: "javascript:window.__pwned=1", title: "x", group: "", pinned: false, asleep: false },
    { id: "t2", url: `${BASE}/api/fs?op=read&path=/x.html`, title: "self", group: "", pinned: false, asleep: false },
    { id: "t3", url: "https://bank.example@evil.example/", title: "phish", group: "", pinned: false, asleep: false },
    { id: "t4", url: "https://example.org/ok", title: "ok", group: "", pinned: false, asleep: false },
  ], active: "t2" })]);
  try {
    ok((await attr(s.root, "tabs")) === "1", `tabs ${await attr(s.root, "tabs")}`);
    ok((await attr(s.root, "active")) === "t4", `active ${await attr(s.root, "active")}`);
    ok(/3 saved tab\(s\) dropped/.test(await s.root.locator('[data-testid="browser-notice"]').innerText()), "no drop notice");
    const srcs = await s.page.locator("iframe").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""));
    ok(!srcs.some((u) => u.startsWith("javascript") || u.startsWith(BASE) || u.startsWith("/api/fs")), `frames: ${srcs}`);
    ok((await s.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)) === undefined, "javascript: ran");
  } finally { await s.close(); }
});

await test("address bar refuses credential, non-http and own-origin URLs; accepts bare hosts (https)", { "PR-07": "partial", "PR-07a": "partial" }, async () => {
  const s = await open([win({ tabs: [{ id: "a1", url: "https://example.org/", title: "a", group: "", pinned: false, asleep: false }], active: "a1" })]);
  try {
    const addr = s.root.getByLabel("Address");
    for (const bad of ["https://bank.example@evil.example/", "javascript:alert(1)", `${BASE}/api/health`, "data:text/html,hi"]) {
      await addr.fill(bad); await addr.press("Enter");
      ok(/Refused/.test(await s.root.locator('[data-testid="browser-notice"]').innerText()), `no refusal for ${bad}`);
      ok((await attr(s.root, "tabs")) === "1", `tab opened for ${bad}`);
    }
    await addr.fill("example.net/docs"); await addr.press("Enter");
    await waitAttr(s.page, s.root, "tabs", (v) => v === "2", "bare host not opened");
    ok(await s.root.locator('[data-tab]').filter({ hasText: "example.net" }).count() === 1, "tab title");
    ok((await addr.inputValue()) === "https://example.net/docs", `address after open: ${await addr.inputValue()}`);
    await s.root.locator('[data-tab="a1"]').click();
    for (let i = 0; i < 30 && (await addr.inputValue()) !== "https://example.org/"; i++) await s.page.waitForTimeout(100);
    ok((await addr.inputValue()) === "https://example.org/", `address follows the active tab: ${await addr.inputValue()}`);
  } finally { await s.close(); }
});

await test("Alt+T / Alt+P / Alt+1..9 / Alt+W shortcuts; pinned tabs move left; middle-click closing the active tab keeps a live tab", { "PR-07i": "full", "PR-07f": "full", "PR-07a": "full" }, async () => {
  const s = await open([win({ tabs: [{ id: "a1", url: "https://example.org/", title: "a", group: "", pinned: false, asleep: false }], active: "a1" })]);
  try {
    await s.root.getByLabel("Address").click(); await s.page.keyboard.press("Escape");
    await s.root.locator('[data-tab="a1"]').focus();
    await s.page.keyboard.press("Alt+t"); await s.page.keyboard.press("Alt+t");
    await waitAttr(s.page, s.root, "tabs", (v) => v === "3", "Alt+T");
    const third = (await attr(s.root, "active"))!;
    await s.page.keyboard.press("Alt+p"); await waitAttr(s.page, s.root, "pinned", (v) => v === third, "Alt+P pin");
    const order = await s.root.locator("[data-tab]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tab")));
    ok(order[0] === third, `pinned not first: ${order}`);
    await s.page.keyboard.press("Alt+2"); await waitAttr(s.page, s.root, "active", (v) => v === order[1], "Alt+2");
    // middle-click the active tab → focus moves to a remaining tab (regression: the view used to go blank)
    const act = (await attr(s.root, "active"))!;
    await s.root.locator(`[data-tab="${act}"]`).click({ button: "middle" });
    await waitAttr(s.page, s.root, "tabs", (v) => v === "2", "middle-click close");
    const now = (await attr(s.root, "active"))!;
    ok(now !== act && (await s.root.locator(`[data-tab="${now}"]`).count()) === 1, `active ${now} is not a live tab`);
    await s.root.locator(`[data-tab="${now}"]`).focus(); // shortcuts are scoped to the focused module (by design)
    await s.page.keyboard.press("Alt+w"); await waitAttr(s.page, s.root, "tabs", (v) => v === "1", "Alt+W");
  } finally { await s.close(); }
});

await test("batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs", { "PR-07q": "full", "PR-07c": "full", "PR-07b": "full", "PR-07g": "full" }, async () => {
  const T = (id: string, url: string, pinned = false) => ({ id, url, title: new URL(url).host, group: "", pinned, asleep: false });
  const s = await open([win({ tabs: [T("p1", "https://pinned.example/", true), T("a", "https://a.example/"), T("b", "https://b.example/"), T("a2", "https://a.example/"), T("c", "https://c.example/")], active: "b" })]);
  try {
    await s.root.locator('[data-tab="a"]').click();
    await s.root.getByRole("button", { name: "Close duplicates" }).click();   // removes every later duplicate URL
    await waitAttr(s.page, s.root, "tabs", (v) => v === "4", "duplicate a.example not closed");
    await s.root.getByRole("button", { name: "Sleep other tabs" }).click();
    ok(/2 tab\(s\) put to sleep/.test(await s.root.locator('[data-testid="browser-notice"]').innerText()), "sleep count (pinned + active spared)");
    await s.root.getByLabel("Tab group").selectOption("+");
    await s.root.getByRole("button", { name: "Vertical tab sidebar" }).click().catch(async () => { await s.root.getByTitle("Vertical tab sidebar").click(); });
    const name = s.root.getByLabel("Group name g1"); await name.fill("Research");
    await s.root.getByRole("button", { name: "Collapse Research" }).click();
    await s.root.locator('[data-tab]').first().waitFor({ state: "detached" }).catch(() => undefined);
    await s.root.getByLabel("Search tabs").fill("c.example");
    const visible = await s.root.locator("button.fs-list-item").allInnerTexts();
    ok(visible.length === 1 && visible[0].includes("c.example"), `search: ${visible}`);
    await s.root.getByLabel("Search tabs").fill("");
    await s.root.getByRole("button", { name: "Close others" }).click();
    await waitAttr(s.page, s.root, "tabs", (v) => v === "2", "close others must keep the pinned tab");
    ok((await attr(s.root, "pinned")) === "p1", "pinned survived");
  } finally { await s.close(); }
});

await test("site permissions panel writes the iframe delegation policy into the saved session", { "PR-07l": "full" }, async () => {
  const s = await open([win({ tabs: [{ id: "a1", url: "https://example.org/", title: "a", group: "", pinned: false, asleep: false }], active: "a1" })]);
  try {
    await s.root.getByRole("button", { name: "Site permissions" }).click();
    await s.root.getByLabel("Delegate camera to example.org").check();
    await s.root.getByLabel("Delegate fullscreen to example.org").check();
    let perms: unknown = null;
    for (let i = 0; i < 40 && !perms; i++) { await s.page.waitForTimeout(150); const st = await api("GET", "/api/state?id=default"); perms = st.json.row?.state?.windows?.find((w: { id: string }) => w.id === "wb1")?.props?.perms?.["example.org"]; }
    ok(JSON.stringify(perms) === JSON.stringify(["camera", "fullscreen"]), `persisted perms ${JSON.stringify(perms)}`);
  } finally { await s.close(); }
});

await test("no page errors in the browser session", { "PR-07": "partial" }, () => { ok(errors.length === 0, errors.join(" | ")); });
await browser.close();
finish();
