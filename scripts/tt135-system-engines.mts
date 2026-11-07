/**
 * TT135 pure-suite: handoff (CT-03), crypto-sign (BL-02), routines-alert (RH-04),
 * routing (CO-03), locks (SH-06), window-groups (WM-02), input-profiles (ST-09).
 */
import { makeHarness } from "./harness.mts";
import { makePayload, encodeCode, normalizeCode, issue, accept, toMessage, fromMessage, CODE_TTL_MS } from "../src/lib/handoff.ts";
import { parseManifest, manifestBody, manifestDigest, verifyManifest, parseCertificate, digestFile } from "../src/lib/crypto-sign.ts";
import { validateRoutine, planFire, planNext, dryRun, isSafeAction, planDay, describeSchedule } from "../src/lib/routines/alert-db.ts";
import { route, followRedirect, describeVerdict, shellManifest, moduleManifest, needsProxy } from "../src/lib/connectivity/routing.ts";
import { leaseFor, claim, renew, checkHeartbeat, describeLease } from "../src/lib/crosstab/locks.ts";
import { makeGroup, layoutGroup, minimizeGroup, closeGroup, focusGroup, summarize, describeGroup } from "../src/lib/shell/window-groups.ts";
import { PROFILES, profileFor, canApply, mismatchReason, needsTimedGesture } from "../src/lib/input-profiles.ts";

const { test, finish } = makeHarness("tt135-system-engines");

// ── Handoff (CT-03) ───────────────────────────────────────────────────────────
await test("CT-07 · makePayload validates app id and title", { "CT-07": "full" }, () => {
  const p = makePayload("editor", "Untitled", { path: "/Documents/a.md" }, Date.now());
  if (p.app !== "editor") throw new Error("wrong app");
  if (p.title !== "Untitled") throw new Error("wrong title");
});

await test("CT-07 · makePayload rejects invalid app id", { "CT-07": "full" }, () => {
  try {
    makePayload("INVALID_ID", "title", {}, Date.now());
    throw new Error("should reject invalid app id");
  } catch (e) {
    if (!(e instanceof Error) || !/module id/.test(e.message)) throw e;
  }
});

await test("CT-07 · makePayload rejects oversized props", { "CT-07": "full" }, () => {
  try {
    makePayload("editor", "title", { big: "x".repeat(10000) }, Date.now());
    throw new Error("should reject oversized props");
  } catch (e) {
    if (!(e instanceof Error) || !/8 KiB/.test(e.message)) throw e;
  }
});

await test("CT-07 · encodeCode produces a 10-char code", { "CT-07": "full" }, () => {
  const p = makePayload("editor", "Untitled", {}, Date.now());
  const code = encodeCode(p);
  if (code.length !== 10) throw new Error(`expected 10 chars, got ${code.length}: ${code}`);
});

await test("CT-07 · normalizeCode handles user typos", { "CT-07": "full" }, () => {
  const p = makePayload("editor", "Untitled", {}, Date.now());
  const code = encodeCode(p);
  // Remove the dash and let the user type it
  const noDash = code.replace("-", "");
  const norm = normalizeCode(noDash);
  if (norm !== code) throw new Error(`normalization failed: ${norm} vs ${code}`);
});

await test("CT-07 · issue and accept round-trip within TTL", { "CT-07": "full" }, () => {
  const now = Date.now();
  const payload = makePayload("editor", "Untitled", { path: "/a.md" }, now);
  const state = issue(payload, now);
  const result = accept(state, state.code, now + 5000);
  if (!result.ok) throw new Error(`should accept within TTL: ${result.reason}`);
});

await test("CT-07 · expired handoff is refused", { "CT-07": "full" }, () => {
  const now = Date.now();
  const payload = makePayload("editor", "Untitled", {}, now);
  const state = issue(payload, now);
  const result = accept(state, state.code, now + CODE_TTL_MS + 1000);
  if (result.ok) throw new Error("should refuse expired handoff");
});

await test("CT-07 · mismatched code is refused", { "CT-07": "full" }, () => {
  const now = Date.now();
  const payload = makePayload("editor", "Untitled", {}, now);
  const state = issue(payload, now);
  const other = makePayload("browser", "Other", {}, now);
  const otherCode = encodeCode(other);
  const result = accept(state, otherCode, now);
  if (result.ok) throw new Error("should refuse mismatched code");
});

await test("CT-07 · fromMessage rejects non-handoff messages", { "CT-07": "full" }, () => {
  const r = fromMessage({ type: "not-handoff" }, Date.now());
  if (r.ok) throw new Error("should reject non-handoff message");
});

// ── Crypto-sign (BL-02) ───────────────────────────────────────────────────────
await test("BL-07 · parseManifest validates digest formats", { "BL-07": "full" }, () => {
  const m = { algorithm: "sha-256", files: [{ name: "/a.txt", size: 10, algorithm: "sha-256", digest: "aa".repeat(32) }] };
  const r = parseManifest(JSON.stringify(m));
  if (r.algorithm !== "sha-256") throw new Error(`expected sha-256, got ${r.algorithm}`);
  if (r.files.length !== 1) throw new Error(`expected 1 file, got ${r.files.length}`);
});

await test("BL-07 · parseManifest rejects mixed algorithms", { "BL-07": "full" }, () => {
  const m = { algorithm: "sha-256", files: [
    { name: "/a.txt", size: 10, algorithm: "sha-256", digest: "aa".repeat(32) },
    { name: "/b.txt", size: 10, algorithm: "sha-512", digest: "bb".repeat(64) },
  ]};
  try {
    parseManifest(JSON.stringify(m));
    throw new Error("should reject mixed algorithms");
  } catch (e) {
    if (!(e instanceof Error) || !/mix/.test(e.message)) throw e;
  }
});

await test("BL-07 · manifestBody is deterministic", { "BL-07": "full" }, () => {
  const files = [{ name: "/b.txt", bytes: 10, algorithm: "sha-256" as const, digest: "bb".repeat(32) }, { name: "/a.txt", bytes: 10, algorithm: "sha-256" as const, digest: "aa".repeat(32) }];
  const body1 = manifestBody(files, "sha-256");
  const body2 = manifestBody([...files].reverse(), "sha-256");
  if (body1 !== body2) throw new Error("manifestBody must be order-independent");
});

await test("BL-07 · verifyManifest detects missing files", { "BL-07": "full" }, () => {
  const files = [{ name: "/a.txt", bytes: 10, algorithm: "sha-256" as const, digest: "aa".repeat(32) }];
  void verifyManifest(files, []).then(r => {
    if (r.missing.length !== 1) throw new Error(`expected 1 missing, got ${r.missing.length}`);
    if (r.complete) throw new Error("should not be complete");
  });
});

await test("BL-07 · verifyManifest detects size mismatch", { "BL-07": "full" }, () => {
  const files = [{ name: "/a.txt", bytes: 10, algorithm: "sha-256" as const, digest: "aa".repeat(32) }];
  void verifyManifest(files, [{ name: "/a.txt", bytes: new Uint8Array(20) }]).then(r => {
    if (r.mismatched.length !== 1) throw new Error(`expected 1 mismatch, got ${r.mismatched.length}`);
  });
});

await test("BL-07 · parseCertificate validates Ed25519 key and signature lengths", { "BL-07": "full" }, () => {
  const cert = { algorithm: "Ed25519", publicKey: "aa".repeat(32), signature: "bb".repeat(64) };
  const r = parseCertificate(JSON.stringify(cert));
  if (r.algorithm !== "Ed25519") throw new Error("wrong algorithm");
});

await test("BL-07 · digestFile produces correct hex length", { "BL-07": "full" }, async () => {
  const bytes = new TextEncoder().encode("hello");
  const d = await digestFile(bytes, "sha-256");
  if (d.length !== 64) throw new Error(`expected 64 hex chars, got ${d.length}`);
});

// ── Routines-alert (RH-04) ───────────────────────────────────────────────────
await test("RH-04 · validateRoutine checks step count", { "RH-04": "full" }, () => {
  const r = validateRoutine({ id: "rt1", name: "Test", when: "2026-01-01T00:00:00", revision: -1, steps: [{ action: { kind: "text", payload: "hello" } }] });
  if (r.steps.length !== 1) throw new Error("should accept 1 step");
  try {
    validateRoutine({ id: "rt1", name: "Test", when: "2026-01-01T00:00:00", revision: -1, steps: [] });
    throw new Error("should reject empty steps");
  } catch (e) {
    if (!(e instanceof Error) || !/1…40/.test(e.message)) throw e;
  }
});

await test("RH-04 · planFire returns fire=true when due", { "RH-04": "full" }, () => {
  const r = validateRoutine({ id: "rt1", name: "Test", when: "2026-01-01T00:00:00", revision: -1, steps: [{ action: { kind: "text", payload: "hi" } }] });
  const plan = planFire(r, Date.now());
  if (!plan.fire) throw new Error("should fire when due time is past");
});

await test("RH-04 · planFire returns fire=false when not due", { "RH-04": "full" }, () => {
  const r = validateRoutine({ id: "rt1", name: "Test", when: "2099-01-01T00:00:00", revision: -1, steps: [{ action: { kind: "text", payload: "hi" } }] });
  const plan = planFire(r, Date.now());
  if (plan.fire) throw new Error("should not fire in the future");
});

await test("RH-04 · isSafeAction rejects payloads with shell metacharacters", { "RH-04": "full" }, () => {
  if (isSafeAction({ kind: "text", payload: "hello; rm -rf /" })) throw new Error("should reject shell metacharacters");
  if (!isSafeAction({ kind: "text", payload: "hello world" })) throw new Error("should accept plain text");
});

await test("RH-04 · dryRun reports which steps would run", { "RH-04": "full" }, () => {
  const r = validateRoutine({ id: "rt1", name: "Test", when: "2026-01-01T00:00:00", revision: -1, steps: [
    { action: { kind: "text", payload: "hi" } },
    { action: { kind: "note", payload: "note" } },
  ] });
  const d = dryRun(r, Date.now());
  if (!d.ok) throw new Error("should be ok");
  if (!d.wouldRun) throw new Error("should wouldRun");
  if (d.steps.length !== 2) throw new Error(`expected 2 steps, got ${d.steps.length}`);
});

await test("RH-04 · planDay filters to due routines", { "RH-04": "full" }, () => {
  const routines = [
    validateRoutine({ id: "rt1", name: "Due", when: "2026-01-01T00:00:00", revision: -1, steps: [{ action: { kind: "text", payload: "hi" } }] }),
    validateRoutine({ id: "rt2", name: "Future", when: "2099-01-01T00:00:00", revision: -1, steps: [{ action: { kind: "text", payload: "hi" } }] }),
  ];
  const due = planDay(routines, Date.now());
  if (due.length !== 1) throw new Error(`expected 1 due, got ${due.length}`);
});

await test("RH-04 · describeSchedule gives a compact summary", { "RH-04": "full" }, () => {
  const r = validateRoutine({ id: "rt1", name: "Test", when: "2026-01-01T00:00:00", revision: -1, steps: [{ action: { kind: "text", payload: "hi" } }] });
  const s = describeSchedule([r], Date.now());
  if (!s.includes("1 routine")) throw new Error(`should mention count: ${s}`);
});

// ── Routing (CO-03) ───────────────────────────────────────────────────────────
await test("CO-03 · route allows same-origin direct fetch", { "CO-03": "full" }, () => {
  const v = route({ url: "https://localhost:3000/api/test", method: "GET" }, shellManifest);
  if (!v.ok) throw new Error(`should allow localhost: ${v.reason}`);
  if (v.route !== "direct") throw new Error(`should be direct: ${v.route}`);
});

await test("CO-03 · route blocks non-HTTP protocols", { "CO-03": "full" }, () => {
  const v = route({ url: "file:///etc/passwd", method: "GET" }, shellManifest);
  if (v.ok) throw new Error("should block file:// protocol");
});

await test("CO-03 · route blocks URLs with credentials", { "CO-03": "full" }, () => {
  const v = route({ url: "https://user:pass@example.com/", method: "GET" }, shellManifest);
  if (v.ok) throw new Error("should block credentials in URL");
});

await test("CO-03 · route proxies cross-origin HTTPS", { "CO-03": "full" }, () => {
  const v = route({ url: "https://example.com/file", method: "GET" }, moduleManifest("store", ["example.com"]));
  if (!v.ok) throw new Error(`should allow example.com: ${v.reason}`);
  if (v.route !== "proxy") throw new Error(`should proxy: ${v.route}`);
});

await test("CO-03 · route rejects GET with body", { "CO-03": "full" }, () => {
  const v = route({ url: "https://localhost/api", method: "GET", bodyBytes: 100 }, shellManifest);
  if (v.ok) throw new Error("should reject GET with body");
});

await test("CO-03 · route rejects oversized POST body", { "CO-03": "full" }, () => {
  const v = route({ url: "https://localhost/api", method: "POST", bodyBytes: 500000 }, shellManifest);
  if (v.ok) throw new Error("should reject oversized body");
});

await test("CO-03 · route rejects host not in manifest", { "CO-03": "full" }, () => {
  const v = route({ url: "https://evil.com/file", method: "GET" }, moduleManifest("store", ["allowed.com"]));
  if (v.ok) throw new Error("should reject host not in manifest");
});

await test("CO-03 · describeVerdict gives a one-line summary", { "CO-03": "full" }, () => {
  const v = route({ url: "https://localhost/api", method: "GET" }, shellManifest);
  const s = describeVerdict(v);
  if (!s.includes("direct")) throw new Error(`should mention route: ${s}`);
});

// ── Locks (SH-06) ─────────────────────────────────────────────────────────────
await test("SH-16 · leaseFor creates a valid lease", { "SH-16": "full" }, () => {
  const l = leaseFor("/Documents/Shared.md", "tab-abc", "identity123", Date.now());
  if (l.owner !== "tab-abc") throw new Error("wrong owner");
  if (l.identity !== "identity123") throw new Error("wrong identity");
  if (l.revision !== 0) throw new Error("should start at revision 0");
});

await test("SH-16 · claim succeeds when no lease exists", { "SH-16": "full" }, () => {
  const candidate = leaseFor("/Documents/Shared.md", "me", "ident12345", Date.now());
  const r = claim(null, candidate, Date.now());
  if (r.state !== "acquired") throw new Error(`should acquire: ${r.reason}`);
});

await test("SH-16 · claim fails when another tab holds the lease", { "SH-16": "full" }, () => {
  const held = leaseFor("/Documents/Shared.md", "other", "ident00001", Date.now());
  const candidate = leaseFor("/Documents/Shared.md", "me", "ident99999", Date.now());
  const r = claim(held, candidate, Date.now());
  if (r.state !== "waiting") throw new Error(`should wait: ${r.state}`);
});

await test("SH-16 · renew by non-holder is denied", { "SH-16": "full" }, () => {
  const held = leaseFor("/Documents/Shared.md", "other", "ident00001", Date.now());
  const r = renew(held, "ident99999", Date.now());
  if (r.state !== "denied") throw new Error(`should deny: ${r.state}`);
});

await test("SH-16 · expired lease can be claimed", { "SH-16": "full" }, () => {
  const expired = leaseFor("/Documents/Shared.md", "other", "ident00001", Date.now() - 100000);
  expired.expiresAt = Date.now() - 1; // force expiry
  const candidate = leaseFor("/Documents/Shared.md", "me", "ident99999", Date.now());
  const r = claim(expired, candidate, Date.now());
  if (r.state !== "acquired") throw new Error(`should acquire expired lease: ${r.state}`);
});

await test("SH-16 · checkHeartbeat rejects wrong identity", { "SH-16": "full" }, () => {
  const l = leaseFor("/Documents/Shared.md", "me", "ident12345", Date.now());
  const hb = { id: "hb1", identity: "ident99999", at: Date.now() };
  const r = checkHeartbeat(l, hb, Date.now());
  if (r.ok) throw new Error("should reject wrong identity");
});

// ── Window groups (WM-02) ────────────────────────────────────────────────────
await test("WM-20 · makeGroup validates member count", { "WM-20": "full" }, () => {
  const g = makeGroup("g-test", "Test", ["w-1", "w-2"], Date.now());
  if (g.name !== "Test") throw new Error("wrong name");
  if (g.memberIds.length !== 2) throw new Error("wrong member count");
});

await test("WM-20 · makeGroup rejects duplicate members", { "WM-20": "full" }, () => {
  try {
    makeGroup("g-test", "Test", ["w-1", "w-1"], Date.now());
    throw new Error("should reject duplicate members");
  } catch (e) {
    if (!(e instanceof Error) || !/twice/.test(e.message)) throw e;
  }
});

await test("WM-20 · minimizeGroup sets minimised on all members", { "WM-20": "full" }, () => {
  const g = makeGroup("g-test", "Test", ["w-1", "w-2"], Date.now());
  const wins = [{ id: "w-1", app: "editor", title: "A", x: 0, y: 0, w: 800, h: 600, z: 1, minimised: false }, { id: "w-2", app: "browser", title: "B", x: 0, y: 0, w: 800, h: 600, z: 2, minimised: false }];
  const r = minimizeGroup(wins, g);
  if (r.windows[0].minimised !== true) throw new Error("member 1 should be minimised");
  if (r.windows[1].minimised !== true) throw new Error("member 2 should be minimised");
  if (r.op.affected !== 2) throw new Error(`expected 2 affected, got ${r.op.affected}`);
});

await test("WM-20 · closeGroup removes members", { "WM-20": "full" }, () => {
  const g = makeGroup("g-test", "Test", ["w-1", "w-2"], Date.now());
  const wins = [{ id: "w-1", app: "editor", title: "A", x: 0, y: 0, w: 800, h: 600, z: 1, minimised: false }, { id: "w-2", app: "browser", title: "B", x: 0, y: 0, w: 800, h: 600, z: 2, minimised: false }, { id: "w-3", app: "notes", title: "C", x: 0, y: 0, w: 800, h: 600, z: 3, minimised: false }];
  const r = closeGroup(wins, g);
  if (r.windows.length !== 1) throw new Error(`expected 1 remaining, got ${r.windows.length}`);
  if (r.op.affected !== 2) throw new Error(`expected 2 affected, got ${r.op.affected}`);
});

await test("WM-20 · layoutGroup positions members without moving others", { "WM-20": "full" }, () => {
  const g = makeGroup("g-test", "Test", ["w-1", "w-2"], Date.now());
  const wins = [{ id: "w-1", app: "editor", title: "A", x: 0, y: 0, w: 800, h: 600, z: 1, minimised: false }, { id: "w-2", app: "browser", title: "B", x: 100, y: 100, w: 800, h: 600, z: 2, minimised: false }];
  const r = layoutGroup(g, wins, "stack", { w: 1200, h: 700 });
  if ("refused" in r) throw new Error(`should layout: ${r.refused}`);
  if (r.applied.length !== 2) throw new Error(`expected 2 placed, got ${r.applied.length}`);
});

await test("WM-20 · summarize groups members by app", { "WM-20": "full" }, () => {
  const g = makeGroup("g-test", "Test", ["w-1", "w-2"], Date.now());
  const wins = [{ id: "w-1", app: "editor", title: "A", x: 0, y: 0, w: 800, h: 600, z: 1, minimised: false }, { id: "w-2", app: "editor", title: "B", x: 0, y: 0, w: 800, h: 600, z: 2, minimised: false }];
  const s = summarize(g, wins);
  if (s.count !== 2) throw new Error(`expected count 2, got ${s.count}`);
  if (s.apps.length !== 1) throw new Error(`expected 1 app, got ${s.apps.length}`);
});

// ── Input profiles (ST-09) ───────────────────────────────────────────────────
await test("ST-18 · all four profiles exist with valid hit sizes", { "ST-18": "full" }, () => {
  for (const key of ["precision", "pointer-large", "touch", "keyboard-only"] as const) {
    const p = PROFILES[key];
    if (p.hitPx < 44) throw new Error(`${key} hit too small: ${p.hitPx}`);
    if (!p.reason) throw new Error(`${key} missing reason`);
  }
});

await test("ST-18 · touch profile does not apply on mouse pointer", { "ST-18": "full" }, () => {
  const touch = profileFor("touch");
  if (canApply(touch, "mouse")) throw new Error("touch profile should not apply on mouse");
});

await test("ST-18 · precision profile applies on mouse", { "ST-18": "full" }, () => {
  const p = profileFor("precision");
  if (!canApply(p, "mouse")) throw new Error("precision should apply on mouse");
});

await test("ST-18 · mismatchReason explains the refusal", { "ST-18": "full" }, () => {
  const touch = profileFor("touch");
  const reason = mismatchReason(touch, "mouse");
  if (!reason.toLowerCase().includes("touch")) throw new Error(`reason should mention touch: ${reason}`);
});

await test("ST-18 · needsTimedGesture detects timed profiles", { "ST-18": "full" }, () => {
  const touch = profileFor("touch");
  if (!needsTimedGesture(touch)) throw new Error("touch should need timed gesture");
  const precision = profileFor("precision");
  if (needsTimedGesture(precision)) throw new Error("precision should not need timed gesture");
});

finish();
