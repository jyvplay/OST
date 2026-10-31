/** Actual Chromium shell interactions. Playwright's controlled wall clock is
 * explicit; these are NOT native OS scheduling or physical suspension tests. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { makeHarness } from "./harness.mts";
import { disposableShell } from "./tt132-fixture.mts";

const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt132-alarms"), covers = { "CK-01": "partial", "PR-10": "partial" } as const;
mkdirSync("docs/screens", { recursive: true });
async function withClock(fn: (page: Page, context: BrowserContext) => Promise<void>, setup?: (context: BrowserContext) => Promise<void>, count = 1, suffix = "") {
  await fx.windows("clock", count);
  const context = await fx.context();
  try {
    if (setup) await setup(context);
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install({ time: new Date("2030-01-07T09:29:40.000Z") }); await page.clock.pauseAt(new Date("2030-01-07T09:29:50.000Z")); await fx.ready(page, "clock", suffix);
    await fn(page, context); assert.deepEqual(errors, [], "no unhandled page errors");
  } finally { await context.close(); }
}
async function add(page: Page, label = "Wake", minutes = "1", which = "w1") {
  const clock = page.locator(`[data-win-id="${which}"]`);
  await clock.getByLabel("Alarm time", { exact: true }).fill("09:30"); await clock.getByLabel("Alarm label", { exact: true }).fill(label);
  await clock.getByLabel("Snooze minutes", { exact: true }).fill(minutes); await clock.getByRole("button", { name: "Add alarm", exact: true }).click();
  await clock.getByRole("button", { name: `Edit alarm ${label}`, exact: true }).waitFor();
}
const occurrence = (page: Page) => page.getByTestId("alarm-occurrence");
async function stage(page: Page, value: string) { await page.waitForFunction((state) => document.querySelector('[data-testid="alarm-occurrence"]')?.getAttribute("data-stage") === state, value); }
async function hold(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    void navigator.locks.request("fusion-clock-alarm-claims", async () => {
      await new Promise<void>((release) => { (window as any).releaseAlarmLock = release; resolve(); });
    });
  }));
}
const release = (page: Page) => page.evaluate(() => (window as any).releaseAlarmLock());
try {
  await test("actionable ring survives Clock close and toast expiry; dismiss leaves the schedule enabled", covers, () => withClock(async (page) => {
    await add(page); await page.locator('[data-win-id="w1"]').getByRole("button", { name: "Close window" }).click();
    await page.clock.fastForward(15_000); await stage(page, "ringing");
    await page.clock.fastForward(7_000); assert.equal(await page.getByText("Alarm: Wake", { exact: true }).count(), 0, "transient toast has expired");
    await occurrence(page).getByRole("button", { name: "Dismiss Wake", exact: true }).click(); await page.getByTestId("alarm-center").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1")!)[0].enabled), true);
  }));
  await test("configured snooze fires again once and can be snoozed a second time", covers, () => withClock(async (page) => {
    await add(page, "Repeat snooze", "1"); await page.clock.fastForward(15_000); await stage(page, "ringing");
    await occurrence(page).getByRole("button", { name: "Snooze Repeat snooze for 1 minutes", exact: true }).click(); await stage(page, "snoozed");
    const first = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.clock.activity.v1")!)[0]);
    assert.equal(first.dueAt, Date.parse("2030-01-07T09:31:05Z")); assert.equal(first.sequence, 1);
    await page.clock.fastForward(61_000); await stage(page, "ringing");
    await occurrence(page).getByRole("button", { name: "Snooze Repeat snooze for 1 minutes", exact: true }).click(); await stage(page, "snoozed");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.clock.activity.v1")!)[0].sequence), 2);
    await page.screenshot({ path: "docs/screens/tt132-alarm-snoozed.png", animations: "disabled" });
  }));
  await test("normal-profile snooze survives reload without replaying the claimed original alarm", covers, () => withClock(async (page) => {
    await add(page, "Reload snooze"); await page.clock.fastForward(15_000); await stage(page, "ringing");
    await occurrence(page).getByRole("button", { name: /Snooze Reload snooze/ }).click(); await stage(page, "snoozed");
    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "World clock", exact: true }).waitFor(); await stage(page, "snoozed");
    assert.equal(await page.getByText("Alarm: Reload snooze", { exact: true }).count(), 0);
    await page.clock.fastForward(61_000); await stage(page, "ringing"); await page.getByTestId("toasts").getByText("Alarm: Reload snooze", { exact: true }).waitFor();
  }));
  await test("cancel snooze before its deadline prevents redelivery", covers, () => withClock(async (page) => {
    await add(page, "Cancel wake"); await page.clock.fastForward(15_000); await stage(page, "ringing");
    await occurrence(page).getByRole("button", { name: /Snooze Cancel wake/ }).click(); await stage(page, "snoozed");
    await occurrence(page).getByRole("button", { name: "Cancel snooze for Cancel wake", exact: true }).click(); await page.getByTestId("alarm-center").waitFor({ state: "detached" });
    await page.clock.fastForward(61_000); assert.equal(await occurrence(page).count(), 0); assert.equal(await page.getByText("Alarm: Cancel wake", { exact: true }).count(), 0);
  }));
  await test("alarm edit saves time, label, weekdays and snooze without replacing its identity", covers, () => withClock(async (page) => {
    await add(page, "Before edit", "9"); const clock = page.locator('[data-win-id="w1"]');
    const id = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1")!)[0].id);
    await clock.getByRole("button", { name: "Edit alarm Before edit", exact: true }).click();
    await clock.getByLabel("Alarm time", { exact: true }).fill("10:45"); await clock.getByLabel("Alarm label", { exact: true }).fill("After edit");
    await clock.getByLabel("Snooze minutes", { exact: true }).fill("60"); await clock.getByRole("button", { name: "Repeat on Tuesday", exact: true }).click();
    await clock.getByRole("button", { name: "Save alarm", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.alarms.v1")!)[0]?.label === "After edit");
    const value = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1")!)[0]);
    assert.equal(value.id, id); assert.equal(value.time, "10:45"); assert.equal(value.snoozeMin, 60); assert.deepEqual(value.days, [2]);
    await page.clock.fastForward(15_000); assert.equal(await occurrence(page).count(), 0, "old time canceled");
    await clock.getByRole("button", { name: "Edit alarm After edit", exact: true }).click(); await clock.getByLabel("Alarm label", { exact: true }).fill("not saved");
    await clock.getByRole("button", { name: "Cancel edit", exact: true }).click(); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1")!)[0].label), "After edit");
  }));
  await test("a second Clock window's edit is not silently overwritten by a stale editor", covers, () => withClock(async (page) => {
    await add(page, "Edit race");
    const first = page.locator('[data-win-id="w1"]'), second = page.locator('[data-win-id="w2"]');
    await second.getByRole("button", { name: "Edit alarm Edit race", exact: true }).waitFor();
    await first.getByRole("button", { name: "Edit alarm Edit race", exact: true }).click();
    await second.getByRole("button", { name: "On", exact: true }).click();
    await first.getByLabel("Alarm label", { exact: true }).fill("Stale name"); await first.getByRole("button", { name: "Save alarm", exact: true }).click();
    await page.getByTestId("toasts").getByText(/changed in another window/).waitFor();
    const value = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1")!)[0]); assert.equal(value.label, "Edit race"); assert.equal(value.enabled, false);
  }, undefined, 2));
  await test("pause all cancels both pending snoozes and upcoming alarms", covers, () => withClock(async (page) => {
    await add(page, "First"); await add(page, "Second"); await page.clock.fastForward(15_000);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="alarm-occurrence"]').length === 2);
    await occurrence(page).filter({ hasText: "First" }).getByRole("button", { name: /Snooze First/ }).click();
    await page.locator('[data-win-id="w1"]').getByRole("button", { name: "Pause all", exact: true }).click();
    await page.getByTestId("alarm-center").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.alarms.v1")!).every((a: any) => !a.enabled)), true);
    await page.clock.fastForward(61_000); assert.equal(await occurrence(page).count(), 0);
  }));
  await test("write-only storage denial keeps actionable snooze working in memory", covers, () => withClock(async (page) => {
    await add(page, "Memory wake"); await page.clock.fastForward(15_000); await stage(page, "ringing");
    await occurrence(page).getByRole("button", { name: /Snooze Memory wake/ }).click(); await stage(page, "snoozed");
    await page.getByTestId("toasts").getByText("Storage unavailable: alarm changes stay in this page.", { exact: true }).waitFor();
    await page.clock.fastForward(61_000); await stage(page, "ringing");
  }, async (context) => {
    await context.addInitScript(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.startsWith("fusion.clock.") || key === "fusion.alarms.v1") throw new DOMException("test write denial", "QuotaExceededError"); return original.call(this, key, value); }; });
  }));
  await test("two pages racing snooze serialize the same occurrence once under a real Web Lock", covers, () => withClock(async (page, context) => {
    await add(page, "Shared wake"); await page.clock.fastForward(15_000); await stage(page, "ringing");
    const second = await context.newPage(); await second.clock.install({ time: new Date("2030-01-07T09:29:55Z") }); await second.clock.pauseAt(new Date("2030-01-07T09:30:05Z")); await fx.ready(second, "clock"); await stage(second, "ringing");
    await hold(page);
    try {
      await Promise.all([occurrence(page).getByRole("button", { name: /Snooze Shared wake/ }).click(), occurrence(second).getByRole("button", { name: /Snooze Shared wake/ }).click()]);
      await page.waitForFunction(async () => (await navigator.locks.query()).pending?.filter((x) => x.name === "fusion-clock-alarm-claims").length === 2);
    } finally { await release(page); }
    await stage(page, "snoozed"); await stage(second, "snoozed");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.clock.activity.v1")!)[0].sequence), 1);
    await occurrence(second).getByRole("button", { name: "Cancel snooze for Shared wake", exact: true }).click();
    await page.getByTestId("alarm-center").waitFor({ state: "detached" });
  }));
  await test("disabling a snooze while its delivery claim waits cancels the actual pending callback", covers, () => withClock(async (page) => {
    await add(page, "Blocked snooze"); await page.clock.fastForward(15_000); await stage(page, "ringing");
    await occurrence(page).getByRole("button", { name: /Snooze Blocked snooze/ }).click(); await stage(page, "snoozed");
    await hold(page);
    try {
      await page.clock.fastForward(61_000);
      await page.waitForFunction(async () => (await navigator.locks.query()).pending?.some((x) => x.name === "fusion-clock-alarm-claims"));
      await page.locator('[data-win-id="w1"]').getByRole("button", { name: "On", exact: true }).click();
    } finally { await release(page); }
    await page.waitForFunction(async () => !(await navigator.locks.query()).pending?.some((x) => x.name === "fusion-clock-alarm-claims"));
    await page.getByTestId("alarm-center").waitFor({ state: "detached" }); assert.equal(await page.getByText("Alarm: Blocked snooze", { exact: true }).count(), 0);
  }));
  await test("late snooze wake is explicitly missed rather than falsely reported on time", covers, () => withClock(async (page) => {
    await add(page, "Late wake"); await page.clock.fastForward(15_000); await stage(page, "ringing");
    await occurrence(page).getByRole("button", { name: /Snooze Late wake/ }).click(); await stage(page, "snoozed");
    await page.clock.fastForward(125_000); await stage(page, "missed");
    await occurrence(page).getByText(/Snooze missed/).waitFor(); assert.equal(await page.getByText("Alarm: Late wake", { exact: true }).count(), 0);
  }));
  await test("amnesic actionable snooze neither reads nor overwrites normal-profile activity", covers, async () => {
    await fx.windows("clock"); const context = await fx.context();
    try {
      await context.addInitScript(() => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        const normal = [{ id: "normal-secret", label: "Normal profile secret", time: "09:30", days: [], snoozeMin: 1, enabled: true }];
        const activity = [{ alarmId: "normal-secret", occurrenceAt: Date.parse("2030-01-07T09:29:00Z"), schedule: '["09:30",[]]', dueAt: Date.parse("2030-01-07T09:30:00Z"), sequence: 1, stage: "snoozed" }];
        set.call(localStorage, "fusion.alarms.v1", JSON.stringify(normal)); set.call(localStorage, "fusion.clock.activity.v1", JSON.stringify(activity));
        const watch = window as unknown as { nativeClockRead: (key: string) => string | null; nativeClockExpected: string[]; notificationAttempts: number };
        watch.nativeClockRead = (key) => get.call(localStorage, key); watch.nativeClockExpected = [JSON.stringify(normal), JSON.stringify(activity)]; watch.notificationAttempts = 0;
        class ObservedNotification { static permission = "granted"; constructor() { watch.notificationAttempts++; } }
        Object.defineProperty(window, "Notification", { value: ObservedNotification, configurable: true });
      });
      const page = await context.newPage(), errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message)); page.setDefaultTimeout(12_000);
      await page.clock.install({ time: new Date("2030-01-07T09:29:40Z") }); await page.clock.pauseAt(new Date("2030-01-07T09:29:50Z"));
      await page.goto(fx.BASE + "/?amnesia=1&open=clock", { waitUntil: "domcontentloaded" }); await page.getByTestId("amnesic-badge").waitFor();
      const clock = page.locator('[data-win-id]').filter({ has: page.getByLabel("Alarm time", { exact: true }) });
      await clock.getByLabel("Alarm time", { exact: true }).waitFor(); assert.equal(await clock.getByText(/Normal profile secret/).count(), 0);
      assert.equal(await page.getByTestId("alarm-center").count(), 0);
      await clock.getByLabel("Alarm time", { exact: true }).fill("09:30"); await clock.getByLabel("Alarm label", { exact: true }).fill("Ephemeral wake");
      await clock.getByLabel("Snooze minutes", { exact: true }).fill("1"); await clock.getByRole("button", { name: "Add alarm", exact: true }).click();
      await clock.getByRole("button", { name: "Edit alarm Ephemeral wake", exact: true }).waitFor();
      await page.clock.fastForward(15_000); await stage(page, "ringing"); await occurrence(page).getByRole("button", { name: /Snooze Ephemeral wake/ }).click(); await stage(page, "snoozed");
      await page.clock.fastForward(61_000); await stage(page, "ringing");
      const witness = await page.evaluate(() => {
        const watch = window as unknown as { nativeClockRead: (key: string) => string | null; nativeClockExpected: string[]; notificationAttempts: number };
        return { stored: [watch.nativeClockRead("fusion.alarms.v1"), watch.nativeClockRead("fusion.clock.activity.v1")], expected: watch.nativeClockExpected, claims: watch.nativeClockRead("fusion.clock.claims.v1"), notifications: watch.notificationAttempts };
      });
      assert.deepEqual(witness.stored, witness.expected); assert.equal(witness.claims, null); assert.equal(witness.notifications, 0);
      // Patch-specific isolation attack: after an amnesic dismissal, a REAL
      // storage event from a normal page must not resurrect normal activity.
      await occurrence(page).getByRole("button", { name: "Dismiss Ephemeral wake", exact: true }).click(); await page.getByTestId("alarm-center").waitFor({ state: "detached" });
      await page.evaluate(() => {
        (window as unknown as { activityStorageSeen: boolean }).activityStorageSeen = false;
        window.addEventListener("storage", (event) => { if (event.key === "fusion.clock.activity.v1") (window as unknown as { activityStorageSeen: boolean }).activityStorageSeen = true; });
      });
      const normal = await context.newPage(); await normal.clock.install({ time: new Date("2030-01-07T09:29:40Z") }); await normal.clock.pauseAt(new Date("2030-01-07T09:29:50Z")); await fx.ready(normal, "clock");
      await normal.evaluate(() => { const list = JSON.parse(localStorage.getItem("fusion.clock.activity.v1")!); localStorage.setItem("fusion.clock.activity.v1", JSON.stringify([{ ...list[0], sequence: 5, dueAt: Date.now() + 30_000 }])); });
      await page.waitForFunction(() => (window as unknown as { activityStorageSeen: boolean }).activityStorageSeen);
      assert.equal(await page.getByTestId("alarm-center").count(), 0); assert.equal(await clock.getByText(/Normal profile secret/).count(), 0); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await test("a throwing Notification constructor cannot abort countdown completion", covers, () => withClock(async (page) => {
    const timer = page.locator('[data-win-id="w1"] .fs-panel').filter({ has: page.getByRole("heading", { name: "Timer", exact: true }) });
    await timer.getByLabel("Minutes", { exact: true }).fill("0"); await timer.getByLabel("Seconds", { exact: true }).fill("1"); await timer.getByRole("button", { name: "Start timer", exact: true }).click();
    await page.clock.fastForward(1500); await page.getByTestId("toasts").getByText("Timer finished", { exact: true }).waitFor();
    assert.equal(await timer.getByRole("button", { name: "Start timer", exact: true }).isEnabled(), true);
  }, async (context) => {
    await context.addInitScript(() => { class RefusedNotification { static permission = "granted"; constructor() { throw new DOMException("injected notification refusal", "NotAllowedError"); } } Object.defineProperty(window, "Notification", { value: RefusedNotification, configurable: true }); });
  }));
} finally { await fx.close(); finish(); }
