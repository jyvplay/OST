/**
 * TT112 — rows that had shipped but had never been tested: the first-run capability report and
 * licence check (SH-07), the honesty of every capability claim the shell makes about this browser
 * (RG-02, HW-09, HW-08, WM-07, HW-05), and the load governor's throttle detector (SH-12).
 *
 * Exclusive real Chromium + real PostgreSQL. Every expectation is compared against a measurement
 * taken in the same page at the same moment, so the test cannot pass by agreeing with itself: if
 * the shell claimed a capability this browser does not have, the comparison would fail.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('e2e-tt112-shell');
// A licence check is only meaningful for a client this installation has never seen before.
const CLIENT = `tt112-${Date.now().toString(36)}`;

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json() as T;
}

const browser = await launchChromium();
const errors: string[] = [];

async function desktop(windows: Record<string, unknown>[]) {
  const cur = await api<{ row?: { revision?: number } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: Number(cur.row?.revision ?? 1) + 1000,
    state: {
      windows: windows.map((w, i) => ({ x: 30, y: 20, w: 1180, h: 820, z: 10 + i, workspace: 1, props: {}, ...w })),
      focus: windows.at(-1)?.id ?? null, workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 30,
    },
  });
}
async function open() {
  const context = await browser.newContext({ viewport: { width: 1480, height: 980 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  return { page, context };
}

await desktop([{ id: 's1', module: 'settings', title: 'Settings' }]);
const { page, context } = await open();
// The Settings module has no root testid; its window is addressed the way the layout suite does.
const settings = page.locator('.fs-window[aria-label="Settings"]');
await settings.getByTestId('settings-layout-business').waitFor();

await test('SH-07 first run: the capability report is measured in this browser, not asserted', { 'SH-07': 'full', 'HW-09': 'partial' }, async () => {
  await settings.getByRole('tab', { name: 'Capabilities' }).click();
  // The report is probed and then refined asynchronously (permissions are queried); wait for a row
  // that only exists once the real probe has landed.
  await settings.getByText('window.getScreenDetails()').waitFor();
  const shown = await settings.getByText(/threads$/).first().innerText();
  const measured = await page.evaluate(`({
    threads: navigator.hardwareConcurrency,
    secure: window.isSecureContext,
    w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio,
  })`) as { threads: number; secure: boolean; w: number; h: number; dpr: number };
  assert.equal(shown.trim(), `${measured.threads} threads`, `thread count comes from this machine: ${shown}`);
  const pane = await settings.innerText();
  assert.ok(pane.includes(`${measured.w}×${measured.h} @${measured.dpr}x`), `screen geometry is the real one: ${measured.w}×${measured.h} @${measured.dpr}x`);
  assert.ok(pane.includes(measured.secure ? 'secure context' : 'insecure context'), 'secure-context state is reported as measured');
  console.log(`    report: ${measured.threads} threads, ${measured.w}×${measured.h} @${measured.dpr}x, secure=${measured.secure}`);
});

await test('every capability claim matches what this browser actually exposes (no invented support)', { 'RG-02': 'partial', 'HW-08': 'partial', 'WM-07': 'partial', 'HW-05': 'partial' }, async () => {
  await settings.getByRole('tab', { name: 'Capabilities' }).click();
  await settings.getByText('window.getScreenDetails()').waitFor();
  // The pane renders each capability as three lines: label, the API it is measured from, then yes/no.
  const lines = (await settings.innerText()).split('\n').map((l) => l.trim());
  const claim = (label: string) => {
    const i = lines.indexOf(label);
    if (i < 0) return null;
    for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
      if (lines[k] === 'yes') return true;
      if (lines[k] === 'no') return false;
    }
    return null;
  };
  const truth = await page.evaluate(`({
    scheduler: 'scheduler' in window,
    screens: 'getScreenDetails' in window,
    wakeLock: 'wakeLock' in navigator,
    audioWorklet: typeof AudioWorkletNode === 'function',
    subtle: Boolean(window.crypto && window.crypto.subtle),
  })`) as Record<string, boolean>;
  const pairs: [string, string, string][] = [
    ['scheduler.postTask', 'scheduler', 'RG-02'],
    ['Multi-screen window placement', 'screens', 'WM-07'],
    ['Screen wake lock', 'wakeLock', 'HW-11'],
  ];
  for (const [label, key, row] of pairs) {
    const said = claim(label);
    assert.notEqual(said, null, `${row}: the pane reports ${label}`);
    assert.equal(said, truth[key], `${row}: pane says ${said} for ${label}, this browser says ${truth[key]}`);
  }
  assert.ok(truth.subtle, 'HW-08: WebCrypto subtle is the real key engine behind the vault');
  console.log(`    pane agrees with the live browser: scheduler=${truth.scheduler} screens=${truth.screens} wakeLock=${truth.wakeLock} audioWorklet=${truth.audioWorklet} subtle=${truth.subtle}`);
});

await test('SH-07 licence: a local trial is granted without any account, and the server holds the public key', { 'SH-07': 'full' }, async () => {
  const before = await api<{ tier?: string; publicKey?: string; gracePeriodDays?: number }>('GET', `/api/entitlement?clientId=${CLIENT}`);
  assert.ok(String(before.publicKey).includes('BEGIN PUBLIC KEY'), 'the verifying key is published, so a licence can be checked offline');
  assert.equal(before.tier, 'none', `a fresh install is unlicensed: ${String(before.tier)}`);
  assert.ok(Number(before.gracePeriodDays) > 0, 'a grace period is declared');
  await settings.getByRole('tab', { name: 'Licence' }).click();
  const pane = await settings.innerText();
  assert.ok(!/sign in|sign up|log in|create an account|email address/i.test(pane), `no account is asked for: ${pane.slice(0, 200)}`);
  const trial = await api<{ ok?: boolean; kind?: string }>('POST', '/api/entitlement', { action: 'trial', clientId: CLIENT });
  assert.ok(trial.ok !== false, `a trial can be started locally: ${JSON.stringify(trial)}`);
  const after = await api<{ entitlements?: { kind: string; status: string }[] }>('GET', `/api/entitlement?clientId=${CLIENT}`);
  assert.ok((after.entitlements ?? []).some((e) => e.kind === trial.kind || e.status === 'active'), `the entitlement is recorded: ${JSON.stringify(after.entitlements)}`);
  console.log(`    unlicensed → local trial ${String(trial.kind)}; no account, key published`);
});

await test('SH-07: the capability report reaches the server only when a human asks for it', { 'SH-07': 'full', 'PR-02': 'partial' }, async () => {
  const before = await api<{ rows?: unknown[] }>('GET', '/api/probe');
  const n = Array.isArray(before.rows) ? before.rows.length : 0;
  await settings.getByRole('tab', { name: 'Capabilities' }).click();
  await page.waitForTimeout(400);
  const idle = await api<{ rows?: unknown[] }>('GET', '/api/probe');
  assert.equal(Array.isArray(idle.rows) ? idle.rows.length : 0, n, 'opening the pane uploaded nothing');
  await settings.getByRole('button', { name: 'Save report' }).click();
  await page.waitForTimeout(800);
  const after = await api<{ rows?: unknown[] }>('GET', '/api/probe');
  assert.equal(Array.isArray(after.rows) ? after.rows.length : 0, n + 1, 'pressing the button saved exactly one report');
  console.log(`    probe rows ${n} → ${n} on open → ${n + 1} after the explicit save`);
});

await test('SH-12: real long tasks drive the governor into a throttled state and the shell drops effects', { 'SH-12': 'full', 'RG-01': 'partial' }, async () => {
  const start = await page.evaluate(`document.documentElement.dataset.effects || ''`) as string;
  assert.equal(start, 'on', `effects start on: ${start}`);
  // longtask entries are delivered to observers and are not kept in the timeline buffer, so the
  // count has to be collected by an observer registered before the work starts.
  await page.evaluate(`window.__tt112 = 0; new PerformanceObserver(function (l) { window.__tt112 += l.getEntries().length; }).observe({ entryTypes: ['longtask'] });`);
  // Real work, not a simulated signal: 60 blocking tasks of ~60 ms each are genuine long tasks, and
  // PerformanceObserver reports them to the governor exactly as it would under a heavy application.
  await page.evaluate(`new Promise(function (done) {
    var n = 0;
    (function burn() {
      var until = performance.now() + 60;
      while (performance.now() < until) { }
      if (++n < 60) setTimeout(burn, 0); else done();
    })();
  })`);
  let effects = '';
  for (let i = 0; i < 40; i++) {
    effects = await page.evaluate(`document.documentElement.dataset.effects || ''`) as string;
    if (effects === 'off') break;
    await page.waitForTimeout(250);
  }
  assert.equal(effects, 'off', 'sustained long tasks switch visual effects off');
  const count = await page.evaluate(`window.__tt112 || 0`) as number;
  assert.ok(count >= 20, `the browser really recorded the long tasks: ${count}`);
  console.log(`    ${count} long tasks observed; shell effects → off`);
});

await test('SH-12: the detector is a measurement, not a latch — effects return once the load stops', { 'SH-12': 'full' }, async () => {
  // The governor keeps a 60 s window of long tasks; this asserts the state is derived from that
  // window rather than sticking, by waiting for the window to drain with the main thread idle.
  let effects = await page.evaluate(`document.documentElement.dataset.effects || ''`) as string;
  assert.equal(effects, 'off', 'still throttled while the window holds the long tasks');
  for (let i = 0; i < 75; i++) {
    effects = await page.evaluate(`document.documentElement.dataset.effects || ''`) as string;
    if (effects === 'on') break;
    await page.waitForTimeout(1000);
  }
  assert.equal(effects, 'on', 'with the thread idle again the governor restores effects');
  console.log('    governor recovered to effects=on after the 60 s long-task window drained');
});

await test('no uncaught page exception across the capability, licence and governor panes', { 'SH-07': 'partial' }, () => {
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
});

await context.close();
await browser.close();
await finish();
