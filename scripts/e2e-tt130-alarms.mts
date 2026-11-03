/** Real Chromium and the disposable shell/database. Clock advancement is
 * controlled with Playwright; this is not an OS alarm or a physical-device test. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE;
const { test, finish } = makeHarness("e2e-tt130-alarms");
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return await r.json() as T;
}
const original = await api<{ row?: { state?: unknown } }>("GET", "/api/state?id=default");
const browser = await launchChromium();
async function clockState(count = 1) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  const windows = Array.from({ length: count }, (_, i) => ({ id: `w${i + 1}`, module: "clock", title: `Clock ${i + 1}`, x: 20 + i * 740, y: 16, w: count > 1 ? 720 : 1100, h: 800, z: 10 + i, workspace: 1, props: {} }));
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows, focus: `w${count}`, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
}
try {
  await test("control: an open Clock window fires the same alarm", { "PR-10": "partial", "CK-01": "partial" }, async () => {
    await clockState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const clock = page.locator('[data-win-id="w1"]');
      await clock.getByLabel("Alarm time").fill("09:30");
      await clock.getByLabel("Alarm label").fill("Control alarm");
      await clock.getByRole("button", { name: "Add alarm" }).click();
      await clock.getByText(/next: Control alarm/).waitFor();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]").length === 1);
      await page.clock.fastForward("00:15");
      await page.getByTestId("toasts").getByText("Alarm: Control alarm", { exact: true }).waitFor({ timeout: 5_000 });
    } finally { await context.close(); }
  });
  await test("an alarm still fires in the shell after its Clock window closes", { "PR-10": "partial", "CK-01": "partial" }, async () => {
    await clockState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const clock = page.locator('[data-win-id="w1"]');
      await clock.getByLabel("Alarm time").fill("09:30");
      await clock.getByLabel("Alarm label").fill("Clock remains open");
      await clock.getByRole("button", { name: "Add alarm" }).click();
      await clock.getByText(/next: Clock remains open/).waitFor();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]").length === 1);
      await clock.getByRole("button", { name: "Close window" }).click();
      await clock.waitFor({ state: "detached" });
      await page.clock.fastForward("00:15");
      await page.getByTestId("toasts").getByText("Alarm: Clock remains open", { exact: true }).waitFor({ timeout: 5_000 });
    } finally { await context.close(); }
  });
  await test("selected weekdays persist and only fire on the selected day", { "CK-01": "partial" }, async () => {
    await clockState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") }); // Monday
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const clock = page.locator('[data-win-id="w1"]');
      await clock.getByLabel("Alarm time").fill("09:30");
      await clock.getByLabel("Alarm label").fill("Tuesday only");
      const tuesday = clock.getByRole("button", { name: "Repeat on Tuesday" });
      await tuesday.click(); assert.equal(await tuesday.getAttribute("aria-pressed"), "true");
      await clock.getByRole("button", { name: "Add alarm" }).click();
      await clock.getByText(/Tuesday only.*Tue/).waitFor();
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]")[0].days), [2]);
      if (process.env.TT130_CAPTURE === "1") await page.screenshot({ path: "docs/screens/tt130-clock-alarm.png" });
      await clock.getByRole("button", { name: "Close window" }).click(); await clock.waitFor({ state: "detached" });
      await page.clock.fastForward(15_000);
      assert.equal(await page.getByText("Alarm: Tuesday only", { exact: true }).count(), 0, "Monday must not fire a Tuesday alarm");
      await page.clock.fastForward(86_400_000);
      await page.getByTestId("toasts").getByText("Alarm: Tuesday only", { exact: true }).waitFor({ timeout: 5_000 });
    } finally { await context.close(); }
  });
  await test("two Clock windows share edits; a disabled alarm does not fire", { "CK-01": "partial" }, async () => {
    await clockState(2);
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const first = page.locator('[data-win-id="w1"]'), second = page.locator('[data-win-id="w2"]');
      await first.getByLabel("Alarm time").fill("09:30"); await first.getByLabel("Alarm label").fill("Shared alarm");
      await first.getByRole("button", { name: "Add alarm" }).click();
      await second.getByText(/Shared alarm.*daily/).waitFor();
      await second.getByRole("button", { name: "On", exact: true }).click();
      assert.equal(await first.getByRole("button", { name: "Off", exact: true }).getAttribute("aria-pressed"), "false");
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]")[0].enabled), false);
      await page.clock.fastForward(15_000);
      assert.equal(await page.getByText("Alarm: Shared alarm", { exact: true }).count(), 0);
    } finally { await context.close(); }
  });
  await test("two alarms created at the same time each deliver once", { "CK-01": "partial" }, async () => {
    await clockState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") }); await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const clock = page.locator('[data-win-id="w1"]');
      await clock.getByLabel("Alarm time").fill("09:30");
      for (const label of ["First simultaneous", "Second simultaneous"]) {
        await clock.getByLabel("Alarm label").fill(label); await clock.getByRole("button", { name: "Add alarm" }).click();
      }
      const ids = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]").map((a: { id: string }) => a.id));
      assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2, "same clock millisecond still yields unique IDs");
      await clock.getByRole("button", { name: "Close window" }).click(); await clock.waitFor({ state: "detached" });
      await page.clock.fastForward(15_000);
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.clock.claims.v1") ?? "[]").length === 2);
      await page.getByRole("button", { name: "1 earlier notification" }).click();
      await page.getByText("Alarm: First simultaneous", { exact: true }).waitFor();
      await page.getByText("Alarm: Second simultaneous", { exact: true }).waitFor();
    } finally { await context.close(); }
  });
  await test("storage denial warns and the in-memory alarm still fires after closing Clock", { "CK-01": "partial" }, async () => {
    await clockState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      await context.addInitScript(() => {
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === "fusion.alarms.v1" || key === "fusion.clock.claims.v1") throw new DOMException("storage denied by test", "QuotaExceededError");
          return originalSet.call(this, key, value);
        };
      });
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const clock = page.locator('[data-win-id="w1"]');
      await clock.getByLabel("Alarm time").fill("09:30"); await clock.getByLabel("Alarm label").fill("Memory alarm");
      await clock.getByRole("button", { name: "Add alarm" }).click();
      await page.getByText("Browser storage is unavailable; alarms last only while this page stays open.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("fusion.alarms.v1")), null);
      await clock.getByRole("button", { name: "Close window" }).click(); await clock.waitFor({ state: "detached" });
      await page.clock.fastForward(15_000);
      await page.getByTestId("toasts").getByText("Alarm: Memory alarm", { exact: true }).waitFor({ timeout: 5_000 });
    } finally { await context.close(); }
  });
  await test("amnesic sessions isolate alarms and do not write their settings or claims", { "CK-01": "partial", "SC-10": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      await context.addInitScript(() => {
        (window as unknown as { sentAlarmNotifications: string[] }).sentAlarmNotifications = [];
        class ObservedNotification {
          static permission = "granted";
          constructor(title: string) { (window as unknown as { sentAlarmNotifications: string[] }).sentAlarmNotifications.push(title); }
        }
        Object.defineProperty(window, "Notification", { value: ObservedNotification, configurable: true });
      });
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const persisted = [{ id: "normal-alarm", label: "Normal profile secret", time: "09:30", days: [], enabled: true, snoozeMin: 9 }];
      await page.evaluate((alarms) => localStorage.setItem("fusion.alarms.v1", JSON.stringify(alarms)), persisted);
      await page.goto(`${BASE}/?amnesia=1&open=clock`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("amnesic-badge").waitFor();
      const clock = page.locator('[data-win-id]').filter({ has: page.getByLabel("Alarm time") });
      await clock.getByLabel("Alarm time").waitFor();
      assert.equal(await clock.getByText(/Normal profile secret/).count(), 0, "normal-profile alarms must not enter an amnesic session");
      await page.evaluate(() => { (window as unknown as { sawAlarmStorageEvent: boolean }).sawAlarmStorageEvent = false; window.addEventListener("storage", (event) => { if (event.key === "fusion.alarms.v1") (window as unknown as { sawAlarmStorageEvent: boolean }).sawAlarmStorageEvent = true; }); });
      const normal = await context.newPage(); await normal.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await normal.goto(BASE, { waitUntil: "domcontentloaded" });
      const changed = [...persisted, { id: "other-alarm", label: "Other tab secret", time: "09:30", days: [], enabled: true, snoozeMin: 9 }];
      await normal.evaluate((alarms) => localStorage.setItem("fusion.alarms.v1", JSON.stringify(alarms)), changed);
      await page.waitForFunction(() => (window as unknown as { sawAlarmStorageEvent: boolean }).sawAlarmStorageEvent);
      assert.equal(await clock.getByText(/Other tab secret/).count(), 0, "normal tabs must not inject alarms into amnesic state");
      await clock.getByLabel("Alarm time").fill("09:30"); await clock.getByLabel("Alarm label").fill("Session secret");
      await clock.getByRole("button", { name: "Add alarm" }).click();
      await page.getByText("Amnesic session: alarms last only while this page stays open.", { exact: true }).waitFor();
      // Amnesic schedules now live in the alarm store's isolated page memory,
      // not even the privacy layer's Storage overlay. Assert the real user
      // route exists; do not make its internal serialization a requirement.
      await clock.getByRole("button", { name: "Edit alarm Session secret", exact: true }).waitFor();
      await clock.getByRole("button", { name: "Close window" }).click(); await clock.waitFor({ state: "detached" });
      await page.clock.fastForward(15_000);
      await page.getByTestId("toasts").getByText("Alarm: Session secret", { exact: true }).waitFor({ timeout: 5_000 });
      assert.deepEqual(await page.evaluate(() => (window as unknown as { sentAlarmNotifications: string[] }).sentAlarmNotifications), [], "amnesic alarm labels must not be sent to the OS notification surface");
      assert.deepEqual(await normal.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]")), changed);
      const normalClaims: string[] = await normal.evaluate(() => JSON.parse(localStorage.getItem("fusion.clock.claims.v1") ?? "[]"));
      const normalIds = new Set(changed.map((alarm) => alarm.id));
      assert.ok(normalClaims.every((claim) => normalIds.has(claim.slice(0, claim.lastIndexOf("@")))), "only known normal-profile alarm IDs may persist claims; no amnesic or unknown claim is allowed");
    } finally { await context.close(); }
  });
  await test("disabling an alarm while its claim is blocked cancels delivery", { "CK-01": "partial" }, async () => {
    await clockState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") }); await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const clock = page.locator('[data-win-id="w1"]');
      await clock.getByLabel("Alarm time").fill("09:30"); await clock.getByLabel("Alarm label").fill("Canceled claim");
      await clock.getByRole("button", { name: "Add alarm" }).click(); await clock.getByText(/Canceled claim.*daily/).waitFor();
      await page.evaluate(() => new Promise<void>((resolve) => {
        void navigator.locks.request("fusion-clock-alarm-claims", async () => {
          await new Promise<void>((release) => { (window as unknown as { releaseClockLock: () => void }).releaseClockLock = release; resolve(); });
        });
      }));
      await page.clock.fastForward(15_000);
      await page.waitForFunction(async () => (await navigator.locks.query()).pending?.some((x) => x.name === "fusion-clock-alarm-claims"), null, { timeout: 5_000 });
      await clock.getByRole("button", { name: "On", exact: true }).click();
      await page.evaluate(() => (window as unknown as { releaseClockLock: () => void }).releaseClockLock());
      await page.waitForFunction(async () => !(await navigator.locks.query()).pending?.some((x) => x.name === "fusion-clock-alarm-claims"), null, { timeout: 5_000 });
      await page.waitForTimeout(200);
      assert.equal(await page.getByText("Alarm: Canceled claim", { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem("fusion.clock.claims.v1")), null, "canceled delivery must not record a claim");
    } finally { await context.close(); }
  });
  await test("two pages contend for one real browser lock and deliver only once", { "CK-01": "partial" }, async () => {
    await clockState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", serviceWorkers: "block" });
    try {
      const first = await context.newPage(); first.setDefaultTimeout(15_000);
      await first.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await first.goto(BASE, { waitUntil: "domcontentloaded" });
      const clock = first.locator('[data-win-id="w1"]');
      await clock.getByLabel("Alarm time").fill("09:30"); await clock.getByLabel("Alarm label").fill("Lock race");
      await clock.getByRole("button", { name: "Add alarm" }).click();
      await first.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]").length === 1);
      const second = await context.newPage(); second.setDefaultTimeout(15_000);
      await second.clock.install({ time: new Date("2030-01-07T09:29:50.000Z") });
      await second.goto(BASE, { waitUntil: "domcontentloaded" });
      await second.getByText(/Lock race.*daily/).waitFor();
      // Hold the real Web Lock until both page schedulers have requested it.
      await first.evaluate(() => new Promise<void>((resolve) => {
        void navigator.locks.request("fusion-clock-alarm-claims", async () => {
          await new Promise<void>((release) => { (window as unknown as { releaseClockLock: () => void }).releaseClockLock = release; resolve(); });
        });
      }));
      await Promise.all([first.clock.fastForward(15_000), second.clock.fastForward(15_000)]);
      await first.waitForFunction(async () => (await navigator.locks.query()).pending?.filter((x) => x.name === "fusion-clock-alarm-claims").length === 2, null, { timeout: 5_000 });
      assert.equal(await first.getByText("Alarm: Lock race", { exact: true }).count() + await second.getByText("Alarm: Lock race", { exact: true }).count(), 0);
      await first.evaluate(() => (window as unknown as { releaseClockLock: () => void }).releaseClockLock());
      await first.waitForFunction(() => (localStorage.getItem("fusion.clock.claims.v1") ?? "").includes("@"), null, { timeout: 5_000 });
      await first.waitForFunction(async () => !(await navigator.locks.query()).pending?.some((x) => x.name === "fusion-clock-alarm-claims"), null, { timeout: 5_000 });
      await first.waitForTimeout(200); // allow the winning page's React commit
      const count = await first.getByText("Alarm: Lock race", { exact: true }).count() + await second.getByText("Alarm: Lock race", { exact: true }).count();
      assert.equal(count, 1, "one of the two pages delivers the shared occurrence");
      assert.doesNotMatch(await first.evaluate(() => localStorage.getItem("fusion.clock.claims.v1") ?? ""), /Lock race/, "claims do not store alarm labels");
      await second.reload({ waitUntil: "domcontentloaded" });
      await second.getByRole("heading", { name: "World clock" }).waitFor();
      await second.clock.fastForward(3_000);
      assert.equal(await second.getByText("Alarm: Lock race", { exact: true }).count(), 0, "reload does not redeliver the claimed occurrence");
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  if (original.row?.state) {
    const last = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    await api("PUT", "/api/state", { id: "default", revision: Number(last.row?.revision ?? 1) + 1000, state: original.row.state });
  }
  finish();
}
