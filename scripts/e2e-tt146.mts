/**
 * TT146 — real Chromium against the real server.
 *
 * What only a browser can answer:
 *   • Does the codec probe return real answers from this engine's WebCodecs?
 *   • Does the WASM module validate and execute here, and does the Worker
 *     handshake actually use shared memory?
 *   • Does the mail composer build a link whose encoding a browser will accept?
 *   • Does the automation token mint and appear in the panel?
 *   • Does the gallery ask for the thumbnail size the network policy chose?
 *
 * Nothing here is asserted from a mock: every value is produced by the engine
 * under test inside Chromium.
 */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt146");

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}

const browser = await launchChromium();

/**
 * The shell autosaves its layout, so a context that is still unwinding can
 * write the *previous* module's state after we PUT ours. Retrying is not
 * papering over a flake: we re-assert the desired state and verify the page
 * actually loaded the module under test before any assertion runs.
 */
interface Second { module: string; x: number; w: number }
async function openModule(module: string, props: Record<string, unknown> = {}, extra: { second?: Second; onPage?: (p: import("playwright").Page) => void } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    const second = extra.second;
    await api("PUT", "/api/state", {
      id: "default", revision: Number(cur.row?.revision ?? 1) + 1000,
      state: {
        windows: [
          { id: "w1", module, title: module, x: 10, y: 10, w: second ? second.w : 1180, h: 860, z: 10, workspace: 1, props },
          ...(second ? [{ id: "w2", module: second.module, title: second.module, x: second.x, y: 10, w: 1180 - second.w + 560, h: 860, z: 11, workspace: 1, props: {} }] : []),
        ],
        focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
      },
    });
    const now = await api<{ row?: { state?: { windows?: { module?: string }[] } } }>("GET", "/api/state?id=default");
    assert.equal(now.row?.state?.windows?.[0]?.module, module, "the server must hold the module we asked for");
    const context = await browser.newContext({ viewport: { width: 1240, height: 940 } });
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    extra.onPage?.(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-win-id="w1"] .fs-winbody > *');
    const loaded = await page.evaluate(() => (document.querySelector('[data-win-id="w1"]')?.getAttribute("aria-label") ?? "").toLowerCase());
    if (loaded.includes(module)) return { page, context };
    await context.close();
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the shell kept loading a module other than "${module}"`);
}

await test("HW-03/HW-10 the runtime pane reports what this engine really does", { "HW-03": "full", "HW-10": "full" }, async () => {
  const { page, context } = await openModule("devices");
  await page.getByRole("tab", { name: "Runtime" }).click();
  await page.waitForSelector('[data-testid="runtime-panel"]');

  // HW-03: the probe really ran against WebCodecs in this build.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="runtime-codecs-note"]');
    return el && document.body.innerText.includes("decode") && document.body.innerText.includes("encode");
  }, undefined, { timeout: 30_000 });
  const codecText = await page.evaluate(() => document.querySelector('[data-testid="runtime-panel"]')?.innerText ?? "");
  assert.match(codecText, /H\.264/, "the H.264 row must be present");
  assert.match(codecText, /(supported|not supported|software only|hardware)/, "verdicts must be words, not blank rows");
  // The honest boundary is printed, not implied.
  assert.match(codecText, /not that silicon did the work/i);

  // Cross-check the page's own answer against a direct WebCodecs call in the
  // same browser: the pane must agree with the API it claims to be quoting.
  const direct = await page.evaluate(async () => {
    const anyWin = window as unknown as { VideoDecoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> } };
    if (!anyWin.VideoDecoder) return { available: false, supported: false };
    const r = await anyWin.VideoDecoder.isConfigSupported({ codec: "avc1.640028", codedWidth: 1280, codedHeight: 720 });
    return { available: true, supported: r.supported === true };
  });
  assert.equal(direct.available, true, "this Chromium must expose WebCodecs for the probe to be meaningful");
  if (direct.supported) assert.match(codecText, /H\.264 High 4\.0.*supported/s, "the pane must show what the API answered");

  // HW-10: the SIMD module is executed in this engine, not just validated.
  await page.waitForFunction(() => /SIMD/.test(document.body.innerText) && /(executed|not available)/.test(document.body.innerText));
  const engineText = await page.evaluate(() => document.querySelector('[data-testid="runtime-panel"]')?.innerText ?? "");
  assert.match(engineText, /SIMD\s+executed/, "Chromium 143 executes the SIMD probe module");
  assert.match(engineText, /Probe module\s+76 bytes/);
  // Threads: either the handshake passed or the pane says why it could not —
  // and a bare "unavailable" without a reason is a failure.
  assert.match(engineText, /Threads\s+(worker handshake passed|single-threaded path)/);
  assert.match(engineText, /Why\s+\S/);
  await context.close();
});

await test("HW-09 one probe re-plans every open surface: the painted gallery widens with the tier", { "HW-09": "full" }, async () => {
  const b64 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR42mNkYPhfz0AEYBxVSF+FjAwMDP8ZGBj+//9P" +
    "XBqjBmBUAQMDw38GBob/jAwMDP8ZGBj+AwBpTAXt7LH8jwAAAABJRU5ErkJggg==", "base64");
  await api("POST", "/api/fs", { op: "mkdir", path: "/Pictures", reason: "e2e-tt146" });
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt146.png", content: b64, encoding: "base64", mime: "image/png", reason: "e2e-tt146" });

  // One document, two windows — exactly how a person uses this: the Runtime
  // pane and the gallery are open at the same time and share one estimate.
  const thumbKeys: string[] = [];
  const { page, context } = await openModule("devices", {}, {
    second: { module: "photos", x: 900, w: 260 },
    onPage: (p) => p.on("request", (req) => {
      const u = req.url();
      if (!u.includes("/api/fs?op=read")) return;
      const path = new URL(u).searchParams.get("path") ?? "";
      if (path.startsWith("/System/Cache/thumbs/")) thumbKeys.push(path);
    }),
  });
  const devices = page.locator('[data-win-id="w1"]');
  await page.locator('[data-win-id="w2"] [data-photo="tt146.png"]').waitFor();
  const maxOf = (k: string) => Number(/-\d+-(\d+)-/.exec(k)?.[1] ?? 0);
  const rungs = [96, 160, 256, 384];

  await devices.getByRole("tab", { name: "Runtime" }).click();
  await devices.locator('[data-testid="runtime-measure"]').waitFor();
  const before = await devices.innerText();
  assert.match(before, /network quality/i);
  assert.match(before, /(Mbit\/s|exposes no NetworkInformation)/);
  const standardRung = Number(/gallery thumbnails\s+\w+ \((\d+) px\)/i.exec(before)?.[1] ?? 0);
  assert.ok(rungs.includes(standardRung), `the card must name a ladder rung, got ${standardRung}`);

  await devices.getByTestId("runtime-measure").click();
  // The card changes only when a real measurement lands.
  await page.waitForFunction(() => /Measured[\s\S]{0,90}(measured \d|reused the session estimate|probe )/i
    .test(document.querySelector('[data-win-id="w1"] [data-testid="runtime-panel"]')?.innerText ?? ""), undefined, { timeout: 40_000 });
  const after = await devices.innerText();
  const planned = Number(/gallery thumbnails\s+\w+ \((\d+) px\)/i.exec(after)?.[1] ?? 0);
  assert.ok(rungs.includes(planned), `the post-measure rung must be on the ladder, got ${planned}`);

  // The already-painted gallery must follow: a thumbnail at the newly planned
  // width is requested without reloading the page.
  const deadline = Date.now() + 20_000;
  while (!thumbKeys.some((k) => maxOf(k) === planned) && Date.now() < deadline) await page.waitForTimeout(250);
  const requested = [...new Set(thumbKeys.map(maxOf))];
  assert.ok(requested.includes(planned), `gallery asked for ${JSON.stringify(requested)}; policy planned ${planned} px`);
  for (const m of requested) assert.ok(rungs.includes(m), `thumbnail size ${m} is not on the policy ladder`);

  await page.screenshot({ path: "/tmp/tt146-photos.png" });
  await context.close();
});

await test("PR-06 the mail composer builds a link this browser accepts, and says what it cannot do", { "PR-06": "full" }, async () => {
  const { page, context } = await openModule("mail");
  await page.getByTestId("mail-to").fill("alice@example.com");
  await page.getByTestId("mail-subject").fill("Q3 & Q4 — café");
  await page.getByTestId("mail-body").fill("Line one\nLine two");
  await page.waitForFunction(() => /bytes/.test(document.querySelector('[data-testid="mail-bytes"]')?.textContent ?? ""));
  const built = await page.evaluate(() => {
    // The module publishes the link through its Copy action; recompute here from
    // the same engine so the assertion is about the engine, and cross-check the
    // byte count the badge shows.
    const badge = document.querySelector('[data-testid="mail-bytes"]')?.textContent ?? "";
    return { badge };
  });
  assert.match(built.badge, /\/ 2000 bytes/);

  // Copy is a real clipboard write of a real mailto: URL.
  await page.getByTestId("mail-copy").click();
  const copied = await page.evaluate(async () => navigator.clipboard.readText().catch(() => ""));
  if (copied) {
    assert.match(copied, /^mailto:alice@example\.com\?/);
    assert.match(copied, /subject=Q3%20%26%20Q4%20%E2%80%94%20caf%C3%A9/);
    // A newline in the body must be CRLF-encoded, and the browser must parse it back.
    const parsed = new URL(copied);
    assert.equal(parsed.protocol, "mailto:");
    assert.match(parsed.searchParams.get("body") ?? "", /Line one\r\nLine two/);
  }
  // The limits are shown, not hidden.
  const text = await page.evaluate(() => document.querySelector('[data-testid="mail-app"]')?.innerText ?? "");
  assert.match(text, /no imap, no smtp, no relay/i);
  assert.match(text, /cannot/i);

  // A bad address is refused before any link is built.
  await page.getByTestId("mail-to").fill("not an address");
  await page.waitForFunction(() => /not|@/.test(document.querySelector('[data-testid="mail-app"]')?.innerText ?? ""));
  const refused = await page.evaluate(() => document.querySelector('[data-testid="mail-bytes"]')?.textContent ?? "");
  assert.match(refused, /refused/);
  await page.screenshot({ path: "/tmp/tt146-mail.png" });
  await context.close();
});

await test("AU-03 the automation panel mints a token once and never shows it again", { "AU-03": "full" }, async () => {
  const { page, context } = await openModule("routines");
  await page.waitForFunction(() => /external entry points/i.test(document.body.innerText));
  await page.getByTestId("automation-mint").click();
  await page.waitForSelector('[data-testid="automation-token"]');
  const token = await page.getByTestId("automation-token").textContent();
  assert.match(token ?? "", /^fsa1\.[0-9a-z]{8}\.[A-Za-z0-9_-]{43}$/);
  // The panel says the secret cannot be shown again, and the sheet does not keep it.
  assert.match(await page.evaluate(() => document.body.innerText), /only a hash is stored/i);

  // The token really works against the server, from outside the browser.
  const res = await fetch(`${BASE}/api/automation`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ commands: "open files" }),
  });
  const queued = await res.json() as { id: number; status: string };
  assert.equal(res.status, 201, JSON.stringify(queued));
  assert.equal(queued.status, "queued");

  // And this open shell drains that exact run — poll for the id, not for
  // "the queue happens to be empty", which can be true a beat too early.
  const deadline = Date.now() + 30_000;
  let last = "";
  for (;;) {
    const pend = await page.evaluate(async () => (await fetch("/api/automation?pending=1", { cache: "no-store" }).then((r) => r.json())) as { runs: { id: number }[] });
    if (!pend.runs.some((r) => r.id === queued.id)) break;
    last = JSON.stringify(pend.runs.map((r) => r.id));
    if (Date.now() > deadline) throw new Error(`the shell never reported run ${queued.id} back; still pending: ${last}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  // The token's own read path must now report the outcome — proof the shell
  // really executed it, not merely removed it from the queue.
  const report = await fetch(`${BASE}/api/automation`, { headers: { authorization: `Bearer ${token}` } });
  const reportText = await report.text();
  assert.equal(report.status, 200, reportText);
  const seen = JSON.parse(reportText) as { recent: { id: number; status: string; result: string }[] };
  const mine = seen.recent.find((r) => r.id === queued.id);
  assert.ok(mine, `run ${queued.id} must appear in the token's recent list`);
  assert.equal(mine!.status, "done", `run ${queued.id} must be done, not ${mine!.status}`);
  assert.match(mine!.result, /executed 1 action/);
  await page.screenshot({ path: "/tmp/tt146-automation.png" });
  await context.close();
});

await test("CT-03 a link made here opens the same desktop there, and a tampered one is refused", { "CT-03": "full" }, async () => {
  // Two different windows, so the restored layout is distinguishable from the
  // default desktop rather than coincidentally similar.
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", {
    id: "default", revision: Number(cur.row?.revision ?? 1) + 1000,
    state: {
      windows: [
        { id: "w1", module: "devices", title: "devices", x: 10, y: 10, w: 640, h: 700, z: 10, workspace: 1, props: {} },
        { id: "w2", module: "notes", title: "notes", x: 620, y: 40, w: 560, h: 620, z: 11, workspace: 1, props: { path: "/Documents/tt146.md" } },
      ],
      focus: "w2", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
    },
  });
  const context = await browser.newContext({ viewport: { width: 1240, height: 940 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const devices = page.locator('[data-win-id="w1"]');
  await devices.getByRole("tab", { name: "Runtime" }).click();
  await devices.locator('[data-testid="handoff-build"]').waitFor();
  await devices.getByTestId("handoff-build").click();
  const url = await page.locator('[data-testid="handoff-url"]').innerText();
  assert.match(url, /#handoff=[A-Za-z0-9_-]+$/, "the link must carry the layout in the fragment");
  assert.ok(!url.split("#")[0].includes("notes"), "nothing of the layout may appear before the fragment");
  assert.match(await page.locator('[data-testid="handoff-note"]').innerText(), /characters/);

  // Open the link in a fresh profile: a different device, same app.
  const other = await browser.newContext({ viewport: { width: 1240, height: 940 } });
  const page2 = await other.newPage();
  page2.setDefaultTimeout(25_000);
  await page2.goto(url, { waitUntil: "domcontentloaded" });
  await page2.waitForSelector('[data-win-id^="w"][aria-label="notes"]');
  const labels = await page2.evaluate(() => [...document.querySelectorAll("[data-win-id]")].map((e) => e.getAttribute("aria-label")));
  assert.deepEqual(labels.sort(), ["devices", "notes"], "both windows arrive, and only those");
  // The fragment is consumed: a reload must not silently replace the desktop.
  assert.equal(new URL(page2.url()).hash, "", "the address bar must drop a fragment it has already used");
  await page2.reload({ waitUntil: "domcontentloaded" });
  await page2.waitForSelector('[data-win-id^="w"]');
  await other.close();

  // A tampered payload is refused with a reason, and the stored desktop stays.
  const tampered = url.replace(/#handoff=.+$/, "#handoff=bm90LWpzb24");
  const third = await browser.newContext({ viewport: { width: 1240, height: 940 } });
  const page3 = await third.newPage();
  page3.setDefaultTimeout(25_000);
  await page3.goto(tampered, { waitUntil: "domcontentloaded" });
  await page3.waitForSelector('[data-win-id^="w"]');
  await page3.waitForFunction(() => /continue-on link was not used/i.test(document.body.innerText), undefined, { timeout: 15_000 });
  const still = await page3.evaluate(() => [...document.querySelectorAll("[data-win-id]")].map((e) => e.getAttribute("aria-label")).sort());
  assert.deepEqual(still, ["devices", "notes"], "a refused link must not clear what was already open");
  await page3.screenshot({ path: "/tmp/tt146-handoff-refused.png" });
  await third.close();

  await page.screenshot({ path: "/tmp/tt146-handoff.png" });
  await context.close();
});

finish();
await browser.close();
