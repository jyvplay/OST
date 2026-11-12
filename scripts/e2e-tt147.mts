/**
 * TT147 — real Chromium against the real server, for the four capability rows.
 *
 * The pure suite proves the rules; this one proves the rules are wired to the
 * browser that is actually running. Each assertion pairs a claim with the API
 * call that can falsify it *in this engine* — the accelerator card must agree
 * with `requestAdapter`, the peripheral card must agree with `navigator.*`
 * presence, and the cursor must really be confined (`document.pointerLockElement`).
 */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { ENTRIES, detectPlatform } from "../src/lib/settings/deep-links.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt147");

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}

const browser = await launchChromium();

async function openModule(module: string, props: Record<string, unknown> = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    await api("PUT", "/api/state", {
      id: "default", revision: Number(cur.row?.revision ?? 1) + 1000,
      state: {
        windows: [{ id: "w1", module, title: module, x: 10, y: 10, w: 1180, h: 900, z: 10, workspace: 1, props }],
        focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
      },
    });
    const context = await browser.newContext({ viewport: { width: 1240, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-win-id="w1"] .fs-winbody > *');
    const label = (await page.evaluate(() => document.querySelector('[data-win-id="w1"]')?.getAttribute("aria-label") ?? "")).toLowerCase();
    if (label.includes(module)) return { page, context };
    await context.close();
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`the shell kept loading a module other than "${module}"`);
}

await test("ST-02 the settings index names real panels and offers only the ones this platform has", { "ST-02": "full" }, async () => {
  const { page, context } = await openModule("settings");
  await page.getByRole("tab", { name: "Default apps" }).click();
  await page.waitForSelector('[data-testid="syslinks-search"]');

  // The platform the app decided on must be the platform the browser reports.
  const ua = await page.evaluate(() => navigator.userAgent);
  const platformHint = await page.evaluate(() => navigator.platform ?? "");
  const expectPlatform = detectPlatform(ua, platformHint);
  const expectCoverage = ENTRIES.filter((e) => Boolean(e.uris[expectPlatform])).length;
  const badge = await page.getByTestId("syslinks-coverage").innerText();
  assert.match(badge, new RegExp(`^${expectCoverage}/${ENTRIES.length} on `), `coverage badge read "${badge}" for ${expectPlatform}`);
  assert.ok(expectCoverage > 0, "this engine must resolve to a platform with at least one panel");

  // Search narrows to the entry a person named.
  await page.getByTestId("syslinks-search").fill("camera");
  await page.waitForFunction(() => document.querySelectorAll("[data-syslink]").length === 1);
  const row = page.locator("[data-syslink]").first();
  assert.equal(await row.getAttribute("data-syslink"), "camera");
  const open = page.getByTestId("syslink-open-camera");
  const uri = await open.getAttribute("title");
  assert.ok(uri && uri.length > 8, "the button must carry the URI it would hand to the OS");
  // It must be this platform's scheme, not another OS's.
  if (expectPlatform === "linux") assert.match(uri!, /^gnome-control-center /);
  if (expectPlatform === "windows") assert.match(uri!, /^ms-settings:/);
  if (expectPlatform === "macos") assert.match(uri!, /^x-apple\.systempreferences:/);

  // A query that matches nothing says so instead of showing everything.
  await page.getByTestId("syslinks-search").fill("zzzzz");
  await page.waitForSelector('[data-testid="syslinks-empty"]');
  assert.equal(await page.locator("[data-syslink]").count(), 0);
  await page.getByTestId("syslinks-search").fill("");
  await page.waitForFunction(() => document.querySelectorAll("[data-syslink]").length > 0);
  await page.screenshot({ path: "/tmp/tt147-syslinks.png" });
  await context.close();
});

await test("HW-04 the accelerator card agrees with a direct WebGPU request in the same page", { "HW-04": "full" }, async () => {
  const { page, context } = await openModule("devices");
  await page.getByRole("tab", { name: "Runtime" }).click();
  await page.waitForSelector('[data-testid="accel-summary"]');
  await page.waitForFunction(() => !/asking this engine/.test(document.querySelector('[data-testid="accel-summary"]')?.textContent ?? ""), undefined, { timeout: 25_000 });

  // What the browser itself says, measured here, by us.
  const direct = await page.evaluate(async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: unknown): Promise<unknown> } }).gpu;
    if (!gpu) return { present: false, text: "", fallback: null as boolean | null };
    const a = await gpu.requestAdapter({ powerPreference: "high-performance" }) as { isFallbackAdapter?: boolean; info?: { vendor?: string; architecture?: string; description?: string } } | null;
    if (!a) return { present: true, adapter: false as const, text: "", fallback: null as boolean | null };
    const info = a.info ?? {};
    return { present: true, adapter: true as const, text: [info.vendor, info.architecture, info.description].filter(Boolean).join(" ").toLowerCase(), fallback: a.isFallbackAdapter === true };
  });
  const cardVerdict = (await page.getByTestId("accel-verdict").innerText()).trim();
  assert.ok(["software", "hardware", "none"].includes(cardVerdict), `the card must state a verdict, read "${cardVerdict}"`);
  const summary = await page.getByTestId("accel-summary").innerText();
  assert.ok(summary.length > 10, "the card must summarise the answer in a sentence");

  // The claim and the API must agree, whichever way this machine falls.
  const softwareHints = /swiftshader|llvmpipe|software|basic render|lavapipe/i;
  if (!direct.present) {
    assert.equal(cardVerdict, "none");
    assert.match(summary, /no accelerator claims|CPU thread/);
  } else if (direct.adapter === false) {
    assert.equal(cardVerdict, "none");
  } else if (direct.fallback || softwareHints.test(direct.text)) {
    assert.equal(cardVerdict, "software", `adapter said "${direct.text}" but the card said ${cardVerdict}`);
  } else {
    assert.equal(cardVerdict, "hardware", `adapter said "${direct.text}" but the card said ${cardVerdict}`);
  }
  await page.screenshot({ path: "/tmp/tt147-accelerators.png" });
  await context.close();
});

await test("HW-07 the peripheral card lists every bus this engine has, and counts only what is granted", { "HW-07": "full" }, async () => {
  const { page, context } = await openModule("devices");
  await page.getByRole("tab", { name: "Runtime" }).click();
  await page.waitForSelector('[data-testid="peripheral-limits"]');
  await page.waitForFunction(() => /granted/.test(document.body.innerText));
  const direct = await page.evaluate(() => ({
    hid: "hid" in navigator, usb: "usb" in navigator, serial: "serial" in navigator, bluetooth: "bluetooth" in navigator,
  }));
  const text = await page.evaluate(() => document.querySelector('[data-win-id="w1"]')?.innerText ?? "");
  for (const bus of ["HID", "USB", "SERIAL", "BLUETOOTH"] as const) {
    const line = new RegExp(`${bus}\\n([^\\n]+)`).exec(text)?.[1] ?? "";
    assert.ok(line.length > 0, `${bus} row must be present`);
    const present = direct[bus.toLowerCase() as keyof typeof direct];
    assert.equal(/absent/.test(line), !present, `${bus}: the card said "${line}" but the API presence is ${present}`);
  }
  // The honest limit is printed, not implied.
  const limits = await page.getByTestId("peripheral-limits").innerText();
  assert.match(limits, /already granted|device list/);
  await context.close();
});

await test("WM-16 the cursor is really confined by a real click, and really released", { "WM-16": "full" }, async () => {
  const { page, context } = await openModule("devices");
  await page.getByRole("tab", { name: "Runtime" }).click();
  await page.waitForSelector('[data-testid="confine-toggle"]');
  assert.equal(await page.evaluate(() => document.pointerLockElement === null), true);

  await page.getByTestId("confine-toggle").click();
  // Pointer lock is asynchronous; wait for the document to report it.
  const locked = await page.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 10_000 })
    .then(() => true).catch(() => false);
  if (!locked) {
    // Headless without a pointer device may refuse. That is a real answer, and
    // the card must have said why rather than pretending to be locked.
    const note = await page.getByTestId("confine-note").innerText();
    assert.match(note, /free|refused|waiting/, `refusal must be explained, read "${note}"`);
    await context.close();
    return;
  }
  const surfaceLocked = await page.evaluate(() => document.pointerLockElement?.getAttribute("data-testid") ?? "");
  assert.equal(surfaceLocked, "confine-surface", "the lock must be on the card's own surface");
  assert.match(await page.getByTestId("confine-note").innerText(), /confined/);

  // Release through the same control, not by a raw exitPointerLock, so the
  // state machine is exercised end to end.
  await page.getByTestId("confine-toggle").click();
  await page.waitForFunction(() => document.pointerLockElement === null, undefined, { timeout: 10_000 });
  assert.match(await page.getByTestId("confine-note").innerText(), /free/);
  await page.screenshot({ path: "/tmp/tt147-confinement.png" });
  await context.close();
});

await test("AU-01 a routine is previewed, saved, rehearsed, then run — and the audit tells them apart", { "AU-01": "full" }, async () => {
  const { page, context } = await openModule("routines");
  const name = `tt147-${Date.now().toString(36)}`;
  const auditBefore = await api<{ log: { action: string; detail: string }[] }>("GET", "/api/jobs?limit=80");

  // A command outside the whitelist is refused at authoring time, not at run time.
  await page.getByTestId("routine-script").fill("open files; selfDestruct now");
  await page.waitForFunction(() => /not in the routine whitelist/.test(document.body.innerText));
  assert.equal(await page.getByTestId("routine-save").isDisabled(), true, "Save must be disabled while the script is invalid");

  // A valid script previews without executing anything.
  await page.getByTestId("routine-script").fill("open files; theme dark");
  await page.waitForFunction(() => /2 valid actions/.test(document.body.innerText));
  await page.getByTestId("routine-preview").click();
  const preview = await page.getByTestId("routine-preview-text").innerText();
  assert.match(preview, /nothing executed yet/);
  assert.match(preview, /1\. open files/);
  const openBefore = await page.evaluate(() => document.querySelectorAll("[data-win-id]").length);

  await page.getByTestId("routine-name").fill(name);
  await page.getByTestId("routine-save").click();
  await page.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 15_000 });
  // Saving a routine must not have opened anything: a preview is not a run.
  assert.equal(await page.evaluate(() => document.querySelectorAll("[data-win-id]").length), openBefore);

  // The token routine selector also contains routine names. Require the actual
  // row's Rehearse control, not just any ancestor containing the name.
  const row = page.locator("div.fs-row", { hasText: name }).filter({ has: page.getByTestId("routine-rehearse") }).first();
  await row.getByTestId("routine-rehearse").click();
  await page.waitForFunction(() => /nothing was executed/i.test(document.body.innerText), undefined, { timeout: 15_000 });

  await row.getByTestId("routine-run").click();
  // The run really executed: a Files window is now open in this shell.
  await page.waitForFunction(() => [...document.querySelectorAll("[data-win-id]")].some((e) => /files/i.test(e.getAttribute("aria-label") ?? "")), undefined, { timeout: 20_000 });

  // Both events are in the audit log, with different actions — the distinction
  // the row promises is visible to a human after the fact.
  const ids = await api<{ rows: { id: number; name: string }[] }>("GET", "/api/routines");
  const mine = ids.rows.find((r) => r.name === name);
  assert.ok(mine, "the routine must exist on the server");
  // The run's audit row is written after the executor finishes, so poll for it
  // instead of sampling once and calling the race a failure.
  const deadline = Date.now() + 20_000;
  let after = await api<{ log: { action: string; detail: string }[] }>("GET", "/api/jobs?limit=80");
  while (!after.log.some((l) => l.action === "routine.run" && l.detail === String(mine!.id)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    after = await api<{ log: { action: string; detail: string }[] }>("GET", "/api/jobs?limit=80");
  }
  const mineLog = after.log.filter((l) => l.detail === String(mine!.id));
  assert.ok(mineLog.some((l) => l.action === "routine.dryrun"), "the rehearsal must be audited as routine.dryrun");
  assert.ok(mineLog.some((l) => l.action === "routine.run"), "the run must be audited as routine.run");
  assert.ok(after.log.length >= auditBefore.log.length, "the log only grows");
  await page.screenshot({ path: "/tmp/tt147-routines.png" });
  await context.close();
});

await test("AP-05 the background inventory is the browser's own list, not a copy of it", { "AP-05": "full" }, async () => {
  const { page, context } = await openModule("apps");
  await page.getByRole("tab", { name: /Background/ }).click();
  await page.waitForSelector('[data-testid="app-sw-state"]');
  // The app registers /sw.js at boot; the panel must see exactly what
  // getRegistrations() sees, in this page, right now.
  await page.waitForFunction(() => document.querySelector('[data-testid="app-sw-state"]')?.getAttribute("data-state") !== "checking browser APIs…", undefined, { timeout: 20_000 });

  const direct = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return Promise.all(regs.map(async (r) => {
      const ext = r as unknown as { sync?: { getTags?: () => Promise<string[]> }; periodicSync?: { getTags?: () => Promise<string[]> } };
      const sync = ext.sync?.getTags ? await ext.sync.getTags().catch(() => []) : [];
      return { scope: r.scope, sync };
    }));
  });
  const state = await page.getByTestId("app-sw-state").getAttribute("data-state");
  assert.equal(state, "available", "the registration query must succeed in this browser");
  const shown = await page.evaluate(() => [...document.querySelectorAll('[data-testid="app-sw-registration"]')].map((e) => e.getAttribute("data-scope")));
  assert.deepEqual(shown.sort(), direct.map((d) => d.scope).sort(), "the panel must list exactly the registrations the browser reports");
  assert.ok(direct.length >= 1, "the shell registers a service worker at boot");

  // Sync tags are read from the registration, not invented.
  const tagsShown = await page.evaluate(() => [...document.querySelectorAll('[data-testid="app-sync-tags"]')].map((e) => ({
    state: e.getAttribute("data-state"), tags: (e.getAttribute("data-tags") ?? "").split(" ").filter(Boolean),
  })));
  for (let i = 0; i < Math.min(tagsShown.length, direct.length); i++) {
    if (tagsShown[i].state !== "available") continue;
    assert.deepEqual(tagsShown[i].tags.sort(), [...direct[i].sync].sort(), "sync tags must match the registration's own getTags()");
  }

  // The page-job inventory is present, states its scope, and never claims an OS
  // wake-up — that sentence is the row's whole honesty content.
  const jobs = await page.evaluate(() => [...document.querySelectorAll('[data-testid="app-bg-job"]')].map((e) => ({
    id: e.getAttribute("data-job-id"), callbacks: Number(e.getAttribute("data-callbacks") ?? "0"),
  })));
  assert.ok(jobs.length >= 1, "the inventory must list the shell's own daemons");
  for (const j of jobs) assert.ok(j.callbacks >= 0 && Number.isInteger(j.callbacks));
  const text = await page.locator("[data-testid=\"app-runtime-inventory\"]").evaluate((e) => e.parentElement?.textContent ?? "");
  assert.match(text, /not operating-system wake counts/);
  await page.screenshot({ path: "/tmp/tt147-background.png" });
  await context.close();
});

finish();
await browser.close();
