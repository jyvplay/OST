/**
 * TT140 — CA-08, LN-12, SC-06, PR-07p, PR-07s.
 *
 * Five capabilities that are mostly POLICY, so the tests attack the policy:
 * a screen chooser that picks the same screen twice, a capture guard that
 * overclaims, a filter that blocks the wrong host, a cast button that appears
 * on something it cannot cast. Each test names the failure it would catch.
 */
import { makeHarness } from "./harness.mts";
import {
  chooseTargetScreen, placementFor, verifyPlacement, placementCaveats,
  presenterLayout, moveCamera, overlapWith, describePresenter, presenterMonitorRects,
  PRESENTER_DEFAULTS, type ScreenInfo, type PresenterConfig,
} from "../src/lib/cast/second-screen.ts";
import {
  protectionFor, createCaptureWatch, beginCapture, endCapture, anyLiveCapture,
  windowsToLock, windowsToBlank, mayAppearInCapture, captureSources,
  readTrackSettings, captureStatement,
} from "../src/lib/privacy/capture-guard.ts";
import {
  createFilterPolicy, checkNavigation, buildCsp, filterCapabilityReport,
  validateRule, normalizeHost, castabilityOf, castSummary, type MediaElementInfo,
} from "../src/lib/browser/content-filter.ts";

const { test, finish } = makeHarness("tt140-cast-privacy");

const screen = (label: string, x: number, w: number, h: number, extra: Partial<ScreenInfo> = {}): ScreenInfo => ({
  label, availLeft: x, availTop: 0, availWidth: w, availHeight: h, ...extra,
});

// ══ CA-08 · second-screen placement ══════════════════════════════════════

await test("CA-08 · the target is a screen that is NOT the current one", { "CA-08": "full" }, () => {
  // The classic bug: taking screens[1] picks the laptop panel when the browser
  // happens to list the external display first.
  const screens = [screen("External", 1920, 2560, 1440), screen("Laptop", 0, 1440, 900, { isCurrent: true })];
  const v = chooseTargetScreen(screens);
  if (!v.ok) throw new Error(`refused a two-screen desk: ${v.reason}`);
  if (v.screen.label !== "External") throw new Error(`chose ${v.screen.label}, not the external display`);
  if (v.kind !== "extended") throw new Error("kind must be extended");
  // And with the order reversed it must still pick External.
  const reversed = chooseTargetScreen([...screens].reverse());
  if (!reversed.ok || reversed.screen.label !== "External") throw new Error("result depends on list order");
});

await test("CA-08 · a mirrored desk is refused, not mislabelled", { "CA-08": "full" }, () => {
  // Mirroring produces two entries describing the same desktop. Opening a
  // window there and calling it an extended display is a lie.
  const mirrored = chooseTargetScreen([screen("A", 0, 1920, 1080, { isCurrent: true }), screen("B", 0, 1920, 1080, { isCurrent: true })]);
  if (mirrored.ok) throw new Error("a mirrored desk was reported as extended");
  if (mirrored.kind !== "mirrored") throw new Error(`kind ${mirrored.kind}`);
  if (!/mirror/i.test(mirrored.reason)) throw new Error(`reason must name the cause: ${mirrored.reason}`);
  const single = chooseTargetScreen([screen("Only", 0, 1920, 1080, { isCurrent: true })]);
  if (single.ok) throw new Error("one screen was reported as extended");
  const none = chooseTargetScreen([]);
  if (none.ok || none.kind !== "none") throw new Error("empty screen list accepted");
  if (!/permission|grant/i.test(none.hint)) throw new Error(`hint must say what to do: ${none.hint}`);
});

await test("CA-08 · among several candidates the largest usable area wins", { "CA-08": "full" }, () => {
  const screens = [
    screen("Laptop", 0, 1440, 900, { isCurrent: true }),
    screen("Small", 1440, 1280, 720),
    screen("Studio", 2720, 3840, 2160),
    screen("Projector", 6560, 1024, 768),
  ];
  const v = chooseTargetScreen(screens);
  if (!v.ok || v.screen.label !== "Studio") throw new Error(`chose ${v.ok ? v.screen.label : v.reason}`);
});

await test("CA-08 · the window request uses usable area and absolute coordinates", { "CA-08": "full" }, () => {
  const s = screen("Ext", 1920, 2560, 1400);
  const w = placementFor(s);
  if (w.left !== 1920 || w.top !== 0) throw new Error(`position ${w.left},${w.top}`);
  if (w.width !== 2560 || w.height !== 1400) throw new Error(`size ${w.width}×${w.height}`);
  if (!w.features.includes("popup=1")) throw new Error("without popup=1 the browser opens a tab and ignores geometry");
  if (!w.features.includes("left=1920")) throw new Error(`features ${w.features}`);
  if (w.features.includes("noopener")) throw new Error("noopener would drop the handle needed to close the display");
  // Extreme geometry must be clamped to something openable.
  const tiny = placementFor(screen("Tiny", -5000, 10, 10));
  if (tiny.width < 320 || tiny.height < 240) throw new Error("a degenerate screen produced an unopenable window");
});

await test("CA-08 · placement is verified, and a mismatch is reported not hidden", { "CA-08": "full" }, () => {
  const want = placementFor(screen("Ext", 1920, 1920, 1080));
  const good = verifyPlacement(want, { screenX: 1920, screenY: 0, outerWidth: 1922, outerHeight: 1080 });
  if (!good.ok) throw new Error(`honest placement reported as failure: ${good.detail}`);
  // 4 px of chrome difference is inside tolerance.
  const closeEnough = verifyPlacement(want, { screenX: 1924, screenY: 3, outerWidth: 1924, outerHeight: 1084 });
  if (!closeEnough.ok) throw new Error("tolerance too tight for window chrome");
  const wrongScreen = verifyPlacement(want, { screenX: 0, screenY: 0, outerWidth: 1920, outerHeight: 1080 });
  if (wrongScreen.ok) throw new Error("a window on the wrong screen was reported as placed");
  if (!/not obliged/.test(wrongScreen.detail)) throw new Error(`detail must state the limit: ${wrongScreen.detail}`);
  // Unknown geometry must not be reported as success or failure.
  const unknown = verifyPlacement(want, {});
  if (!unknown.ok) throw new Error("absent geometry should not be treated as a mismatch");
});

await test("CA-08 · caveats name the things that actually go wrong", { "CA-08": "full" }, () => {
  const screens = [
    screen("Laptop", 0, 1440, 900, { isCurrent: true, devicePixelRatio: 2 }),
    screen("Ext", 1440, 1920, 1080, { devicePixelRatio: 1 }),
  ];
  const caveats = placementCaveats(screens, screens[1]);
  if (!caveats.some((c) => /scale/i.test(c))) throw new Error("mixed DPI must be warned about");
  const three = placementCaveats([...screens, screen("Third", 3360, 1920, 1080)], screens[1]);
  if (!three.some((c) => /3 displays/.test(c))) throw new Error("a third display must be mentioned");
  const tiny = screen("Tiny", 1440, 640, 480);
  const small = placementCaveats([screens[0], tiny], tiny);
  if (!small.some((c) => /narrow/.test(c))) throw new Error("a 640 px target must be called narrow");
});

// ══ LN-12 · presenter layout ═════════════════════════════════════════════

await test("LN-12 · picture-in-picture keeps the camera ratio and stays on screen", { "LN-12": "full" }, () => {
  const out = { width: 1920, height: 1080 };
  const cam = { width: 640, height: 480 }; // 4:3
  const l = presenterLayout(out, cam);
  if (!l.camera || !l.slides) throw new Error("PiP must produce both rects");
  const wantH = Math.round(l.camera.width * (480 / 640));
  if (l.camera.height !== wantH) throw new Error(`camera squashed: ${l.camera.width}×${l.camera.height}, expected height ${wantH}`);
  if (l.camera.x < 0 || l.camera.y < 0) throw new Error("camera off-canvas");
  if (l.camera.x + l.camera.width > out.width || l.camera.y + l.camera.height > out.height) throw new Error("camera overflows the output");
  if (l.slides.width !== out.width) throw new Error("slides must stay full-frame behind a PiP");
  if (l.cameraOnly) throw new Error("PiP is not camera-only");
  // Every corner puts the box in a different quadrant.
  const seen = new Set<string>();
  for (const corner of ["bottom-right", "bottom-left", "top-right", "top-left"] as const) {
    const r = presenterLayout(out, cam, { corner });
    const key = `${r.camera!.x < out.width / 2 ? "L" : "R"}${r.camera!.y < out.height / 2 ? "T" : "B"}`;
    seen.add(key);
  }
  if (seen.size !== 4) throw new Error(`corners collapse: ${[...seen].join(",")}`);
});

await test("LN-12 · invalid presenter settings are refused, not clamped silently", { "LN-12": "full" }, () => {
  const out = { width: 1920, height: 1080 }, cam = { width: 640, height: 480 };
  for (const bad of [{ scale: 0.05 }, { scale: 0.9 }, { margin: -0.1 }, { margin: 0.5 }] as Partial<PresenterConfig>[]) {
    let threw = false;
    try { presenterLayout(out, cam, bad); } catch { threw = true; }
    if (!threw) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
  let threw = false;
  try { presenterLayout({ width: 0, height: 1080 }, cam); } catch { threw = true; }
  if (!threw) throw new Error("zero-size output accepted");
});

await test("LN-12 · camera-only, green-screen and off are three distinct states", { "LN-12": "full" }, () => {
  const out = { width: 1280, height: 720 }, cam = { width: 640, height: 480 };
  const off = presenterLayout(out, cam, { mode: "off" });
  if (off.camera !== null || off.slides?.width !== out.width) throw new Error("off must show slides only");
  if (!/off/i.test(describePresenter({ ...PRESENTER_DEFAULTS, mode: "off" }, off))) throw new Error("off not described");

  const only = presenterLayout(out, cam, { mode: "camera-only" });
  if (!only.cameraOnly || only.slides !== null) throw new Error("camera-only must hide the slides");
  if (only.camera?.width !== out.width) throw new Error("camera-only must fill the frame");

  const key = presenterLayout(out, cam, { mode: "green-screen" });
  // A keyed source is not a picture: returning a rect for it would be a lie.
  if (key.camera !== null) throw new Error("green-screen must not return a camera rectangle");
  if (key.slides?.width !== out.width) throw new Error("green-screen keeps the slides");
  if (!key.warnings.some((w) => /chroma|key/i.test(w))) throw new Error("green-screen must explain what it expects downstream");
});

await test("LN-12 · side-by-side gives the presenter a usable column or says it will not", { "LN-12": "full" }, () => {
  const big = presenterLayout({ width: 1920, height: 1080 }, { width: 640, height: 480 }, { mode: "side-by-side" });
  if (!big.slides || !big.camera) throw new Error("side-by-side must produce both");
  if (big.slides.width + big.camera.width !== 1920) throw new Error("side-by-side must not overlap or leave a gap");
  if (big.camera.x !== big.slides.width) throw new Error("the camera column must start where the slides end");
  if (big.camera.height > 1080) throw new Error("camera column taller than the output");
  // A narrow output makes the column a thumbnail, and that must be said.
  const small = presenterLayout({ width: 640, height: 480 }, { width: 640, height: 480 }, { mode: "side-by-side" });
  if (!small.warnings.some((w) => /thumbnail|narrow/i.test(w))) throw new Error("a 192 px column must warn");
});

await test("LN-12 · the cutout can be moved and its overlap with content is measured", { "LN-12": "full" }, () => {
  const out = { width: 1920, height: 1080 };
  const base = presenterLayout(out, { width: 640, height: 480 }).camera!;
  const moved = moveCamera(base, out, "top-left", 0.02);
  if (moved.width !== base.width || moved.height !== base.height) throw new Error("moving must not resize");
  if (moved.x >= base.x) throw new Error("moving to the left corner did not move it left");

  // A subtitle band across the bottom must collide with a bottom-right cutout.
  const subtitle = { x: 0, y: 1000, width: 1920, height: 80 };
  const hit = overlapWith(presenterLayout(out, { width: 640, height: 480 }, { corner: "bottom-right" }).camera!, subtitle);
  if (!hit.overlaps) throw new Error("a bottom-right cutout was reported clear of the subtitle band");
  const clear = overlapWith(moved, subtitle);
  if (clear.overlaps) throw new Error("a top-left cutout was reported over the subtitle band");
  if (clear.area !== 0) throw new Error("no overlap must be zero area");
});

await test("LN-12 · the presenter monitor is four separate rects that do not overlap", { "LN-12": "full" }, () => {
  const out = { width: 1600, height: 900 };
  const m = presenterMonitorRects(out);
  const rects = [m.current, m.next, m.notes, m.clock];
  for (const r of rects) {
    if (r.x < 0 || r.y < 0 || r.x + r.width > out.width || r.y + r.height > out.height) {
      throw new Error(`monitor rect outside the output: ${JSON.stringify(r)}`);
    }
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlapWith(rects[i], rects[j]).overlaps) throw new Error("monitor panes overlap");
    }
  }
});

// ══ SC-06 · capture exclusion ════════════════════════════════════════════

await test("SC-06 · the protection statement never claims more than the platform allows", { "SC-06": "full" }, () => {
  // The whole point of this row is honesty, so the test IS the honesty check.
  for (const level of ["private", "secret"] as const) {
    const p = protectionFor(level);
    if (p.doesNotProtectAgainst.length === 0) throw new Error(`${level} claims to protect against everything`);
    const joined = p.doesNotProtectAgainst.join(" ");
    if (!/another application|recorder|capture card/i.test(joined)) {
      throw new Error(`${level} must admit an outside recorder can still see the screen`);
    }
    if (!/already transmitted|frames already/i.test(joined)) {
      throw new Error(`${level} must admit that frames already sent cannot be recalled`);
    }
    if (/FLAG_SECURE|guarantee|prevents capture/i.test(p.statement)) {
      throw new Error(`${level} statement uses a claim the web cannot make: ${p.statement}`);
    }
  }
  const pub = protectionFor("public");
  if (pub.doesNotProtectAgainst.length !== 0) throw new Error("a public window has nothing to disclaim");
  if (pub.excludedFromOurCapture) throw new Error("a public window must appear in our own captures");
});

await test("SC-06 · our own capture excludes private windows, always", { "SC-06": "full" }, () => {
  // This is the one real guarantee: the compositor is ours.
  if (mayAppearInCapture("private")) throw new Error("a private window was allowed into our capture");
  if (mayAppearInCapture("secret")) throw new Error("a secret window was allowed into our capture");
  if (!mayAppearInCapture("public")) throw new Error("a public window was excluded");
  const windows = [
    { id: "files", sensitivity: "public" as const },
    { id: "vault", sensitivity: "private" as const },
    { id: "keys", sensitivity: "secret" as const },
  ];
  const sources = captureSources(windows);
  if (sources.includes("vault") || sources.includes("keys")) throw new Error(`capture included a sensitive window: ${sources}`);
  if (sources.length !== 1 || sources[0] !== "files") throw new Error(`sources ${sources}`);
});

await test("SC-06 · locks and blanks fire on a live capture and clear when it ends", { "SC-06": "full" }, () => {
  let w = createCaptureWatch();
  const windows = [
    { id: "vault", sensitivity: "private" as const },
    { id: "keys", sensitivity: "secret" as const },
    { id: "notes", sensitivity: "public" as const },
  ];
  if (anyLiveCapture(w) !== null) throw new Error("a fresh watch claims a capture");
  if (windowsToLock(w, windows).length !== 0) throw new Error("locks fired with no capture");

  const begun = beginCapture(w, { source: "self", surface: "screen", startedAt: 100 });
  w = begun.watch;
  const locked = windowsToLock(w, windows);
  if (locked.length !== 2 || !locked.includes("vault") || !locked.includes("keys")) throw new Error(`locked ${locked}`);
  const blanked = windowsToBlank(w, windows);
  if (blanked.length !== 1 || blanked[0] !== "keys") throw new Error(`blanked ${blanked}, only secret windows blank`);
  if (anyLiveCapture(w)?.id !== begun.session.id) throw new Error("live session not reported");

  w = endCapture(w, begun.session.id);
  if (anyLiveCapture(w) !== null) throw new Error("an ended capture still counts as live");
  if (windowsToLock(w, windows).length !== 0) throw new Error("locks persist after capture ends");
  if (windowsToBlank(w, windows).length !== 0) throw new Error("blanks persist after capture ends");
});

await test("SC-06 · an unreported surface is unknown, not assumed safe", { "SC-06": "full" }, () => {
  const known = readTrackSettings({ displaySurface: "monitor" });
  if (!known.confident || known.surface !== "monitor") throw new Error("a reported surface was not read");
  const browser = readTrackSettings({ displaySurface: "browser" });
  if (browser.surface !== "browser") throw new Error("browser surface lost");
  const unknown = readTrackSettings({});
  if (unknown.surface !== "unknown" || unknown.confident) throw new Error("an unreported surface must be unknown and unconfident");
  if (!/unknown|not.*safe/i.test(unknown.note)) throw new Error(`note must warn: ${unknown.note}`);
});

await test("SC-06 · the summary sentence states the limit in the same breath", { "SC-06": "full" }, () => {
  let w = createCaptureWatch();
  const windows = [{ id: "vault", sensitivity: "private" as const }];
  const idle = captureStatement(w, windows);
  if (!/no capture/i.test(idle)) throw new Error(`idle statement: ${idle}`);
  const begun = beginCapture(w, { source: "self", surface: "window" });
  w = begun.watch;
  const active = captureStatement(w, windows);
  if (!/active/i.test(active)) throw new Error(`active statement: ${active}`);
  if (!/not hidden|outside this app/i.test(active)) throw new Error(`statement must admit the outside case: ${active}`);
});

// ══ PR-07p · content filtering ═══════════════════════════════════════════

await test("PR-07p · rules match hosts exactly, never substrings", { "PR-07p": "full" }, () => {
  const p = createFilterPolicy([{ host: "ads.example", reason: "Ad network" }]);
  const blocked = checkNavigation(p, "https://ads.example/banner.js");
  if (!blocked.blocked) throw new Error("the listed host was not blocked");
  // The classic blocker bug: substring matching blocks the innocent neighbour.
  const innocent = checkNavigation(p, "https://notads.example/page");
  if (innocent.blocked) throw new Error("a host that merely CONTAINS the rule was blocked");
  const inQuery = checkNavigation(p, "https://good.example/?next=ads.example");
  if (inQuery.blocked) throw new Error("a URL with the host in its query was blocked");
  // Subdomain behaviour follows the flag.
  const sub = checkNavigation(p, "https://cdn.ads.example/x.js");
  if (!sub.blocked) throw new Error("blockSubdomains default must catch cdn.ads.example");
  const noSub = createFilterPolicy([{ host: "ads.example", reason: "Ad network" }], { blockSubdomains: false });
  if (checkNavigation(noSub, "https://cdn.ads.example/x.js").blocked) throw new Error("subdomains blocked with the flag off");
});

await test("PR-07p · allow wins, invalid input is refused, non-http never navigates", { "PR-07p": "full" }, () => {
  // Only the path-scoped rule here: an unscoped rule for the same host would
  // (correctly) match everything, and first-match-wins is the contract.
  const p = createFilterPolicy(
    [{ host: "example.com", pathPrefix: "/private", reason: "Only below /private" }],
    { allow: ["trusted.example.com"] },
  );
  if (checkNavigation(p, "https://example.com/").blocked) throw new Error("a path-scoped rule blocked the root");
  if (!checkNavigation(p, "https://example.com/private/x").blocked) throw new Error("the path rule did not fire");
  // First-match-wins: an unscoped rule listed first blocks everything.
  const ordered = createFilterPolicy([
    { host: "example.com", reason: "Whole host" },
    { host: "example.com", pathPrefix: "/private", reason: "Never reached" },
  ]);
  const first = checkNavigation(ordered, "https://example.com/private/x");
  if (!first.blocked || first.rule?.reason !== "Whole host") throw new Error("rules did not apply in the order they are shown");
  // An allow entry beats a rule even when both match.
  const allowed = checkNavigation(p, "https://trusted.example.com/x");
  if (allowed.blocked) throw new Error("allow list did not win");
  if (allowed.kind !== "explicit-allow") throw new Error(`kind ${allowed.kind}`);
  // Garbage is refused, not guessed at.
  const junk = checkNavigation(p, "not a url");
  if (!junk.blocked || junk.kind !== "invalid") throw new Error("a malformed URL was not refused");
  const js = checkNavigation(p, "javascript:alert(1)");
  if (!js.blocked) throw new Error("a javascript: URL was allowed to navigate");
  const data = checkNavigation(p, "data:text/html,<b>x</b>");
  if (!data.blocked) throw new Error("a data: URL was allowed");
});

await test("PR-07p · rules are validated at construction", { "PR-07p": "full" }, () => {
  const bads = [
    { host: "", reason: "x" },
    { host: "*", reason: "x" },
    { host: "https://example.com/path", reason: "x" },
    { host: "exa mple.com", reason: "x" },
    { host: "example.com", reason: "" },
    { host: "example.com", reason: "r", pathPrefix: "private" },
  ];
  for (const b of bads) {
    if (validateRule(b).length === 0) throw new Error(`rule ${JSON.stringify(b)} passed validation`);
    let threw = false;
    try { createFilterPolicy([b]); } catch { threw = true; }
    if (!threw) throw new Error(`createFilterPolicy accepted ${JSON.stringify(b)}`);
  }
  if (normalizeHost("  .EXAMPLE.com.  ") !== "example.com") throw new Error("host normalisation");
});

await test("PR-07p · the capability report distinguishes enforced from impossible", { "PR-07p": "full" }, () => {
  const report = filterCapabilityReport();
  const enforced = report.filter((r) => r.enforced).map((r) => r.action);
  const impossible = report.filter((r) => !r.enforced).map((r) => r.action);
  if (!enforced.some((a) => /navigate/i.test(a))) throw new Error("navigation refusal must be claimed");
  if (!impossible.some((a) => /cross-origin iframe/i.test(a))) throw new Error("in-frame filtering must be declared impossible");
  if (enforced.some((a) => /inside a cross-origin/i.test(a))) throw new Error("the report claims to filter inside an opaque frame");
  // A CSP that permits everything would make the enforced row false.
  const csp = buildCsp(createFilterPolicy([{ host: "ads.example", reason: "r" }]), { selfOrigin: "https://app.test" });
  if (/\*/.test(csp)) throw new Error(`CSP must not contain a wildcard: ${csp}`);
  if (!/default-src/.test(csp)) throw new Error("CSP missing default-src");
  const empty = buildCsp(createFilterPolicy([]), { selfOrigin: "https://app.test" });
  if (!/default-src/.test(empty)) throw new Error("an empty policy must still emit a CSP");
});

// ══ PR-07s · casting page media ══════════════════════════════════════════

const media = (o: Partial<MediaElementInfo> = {}): MediaElementInfo => ({
  id: "v1", origin: "self", kind: "video", controllable: true,
  remoteApiPresent: true, inOurDocument: true, type: "video/mp4", ...o,
});

await test("PR-07s · media in another document is never offered as castable", { "PR-07s": "full" }, () => {
  const foreign = castabilityOf(media({ inOurDocument: false, origin: "cross-origin" }));
  if (foreign.canCast) throw new Error("offered to cast an element in a foreign document");
  if (!/another document|frame/i.test(foreign.why)) throw new Error(`why: ${foreign.why}`);
  if (!foreign.whatWouldWork.trim()) throw new Error("a refusal must suggest what would work");
});

await test("PR-07s · each blocker produces its own honest reason", { "PR-07s": "full" }, () => {
  const cases: Array<[Partial<MediaElementInfo>, RegExp]> = [
    [{ remoteApiPresent: false }, /no HTMLMediaElement\.remote|Remote Playback/i],
    [{ controllable: false }, /no src|source first/i],
    [{ type: "video/x-matroska" }, /decode|convert/i],
  ];
  for (const [patch, want] of cases) {
    const v = castabilityOf(media(patch));
    if (v.canCast) throw new Error(`castable despite ${JSON.stringify(patch)}`);
    if (!want.test(v.why)) throw new Error(`why for ${JSON.stringify(patch)}: ${v.why}`);
  }
  // Cross-origin media in OUR document is allowed but carries its caveat.
  const xo = castabilityOf(media({ origin: "cross-origin" }));
  if (!xo.canCast) throw new Error("cross-origin media in our own document should be offered");
  if (!/cross-origin|policy/i.test(xo.why)) throw new Error("the caveat must be stated");
  if (castabilityOf(media()).canCast !== true) throw new Error("plain same-origin mp4 must be castable");
});

await test("PR-07s · the per-tab summary counts and explains", { "PR-07s": "full" }, () => {
  const none = castSummary([]);
  if (none.castable !== 0 || !/no media/i.test(none.headline)) throw new Error(`empty: ${none.headline}`);
  const mixed = castSummary([media({ id: "a" }), media({ id: "b", inOurDocument: false }), media({ id: "c", remoteApiPresent: false })]);
  if (mixed.castable !== 1) throw new Error(`castable ${mixed.castable}`);
  if (mixed.blocked.length !== 2) throw new Error(`blocked ${mixed.blocked.length}`);
  if (!mixed.blocked.every((b) => b.why.trim().length > 0)) throw new Error("every blocked element needs a reason");
  if (!/1 of 3/.test(mixed.headline)) throw new Error(`headline ${mixed.headline}`);
  const allBlocked = castSummary([media({ inOurDocument: false })]);
  if (!/none castable/i.test(allBlocked.headline)) throw new Error(`headline ${allBlocked.headline}`);
});

finish();
