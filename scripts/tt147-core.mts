/**
 * TT147 — pure contracts for the four capability modules added this turn:
 * the OS-settings deep-link index (ST-02), the accelerator report (HW-04), the
 * peripheral inventory (HW-07) and cursor confinement (WM-16).
 *
 * These four rows all have the same failure mode, and it is the reason they are
 * tested together: an app that *claims* a capability it merely detects. Each
 * test therefore asks the same three questions — does the module refuse when
 * the API is absent, does it distinguish "none granted" from "refused", and
 * does it say out loud what it cannot know.
 *
 * No browser, no server, no database: every input is a plain object.
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import {
  ENTRIES, coverage, deepLinkFor, detectPlatform, indexFor, searchEntries, type Platform,
} from "../src/lib/settings/deep-links";
import { classifyAdapter, probeAccelerators, type AdapterFacts, type GpuLike, type MlLike } from "../src/lib/gpu/accelerators";
import { browserInventory, readInventory, requestPlan } from "../src/lib/peripherals/inventory";
import { applyOutcome, describeConfinement, initialConfinement, planConfinement, type ConfinementState } from "../src/lib/windowing/pointer-lock";

const { test, finish } = makeHarness("tt147-core");

/* ─────────────────────────────────────────────────────────────── ST-02 */

await test("ST-02 settings index: every URI is well-formed, platform-scoped, and never guessed", { "ST-02": "full" }, () => {
  // A URI must be a scheme we recognise, with no whitespace, and it must be in
  // that platform's own scheme — no Windows link under macOS.
  const schemeOf = (u: string) => u.slice(0, u.indexOf(":") + 1);
  const allowed: Record<Platform, RegExp> = {
    windows: /^ms-settings:$/,
    macos: /^x-apple\.systempreferences:$/,
    linux: /^gnome-control-center[ :]?$/,
    android: /^intent:$/,
    ios: /^$/,
    unknown: /^$/,
  };
  for (const e of ENTRIES) {
    for (const [platform, uri] of Object.entries(e.uris) as [Platform, string][]) {
      assert.ok(!/\s/.test(uri.replace(/ /g, "\u0000")), `${e.id} ${platform} contains whitespace inside a token`);
      assert.ok(uri.length > 8, `${e.id} ${platform} URI is too short to be real`);
      if (platform === "linux") {
        assert.match(uri, /^gnome-control-center /, `${e.id} linux must name a real control-centre panel`);
      } else {
        assert.match(schemeOf(uri), allowed[platform], `${e.id} ${platform} uses the wrong scheme (${schemeOf(uri)})`);
      }
    }
  }
  // iOS is never offered a URI: there is no public scheme.
  assert.equal(ENTRIES.filter((e) => e.uris.ios).length, 0);
  assert.equal(coverage("windows").available, ENTRIES.length);
  assert.equal(coverage("android").available, ENTRIES.filter((e) => e.uris.android).length);
  assert.ok(coverage("android").available < coverage("windows").available, "Android exposes fewer panels than Windows, and the report says so");

  // Unknown and iOS refuse with a reason, and the reason is different.
  const camera = ENTRIES.find((e) => e.id === "camera")!;
  const ios = deepLinkFor(camera, "ios");
  assert.equal(ios.ok, false);
  assert.match((ios as { reason: string }).reason, /no public settings URI/);
  const unknown = deepLinkFor(camera, "unknown");
  assert.match((unknown as { reason: string }).reason, /not identified/);
  // A platform without that panel refuses rather than falling back to another OS.
  const print = ENTRIES.find((e) => e.id === "printers")!;
  const androidPrint = deepLinkFor(print, "android");
  assert.equal(androidPrint.ok, false);
  assert.match((androidPrint as { reason: string }).reason, /no verified android/);

  // A link that exists carries a caveat; the caveat never claims success.
  for (const row of indexFor("windows")) {
    assert.ok(row.link);
    assert.match(row.link!.caveat, /may|cannot/);
    assert.ok(!/opened|succeeded/i.test(row.link!.caveat));
  }
});

await test("ST-02 platform detection: an iPad is iOS, an Android phone is not Linux", {}, () => {
  const cases: [string, string, Platform][] = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1)", "MacIntel", "macos"],
    ["Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X)", "MacIntel", "ios"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X)", "iPhone", "ios"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Linux armv8l", "android"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", "linux"],
    ["", "Linux x86_64", "linux"],
    ["", "", "unknown"],
  ];
  for (const [ua, platform, want] of cases) assert.equal(detectPlatform(ua, platform), want, `${ua} / ${platform}`);
});

await test("ST-02 search: label beats keyword, every returned entry is usable, and a miss returns nothing", {}, () => {
  const byLabel = searchEntries("bluetooth", "windows");
  assert.equal(byLabel[0].entry.id, "bluetooth");
  const loud = searchEntries("sound", "windows");
  assert.equal(loud[0].entry.id, "sound-output", "the label match must outrank a keyword mention elsewhere");
  // A query that matches nothing is empty, not a list of everything.
  assert.deepEqual(searchEntries("zzzzz", "windows"), []);
  assert.deepEqual(searchEntries("   ", "windows"), []);
  // Limit is honoured and results keep their link/refusal pair.
  const limited = searchEntries("settings", "windows", 2);
  assert.ok(limited.length <= 2);
  for (const r of limited) assert.ok(r.link || r.reason);
  // iOS results carry refusals, not links.
  const iosSearch = searchEntries("camera", "ios");
  assert.equal(iosSearch.length, 1);
  assert.equal(iosSearch[0].link, null);
  assert.match(iosSearch[0].reason ?? "", /iOS/);
});

/* ─────────────────────────────────────────────────────────────── HW-04 */

const adapter = (o: Partial<AdapterFacts>): AdapterFacts => ({ vendor: null, architecture: null, device: null, description: null, fallback: false, ...o });

await test("HW-04 an adapter that names SwiftShader is reported as software, not as a GPU", { "HW-04": "full" }, async () => {
  const software = classifyAdapter(adapter({ vendor: "google", architecture: "swiftshader", description: "Google SwiftShader" }));
  assert.equal(software.verdict, "software");
  assert.match(software.reason, /software/i);
  const fallback = classifyAdapter(adapter({ fallback: true }));
  assert.equal(fallback.verdict, "software");
  assert.match(fallback.reason, /fallback/);
  const real = classifyAdapter(adapter({ vendor: "nvidia", architecture: "ampere", device: "rtx 3060" }));
  assert.equal(real.verdict, "hardware");
  assert.match(real.reason, /nvidia ampere rtx 3060/);
  // No adapter at all is "none", never "hardware" by default.
  assert.equal(classifyAdapter(null).verdict, "none");

  // The full probe with an injected GPU that behaves like this container's:
  // requestAdapter resolves, info says swiftshader, WebNN is missing.
  const gpu: GpuLike = {
    requestAdapter: async () => ({ isFallbackAdapter: false, info: { vendor: "google", architecture: "swiftshader", description: "Google SwiftShader" } }),
  };
  const report = await probeAccelerators({ gpu, ml: null, hardwareConcurrency: 2 });
  assert.equal(report.webgpu.verdict, "software");
  assert.equal(report.webnn.available, false);
  assert.match(report.webnn.reason, /no WebNN object/);
  assert.equal(report.fallback.threads, 2);
  assert.match(report.summary, /lands on the CPU/);
  // The strings the API returned are quoted, not translated.
  assert.equal(report.webgpu.adapter?.architecture, "swiftshader");
});

await test("HW-04 WebNN: an NPU is claimed only when a context was really created", {}, async () => {
  const npu: MlLike = { createContext: async ({ deviceType }) => { if (deviceType !== "npu") throw new Error(`no ${deviceType}`); return {}; } };
  const withNpu = await probeAccelerators({ gpu: null, ml: npu, hardwareConcurrency: 8 });
  assert.equal(withNpu.webnn.available, true);
  assert.equal(withNpu.webnn.deviceType, "npu");
  assert.match(withNpu.summary, /NPU answers/);
  assert.equal(withNpu.webgpu.available, false);
  assert.equal(withNpu.webgpu.verdict, "none");

  // Falls back to the next device without pretending the first one worked.
  const seen: string[] = [];
  const cpuOnly: MlLike = { createContext: async ({ deviceType }) => { seen.push(String(deviceType)); if (deviceType !== "cpu") throw new Error("unsupported"); return {}; } };
  const r = await probeAccelerators({ ml: cpuOnly, hardwareConcurrency: 1 });
  assert.deepEqual(seen, ["npu", "gpu", "cpu"]);
  assert.equal(r.webnn.deviceType, "cpu");

  // An engine that has WebNN but refuses every device is reported as refused.
  const broken: MlLike = { createContext: async () => { throw new Error("permission policy"); } };
  const refused = await probeAccelerators({ ml: broken });
  assert.equal(refused.webnn.available, false);
  assert.match(refused.webnn.reason, /refused a context: permission policy/);

  // A throwing requestAdapter cannot escape as an unhandled rejection.
  const throwing: GpuLike = { requestAdapter: async () => { throw new Error("gpu process crashed"); } };
  const crashed = await probeAccelerators({ gpu: throwing });
  assert.equal(crashed.webgpu.verdict, "none");
  assert.match(crashed.webgpu.reason, /no WebGPU adapter/);
});

/* ─────────────────────────────────────────────────────────────── HW-07 */

await test("HW-07 inventory: granted is not the device list, and a refusal is not an absence", { "HW-07": "full" }, async () => {
  const inv = await readInventory({
    hid: { getDevices: async () => [{ id: 1 }, { id: 2 }], requestDevice: async () => ({}) },
    usb: { getDevices: async () => [], requestDevice: async () => ({}) },
    serial: { getPorts: async () => [{ id: "p" }], requestPort: async () => ({}) },
    bluetooth: { getDevices: async () => { throw new Error("Bluetooth permission denied"); }, requestDevice: async () => ({}) },
  });
  assert.equal(inv.granted, 3, "2 HID + 1 serial");
  assert.equal(inv.buses.find((b) => b.bus === "usb")!.reason, "nothing granted to this origin yet — the chooser is the only way to add one");
  // The refused bus keeps the browser's own words and is not counted as empty.
  assert.match(inv.buses.find((b) => b.bus === "bluetooth")!.reason, /Bluetooth permission denied/);
  assert.ok(inv.limits.length >= 3);
  assert.match(inv.summary, /3 granted device\(s\)/);
  // Every bus that has a request method can open a chooser; one that does not, cannot.
  assert.equal(inv.buses.every((b) => b.canRequest), true);
  const noApi = await readInventory({});
  assert.equal(noApi.buses.every((b) => !b.present && !b.canRequest), true);
  assert.match(noApi.buses[0].reason, /no Webhid object/);
  assert.equal(noApi.granted, 0);
});

await test("HW-07 requests: a filterless request is refused before it can ask for a keyboard", {}, () => {
  // HID without a usage page: refused, with the reason naming the keyboard risk.
  const hid = requestPlan("hid");
  assert.equal(hid.options, null);
  assert.match(hid.reason, /keyboard/);
  const hidOk = requestPlan("hid", { usagePage: 0x0c, usage: 0x09 });
  assert.deepEqual(hidOk.options, { filters: [{ usagePage: 12, usage: 9 }] });
  // USB needs both ids.
  assert.equal(requestPlan("usb", { vendorId: 1 }).options, null);
  assert.match(requestPlan("usb", { vendorId: 1 }).reason, /vendor and product/);
  assert.deepEqual(requestPlan("usb", { vendorId: 0x2341, productId: 0x0043 }).options, { filters: [{ vendorId: 9025, productId: 67 }] });
  // Serial has no filter; Bluetooth refuses acceptAllDevices.
  assert.deepEqual(requestPlan("serial").options, {});
  const bt = requestPlan("bluetooth");
  assert.equal((bt.options as { acceptAllDevices: boolean }).acceptAllDevices, false);
  assert.match(bt.reason, /service filter/);
});

/* ─────────────────────────────────────────────────────────────── WM-16 */

await test("WM-16 confinement state machine: no API, no gesture, pending, and a raw-input refusal", { "WM-16": "full" }, () => {
  // Absent API is a refusal with a reason, not a thrown exception.
  const none = planConfinement(initialConfinement, { apiAvailable: false, userGesture: true, wantLocked: true });
  assert.equal(none.action, "refuse");
  assert.match(none.reason, /no Pointer Lock/);

  // No gesture: the browser will not lock, so we do not ask.
  const noGesture = planConfinement(initialConfinement, { apiAvailable: true, userGesture: false, wantLocked: true });
  assert.equal(noGesture.action, "refuse");
  assert.match(noGesture.reason, /real click/);

  // A click asks for raw input first.
  const ask = planConfinement(initialConfinement, { apiAvailable: true, userGesture: true, wantLocked: true });
  assert.equal(ask.action, "lock");
  assert.deepEqual(ask.options, { unadjustedMovement: true });

  // Pending blocks a second request: Chromium would ignore it and the caller
  // would read the silence as a failure.
  const pending: ConfinementState = { pending: true, locked: false, rawRefused: false };
  assert.equal(planConfinement(pending, { apiAvailable: true, userGesture: true, wantLocked: true }).action, "wait");

  // A raw-input refusal is remembered, and the retry asks for adjusted movement.
  const refusedRaw = applyOutcome(pending, { kind: "rejected", error: "NotSupportedError: unadjustedMovement not supported" });
  assert.equal(refusedRaw.state.locked, false);
  assert.equal(refusedRaw.state.rawRefused, true);
  assert.match(refusedRaw.note, /refused raw input/);
  const retry = planConfinement(refusedRaw.state, { apiAvailable: true, userGesture: true, wantLocked: true });
  assert.deepEqual(retry.options, {});
  assert.match(retry.reason, /adjusted movement/);

  // A plain rejection is reported with its message and does not poison later attempts.
  const plain = applyOutcome(initialConfinement, { kind: "rejected", error: "user cancelled" });
  assert.equal(plain.state.rawRefused, false);
  assert.match(plain.note, /user cancelled/);

  // Locked → unlock, and the state forgets the lock.
  const locked = applyOutcome(initialConfinement, { kind: "locked" });
  assert.equal(locked.state.locked, true);
  const unlock = planConfinement(locked.state, { apiAvailable: true, userGesture: false, wantLocked: false });
  assert.equal(unlock.action, "unlock", "dropping confinement needs no gesture");
  assert.equal(applyOutcome(locked.state, { kind: "unlocked" }).state.locked, false);

  // The description never claims multi-display confinement, and admits an
  // unknown display count instead of defaulting to one.
  assert.match(describeConfinement(initialConfinement, null), /does not report the display layout/);
  assert.match(describeConfinement(initialConfinement, 2), /2 displays/);
  assert.match(describeConfinement(locked.state, 1), /cannot leave it/);
  assert.ok(!/display 1|primary display|confined to display/i.test(describeConfinement(locked.state, 2)));
});

await test("HW-07 browserInventory works on this Node engine: every bus is absent and says so", {}, async () => {
  // Node has no navigator.hid/usb/serial/bluetooth unless something polyfills
  // them; the wrapper must still return a complete, honest report.
  const inv = await browserInventory();
  assert.equal(inv.buses.length, 4);
  assert.equal(inv.granted, 0);
  for (const b of inv.buses) assert.ok(!b.present || b.granted >= 0);
});


/* ─────────────────────────────────────────────────────────────── PR-07o */

await test("PR-07o profiles: one jar per profile, one jar per anonymous tab, and names that cannot escape", { "PR-07o": "full" }, async () => {
  const { safeProfileName, profileSessionKey, profileSessionKeys, normalizeSession, safeBrowserUrl } = await import("../src/lib/browserSession");

  // A name from untrusted input: letters/digits/space/-/_ only, 1..30, and the
  // whitespace is normalised so " Work  2 " and "Work 2" are the same profile.
  assert.equal(safeProfileName("Personal"), "Personal");
  assert.equal(safeProfileName("  Work  2 "), "Work 2");
  assert.equal(safeProfileName("side-project_1"), "side-project_1");
  for (const bad of ["", "   ", "a/b", "a:b", "a\u0000b", "x".repeat(31), "<script>", "p:evil", 42, null]) {
    assert.equal(safeProfileName(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }

  // Jar keys: the same profile is one jar, a tab-only tab is its own, and two
  // different profiles never collide with a tab id that happens to look like one.
  assert.equal(profileSessionKey({ id: "t1", profile: "Work" }), profileSessionKey({ id: "t2", profile: "Work" }));
  assert.notEqual(profileSessionKey({ id: "t1" }), profileSessionKey({ id: "t1", profile: "Work" }));
  assert.notEqual(profileSessionKey({ id: "t1" }), profileSessionKey({ id: "t2" }));
  assert.deepEqual(profileSessionKeys([{ id: "t1", profile: "Work" }, { id: "t2", profile: "Work" }, { id: "t3" }]), ["p:Work", "t3"]);

  // A restored session keeps valid profiles, drops invalid ones (the tab still
  // opens — losing the profile must not lose the tab), and never shares a jar
  // by accident.
  const restored = normalizeSession({
    tabs: [
      { id: "t1", url: "https://a.example", profile: "Work" },
      { id: "t2", url: "https://b.example", profile: "Work" },
      { id: "t3", url: "https://c.example", profile: "bad/name" },
      { id: "t4", url: "https://d.example" },
      { id: "t5", url: "javascript:alert(1)" },
      { id: "t6", url: "https://evil.example@phish.example" },
    ],
    active: "t2",
  });
  assert.equal(restored.dropped, 2, "the javascript: URL and the credential-bearing URL must be dropped");
  assert.equal(restored.tabs.length, 4);
  assert.equal(restored.tabs.find((t) => t.id === "t3")!.profile, undefined);
  const keys = profileSessionKeys(restored.tabs);
  assert.equal(keys.filter((k) => k === "p:Work").length, 1, "two Work tabs must share exactly one jar");
  assert.equal(keys.length, 3, "Work, t3 and t4 are three jars");
  assert.equal(restored.active, "t2");

  // The URL guard the profiles sit on: no same-origin frames (they could
  // unsandbox themselves), no userinfo, no non-http schemes.
  assert.equal(safeBrowserUrl("https://example.com/a", "https://app.example"), "https://example.com/a");
  assert.equal(safeBrowserUrl("https://app.example/x", "https://app.example"), null);
  assert.equal(safeBrowserUrl("ftp://example.com", "https://app.example"), null);
  assert.equal(safeBrowserUrl("example.com", undefined), "https://example.com/");
});

finish();
