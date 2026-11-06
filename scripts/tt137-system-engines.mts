/**
 * TT137 pure-suite: FM-18, ST-03, AP-05, BK-05, MD-06, MD-09, CA-15, LN-05, LN-06.
 */
import { makeHarness } from "./harness.mts";
import {
  createSafeSave, writeChunk, markTempWritten, validate, markValidated, publish, fail, isOriginalSafe, describePhase,
} from "../src/lib/files/safe-save.ts";
import {
  createRegistry, getExtension, setOverride, clearOverride, getProtocol, buildGuide, describeApp,
} from "../src/lib/default-apps.ts";
import {
  createInventory, registerEntry, unregisterEntry, markActive, report, checkConsistency, describeEntry,
} from "../src/lib/apps/inventory.ts";
import {
  checkHealth, planDrill, describeHealth,
} from "../src/lib/backup/health.ts";
import {
  createDashboard, addWindow, setVolume, toggleMute, setContextState, reportDashboard, describeWindow, routeAudio, reroute,
} from "../src/lib/audio/routing.ts";
import {
  createSync, addReceiver, setLeader, startPlayback, stopPlayback, advance, nudge, reportSync, describeSync,
} from "../src/lib/cast/sync.ts";
import {
  planUpscale, estimateUpscale, bilinearInterpolate, planRelight, computeLighting, applyRelightPixel, relightReport,
} from "../src/lib/lens/image-ops.ts";

const { test, finish } = makeHarness("tt137-system-engines");

// ── FM-18: Safe-save contract ─────────────────────────────────────────────────
await test("FM-18 · safe-save creates idle state", { "FM-18": "full" }, () => {
  const s = createSafeSave("/Session/file.md", "/Documents/file.md", 1024);
  if (s.phase !== "idle") throw new Error(`expected idle, got ${s.phase}`);
  if (!s.tempPath.includes(".part")) throw new Error("temp should have .part extension");
});

await test("FM-18 · safe-save rejects same path", { "FM-18": "full" }, () => {
  try {
    createSafeSave("/Documents/a.md", "/Documents/a.md", 1024);
    throw new Error("should reject same path");
  } catch (e) {
    if (!(e instanceof Error) || !/differ/.test(e.message)) throw e;
  }
});

await test("FM-18 · writeChunk tracks progress", { "FM-18": "full" }, () => {
  let s = createSafeSave("/Session/a.md", "/Documents/a.md", 1024);
  s = writeChunk(s, new Uint8Array(512));
  if (s.written !== 512) throw new Error(`expected 512, got ${s.written}`);
  if (s.phase !== "copying") throw new Error("should be copying");
});

await test("FM-18 · writeChunk rejects overflow", { "FM-18": "full" }, () => {
  let s = createSafeSave("/Session/a.md", "/Documents/a.md", 1024);
  s = writeChunk(s, new Uint8Array(512));
  try {
    writeChunk(s, new Uint8Array(1024));
    throw new Error("should reject overflow");
  } catch (e) {
    if (!(e instanceof Error) || !/exceed/.test(e.message)) throw e;
  }
});

await test("FM-18 · validate requires matching size and sha", { "FM-18": "full" }, () => {
  let s = createSafeSave("/Session/a.md", "/Documents/a.md", 1024);
  s = writeChunk(s, new Uint8Array(1024));
  s = markTempWritten(s, "a".repeat(64));
  const r = validate(s, "b".repeat(64), 1024);
  if (r.ok) throw new Error("should reject sha mismatch");
  const r2 = validate(s, "a".repeat(64), 2048);
  if (r2.ok) throw new Error("should reject size mismatch");
});

await test("FM-18 · publish only after validated", { "FM-18": "full" }, () => {
  let s = createSafeSave("/Session/a.md", "/Documents/a.md", 1024);
  try {
    publish(s);
    throw new Error("should reject publish before validated");
  } catch (e) {
    if (!(e instanceof Error) || !/validated/.test(e.message)) throw e;
  }
});

await test("FM-18 · original is safe until published", { "FM-18": "full" }, () => {
  let s = createSafeSave("/Session/a.md", "/Documents/a.md", 1024);
  if (!isOriginalSafe(s)) throw new Error("original should be safe in idle");
  s = writeChunk(s, new Uint8Array(1024));
  s = markTempWritten(s, "a".repeat(64));
  s = markValidated(s, "b".repeat(64));
  if (!isOriginalSafe(s)) throw new Error("original should still be safe in validated");
  s = publish(s);
  if (isOriginalSafe(s)) throw new Error("original is no longer safe after publish");
});

// ── ST-03: Default-apps guide ──────────────────────────────────────────────────
await test("ST-03 · registry has system extensions", { "ST-03": "full" }, () => {
  const reg = createRegistry();
  if (reg.extensions.size < 20) throw new Error(`expected ≥20 extensions, got ${reg.extensions.size}`);
});

await test("ST-03 · getExtension finds md", { "ST-03": "full" }, () => {
  const reg = createRegistry();
  const app = getExtension(reg, "md");
  if (!app) throw new Error("should find md");
  if (app.module !== "editor") throw new Error(`expected editor, got ${app.module}`);
});

await test("ST-03 · override shadows system default", { "ST-03": "full" }, () => {
  const reg = createRegistry();
  const r = setOverride(reg, "md", "writer");
  if (!r.ok) throw new Error(`override failed: ${r.reason}`);
  const app = getExtension(reg, "md");
  if (!app || app.module !== "writer") throw new Error("override should shadow system");
});

await test("ST-03 · clearOverride restores system default", { "ST-03": "full" }, () => {
  const reg = createRegistry();
  setOverride(reg, "md", "writer");
  const r = clearOverride(reg, "md");
  if (!r.ok) throw new Error("clear should work");
  const app = getExtension(reg, "md");
  if (!app || app.module !== "editor") throw new Error("should restore system default");
});

await test("ST-03 · protocol handlers exist", { "ST-03": "full" }, () => {
  const reg = createRegistry();
  const p = getProtocol(reg, "mailto");
  if (!p) throw new Error("should have mailto handler");
  if (p.module !== "mail") throw new Error("mailto should map to mail");
});

await test("ST-03 · describeApp gives one-liner", { "ST-03": "full" }, () => {
  const reg = createRegistry();
  const d = describeApp(reg, "/Documents/report.pdf");
  if (!d.includes("pdf")) throw new Error(`should mention pdf: ${d}`);
  if (!d.includes("PDF")) throw new Error(`should mention PDF app: ${d}`);
});

// ── AP-05: Background inventory ───────────────────────────────────────────────
await test("AP-05 · register entry", { "AP-05": "full" }, () => {
  const inv = createInventory();
  const r = registerEntry(inv, { id: "bg-sw1", kind: "service-worker", module: "shell", active: true, startup: true, lastRun: null, description: "Shell service worker" }, 1000);
  if (!r.ok) throw new Error(`register failed: ${r.reason}`);
});

await test("AP-05 · report counts by kind and module", { "AP-05": "full" }, () => {
  const inv = createInventory();
  registerEntry(inv, { id: "bg-sw1", kind: "service-worker", module: "shell", active: true, startup: true, lastRun: null, description: "SW" }, 1000);
  registerEntry(inv, { id: "bg-alarm1", kind: "alarm", module: "clock", active: false, startup: false, lastRun: null, description: "Alarm" }, 1000);
  const r = report(inv);
  if (r.total !== 2) throw new Error(`expected 2, got ${r.total}`);
  if (r.byKind["service-worker"] !== 1) throw new Error("should count 1 SW");
  if (r.byModule["shell"] !== 1) throw new Error("should count 1 shell");
});

await test("AP-05 · consistency check flags missing startup on SW", { "AP-05": "full" }, () => {
  const inv = createInventory();
  registerEntry(inv, { id: "bg-sw1", kind: "service-worker", module: "shell", active: true, startup: false, lastRun: null, description: "SW" }, 1000);
  const c = checkConsistency(inv);
  if (c.ok) throw new Error("should flag SW without startup");
});

await test("AP-05 · unregister removes entry", { "AP-05": "full" }, () => {
  const inv = createInventory();
  registerEntry(inv, { id: "bg-sw1", kind: "service-worker", module: "shell", active: true, startup: true, lastRun: null, description: "SW" }, 1000);
  const r = unregisterEntry(inv, "bg-sw1");
  if (!r.ok) throw new Error("unregister should work");
  if (inv.entries.length !== 0) throw new Error("entry should be removed");
});

// ── BK-05: Backup health + drill ──────────────────────────────────────────────
await test("BK-05 · fresh backup is healthy", { "BK-05": "full" }, () => {
  const now = Date.now();
  const h = checkHealth({ id: "bk1", lastBackup: now - 86_400_000, bytes: 1024, files: 10, encrypted: true, verifiable: true, complete: true }, now);
  if (!h.ok) throw new Error(`should be ok: ${h.issues.join("; ")}`);
  if (h.grade !== "fresh") throw new Error(`expected fresh, got ${h.grade}`);
});

await test("BK-05 · stale backup reports issues", { "BK-05": "full" }, () => {
  const now = Date.now();
  const h = checkHealth({ id: "bk1", lastBackup: now - 10 * 86_400_000, bytes: 1024, files: 10, encrypted: false, verifiable: false, complete: true }, now);
  if (h.ok) throw new Error("should have issues");
  if (h.grade !== "stale") throw new Error(`expected stale, got ${h.grade}`);
  if (h.issues.length < 2) throw new Error(`expected ≥2 issues, got ${h.issues.length}`);
});

await test("BK-05 · drill plan is safe for dry run", { "BK-05": "full" }, () => {
  const set = { id: "bk1", lastBackup: Date.now(), bytes: 1024, files: 10, encrypted: true, verifiable: true, complete: true };
  const drill = planDrill(set, []);
  if (!drill.safe) throw new Error("dry run should be safe");
  if (!drill.full) throw new Error("empty targets should be full drill");
});

await test("BK-05 · drill rejects incomplete set", { "BK-05": "full" }, () => {
  const set = { id: "bk1", lastBackup: Date.now(), bytes: 1024, files: 10, encrypted: true, verifiable: true, complete: false };
  try {
    planDrill(set, []);
    throw new Error("should reject incomplete set");
  } catch (e) {
    if (!(e instanceof Error) || !/incomplete/.test(e.message)) throw e;
  }
});

// ── MD-06: Audio routing ──────────────────────────────────────────────────────
await test("MD-06 · routeAudio uses defaults", { "MD-06": "full" }, () => {
  const devices = [
    { id: "out1", label: "Speakers", kind: "output" as const, default: true },
    { id: "out2", label: "HDMI", kind: "output" as const, default: false },
    { id: "in1", label: "Mic", kind: "input" as const, default: true },
  ];
  const r = routeAudio("w-1", devices);
  if (r.outputDevice !== "out1") throw new Error(`expected out1, got ${r.outputDevice}`);
  if (r.isDefault !== true) throw new Error("should be default");
});

await test("MD-06 · reroute changes output device", { "MD-06": "full" }, () => {
  const devices = [
    { id: "out1", label: "Speakers", kind: "output" as const, default: true },
    { id: "out2", label: "HDMI", kind: "output" as const, default: false },
  ];
  const r = reroute("w-1", "out1", "out2", devices);
  if (r.outputDevice !== "out2") throw new Error(`expected out2, got ${r.outputDevice}`);
});

// ── MD-09: Per-window audio dashboard ─────────────────────────────────────────
await test("MD-09 · addWindow registers audio state", { "MD-09": "full" }, () => {
  const dash = createDashboard();
  const r = addWindow(dash, "w-1", "out1", "in1");
  if (!r.ok) throw new Error(`add failed: ${r.reason}`);
  if (dash.windows.get("w-1")!.volume !== 1) throw new Error("default volume should be 1");
});

await test("MD-09 · setVolume and toggleMute work", { "MD-09": "full" }, () => {
  const dash = createDashboard();
  addWindow(dash, "w-1", "out1", "in1");
  setVolume(dash, "w-1", 0.5);
  if (dash.windows.get("w-1")!.volume !== 0.5) throw new Error("volume not set");
  const m = toggleMute(dash, "w-1");
  if (!m.ok || !m.muted) throw new Error("should mute");
});

await test("MD-09 · reportDashboard gives summary", { "MD-09": "full" }, () => {
  const dash = createDashboard();
  addWindow(dash, "w-1", "out1", "in1");
  addWindow(dash, "w-2", "out1", "in1");
  setContextState(dash, "w-1", true, 10);
  const r = reportDashboard(dash);
  if (r.total !== 2) throw new Error(`expected 2, got ${r.total}`);
  if (r.running !== 1) throw new Error(`expected 1 running, got ${r.running}`);
});

// ── CA-15: Multi-receiver sync ────────────────────────────────────────────────
await test("CA-15 · add and set leader", { "CA-15": "full" }, () => {
  const s = createSync();
  addReceiver(s, "r-1", "TV", 1000);
  addReceiver(s, "r-2", "Phone", 1000);
  const r = setLeader(s, "r-1");
  if (!r.ok) throw new Error(`setLeader failed: ${r.reason}`);
  if (s.leader !== "r-1") throw new Error("leader not set");
});

await test("CA-15 · advance keeps receivers in sync", { "CA-15": "full" }, () => {
  const s = createSync();
  addReceiver(s, "r-1", "TV", 1000);
  addReceiver(s, "r-2", "Phone", 1000);
  setLeader(s, "r-1");
  startPlayback(s, 1000);
  const r = advance(s, 5000, 5000);
  if (!r.ok) throw new Error(`advance failed: ${r.reason}`);
  if (Math.abs(r.drift["r-2"]) > 0) throw new Error("should be in sync");
});

await test("CA-15 · nudge corrects drift", { "CA-15": "full" }, () => {
  const s = createSync();
  addReceiver(s, "r-1", "TV", 1000);
  addReceiver(s, "r-2", "Phone", 1000);
  setLeader(s, "r-1");
  startPlayback(s, 1000);
  advance(s, 5000, 5000);
  // Simulate drift
  s.receivers.get("r-2")!.positionMs = 7000;
  s.receivers.get("r-2")!.offsetMs = 2000;
  s.receivers.get("r-2")!.inSync = false;
  const r = nudge(s, "r-2", -2000);
  if (!r.ok) throw new Error("nudge should work");
  if (!s.receivers.get("r-2")!.inSync) throw new Error("should be in sync after nudge");
});

await test("CA-15 · reportSync counts in-sync receivers", { "CA-15": "full" }, () => {
  const s = createSync();
  addReceiver(s, "r-1", "TV", 1000);
  addReceiver(s, "r-2", "Phone", 1000);
  setLeader(s, "r-1");
  const r = reportSync(s);
  if (r.total !== 2) throw new Error(`expected 2, got ${r.total}`);
  if (r.inSync !== 1) throw new Error(`expected 1 in sync (leader), got ${r.inSync}`);
});

// ── LN-05: Upscale ────────────────────────────────────────────────────────────
await test("LN-05 · planUpscale validates inputs", { "LN-05": "full" }, () => {
  const r = planUpscale(800, 600, 2, "bilinear");
  if (r.scale !== 2) throw new Error("scale wrong");
  if (r.radius !== 1) throw new Error("bilinear radius should be 1");
});

await test("LN-05 · planUpscale rejects overscale", { "LN-05": "full" }, () => {
  try {
    planUpscale(800, 600, 10, "bilinear");
    throw new Error("should reject scale > 8");
  } catch (e) {
    if (!(e instanceof Error) || !/Scale/.test(e.message)) throw e;
  }
});

await test("LN-05 · bilinear interpolation is correct", { "LN-05": "full" }, () => {
  const v = bilinearInterpolate(0, 100, 0, 100, 0.5, 0.5);
  if (Math.abs(v - 50) > 0.1) throw new Error(`expected 50, got ${v}`);
});

await test("LN-05 · estimateUpscale gives output dims", { "LN-05": "full" }, () => {
  const r = estimateUpscale(800, 600, 2, "bicubic");
  if (r.width !== 1600) throw new Error(`expected 1600, got ${r.width}`);
  if (r.method !== "bicubic") throw new Error("method wrong");
});

// ── LN-06: Virtual key light ──────────────────────────────────────────────────
await test("LN-06 · planRelight validates sources", { "LN-06": "full" }, () => {
  const r = planRelight(800, 600, [{ x: 0.5, y: 0.3, intensity: 0.8, warmth: 0.2, radius: 0.2 }], 0.2);
  if (r.sources.length !== 1) throw new Error("should accept 1 source");
});

await test("LN-06 · planRelight rejects too many sources", { "LN-06": "full" }, () => {
  try {
    const sources = Array.from({ length: 10 }, (_, i) => ({ x: 0.1, y: 0.1, intensity: 0.5, warmth: 0, radius: 0.1 }));
    planRelight(800, 600, sources, 0.2);
    throw new Error("should reject >8 sources");
  } catch (e) {
    if (!(e instanceof Error) || !/8/.test(e.message)) throw e;
  }
});

await test("LN-06 · computeLighting gives intensity at source", { "LN-06": "full" }, () => {
  const spec = planRelight(800, 600, [{ x: 0.5, y: 0.3, intensity: 1.0, warmth: 0, radius: 0.3 }], 0.1);
  const light = computeLighting(0.5, 0.3, spec);
  if (light.intensity < 0.5) throw new Error(`expected high intensity at source, got ${light.intensity}`);
});

await test("LN-06 · applyRelightPixel shifts channels", { "LN-06": "full" }, () => {
  const spec = planRelight(800, 600, [{ x: 0.5, y: 0.5, intensity: 1.0, warmth: 0.5, radius: 0.5 }], 0.0);
  const [r, g, b] = applyRelightPixel(200, 150, 100, 0.5, 0.5, spec);
  if (r <= g) throw new Error("warm light should increase red");
  if (b >= g) throw new Error("warm light should decrease blue relative to green");
});

await test("LN-06 · relightReport gives coverage stats", { "LN-06": "full" }, () => {
  const spec = planRelight(800, 600, [{ x: 0.5, y: 0.5, intensity: 1.0, warmth: 0, radius: 0.3 }], 0.0);
  const r = relightReport(spec);
  if (r.sources !== 1) throw new Error("should have 1 source");
  if (r.maxIntensity < 0.5) throw new Error("max intensity should be high");
});

finish();
