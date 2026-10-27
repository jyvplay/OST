import { readFileSync } from "node:fs";
import type { BrowserContext, Frame, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";
import { UA } from "../src/lib/wp-core.ts";

const { test, finish } = makeHarness("e2e-tt85");
const BASE = process.env.BASE ?? "http://localhost:3999";
const ok = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j;
};
async function waitProxyFrame(page: Page, predicate: (frame: Frame) => Promise<boolean>, what: string, timeout = 45000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes("/api/wp/s/"));
    if (frame && await predicate(frame).catch(() => false)) return frame;
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out: ${what}`);
}

const browser = await launchChromium();
const pageErrors: string[] = [];
async function openHub(): Promise<{ ctx: BrowserContext; page: Page }> {
  const current = await api("GET", "/api/state?id=default");
  const revision = Number(current.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision, state: {
    windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
    viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision,
  } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/?open=apps`, { waitUntil: "domcontentloaded" });
  const hub = page.getByRole("dialog", { name: "Apps", exact: true }).last();
  await hub.waitFor({ timeout: 30000 });
  return { ctx, page };
}
const axeSource = readFileSync("node_modules/axe-core/axe.min.js", "utf8");

await test("E1 AP-01 app hub: the live module registry is launchable; real manifest handlers, display mode and origin quota are shown without inventing installed apps or OS associations", { "AP-01": "full", "SH-13": "partial" }, async () => {
  const { ctx, page } = await openHub();
  try {
    const hub = page.getByRole("dialog", { name: "Apps", exact: true }).last();
    const root = hub.getByTestId("app-hub");
    await root.waitFor();
    ok(Number(await root.getAttribute("data-module-count")) === MODULES.length, "registry length not reflected in app hub");
    await hub.getByTestId("app-module-open").first().waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="app-storage-estimate"]')?.getAttribute("data-state") !== "loading");
    const browserInfo = await page.evaluate(async () => {
      const estimate = await navigator.storage?.estimate?.();
      const mode = window.matchMedia("(display-mode: standalone)").matches ? "standalone"
        : window.matchMedia("(display-mode: minimal-ui)").matches ? "minimal-ui"
        : window.matchMedia("(display-mode: fullscreen)").matches ? "fullscreen"
        : window.matchMedia("(display-mode: window-controls-overlay)").matches ? "window-controls-overlay" : "browser tab";
      return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, mode };
    });
    const storageUi = hub.getByTestId("app-storage-estimate");
    ok(await storageUi.getAttribute("data-state") === "available", "origin storage estimate API should be read and labeled available in Chromium");
    ok(Number(await storageUi.getAttribute("data-usage")) === browserInfo.usage, "displayed origin usage differs from navigator.storage.estimate()");
    ok(Number(await storageUi.getAttribute("data-quota")) === browserInfo.quota, "displayed origin quota differs from navigator.storage.estimate()");
    ok((await hub.getByTestId("app-display-mode").innerText()).trim() === browserInfo.mode, "display-mode badge differs from live matchMedia");
    const ids = await hub.getByTestId("app-module-open").evaluateAll((els) => els.map((e) => e.getAttribute("data-module-id")));
    ok(ids.length === MODULES.length && JSON.stringify(ids) === JSON.stringify(MODULES.map((m) => m.id)), `module rows drifted from registry: ${ids.length}/${MODULES.length}`);
    await hub.getByTestId("app-module-filter").fill("no-such-module-tt85");
    await hub.getByText("No modules match that filter.").waitFor();
    await hub.getByTestId("app-module-filter").fill("");
    await hub.getByTestId("app-module-open").filter({ has: page.locator("strong", { hasText: "Calculator" }) }).first().click();
    await page.getByRole("dialog", { name: "Calculator", exact: true }).waitFor();
    await page.getByRole("dialog", { name: "Calculator", exact: true }).getByRole("button", { name: "Close window", exact: true }).click();

    const manifest = await page.evaluate(async () => await (await fetch("/manifest.webmanifest", { cache: "no-store" })).json());
    await hub.getByTestId("app-related-state").waitFor();
    await page.waitForFunction(() => {
      const x = document.querySelector('[data-testid="app-related-state"]');
      return !!x && !/waiting for manifest/.test(x.textContent || "");
    });
    const fileCount = await hub.getByTestId("app-file-handler").count();
    ok(fileCount === (manifest.file_handlers?.length ?? 0), `file handler declarations ${fileCount} differ from manifest ${manifest.file_handlers?.length ?? 0}`);
    const moduleHubText = await hub.innerText();
    for (const handler of manifest.file_handlers ?? []) {
      ok(moduleHubText.includes(handler.action ?? "(unspecified)"), `file handler action ${handler.action} missing`);
      for (const [mime, extensions] of Object.entries(handler.accept ?? {})) {
        ok(moduleHubText.includes(mime), `file handler MIME ${mime} missing`);
        for (const ext of extensions) ok(moduleHubText.includes(ext), `file handler extension ${ext} missing`);
      }
    }
    for (const protocol of manifest.protocol_handlers ?? []) ok(moduleHubText.includes(protocol.protocol), `protocol declaration ${protocol.protocol} missing`);
    if (manifest.share_target) ok(moduleHubText.includes("Share target"), "share target missing");
    if (!(manifest.related_applications?.length)) ok((await hub.getByTestId("app-related-state").innerText()).includes("no related apps declared"), "empty relationship must not be described as a device-wide empty app list");
    ok(moduleHubText.includes("origin quota") && moduleHubText.includes("per Fusion module"), "storage boundary is not visible");
    // An install prompt is never forged: a disabled control is expected unless Chromium actually dispatched the event.
    const prompt = await hub.getByTestId("app-install").isEnabled();
    if (!prompt) ok(await hub.getByTestId("app-install").isDisabled(), "install enabled with no captured browser prompt");
    const relatedState = await hub.getByTestId("app-related-state").getAttribute("data-count");
    ok(relatedState !== null, "related-app result count missing");

    await page.waitForTimeout(250); // Let selected-tab theme transitions settle before contrast checks.
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      const r = await (window as any).axe.run(document.querySelector('[data-testid="app-hub"]'), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
      return r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) }));
    });
    ok(!violations.length, `Apps module axe violations ${JSON.stringify(violations)}`);
    ok(pageErrors.length === 0, `page errors ${pageErrors.join(" | ")}`);
    console.log(`    modules=${ids.length}; manifest handlers=${handlerCount(manifest)}; browser prompt=${prompt ? "actually offered" : "not offered"}; related app count=${relatedState}`);
  } finally { await ctx.close(); }
});

await test("E2 AP-05 inventory: actual service-worker registrations and sync tags match Chromium APIs; page callback counters are measured and clearly not OS wake counts", { "AP-05": "full" }, async () => {
  const { ctx, page } = await openHub();
  try {
    const hub = page.getByRole("dialog", { name: "Apps", exact: true }).last();
    await hub.getByRole("tab", { name: /Background & startup/ }).click();
    await hub.getByTestId("app-runtime-inventory").waitFor();
    const planner = hub.locator('[data-testid="app-bg-job"][data-job-id="planner-reminders"]');
    const routines = hub.locator('[data-testid="app-bg-job"][data-job-id="routine-triggers"]');
    await page.waitForFunction(() => {
      const a = document.querySelector('[data-testid="app-bg-job"][data-job-id="planner-reminders"]');
      const b = document.querySelector('[data-testid="app-bg-job"][data-job-id="routine-triggers"]');
      return Number(a?.getAttribute("data-callbacks") ?? 0) >= 1 && Number(b?.getAttribute("data-callbacks") ?? 0) >= 1;
    }, null, { timeout: 15000 });
    ok(Number(await planner.getAttribute("data-callbacks")) >= 1, "reminder callback not measured");
    ok(Number(await routines.getAttribute("data-callbacks")) >= 1, "routine callback not measured");
    ok((await hub.innerText()).includes("not operating-system wake counts"), "counter scope is not disclosed");

    const actual = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return { available: false, registrations: [] as any[] };
      const registrations = await navigator.serviceWorker.getRegistrations();
      const read = async (m: { getTags?: () => Promise<string[]> } | undefined) => {
        if (typeof m?.getTags !== "function") return { state: "not-exposed", tags: [] as string[], error: "" };
        try { return { state: "available", tags: await m.getTags(), error: "" }; }
        catch (e) { return { state: "query-failed", tags: [] as string[], error: String((e as Error).message ?? e) }; }
      };
      return { available: true, registrations: await Promise.all(registrations.map(async (r) => {
        const x = r as ServiceWorkerRegistration & { sync?: { getTags?: () => Promise<string[]> }; periodicSync?: { getTags?: () => Promise<string[]> } };
        return { scope: r.scope, activeUrl: r.active?.scriptURL ?? null, updateViaCache: r.updateViaCache, sync: await read(x.sync), periodic: await read(x.periodicSync) };
      })) };
    });
    ok(actual.available, "headless Chromium did not expose ServiceWorkerContainer on the secure localhost origin");
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="app-sw-registration"]').length === n, actual.registrations.length, { timeout: 15000 });
    const visible = await hub.getByTestId("app-sw-registration").evaluateAll((els) => els.map((e) => ({
      scope: e.getAttribute("data-scope"),
      active: e.querySelectorAll(".fs-row")[1]?.textContent ?? "",
      sync: e.querySelector('[data-testid="app-sync-tags"]')?.getAttribute("data-tags") ?? "",
      syncState: e.querySelector('[data-testid="app-sync-tags"]')?.getAttribute("data-state") ?? "",
      periodic: e.querySelector('[data-testid="app-periodic-sync"]')?.getAttribute("data-tags") ?? "",
      periodicState: e.querySelector('[data-testid="app-periodic-sync"]')?.getAttribute("data-state") ?? "",
    })));
    ok(visible.length === actual.registrations.length, "visible registration cardinality differs from browser API");
    for (let i = 0; i < actual.registrations.length; i++) {
      const reg = actual.registrations[i], ui = visible.find((x) => x.scope === reg.scope);
      ok(!!ui, `missing actual scope ${reg.scope}`);
      ok(reg.activeUrl ? ui!.active.includes(reg.activeUrl) : ui!.active.includes("none"), `active worker mismatch for ${reg.scope}`);
      for (const [label, apiState, tags, uiState, uiTags] of [
        ["one-off", reg.sync.state, reg.sync.tags, ui!.syncState, ui!.sync],
        ["periodic", reg.periodic.state, reg.periodic.tags, ui!.periodicState, ui!.periodic],
      ] as const) {
        ok(uiState === apiState, `${label} sync query state differs for ${reg.scope}: browser=${apiState}, UI=${uiState}`);
        if (apiState === "available") ok(uiTags.split(/\s+/).filter(Boolean).sort().join("|") === [...tags].sort().join("|"), `${label} sync tags differ for ${reg.scope}`);
        if (apiState === "query-failed") ok((await hub.getByTestId(label === "one-off" ? "app-sync-tags" : "app-periodic-sync").first().innerText()).includes("Browser refused query"), `${label} sync query failure must be explicit`);
      }
    }
    const periodic = await hub.getByTestId("app-periodic-sync").first().getAttribute("data-tags");
    ok(periodic !== null, "periodic tag state missing");
    ok((await hub.innerText()).includes("Fusion registers no periodic sync job itself"), "no-self-registration boundary missing");
    await page.waitForTimeout(250); // Let selected-tab theme transitions settle before contrast checks.
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      const r = await (window as any).axe.run(document.querySelector('[data-testid="app-hub"]'), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
      return r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) }));
    });
    ok(!violations.length, `background inventory axe violations ${JSON.stringify(violations)}`);
    ok(pageErrors.length === 0, `page errors ${pageErrors.join(" | ")}`);
    console.log(`    service workers=${actual.registrations.length}; periodic tags=${actual.registrations.reduce((n, r) => n + (r.periodic.tags?.length ?? 0), 0)}; actual page callbacks=${await planner.getAttribute("data-callbacks")}/${await routines.getAttribute("data-callbacks")}`);
  } finally { await ctx.close(); }
});

await test("E3 PR-07h per-site browser identity: desktop is the default, a mobile override is host-scoped and survives same-site navigation, and another host remains on default", { "PR-07h": "full" }, async () => {
  const previous = (await api("GET", "/api/state?id=default")).row?.state;
  const current = await api("GET", "/api/state?id=default");
  const revision = Number(current.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision, state: {
    windows: [{ id: "ua-test", module: "browser", title: "Browser", x: 8, y: 8, w: 1420, h: 840, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {
      tabs: [{ id: "ua-tab", url: "https://pypi.org/", title: "pypi.org", group: "", pinned: false, asleep: false }], active: "ua-tab", proxyAll: true,
    } }], focus: "ua-test", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
    viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision,
  } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  ctx.setDefaultTimeout(20000);
  let sid = "";
  try {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const frameRow = page.getByTestId("wp-tab");
    await frameRow.waitFor({ timeout: 30000 });
    await waitProxyFrame(page, async (frame) => frame.url().includes("pypi.org") && await frame.locator('input[name="q"]').count() > 0, "PyPI in private proxy");
    sid = (await frameRow.getAttribute("data-sid")) ?? "";
    ok(!!sid, "proxy session id missing");
    const selector = page.getByTestId("wp-ua");
    await page.waitForFunction(() => document.querySelector('[data-testid="wp-ua"]')?.getAttribute("data-effective") === "desktop");
    ok(await selector.inputValue() === "default", "new site must use the Desktop default rather than an explicit override");
    const desktopFrame = await waitProxyFrame(page, async (frame) => (await frame.evaluate(() => navigator.userAgent)) === UA.desktop, "desktop page identity");
    const desktopPage = await desktopFrame.evaluate(() => ({ ua: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform, touch: navigator.maxTouchPoints, uaDataSuppressed: (navigator as Navigator & { userAgentData?: unknown }).userAgentData === undefined }));
    ok(desktopPage.ua === UA.desktop && desktopPage.appVersion === UA.desktop.slice(8) && desktopPage.platform === "Win32" && desktopPage.touch === 0 && desktopPage.uaDataSuppressed, `desktop page surface mismatch: ${JSON.stringify(desktopPage)}`);
    const initial = await api("GET", `/api/wp-session?sid=${encodeURIComponent(sid)}&site=pypi.org`);
    ok(initial.ua === "desktop" && initial.uaOverride === null, "new site's upstream identity should be default desktop");

    await selector.selectOption("mobile");
    await page.waitForFunction(() => document.querySelector('[data-testid="wp-ua"]')?.getAttribute("data-effective") === "mobile");
    const mobileFrame = await waitProxyFrame(page, async (frame) => (await frame.evaluate(() => navigator.userAgent)).includes("Android 14") && (await frame.evaluate(() => navigator.userAgent)).includes("Mobile"), "mobile page identity after server-side session reload");
    const mobilePage = await mobileFrame.evaluate(() => ({ ua: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform, touch: navigator.maxTouchPoints, uaDataSuppressed: (navigator as Navigator & { userAgentData?: unknown }).userAgentData === undefined }));
    ok(mobilePage.ua === UA.mobile && mobilePage.appVersion === UA.mobile.slice(8) && mobilePage.platform === "Linux armv8l" && mobilePage.touch === 5 && mobilePage.uaDataSuppressed, `mobile page surface mismatch: ${JSON.stringify(mobilePage)}`);
    const mobile = await api("GET", `/api/wp-session?sid=${encodeURIComponent(sid)}&site=pypi.org`);
    ok(mobile.ua === "mobile" && mobile.uaOverride === "mobile", "server session did not retain the pypi.org override");

    const sponsor = mobileFrame.locator('a[href*="/sponsors/"]').first();
    await sponsor.click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="wp-tab"]')?.getAttribute("data-url") ?? "").endsWith("/sponsors/"), null, { timeout: 30000 });
    const sponsorFrame = await waitProxyFrame(page, async (frame) => /^Sponsors/.test(await frame.title()) && (await frame.evaluate(() => navigator.userAgent)) === UA.mobile, "same-site navigation keeps the mobile override");
    ok((await sponsorFrame.evaluate(() => navigator.userAgent)) === UA.mobile, "same-site navigation lost the selected identity");
    const otherSite = await api("GET", `/api/wp-session?sid=${encodeURIComponent(sid)}&site=registry.npmjs.org`);
    ok(otherSite.ua === "desktop" && otherSite.uaOverride === null, "a pypi.org override leaked to another host");

    await page.getByTestId("wp-ua").selectOption("default");
    await page.waitForFunction(() => document.querySelector('[data-testid="wp-ua"]')?.getAttribute("data-effective") === "desktop");
    const resetFrame = await waitProxyFrame(page, async (frame) => /^Sponsors/.test(await frame.title()) && (await frame.evaluate(() => navigator.userAgent)) === UA.desktop, "clearing the per-site override restores Desktop");
    ok((await resetFrame.evaluate(() => navigator.userAgent)) === UA.desktop, "default identity was not restored");
    const reset = await api("GET", `/api/wp-session?sid=${encodeURIComponent(sid)}&site=pypi.org`);
    ok(reset.ua === "desktop" && reset.uaOverride === null, "site override was not cleared");
    const privateStats = await api("GET", `/api/wp-session?sid=${encodeURIComponent(sid)}`);
    ok(!("uaOverrides" in privateStats) && !("uaOverride" in privateStats), "session API must not export the complete site-override map");
    // PyPI embeds third-party ad/status assets that may throw inside the opaque proxy frame when this sandbox blocks
    // their separate hosts; this test gates only the tested Fusion identity path, not completeness of those assets.
  } finally {
    await ctx.close();
    if (sid) await api("DELETE", `/api/wp-session?sid=${encodeURIComponent(sid)}`).catch(() => undefined);
    const latest = await api("GET", "/api/state?id=default");
    const restoreRevision = Number(latest.row?.revision ?? 1) + 1000;
    const restored = previous ?? { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false };
    await api("PUT", "/api/state", { id: "default", revision: restoreRevision, state: { ...restored, revision: restoreRevision } });
  }
});

await browser.close();
finish();

function handlerCount(manifest: { file_handlers?: unknown[]; protocol_handlers?: unknown[]; share_target?: unknown }): number {
  return (manifest.file_handlers?.length ?? 0) + (manifest.protocol_handlers?.length ?? 0) + (manifest.share_target ? 1 : 0);
}
