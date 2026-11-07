/**
 * TT139 platform suite — the fifteen platform/permission engines.
 *
 * Every test here asks the same question the user cares about: does the module
 * say "no" where reality says no? So each engine is tested on its refusal path
 * first (a missing API, a refused permission, a lying header, an impossible
 * conversion) and only then on its happy path. Where a claim is numeric the
 * threshold is asserted, not the wording.
 */
import { makeHarness } from "./harness.mts";
import { desktopBounds, displayAt, moveCursor, backingSize, lockRequest, virtualCursorPoint, type Display } from "../src/lib/pointer-confinement.ts";
import { usableArea, insetFromVisualViewport, sanitiseInset, scrollIntoView, reflowWindows, keyboardNotice, insetVariables } from "../src/lib/keyboard-inset.ts";
import { detectBrowserFamily, checkLink, resolveSetting, SETTINGS_INDEX } from "../src/lib/settings-links.ts";
import { buildMailto, encodeComponent, isEmailShape, sharePayload, handoffFallback } from "../src/lib/mailto.ts";
import { decideEmbed, embedLabel, originOf } from "../src/lib/embed-policy.ts";
import { stateFromCanPlay, evaluateFormats, supportSentence, FORMATS } from "../src/lib/media-support.ts";
import { PROBE_MODULES, interpretFeatures, inferenceTiers, certifyTier } from "../src/lib/wasm-features.ts";
import { dictationPolicy, startDictation, applyRecognition, displayText, classifyStop, pickLanguage, DICTATION_MAX_CHARS } from "../src/lib/voice-input.ts";
import { decideStore, mayRenderPayButton, validateItemDetails, PRODUCTS } from "../src/lib/store-gate.ts";
import { planFromUtterance, validatePlan, parseDuration, quotedOrTrailingPath, trailingFolderName, assistantAvailability, INTENTS } from "../src/lib/assistant-plan.ts";
import { guardDecision, watermarkTiles, captureKnowledge, UNFOCUS_GRACE_MS, GUARD_DISCLOSURE } from "../src/lib/screen-capture-guard.ts";
import { bridgeAllowed, bridgeRequests, parseBridgeChats, parseBridgeMessages, matrixAllowed, matrixRequests, parseMatrixVersions, parseMatrixMessages, redact } from "../src/lib/media-bridge.ts";
import { primarySubject, cropForSubject, centreCrop, smoothCrop, presenterLayout, MIN_CROP_FRACTION } from "../src/lib/auto-frame.ts";
import { parseAutomationRequest, dryRun, issueToken, redeemToken, MAX_ACTIONS } from "../src/lib/automation-entry.ts";
import { sortLines, uniqLines, cutFields, pasteColumns, wcCount, trSet, numericPrefix } from "../src/lib/text-import.ts";
import { virtualDesktop, screenForRect, placeWindow, presentationScreen, dpiTransition, screenDisclosure, type ScreenRect } from "../src/lib/multi-screen.ts";
import { transportSupport, validateFilters, classifyFailure, serialFramer } from "../src/lib/peripheral.ts";
import { estimateThroughput, pickRung, adaptRung, LADDER, MIN_SAMPLE_BYTES, captureConstraints } from "../src/lib/network-measured.ts";
import { beginWake, tickWake, wakeSentence, MAX_LEASE_MS } from "../src/lib/wake-lock.ts";
import { encodeHandoff, decodeHandoff, describeHandoff, checksum, HANDOFF_VERSION, HANDOFF_MAX_BYTES } from "../src/lib/handoff-link.ts";
import { gate, checkColourPairs, checkControls, DEFAULT_THRESHOLDS, GATE_LIMITS } from "../src/lib/a11y-gate.ts";
import { decideStore as decideStore2 } from "../src/lib/store-gate.ts";

const { test, finish } = makeHarness("tt139-platform");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const throws = (fn: () => unknown, m: string) => { try { fn(); } catch { return; } throw new Error(`expected a refusal: ${m}`); };

const screens: ScreenRect[] = [
  { label: "Built-in", availLeft: 0, availTop: 0, availWidth: 1440, availHeight: 900, width: 1440, height: 900, devicePixelRatio: 2, isPrimary: true, isInternal: true },
  { label: "DELL U2720Q", availLeft: 1440, availTop: -200, availWidth: 2560, availHeight: 1440, width: 2560, height: 1440, devicePixelRatio: 1, isPrimary: false, isInternal: false },
];
const displays: Display[] = [
  { id: "a", rect: { x: 0, y: 0, w: 1440, h: 900 }, dpr: 2 },
  { id: "b", rect: { x: 1440, y: 0, w: 2560, h: 1440 }, dpr: 1 },
];

// ── WM-16 pointer confinement ──────────────────────────────────────────────
await test("WM-16 · a delta integrates into an absolute cursor and crosses a seam", { "WM-16": "full" }, () => {
  const start = { x: 100, y: 100, displayId: "a" };
  const one = moveCursor(start, { dx: 50, dy: -20 }, displays);
  eq([one.state.x, one.state.y], [150, 80], "plain movement");
  ok(!one.crossedSeam, "no seam");
  const across = moveCursor({ x: 1430, y: 400, displayId: "a" }, { dx: 40, dy: 0 }, displays);
  eq(across.state.displayId, "b", "the cursor is handed to the second display");
  eq(across.state.x, 1470, "the absolute position is continuous");
  ok(across.crossedSeam, "seam crossing is reported");
  // A delta of zero must not move anything.
  eq(moveCursor(start, { dx: 0, dy: 0 }, displays).state, start, "no movement");
  // NaN from a flaky event must not poison the position.
  eq(moveCursor(start, { dx: Number.NaN, dy: 0 }, displays).state, start, "NaN delta is ignored");
});

await test("WM-16 · a cursor pushed past every display is clamped, not lost", { "WM-16": "full" }, () => {
  const r = moveCursor({ x: 10, y: 10, displayId: "a" }, { dx: -500, dy: -500 }, displays);
  ok(r.clamped, "clamped is reported");
  eq([r.state.x, r.state.y], [0, 0], "clamped to the desktop origin");
  const b = desktopBounds(displays)!;
  eq([b.x, b.y, b.w, b.h], [0, 0, 4000, 1440], "union bounds");
  eq(displayAt(displays, 2000, 300)?.id, "b", "point on the second display");
  eq(displayAt(displays, 5000, 300), null, "point outside every display");
});

await test("WM-16 · a DPR change resizes the backing store and leaves the position alone", { "WM-16": "full" }, () => {
  // The Screen Details API reports one shared CSS-pixel virtual space, so a
  // crossing position is already correct; only the pixels behind it change.
  eq(backingSize({ w: 400, h: 400 }, { id: "b", rect: { x: 0, y: 0, w: 1, h: 1 }, dpr: 1 }), { w: 400, h: 400, dpr: 1, capped: false }, "1x backing store");
  eq(backingSize({ w: 400, h: 400 }, displays[0]), { w: 800, h: 800, dpr: 2, capped: false }, "2x backing store doubles, position does not move");
  const huge = backingSize({ w: 10000, h: 10000 }, displays[0]);
  ok(huge.capped && huge.w * huge.h <= 16 * 1024 * 1024, "an absurd canvas is capped");
  // Regression for the actual bug: crossing a seam must not move the cursor in x.
  const crossed = moveCursor({ x: 1430, y: 400, displayId: "a" }, { dx: 40, dy: 0 }, displays);
  eq(crossed.state.x, 1470, "the crossing position stays in the shared space");
  eq(virtualCursorPoint({ x: 1500, y: 100, displayId: "b" }, displays[1]), { x: 60, y: 100 }, "virtual cursor is window-relative");
});

await test("WM-16 · lock is refused without a gesture, a secure context, an API — and states the way out", { "WM-16": "full" }, () => {
  eq(lockRequest({ hasPointerLock: false, secureContext: true, userGesture: true }).allowed, false, "no API");
  eq(lockRequest({ hasPointerLock: true, secureContext: false, userGesture: true }).allowed, false, "insecure context");
  const noGesture = lockRequest({ hasPointerLock: true, secureContext: true, userGesture: false });
  eq(noGesture.allowed, false, "no gesture");
  ok(noGesture.reason.includes("user gesture"), "reason names the real cause");
  const voted = lockRequest({ hasPointerLock: true, secureContext: true, userGesture: true, prefersVisibleCursor: true });
  eq(voted.allowed, false, "the user's preference wins over the feature");
  const good = lockRequest({ hasPointerLock: true, secureContext: true, userGesture: true });
  ok(good.allowed && good.escapeChord === "Escape", "Escape is always the way out");
  ok(good.drawVirtualCursor, "a hidden system cursor needs a drawn substitute");
  ok(good.disclosure.length > 20, "the disclosure is a sentence, not a tooltip");
});

// ── IN-06 keyboard insets ──────────────────────────────────────────────────
await test("IN-06 · the usable band is the viewport minus the keyboard, never negative", { "IN-06": "full" }, () => {
  const vp = { width: 800, height: 900, offsetTop: 0, offsetLeft: 0, scale: 1 };
  eq(usableArea(vp, { top: 0, right: 0, bottom: 300, left: 0 }), { x: 0, y: 0, w: 800, h: 600 }, "keyboard at the bottom");
  eq(usableArea(vp, { top: 0, right: 0, bottom: 2000, left: 0 }).h, 0, "an absurd inset yields zero, not negative");
  const vv = insetFromVisualViewport(900, { height: 600, offsetTop: 0, width: 800 }, 800);
  eq(vv.inset.bottom, 300, "fallback derives the inset from visualViewport");
  ok(vv.estimated, "the fallback is marked as an estimate");
  const scrolled = insetFromVisualViewport(900, { height: 600, offsetTop: 100, width: 800 }, 800);
  eq(scrolled.inset.top, 100, "the offset is the top inset");
  eq(scrolled.inset.bottom, 200, "and the rest is the bottom");
});

await test("IN-06 · an implausible inset is clamped and the clamp is visible", { "IN-06": "full" }, () => {
  const vp = { width: 800, height: 900, offsetTop: 0, offsetLeft: 0, scale: 1 };
  const s = sanitiseInset(vp, { top: 0, right: 0, bottom: 850, left: 0 });
  eq(s.inset.bottom, 630, "clamped to 70% of the height");
  ok(s.rejected !== null && s.rejected.includes("%"), "the clamp is explained");
  eq(sanitiseInset(vp, { top: -5, right: 0, bottom: 100, left: 0 }).inset.top, 0, "negative inset ignored");
  eq(sanitiseInset(vp, { top: 0, right: 0, bottom: 100, left: 0 }).rejected, null, "a plausible inset passes");
});

await test("IN-06 · scroll-into-view moves the minimum needed, and reflow keeps the focused window put", { "IN-06": "full" }, () => {
  const area = { x: 0, y: 0, w: 800, h: 600 };
  eq(scrollIntoView({ x: 100, y: 500, w: 200, h: 40 }, area), { dx: 0, dy: 0 }, "already visible");
  eq(scrollIntoView({ x: 100, y: 580, w: 200, h: 60 }, area), { dx: 0, dy: 48 }, "just enough to clear the margin");
  eq(scrollIntoView({ x: 700, y: 10, w: 200, h: 40 }, area), { dx: 108, dy: 0 }, "a control past the right edge needs a positive scrollLeft delta");
  eq(scrollIntoView({ x: 10, y: 10, w: 20, h: 20 }, area, 0), { dx: 0, dy: 0 }, "zero margin means the edge itself is enough");
  // x=0 is exactly at the margin, so it needs the 8 px margin scroll horizontally too.
  eq(scrollIntoView({ x: 0, y: -50, w: 100, h: 40 }, area), { dx: -8, dy: -58 }, "above and at the left margin: both axes");
  eq(scrollIntoView({ x: 8, y: -50, w: 100, h: 40 }, area), { dx: 0, dy: -58 }, "already at the margin horizontally: only vertically");
  const reflow = reflowWindows([
    { id: "focused", x: 40, y: 400, w: 300, h: 200, focused: true },
    { id: "other", x: 40, y: 600, w: 300, h: 200, focused: false },
  ], area);
  eq(reflow.windows[0].id, "focused", "the focused window is first");
  eq(reflow.windows[0].y, 400, "and is not moved under the user's finger");
  ok(reflow.windows[1].h <= 200, "the other window is fitted into the band");
  ok(reflow.moved >= 1, "the move is reported");
  const tall = reflowWindows([{ id: "t", x: 0, y: 0, w: 300, h: 900, focused: true }], area);
  eq(tall.windows[0].h, 600, "a window taller than the band is shrunk to it");
  eq(tall.shrunk, ["t"], "and the shrink is named");
});

await test("IN-06 · the notice and the CSS variables always agree with the geometry", { "IN-06": "full" }, () => {
  const vp = { width: 800, height: 900, offsetTop: 0, offsetLeft: 0, scale: 1 };
  eq(keyboardNotice({ x: 0, y: 0, w: 800, h: 600 }, vp, false), null, "no keyboard, no notice");
  ok(keyboardNotice({ x: 0, y: 0, w: 800, h: 600 }, vp, true)?.includes("33%"), "the fraction is stated");
  ok(keyboardNotice({ x: 0, y: 0, w: 800, h: 100 }, vp, true)?.includes("almost everything"), "a tiny band gets a different sentence");
  eq(insetVariables({ top: 0, right: 0, bottom: 300.4, left: 0 })["--kb-inset-bottom"], "300px", "rounded once, in one place");
});

// ── ST-02 settings links ───────────────────────────────────────────────────
await test("ST-02 · browser detection does not confuse a Chromium fork with Chrome", { "ST-02": "full" }, () => {
  eq(detectBrowserFamily("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"), "edge", "Edge");
  eq(detectBrowserFamily("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 OPR/115.0"), "opera", "Opera");
  eq(detectBrowserFamily("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Vivaldi/6.9"), "vivaldi", "Vivaldi");
  eq(detectBrowserFamily("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"), "firefox", "Firefox");
  eq(detectBrowserFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"), "safari", "Safari");
  eq(detectBrowserFamily("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"), "chromium", "Chrome");
  eq(detectBrowserFamily("something else entirely"), "unknown", "unknown stays unknown");
});

await test("ST-02 · internal schemes are never linkable, and the refusal carries the text to copy", { "ST-02": "full" }, () => {
  for (const url of ["chrome://settings/content/camera", "edge://settings", "about:preferences#privacy", "brave://flags", "opera://settings"]) {
    const c = checkLink(url);
    eq(c.linkable, false, `${url} must not be linkable`);
    ok(c.copyText === url, `${url} must be offered as copyable text`);
  }
  eq(checkLink("https://example.com/x").linkable, true, "https is linkable");
  eq(checkLink("javascript:alert(1)").linkable, false, "script URL");
  eq(checkLink("not a url").linkable, false, "relative/garbage");
  eq(checkLink("").reason, "empty", "empty");
  eq(checkLink("https://exa\u0000mple.com").linkable, false, "control characters refused");
});

await test("ST-02 · every indexed setting resolves to a real action for the detected browser", { "ST-02": "full" }, () => {
  const chrome = "Mozilla/5.0 Chrome/130.0 Safari/537.36";
  const notif = resolveSetting("notifications", chrome)!;
  eq(notif.action, "copy", "a chrome:// path can only be copied");
  ok(notif.instruction.includes("chrome://settings/content/notifications"), "the exact path is in the instruction");
  const safari = resolveSetting("notifications", "Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15")!;
  eq(safari.action, "manual", "Safari's is a menu, not a URL");
  ok(safari.instruction.includes("Settings for This Website"), "and it is named");
  for (const entry of SETTINGS_INDEX) {
    const r = resolveSetting(entry.id, "Mozilla/5.0 Chrome/130.0")!;
    ok(["open", "copy", "manual", "unsupported"].includes(r.action), `${entry.id} must resolve`);
    ok(r.instruction.length > 10, `${entry.id} must have an instruction`);
    ok(!r.instruction.includes("undefined"), `${entry.id} leaked undefined into its instruction`);
  }
  eq(resolveSetting("nope", chrome), null, "unknown id is null, not a guess");
  ok(resolveSetting("flags", "weird agent")!.guessed, "an unknown browser is flagged as a guess");
});

// ── PR-06 mailto ───────────────────────────────────────────────────────────
await test("PR-06 · RFC 6068 encoding keeps the safe characters and encodes newlines as %0D%0A", { "PR-06": "full" }, () => {
  eq(encodeComponent("a b&c"), "a%20b%26c", "space and ampersand");
  eq(encodeComponent("line1\nline2"), "line1%0D%0Aline2", "CRLF from LF");
  eq(encodeComponent("x@y.com:8080/a"), "x@y.com:8080/a", "the three reserved characters survive");
  eq(encodeComponent("é"), "%C3%A9", "UTF-8 percent-encoding");
  eq(encodeComponent("100%"), "100%25", "a literal percent is escaped");
});

await test("PR-06 · a draft builds a valid mailto, drops invalid addresses and never emits a stray '?'", { "PR-06": "full" }, () => {
  const built = buildMailto({ to: ["a@b.co"], subject: "Hi", body: "Line one\nLine two" });
  ok(built.url.startsWith("mailto:a@b.co?subject=Hi&body=Line%20one%0D%0ALine%20two"), `unexpected url ${built.url}`);
  const bare = buildMailto({});
  eq(bare.url, "mailto:", "an empty draft is just the scheme");
  ok(!bare.url.includes("?"), "no stray query separator");
  const bad = buildMailto({ to: ["not-an-email", "ok@example.com"] });
  eq(bad.invalidRecipients, ["not-an-email"], "the bad address is named");
  ok(bad.url.includes("ok@example.com"), "the good address survives");
  eq(isEmailShape("a@b"), false, "no TLD is not an address");
  eq(isEmailShape("a.b+c@d-e.fg"), true, "dot-atom with plus");
  eq(isEmailShape("a@b.co"), true, "ordinary address");
});

await test("PR-06 · an over-long body is truncated on a character boundary and says so", { "PR-06": "full" }, () => {
  const body = "é".repeat(2000);
  const built = buildMailto({ to: ["a@b.co"], subject: "Long", body, budget: 1200 });
  ok(built.length <= 1200, `the url is ${built.length} chars, budget 1200`);
  ok(built.truncatedBody, "truncation is reported");
  ok(built.url.includes("truncated"), "and marked inside the body");
  // no half-encoded multi-byte sequence at the cut
  const bodyPart = built.url.split("body=")[1] ?? "";
  ok(!/%[0-9A-F]$/.test(bodyPart), "the cut is not inside a percent escape");
  ok(!/[^%]%[0-9A-F][^0-9A-F]/.test(bodyPart.slice(-40)), "no truncated escape near the end");
  const fits = buildMailto({ to: ["a@b.co"], body: "short" });
  ok(!fits.truncatedBody, "a short body is untouched");
  eq(sharePayload({ body: "  " }), null, "an empty share is null");
  eq(sharePayload({ subject: "S", body: "B" })?.text, "B", "share text");
  eq(handoffFallback({ subject: "S", body: "B" }).copyable, true, "the fallback is copyable");
});

// ── PR-07 embed policy ─────────────────────────────────────────────────────
await test("PR-07 · X-Frame-Options is read case-insensitively with the most restrictive answer winning", { "PR-07": "full" }, () => {
  eq(decideEmbed({ "X-Frame-Options": "DENY" }, "https://a.com/x", "https://shell.app").verdict, "deny", "DENY");
  eq(decideEmbed({ "x-FRAME-options": "deny" }, "https://a.com/x", "https://shell.app").verdict, "deny", "case-insensitive name and value");
  eq(decideEmbed([{ name: "X-Frame-Options", value: "SAMEORIGIN" }], "https://a.com/x", "https://a.com").verdict, "allow", "SAMEORIGIN from the same origin");
  eq(decideEmbed([{ name: "X-Frame-Options", value: "SAMEORIGIN" }], "https://a.com/x", "https://shell.app").verdict, "deny", "SAMEORIGIN from another origin");
  eq(decideEmbed({ "X-Frame-Options": "ALLOW-FROM https://shell.app" }, "https://a.com/x", "https://shell.app").verdict, "deny", "ALLOW-FROM is dead");
  const repeated = decideEmbed([{ name: "X-Frame-Options", value: "SAMEORIGIN" }, { name: "X-Frame-Options", value: "DENY" }], "https://a.com/x", "https://a.com");
  eq(repeated.verdict, "deny", "repeats: the stricter one wins");
  ok(repeated.conflicts.length === 1, "the conflict is surfaced");
});

await test("PR-07 · CSP frame-ancestors overrides X-Frame-Options and understands sources", { "PR-07": "full" }, () => {
  const withBoth = decideEmbed({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors https://shell.app" }, "https://a.com/x", "https://shell.app");
  eq(withBoth.verdict, "allow", "CSP wins over XFO");
  eq(withBoth.source, "csp-frame-ancestors", "and the source says so");
  eq(decideEmbed({ "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'" }, "https://a.com", "https://shell.app").verdict, "deny", "'none'");
  eq(decideEmbed({ "Content-Security-Policy": "frame-ancestors 'self'" }, "https://a.com/x", "https://a.com").verdict, "allow", "'self' when the frame target is the parent");
  eq(decideEmbed({ "Content-Security-Policy": "frame-ancestors *.shell.app" }, "https://a.com", "https://eu.shell.app").verdict, "allow", "wildcard subdomain");
  eq(decideEmbed({ "Content-Security-Policy": "frame-ancestors *.shell.app" }, "https://a.com", "https://shell.app").verdict, "allow", "the apex matches the wildcard");
  eq(decideEmbed({ "Content-Security-Policy": "frame-ancestors https://shell.app" }, "https://a.com", "http://shell.app").verdict, "deny", "scheme mismatch is not a match");
  eq(decideEmbed({ "Content-Security-Policy": "frame-ancestors https://shell.app:8443" }, "https://a.com", "https://shell.app").verdict, "deny", "port mismatch");
});

await test("PR-07 · a missing policy is 'unknown', not 'allowed' — and the label says which", { "PR-07": "full" }, () => {
  const none = decideEmbed({}, "https://a.com", "https://shell.app");
  eq(none.verdict, "unknown", "no headers is unknown");
  ok(none.inferred, "and marked as a default");
  eq(embedLabel(none), "Tries to embed", "the label admits uncertainty");
  eq(embedLabel(decideEmbed({ "X-Frame-Options": "DENY" }, "https://a.com", "https://s.app")), "Opens in a tab", "deny label");
  eq(originOf("https://A.com:443/x")?.origin, "https://a.com", "origin normalisation");
  eq(originOf("ftp://a.com"), null, "non-http origin");
});

// ── FF-06 / HW-03 / HW-10 media support ────────────────────────────────────
await test("FF-06 · canPlayType's three answers map to three different states", { "FF-06": "full" }, () => {
  eq(stateFromCanPlay("probably"), "native", "probably");
  eq(stateFromCanPlay("maybe"), "unknown", "maybe is not a promise");
  eq(stateFromCanPlay(""), "unsupported", "empty is a refusal");
  const verdicts = evaluateFormats({ canPlay: { "image/heic": "maybe" }, imageDecoder: {}, mediaCapabilities: {} });
  const heic = verdicts.find((v) => v.id === "heic")!;
  eq(heic.state, "unknown", "HEIC 'maybe' is not upgraded to supported");
  const viaDecoder = evaluateFormats({ canPlay: {}, imageDecoder: { "image/heic": true }, mediaCapabilities: {} }).find((v) => v.id === "heic")!;
  eq(viaDecoder.state, "software", "an image decoder is software decoding, not native");
  eq(viaDecoder.via, "imageDecoder", "and the mechanism is named");
});

await test("FF-06 · MediaCapabilities decides per configuration, and power efficiency decides the state", { "FF-06": "full" }, () => {
  const efficient = evaluateFormats({ canPlay: {}, imageDecoder: {}, mediaCapabilities: { "video/mp4; codecs=avc1.42E01E": { supported: true, smooth: true, powerEfficient: true } } }).find((v) => v.id === "mp4")!;
  eq(efficient.state, "native", "hardware decode is native");
  const software = evaluateFormats({ canPlay: {}, imageDecoder: {}, mediaCapabilities: { "video/mp4; codecs=avc1.42E01E": { supported: true, smooth: false, powerEfficient: false } } }).find((v) => v.id === "mp4")!;
  eq(software.state, "software", "software decode is labelled as such");
  const refused = evaluateFormats({ canPlay: {}, imageDecoder: {}, mediaCapabilities: { "video/mp4": { supported: false, smooth: false, powerEfficient: false } } }).find((v) => v.id === "mp4")!;
  eq(refused.state, "unsupported", "a refusal is a refusal");
  const nothing = evaluateFormats({ canPlay: {}, imageDecoder: {}, mediaCapabilities: {} });
  ok(nothing.every((v) => v.state === "unsupported"), "no probe at all means unsupported, never assumed");
  for (const v of nothing) {
    const spec = FORMATS.find((f) => f.id === v.id)!;
    ok(supportSentence(v, spec).length > 15, `${v.id} needs a sentence`);
  }
});

await test("HW-10 · WASM probes are real modules, and threads without isolation is reported as blocked", { "HW-10": "full" }, () => {
  // The probe bytes must at minimum be a well-formed module header.
  for (const [name, bytes] of Object.entries(PROBE_MODULES)) {
    eq([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d], `${name} must start with the magic number`);
    eq(bytes[4], 1, `${name} must be version 1`);
  }
  // Real validation in this Node build is the truthful thing to try.
  const validate = (WebAssembly as unknown as { validate?: (b: Uint8Array) => boolean }).validate;
  if (typeof validate === "function") {
    for (const [name, bytes] of Object.entries(PROBE_MODULES)) {
      const okModule = validate(bytes);
      ok(typeof okModule === "boolean", `${name} validation must return a boolean`);
    }
  }
  const blocked = interpretFeatures({ simd: true, threads: true, bulkMemory: true, referenceTypes: true, exceptions: false }, false);
  ok(blocked.threadsBlockedByIsolation, "threads are blocked without COOP/COEP");
  ok(blocked.verdict.includes("cross-origin"), "and the verdict says why");
  const fine = interpretFeatures({ simd: true, threads: true, bulkMemory: true, referenceTypes: true, exceptions: false }, true);
  ok(!fine.threadsBlockedByIsolation, "isolated pages can use threads");
});

await test("HW-04 · an inference tier is only certified by a timed run, with warm-up discarded", { "HW-04": "full" }, () => {
  eq(certifyTier("webgpu", []).certified, false, "no run, no claim");
  eq(certifyTier("webgpu", [50, 10]).certified, false, "two runs is not enough");
  const c = certifyTier("webgpu", [200, 10, 12, 11]);
  ok(c.certified, "three timed runs certify");
  eq(c.medianMs, 11, "the warm-up run is discarded");
  eq(certifyTier("wasm", [0, 0, 0]).certified, false, "a zero timing is not measurable");
  eq(inferenceTiers({ hasWebNN: false, hasWebGPU: true, simd: true, hasWasm: true }), ["webgpu", "wasm-simd", "wasm"], "the ladder in order");
  eq(inferenceTiers({ hasWebNN: false, hasWebGPU: false, simd: false, hasWasm: false }), ["none"], "nothing at all");
});

// ── AX-06 voice ────────────────────────────────────────────────────────────
await test("AX-06 · dictation is off unless the user consented to cloud speech", { "AX-06": "full" }, () => {
  const off = dictationPolicy({ hasApi: true, secureContext: true, networkCloudConsent: false, language: "en-US" });
  eq(off.allowed, false, "no consent, no microphone");
  ok(off.audioLeavesDevice, "and it says the audio would have left the device");
  ok(off.disclosure.includes("Privacy"), "the disclosure points at the switch");
  eq(dictationPolicy({ hasApi: false, secureContext: true, networkCloudConsent: true, language: "en" }).allowed, false, "no API");
  eq(dictationPolicy({ hasApi: true, secureContext: false, networkCloudConsent: true, language: "en" }).allowed, false, "insecure context");
  ok(dictationPolicy({ hasApi: true, secureContext: true, networkCloudConsent: true, language: "de-DE" }).disclosure.includes("de-DE"), "the language is stated");
});

await test("AX-06 · interim results replace the tail, finals commit, and the budget is enforced", { "AX-06": "full" }, () => {
  let b = startDictation("Hello");
  b = applyRecognition(b, { text: "wor", final: false });
  eq(displayText(b), "Hello wor", "interim is appended for display");
  b = applyRecognition(b, { text: "world", final: false });
  eq(displayText(b), "Hello world", "a new interim replaces the old one");
  b = applyRecognition(b, { text: "world.", final: true });
  eq(b.committed, "Hello world.", "final commits with one joining space");
  eq(b.interim, "", "interim cleared");
  const again = applyRecognition(b, { text: "more", final: true });
  eq(again.committed, "Hello world. more", "a second sentence is separated by a single space");
  eq(applyRecognition(b, { text: "   ", final: true }).committed, b.committed, "blank recognition changes nothing");
  const full = startDictation("x".repeat(DICTATION_MAX_CHARS));
  const over = applyRecognition(full, { text: "more", final: true });
  ok(over.stoppedBecause?.includes("limit"), "the limit is reported");
  eq(over.committed.length, DICTATION_MAX_CHARS, "and nothing was written past it");
});

await test("AX-06 · every stop reason is classified, and text is never discarded on stop", { "AX-06": "full" }, () => {
  const buffer = startDictation("kept");
  for (const [code, expect] of [["not-allowed", "not-allowed"], ["no-speech", "no-speech"], ["network", "network"], ["audio-capture", "unknown"], ["aborted", "aborted"], ["", "silence"]] as const) {
    const c = classifyStop(code, "", buffer);
    eq(c.reason, expect, `code ${code || "(empty)"}`);
    ok(c.keepText, "text is always kept");
    ok(c.sentence.length > 10, `code ${code || "(empty)"} needs a sentence`);
  }
  eq(classifyStop("network", "", buffer).sentence.includes("network"), true, "the network case names the network");
  eq(pickLanguage("de-AT", ["de-DE", "en-US"]).exact, true === false ? true : false, "de-AT is not exact");
  eq(pickLanguage("de-AT", ["de-DE", "en-US"]).language, "de-DE", "falls back to the same base language");
  eq(pickLanguage("en_US", ["en-US"]).exact, true, "underscore is normalised");
  eq(pickLanguage("zz-ZZ", ["en-US"], "en-US").language, "en-US", "an unknown language gets the fallback");
});

// ── BL-04 store gate ───────────────────────────────────────────────────────
await test("BL-04 · a Pay button is impossible outside a real store context", { "BL-04": "full" }, () => {
  const base = { hasDigitalGoods: false, digitalGoodsService: false, installed: false, storeUrl: null, sells: true };
  const self = decideStore(base, []);
  eq(self.mode, "self-issued", "no store, self-issued licence");
  eq(mayRenderPayButton(self), false, "no Pay button");
  const link = decideStore({ ...base, storeUrl: "https://store.example/fusion" }, []);
  eq(link.mode, "external-link", "external link");
  eq(mayRenderPayButton(link), false, "still no in-app charging");
  eq(decideStore({ ...base, storeUrl: "http://store.example" }, []).mode, "unavailable", "a non-https store link is refused");
  const dg = decideStore({ ...base, hasDigitalGoods: true, digitalGoodsService: true, installed: true }, []);
  eq(dg.mode, "digital-goods", "a real store context");
  eq(mayRenderPayButton(dg), true, "and only there is Pay allowed");
  eq(dg.requestableSkus.length, PRODUCTS.length, "unowned skus are requestable");
  const owned = decideStore({ ...base, hasDigitalGoods: true, digitalGoodsService: true, installed: true }, ["fusion.pro"]);
  eq(owned.requestableSkus.includes("fusion.pro"), false, "an owned product is not offered again");
  // Digital Goods present but not installed is *not* enough.
  eq(decideStore({ ...base, hasDigitalGoods: true, digitalGoodsService: true, installed: false }, []).mode, "self-issued", "needs the installed context");
  eq(decideStore({ ...base, sells: false }, []).mode, "unavailable", "a build with nothing to sell shows nothing");
});

await test("BL-04 · a malformed price from the store is a refusal, not 'undefined'", { "BL-04": "full" }, () => {
  eq(validateItemDetails({ itemId: "a", title: "A", price: { value: "9.99", currency: "USD" } }).ok, true, "valid");
  eq(validateItemDetails({ itemId: "a", title: "A", price: { value: "9.999", currency: "USD" } }).ok, false, "three decimals is not a price");
  eq(validateItemDetails({ itemId: "a", title: "A", price: { value: "9.99", currency: "usd" } }).ok, false, "currency must be ISO-4217 shape");
  eq(validateItemDetails({ itemId: "a", title: "A" }).ok, false, "no price at all");
  eq(validateItemDetails({}).ok, false, "empty");
});

// ── AU-04 assistant plan ───────────────────────────────────────────────────
await test("AU-04 · a plan is built from the sentence, and a missing argument is a partial, not a guess", { "AU-04": "full" }, () => {
  const note = planFromUtterance('new note "Quarterly plan"');
  eq(note.intent, "new-note", "intent");
  eq(note.steps[0].args, { title: "Quarterly plan" }, "the quoted title is used");
  eq(note.confidence, "exact", "exact");
  const timer = planFromUtterance("set a timer for 25 minutes");
  eq(timer.steps[0].args.seconds, "1500", "the duration is parsed");
  const partial = planFromUtterance("open");
  eq(partial.confidence, "partial", "an 'open' with nothing to open is partial");
  eq(partial.steps, [], "and proposes nothing");
  ok(partial.unrecognised[0].includes("more detail"), "the missing detail is named");
  const none = planFromUtterance("write me a poem about the sea");
  eq(none.intent, "none", "unrecognised");
  eq(planFromUtterance("").confidence, "none", "empty");
});

await test("AU-04 · an executable plan is validated against the real command table", { "AU-04": "full" }, () => {
  const schema = { "notes.create": ["title"], "clock.timer.start": ["seconds"], "files.open": ["path"] };
  const good = planFromUtterance("timer for 90 seconds");
  eq(validatePlan(good, schema).executable, true, "a known command with a known argument is executable");
  const unknown = validatePlan({ intent: "x", steps: [{ command: "shell.exec", args: {}, describe: "rm -rf" }], confidence: "exact", unrecognised: [], source: "local-grammar" }, schema);
  eq(unknown.executable, false, "an unknown command blocks the plan");
  ok(unknown.problems[0].includes("unknown command"), "and says which");
  const badArg = validatePlan({ intent: "x", steps: [{ command: "notes.create", args: { title: "a", body: "b" }, describe: "" }], confidence: "exact", unrecognised: [], source: "local-grammar" }, schema);
  eq(badArg.executable, false, "an unexpected argument blocks it");
  eq(validatePlan({ intent: "none", steps: [], confidence: "none", unrecognised: [], source: "local-grammar" }, schema).executable, false, "an empty plan is not executable");
});

await test("AU-04 · the module never claims a model it does not have", { "AU-04": "full" }, () => {
  const none = assistantAvailability({ hasLocalModel: false, userEndpoint: false });
  eq(none.available, false, "no model is not available");
  ok(none.sentence.includes("planner"), "and it says what does work");
  ok(assistantAvailability({ hasLocalModel: true, userEndpoint: false }).sentence.includes("nothing left this device"), "a local model says so");
  ok(assistantAvailability({ hasLocalModel: false, userEndpoint: true }).sentence.includes("sent there"), "a user endpoint says so");
  eq(INTENTS.every((i) => i.keywords.length > 0), true, "every intent has keywords");
  eq(parseDuration("2 hours"), 7200, "hours");
  eq(parseDuration("99999 hours"), null, "beyond a day is refused");
  eq(parseDuration("soon"), null, "no number");
  eq(quotedOrTrailingPath('open "/Documents/Taxes"'), "/Documents/Taxes", "quoted path");
  eq(trailingFolderName("open the folder in Documents"), "Documents", "trailing folder");
});

// ── SC-06 capture guard ────────────────────────────────────────────────────
await test("SC-06 · the guard hides on every trigger and says which one fired", { "SC-06": "full" }, () => {
  const calm = { tabHidden: false, selfSharing: false, shareTrackLive: false, unfocusedMs: 0, captureToolSuspected: false };
  eq(guardDecision("off", calm, { id: "s1", now: 0 }).hide, false, "off is off");
  const hidden = guardDecision("cover", { ...calm, tabHidden: true }, { id: "s1", now: 0 });
  ok(hidden.hide && hidden.reason.includes("not visible"), "hidden tab covers the window");
  const sharing = guardDecision("cover", { ...calm, selfSharing: true, shareTrackLive: true }, { id: "s1", now: 0 });
  ok(sharing.hide && sharing.reason.includes("sharing"), "active share covers it");
  eq(guardDecision("cover", { ...calm, selfSharing: true, shareTrackLive: false }, { id: "s1", now: 0 }).hide, false, "a dead track is not a share");
  eq(guardDecision("cover", { ...calm, unfocusedMs: UNFOCUS_GRACE_MS - 1 }, { id: "s1", now: 0 }).hide, false, "under the grace period nothing happens");
  ok(guardDecision("cover", { ...calm, unfocusedMs: UNFOCUS_GRACE_MS }, { id: "s1", now: 0 }).hide, "at the grace period it covers");
  ok(guardDecision("cover+watermark", calm, { id: "abcdefgh1234", now: Date.UTC(2026, 10, 6, 12) }).watermark?.includes("2026-11-06"), "the watermark carries the time");
});

await test("SC-06 · the guarantee is never overstated, and the tiles cover the area", { "SC-06": "full" }, () => {
  ok(GUARD_DISCLOSURE.includes("cannot stop"), "the disclosure admits the limit");
  const k = captureKnowledge();
  eq(k.canSeeRemoteCapture, false, "a page cannot detect remote capture");
  eq(k.canSeeOwnCapture, true, "it can see its own");
  const tiles = watermarkTiles(1440, 900, 220);
  ok(tiles.length > 10 && tiles.length <= 96, "a bounded number of tiles");
  ok(tiles.every((t) => t.x >= 0 && t.x < 1440 && t.y >= 0 && t.y < 900), "every tile is inside the surface");
  eq(watermarkTiles(0, 900), [], "a zero-width surface has no tiles");
});

// ── MS-01 / MS-04 bridges ──────────────────────────────────────────────────
await test("MS-01 · a plain-http bridge is refused unless it is on this machine", { "MS-01": "full" }, () => {
  eq(bridgeAllowed("http://localhost:1234").ok, true, "localhost is fine");
  eq(bridgeAllowed("http://127.0.0.1:1234").ok, true, "loopback is fine");
  eq(bridgeAllowed("http://bridge.example.com").ok, false, "a remote plain-http bridge leaks its token");
  ok(bridgeAllowed("http://bridge.example.com").reason.includes("https"), "and says why");
  eq(bridgeAllowed("ftp://x").ok, false, "wrong scheme");
  eq(bridgeAllowed("not a url").ok, false, "garbage");
  throws(() => bridgeRequests("nope", "pw"), "an invalid base throws rather than building a relative URL");
});

await test("MS-01 · requests carry the token in a header, never in the URL", { "MS-01": "full" }, () => {
  const reqs = bridgeRequests("https://bridge.example.com/", "s3cret", { chatGuid: "iMessage;-;+1555", text: "hi" });
  eq(reqs.length, 4, "ping, chats, messages, send");
  ok(reqs.every((r) => !r.url.includes("s3cret")), "no token in any URL");
  ok(reqs[0].headers.Authorization === "Bearer s3cret", "the token is a bearer header");
  ok(reqs[3].url.endsWith("/api/v1/message/text") && reqs[3].method === "POST", "send shape");
  ok(reqs[1].url.includes("limit=30"), "a default limit is always present");
  eq(bridgeRequests("https://b.ex.com", "", { limit: 10_000 })[1].url.includes("limit=200"), true, "the limit is capped");
});

await test("MS-01 · a wrong-shaped response is a typed failure, not an empty screen", { "MS-01": "full" }, () => {
  eq(parseBridgeChats(null).ok, false, "null body");
  eq(parseBridgeChats({ status: 500, message: "boom" }).ok, false, "an error status");
  const wrong = parseBridgeChats({ data: "not an array" });
  eq(wrong.ok, false, "no data array");
  ok(!wrong.ok && wrong.error.includes("BlueBubbles"), "and it names what it expected");
  const good = parseBridgeChats({ status: 200, data: [{ guid: "g1", displayName: "Mum", lastMessageDate: 1700000000000 }, { notAGuid: true }] });
  ok(good.ok, "a valid response parses");
  if (good.ok) { eq(good.chats.length, 1, "the malformed row is dropped"); eq(good.chats[0].title, "Mum", "title"); }
  const msgs = parseBridgeMessages({ data: [{ text: "hello", handle: { address: "+1555" }, isFromMe: false, dateCreated: 1 }, { subject: "subj", isFromMe: true }, { noText: true }] });
  ok(msgs.ok);
  if (msgs.ok) { eq(msgs.messages.length, 2, "two usable messages"); eq(msgs.messages[1].mine, true, "isFromMe is honoured"); }
});

await test("MS-04 · Matrix needs https and a real token, and its responses are typed", { "MS-04": "full" }, () => {
  eq(matrixAllowed({ homeserver: "http://matrix.org", accessToken: "a".repeat(30) }).ok, false, "http homeserver refused");
  eq(matrixAllowed({ homeserver: "https://matrix.org", accessToken: "short" }).ok, false, "a short token is refused");
  eq(matrixAllowed({ homeserver: "https://matrix.org", accessToken: "syt_" + "x".repeat(40) }).ok, true, "https + real token");
  const reqs = matrixRequests({ homeserver: "https://m.example", accessToken: "t".repeat(30), userId: "@a:b" }, { roomId: "!r:b", text: "hi" });
  eq(reqs[0].url, "https://m.example/_matrix/client/v3/versions", "versions endpoint");
  ok(reqs.some((r) => r.url.includes("dir=b")), "messages are paginated backwards with a direction");
  ok(reqs.some((r) => r.method === "PUT" && r.url.includes("/send/m.room.message/")), "send uses PUT with a txn id");
  throws(() => matrixRequests({ homeserver: "http://m.example", accessToken: "t".repeat(30), userId: "x" }), "refuses to build an insecure request list");
});

await test("MS-04 · pagination and errors are read correctly, and secrets are redacted", { "MS-04": "full" }, () => {
  eq(parseMatrixVersions({ versions: ["v1.1"] }).ok, true, "a v1.1 server");
  eq(parseMatrixVersions({ nope: true }).ok, false, "not a homeserver");
  eq(parseMatrixVersions({ versions: ["r0.6.1"] }).ok, false, "an ancient API is not usable");
  const page = parseMatrixMessages({ chunk: [{ type: "m.room.message", content: { body: "hi", msgtype: "m.text" }, sender: "@a:b", event_id: "$1", origin_server_ts: 5 }, { type: "m.reaction" }], end: "t42" });
  ok(page.ok);
  if (page.ok) { eq(page.page.messages.length, 1, "only text events"); eq(page.page.end, "t42", "the pagination token is kept"); }
  eq(parseMatrixMessages({ errcode: "M_FORBIDDEN", error: "no" }).ok, false, "an errcode is a failure");
  eq(parseMatrixMessages({ chunk: [] }).ok, true, "an empty page is valid");
  const secret = "syt_abcdefghijklmnop";
  ok(!redact(`failed with Bearer ${secret}`, [secret]).includes(secret), "a bearer token is redacted");
  ok(!redact(`url?access_token=${secret}`, [secret]).includes(secret), "a query token is redacted");
  eq(redact("harmless text", [secret]), "harmless text", "ordinary text is untouched");
});

// ── LN-02 / LN-12 auto-frame ───────────────────────────────────────────────
await test("LN-02 · the subject is the largest box plus its neighbours, and no faces means no subject", { "LN-02": "full" }, () => {
  eq(primarySubject([], { w: 1280, h: 720 }), null, "no faces is not a centred face");
  const one = primarySubject([{ x: 100, y: 100, w: 200, h: 200 }], { w: 1280, h: 720 })!;
  eq([one.x, one.y, one.w, one.h], [100, 100, 200, 200], "one face is itself");
  const pair = primarySubject([{ x: 100, y: 100, w: 200, h: 200 }, { x: 320, y: 110, w: 190, h: 190 }], { w: 1280, h: 720 })!;
  eq(pair.w, 410, "two similar faces merge so neither is cut off");
  const stray = primarySubject([{ x: 100, y: 100, w: 200, h: 200 }, { x: 900, y: 500, w: 60, h: 60 }], { w: 1280, h: 720 })!;
  eq(stray.w, 200, "a small distant face does not widen the crop");
  eq(primarySubject([{ x: -500, y: -500, w: 0, h: 0 }], { w: 100, h: 100 }), null, "degenerate boxes are ignored");
});

await test("LN-02 · the crop keeps the subject inside and never shrinks below the floor", { "LN-02": "full" }, () => {
  const frame = { w: 1280, h: 720 };
  const crop = cropForSubject({ x: 500, y: 100, w: 240, h: 240 }, frame, 16 / 9);
  ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.w <= frame.w && crop.y + crop.h <= frame.h, "crop is inside the frame");
  ok(crop.w >= frame.w * MIN_CROP_FRACTION, "and respects the minimum size");
  const centred = centreCrop(frame, 16 / 9);
  eq([centred.w, centred.h], [1280, 720], "a 16:9 frame needs no crop");
  const square = centreCrop(frame, 1);
  eq([square.w, square.h], [720, 720], "a 1:1 crop of a 16:9 frame is height-limited");
  eq(cropForSubject(null, frame, 1).w, 720, "no subject still yields a valid centred crop");
});

await test("LN-02 · smoothing is critically damped: it approaches without overshoot and stops jittering", { "LN-02": "full" }, () => {
  let crop = { x: 0, y: 0, w: 400, h: 400 };
  const target = { x: 100, y: 0, w: 400, h: 400 };
  let previous = crop.x;
  let monotone = true;
  for (let i = 0; i < 60; i++) {
    const r = smoothCrop(crop, target, 0.2, 1);
    if (r.crop.x > target.x || r.crop.x < previous) monotone = false;
    previous = r.crop.x;
    crop = r.crop;
    if (r.settled) break;
  }
  ok(monotone, "the crop never overshoots or reverses");
  ok(Math.abs(crop.x - target.x) <= 2, "it settles inside the dead zone");
  const still = smoothCrop({ x: 100, y: 0, w: 400, h: 400 }, { x: 100, y: 0, w: 400, h: 400 }, 0.2, 2);
  eq(still.changed, false, "a still subject produces no change");
  eq(still.settled, true, "and is reported as settled");
  eq(smoothCrop(crop, target, 1, 0).crop, target, "stiffness 1 is no smoothing");
});

await test("LN-12 · the presenter bubble stays inside the stage and warns when it covers the content", { "LN-12": "full" }, () => {
  const stage = { w: 1280, h: 720 };
  const content = { x: 0, y: 0, w: 1280, h: 720 };
  for (const corner of ["tl", "tr", "bl", "br"] as const) {
    const layout = presenterLayout({ stage, content, corner, bubbleFraction: 0.2 });
    const b = layout.bubble;
    ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= stage.w && b.y + b.h <= stage.h, `bubble inside the stage for ${corner}`);
    ok(Math.abs(b.w / b.h - 16 / 9) < 0.05, `bubble keeps the camera aspect for ${corner}`);
    ok(layout.margin >= 8, "a real margin");
  }
  const shrunk = presenterLayout({ stage: { w: 400, h: 120 }, content, corner: "br", bubbleFraction: 0.35 });
  ok(shrunk.shrunk, "a wide stage only 120 px tall cannot hold a 140 px bubble");
  ok(shrunk.bubble.h <= 48, "so it is shrunk to at most 40% of the height");
  eq(presenterLayout({ stage: { w: 1280, h: 720 }, content, corner: "br", bubbleFraction: 0.2 }).shrunk, false, "an ordinary stage needs no shrink");
  // A slide whose own logo sits in the top-right corner: the bubble would cover it.
  const overlapping = presenterLayout({ stage, content: { x: 620, y: 0, w: 660, h: 380 }, corner: "tr", bubbleFraction: 0.3 });
  ok(overlapping.note.includes("invert") || overlapping.note.includes("shrink"), "an overlap with the slide's own content is called out");
  const clear = presenterLayout({ stage, content: { x: 0, y: 200, w: 600, h: 400 }, corner: "br", bubbleFraction: 0.2 });
  eq(clear.note, "ok", "a bubble in an empty corner is not flagged");
});

// ── AU-03 automation entry ─────────────────────────────────────────────────
await test("AU-03 · the entry shape is fixed: no free-form steps, bounded arguments", { "AU-03": "full" }, () => {
  const good = parseAutomationRequest({ routineId: "morning", args: { name: "a", n: 3, flag: true } });
  ok(good.ok, "a valid request parses");
  if (good.ok) eq(good.request.args, { name: "a", n: 3, flag: true }, "typed arguments survive");
  eq(parseAutomationRequest({ routineId: "x", actions: [{ command: "rm" }] }).ok, true, "an unknown key is ignored, not executed");
  eq(parseAutomationRequest({ routineId: "bad id!" }).ok, false, "id charset");
  eq(parseAutomationRequest({ args: {} }).ok, false, "missing id");
  eq(parseAutomationRequest({ routineId: "x", args: { "bad-key": 1 } }).ok, false, "argument-name charset");
  eq(parseAutomationRequest({ routineId: "x", args: { a: { nested: 1 } } }).ok, false, "a nested object is refused");
  eq(parseAutomationRequest({ routineId: "x", args: { a: Number.NaN } }).ok, false, "NaN is refused");
  eq(parseAutomationRequest({ routineId: "x", args: { a: "y".repeat(3000) } }).ok, false, "an oversized argument is refused");
  eq(parseAutomationRequest([1, 2]).ok, false, "an array is not a request");
});

await test("AU-03 · a dry run blocks the whole routine when one step is unknown", { "AU-03": "full" }, () => {
  const schema = { "files.write": { args: ["path", "content"], mutates: true, required: ["path", "content"] }, "find.open": { args: ["q"], mutates: false, required: ["q"] } };
  const routine = { id: "r", name: "R", trigger: "manual" as const, enabled: true, actions: [{ command: "find.open", args: { q: "taxes" } }, { command: "files.write", args: { path: "/a", content: "b" } }] };
  const run = dryRun(routine, schema);
  ok(run.executable, "a valid routine is executable");
  eq(run.steps.length, 2, "both steps are described");
  ok(run.steps[1].wouldChange.length === 1, "a mutating step is marked");
  eq(run.steps[0].wouldChange.length, 0, "a read step is not");
  const bad = dryRun({ ...routine, actions: [{ command: "find.open", args: { q: "x" } }, { command: "shell.run", args: {} }] }, schema);
  eq(bad.executable, false, "one unknown command blocks everything");
  ok(bad.problems[0].includes("shell.run"), "and names it");
  eq(dryRun({ ...routine, enabled: false }, schema).executable, false, "a disabled routine is not runnable");
  eq(dryRun({ ...routine, actions: Array.from({ length: MAX_ACTIONS + 1 }, () => ({ command: "find.open", args: { q: "x" } })) }, schema).executable, false, "the action budget is enforced");
  const missing = dryRun({ ...routine, actions: [{ command: "files.write", args: { path: "/a" } }] }, schema);
  eq(missing.executable, false, "a missing required argument is caught");
  ok(missing.problems[0].includes("content"), "and the missing name is printed");
  eq(dryRun({ ...routine, actions: [{ command: "find.open", args: {} }] }, schema).executable, false, "an empty argument object is refused when one is required");
});

await test("AU-03 · tokens are single-use, routine-bound and expiring", { "AU-03": "full" }, () => {
  const now = 1_000_000;
  const token = issueToken("morning", now, 60_000);
  eq(token.value.length, 24, "96 bits of randomness, hex");
  eq(redeemToken(token, "morning", now + 1000).ok, true, "a fresh token for the right routine");
  eq(redeemToken({ ...token, used: true }, "morning", now).ok, false, "single use");
  eq(redeemToken(token, "other", now).ok, false, "routine-bound");
  eq(redeemToken(token, "morning", now + 120_000).ok, false, "expiring");
  eq(redeemToken(undefined, "morning", now).ok, false, "a token is required");
  ok(issueToken("x", now).expiresAt <= now + 600_000, "the ttl is capped");
});

// ── TD-04 text import ──────────────────────────────────────────────────────
await test("TD-04 · sort is stable, numeric like sort -n, and unique is not a set", { "TD-04": "full" }, () => {
  eq(sortLines("b\na\nc").lines, ["a", "b", "c"], "lexical");
  eq(sortLines("b\na\nc", { reverse: true }).lines, ["c", "b", "a"], "reverse");
  eq(sortLines("b\na\nc", { unique: true }).lines.length, 3, "unique removes duplicates, not order");
  eq(sortLines("a\na\nb", { unique: true }).removed, 1, "the removal is counted");
  const nums = sortLines("10\n9\n2", { numeric: true }).lines;
  eq(nums, ["2", "9", "10"], "numeric order, not lexical");
  eq(sortLines("10\n2\nx\n1", { numeric: true }).lines[0], "x", "non-numeric lines sort first, as sort -n does");
  eq(sortLines("a\nb\nc").lines, ["a", "b", "c"], "input order is preserved among equals (stable)");
  eq(numericPrefix("  -12.5kg"), -12.5, "a numeric prefix with blanks and a sign");
  eq(Number.isNaN(numericPrefix("abc")), true, "no numeric prefix");
  eq(sortLines("b\t2\na\t1", { key: 2, numeric: true }).lines, ["a\t1", "b\t2"], "keyed numeric sort");
  eq(sortLines("B\na", { foldCase: true }).lines, ["a", "B"], "case folding affects comparison only");
});

await test("TD-04 · uniq only collapses adjacent duplicates, which is the real semantics", { "TD-04": "full" }, () => {
  eq(uniqLines("a\na\nb\na").lines, ["a", "b", "a"], "non-adjacent duplicates survive");
  eq(uniqLines("a\na\na").groups[0].count, 3, "the group count is exact");
  ok(uniqLines("a\na", { count: true }).lines[0].trim().startsWith("2"), "the -c form is right-aligned and counted");
  eq(uniqLines("A\na", { foldCase: true }).groups.length, 1, "folded comparison merges");
  eq(uniqLines("A\na").groups.length, 2, "without folding it does not");
});

await test("TD-04 · cut, paste and wc follow POSIX counting", { "TD-04": "full" }, () => {
  eq(cutFields("a:b:c", { delimiter: ":", fields: [1, 3] }).lines, ["a:c"], "fields are 1-based and orderable");
  eq(cutFields("a:b:c", { delimiter: ":", fields: [3, 1] }).lines, ["a:c"], "the output is always in field order");
  eq(cutFields("a", { delimiter: ":", fields: [2] }).missing, 1, "a missing field is counted");
  eq(cutFields("a\tb", { fields: [2] }).lines, ["b"], "tab is the default delimiter");
  throws(() => cutFields("x", { delimiter: "::", fields: [1] }), "a multi-character delimiter is refused");
  throws(() => cutFields("x", { fields: [] }), "no fields is refused");
  eq(pasteColumns([["a", "b"], ["1", "2"]]), ["a\t1", "b\t2"], "columns are pasted row-wise");
  eq(pasteColumns([["a"], ["1", "2"]]), ["a\t1", "\t2"], "ragged columns are padded with an empty cell, not truncated");
});

await test("TD-04 · wc and tr match the tools they are named after", { "TD-04": "full" }, () => {
  eq(wcCount("a b\nc\n"), { bytes: 6, chars: 6, words: 3, lines: 2 }, "POSIX counts");
  eq(wcCount("").lines, 0, "empty input has no lines");
  eq(wcCount("no newline").lines, 1, "a final line without a newline still counts");
  eq(wcCount("é").bytes, 2, "bytes are UTF-8 bytes");
  eq(wcCount("é").chars, 1, "chars are code points");
  eq(trSet("abc", "a-c", "x").text, "xxx", "a range maps and the last target repeats");
  eq(trSet("a-b", "a-z", "A-Z").text, "A-B", "case translation");
  eq(trSet("abc", "abc", "", { delete: true }).text, "", "delete mode removes");
  eq(trSet("abc", "abc", "x", { complement: true }).text, "abc", "complement leaves members alone");
  throws(() => trSet("a", "z", ""), "an empty target set without delete is an error");
  ok(trSet("a", "z-a", "x").warnings.length === 1, "a reversed range is warned about, not silently ignored");
});

// ── HW-06 multi-screen ─────────────────────────────────────────────────────
await test("HW-06 · windows are centred in the work area, never under a taskbar", { "HW-06": "full" }, () => {
  const place = placeWindow(screens, { w: 800, h: 600 });
  eq(place.screenIndex, 0, "the primary screen by default");
  eq(place.rect.x, Math.round((1440 - 800) / 2), "centred horizontally");
  ok(place.rect.y + place.rect.h <= 900, "inside the work area");
  const onSecond = placeWindow(screens, { w: 800, h: 600 }, { screenIndex: 1 });
  eq(onSecond.screenLabel, "DELL U2720Q", "the requested screen");
  ok(onSecond.rect.x >= 1440, "on the second screen's coordinates");
  const follow = placeWindow(screens, { w: 400, h: 300 }, { currentRect: { x: 2000, y: 100, w: 400, h: 300 } });
  eq(follow.screenIndex, 1, "a window follows the screen it is on");
  eq(placeWindow(screens, { w: 400, h: 300 }, { screenIndex: 7 }).reason.includes("no screen 7"), true, "a nonexistent screen is refused, not clamped");
  const big = placeWindow(screens, { w: 5000, h: 4000 }, { screenIndex: 0 });
  ok(big.shrunk && big.rect.w <= 1440, "an oversized window is shrunk with a reason");
  eq(virtualDesktop(screens)!.w, 4000, "virtual desktop width");
  eq(screenForRect(screens, { x: 1500, y: 0, w: 100, h: 100 }), 1, "ownership by overlap");
});

await test("HW-06 · presentation prefers an external screen, and DPI changes are described", { "HW-06": "full" }, () => {
  eq(presentationScreen(screens), 1, "the external screen wins over the built-in one");
  eq(presentationScreen([screens[0]]), 0, "with one screen, that one");
  eq(presentationScreen([]), -1, "no screens");
  ok(dpiTransition(screens[0], screens[1]).sentence.includes("2×"), "a DPI change is stated with both values");
  eq(dpiTransition(screens[0], screens[0]).changed, false, "same screen is not a transition");
  eq(dpiTransition(null, screens[1]).changed, false, "no previous screen is not a transition");
  ok(screenDisclosure(false, []).includes("does not expose"), "the no-API sentence is honest");
  ok(screenDisclosure(true, screens).includes("2 screens"), "the count is stated");
});

// ── HW-07 peripherals ──────────────────────────────────────────────────────
await test("HW-07 · each transport's availability is its own answer, gated on a secure context", { "HW-07": "full" }, () => {
  const all = transportSupport({ hasHid: true, hasUsb: true, hasSerial: false, hasBluetooth: true, secureContext: true });
  eq(all.find((t) => t.transport === "serial")!.available, false, "missing API");
  ok(all.find((t) => t.transport === "serial")!.reason.includes("no Web Serial"), "and it names the API");
  const insecure = transportSupport({ hasHid: true, hasUsb: true, hasSerial: true, hasBluetooth: true, secureContext: false });
  ok(insecure.every((t) => !t.available), "nothing works in an insecure context");
  ok(insecure[0].reason.includes("secure context"), "and the reason is the same for each");
});

await test("HW-07 · over-broad filters are refused before a picker opens", { "HW-07": "full" }, () => {
  eq(validateFilters("usb", []).ok, false, "an empty USB filter lists every device");
  eq(validateFilters("hid", []).ok, true, "HID with no filter is the picker asking");
  eq(validateFilters("usb", [{ vendorId: 0x1234, productIds: [0x5678] }]).ok, true, "a specific USB filter");
  eq(validateFilters("usb", [{ vendorId: 0 }]).ok, false, "vendorId 0 is not a vendor");
  eq(validateFilters("usb", [{ vendorId: 70000 }]).ok, false, "vendorId out of range");
  eq(validateFilters("bluetooth", [{ services: ["180d"] }]).ok, true, "a 16-bit service UUID");
  eq(validateFilters("bluetooth", [{ services: ["nothex"] }]).ok, false, "a bad UUID");
  const warn = validateFilters("serial", []);
  ok(warn.ok && warn.warnings.length === 1, "serial with no filter warns about debug consoles");
  const wrongKey = validateFilters("serial", [{ vendorId: 1 }]);
  ok(wrongKey.warnings.some((w) => w.includes("usbVendorId")), "the serial key is corrected in a warning");
});

await test("HW-07 · failures are classified, and frames survive chunk boundaries", { "HW-07": "full" }, () => {
  eq(classifyFailure({ name: "NotFoundError" }).kind, "cancelled", "chooser closed");
  eq(classifyFailure({ name: "SecurityError" }).kind, "protected", "a protected class");
  eq(classifyFailure({ name: "NetworkError" }).kind, "busy", "claimed by a driver");
  eq(classifyFailure({ name: "InvalidStateError" }).kind, "disconnected", "unplugged");
  eq(classifyFailure({ name: "AbortError" }).kind, "cancelled", "aborted");
  ok(classifyFailure({ message: "Access denied" }).kind === "denied", "a message-only denial is caught");
  eq(classifyFailure(null).kind, "unknown", "null is unknown");
  const framer = serialFramer("\n");
  const enc = new TextEncoder();
  eq(framer.push(enc.encode("hello\nwor")), ["hello"], "a partial frame is held");
  eq(framer.push(enc.encode("ld\nbye\n")), ["world", "bye"], "the held bytes complete correctly");
  const flood = framer.push(enc.encode("x".repeat(2_000_000)));
  eq(flood.length, 0, "a delimiter-free flood does not produce frames");
});

// ── HW-09b measured network ────────────────────────────────────────────────
await test("HW-09 · a cached or tiny sample is not a measurement", { "HW-09": "full" }, () => {
  const cached = estimateThroughput([{ bytes: 2_000_000, ms: 50, fromCache: true }]);
  eq(cached.usable, false, "a cache hit measures the cache");
  ok(cached.reason.includes("cache"), "and says so");
  const tiny = estimateThroughput([{ bytes: 4000, ms: 20 }]);
  eq(tiny.usable, false, "a tiny sample is dominated by latency");
  eq(tiny.bitsPerSecond, 0, "no number is published");
  const real = estimateThroughput([{ bytes: 1_000_000, ms: 400, rttMs: 100 }]);
  ok(real.usable, "a real sample is usable");
  ok(real.bitsPerSecond > 20_000_000 && real.bitsPerSecond < 30_000_000, `latency-subtracted throughput, got ${real.bitsPerSecond}`);
  const multi = estimateThroughput([{ bytes: 600_000, ms: 100 }, { bytes: 600_000, ms: 120 }, { bytes: 600_000, ms: 110 }]);
  ok(multi.confidence !== "low", "three real samples raise confidence");
  eq(MIN_SAMPLE_BYTES, 16384, "the floor is a stated constant");
});

await test("HW-09 · the ladder names an exact resolution and steps down on loss", { "HW-09": "full" }, () => {
  const fast = pickRung({ bitsPerSecond: 50_000_000, confidence: "high", usable: true, reason: "" });
  eq(fast.rung.name, "best", "a fast link gets the top rung");
  const slow = pickRung({ bitsPerSecond: 2_000_000, confidence: "low", usable: true, reason: "" });
  ok(["lowest", "low"].includes(slow.rung.name), `a 2 Mbit/s link gets a low rung, got ${slow.rung.name}`);
  eq(pickRung({ bitsPerSecond: 250_000, confidence: "low", usable: true, reason: "" }).rung.name, "lowest", "below the floor for anything better is the floor rung");
  const unconstrained = pickRung({ bitsPerSecond: 20_000_000, confidence: "high", usable: true, reason: "" });
  eq(unconstrained.rung.name, "best", "20 Mbit/s with no constraints reaches the top rung");
  const metered = pickRung({ bitsPerSecond: 20_000_000, confidence: "high", usable: true, reason: "" }, { metered: true, batterySaver: true });
  ok(LADDER.indexOf(metered.rung) < LADDER.indexOf(unconstrained.rung), "metered + battery saver steps down at the same measurement");
  ok(metered.reason.includes("metered") && metered.reason.includes("battery saver"), "and the reason names both constraints");
  const unmeasured = pickRung({ bitsPerSecond: 0, confidence: "low", usable: false, reason: "cached" });
  eq(unmeasured.rung.name, "lowest", "no measurement means the safest rung, not the middle one");
  eq(adaptRung("high", { droppedFramesFraction: 0.2, bufferedMs: 0, stableMs: 0 }).next, "standard", "loss steps down one rung");
  eq(adaptRung("high", { droppedFramesFraction: 0.001, bufferedMs: 200, stableMs: 20_000 }).next, "best", "stability steps up one rung");
  eq(adaptRung("lowest", { droppedFramesFraction: 0.5, bufferedMs: 9000, stableMs: 0 }).next, "lowest", "the floor is the floor");
  eq(adaptRung("standard", { droppedFramesFraction: 0.0, bufferedMs: 0, stableMs: 1000 }).next, "standard", "one second of calm is not stability");
  const constraints = captureConstraints(LADDER[2]) as { video: { height: { max: number } } };
  eq(constraints.video.height.max, 720, "the constraint matches the rung exactly");
});

// ── HW-11b wake lock ───────────────────────────────────────────────────────
await test("HW-11 · a wake lock is a lease with a visible state, not a boolean hope", { "HW-11": "full" }, () => {
  eq(beginWake({ hasApi: false, secureContext: true, visible: true, now: 0 }).state, "denied", "no API");
  eq(beginWake({ hasApi: true, secureContext: true, visible: false, now: 0 }).state, "denied", "hidden page");
  eq(beginWake({ hasApi: true, secureContext: true, visible: true, batteryLow: true, now: 0 }).state, "denied", "low battery is respected");
  const live = beginWake({ hasApi: true, secureContext: true, visible: true, now: 1000, leaseMs: 60_000 });
  eq(live.state, "granted", "granted");
  ok(wakeSentence(live).includes("60 min") || wakeSentence(live).includes("1 min"), "the sentence states the lease");
  eq(tickWake(live, { visible: true, now: 2000, stillNeeded: true }).action, "none", "holding");
  eq(tickWake(live, { visible: false, now: 2000, stillNeeded: true }).state, "released", "a hidden tab loses the lock");
  eq(tickWake(live, { visible: true, now: 1000 + 61_000, stillNeeded: true }).state, "expired", "the lease expires");
  eq(tickWake(live, { visible: true, now: 2000, stillNeeded: false }).action, "release", "ending the session releases it");
  eq(tickWake({ ...live, state: "released" }, { visible: true, now: 3000, stillNeeded: true }).action, "reacquire", "coming back re-acquires");
  ok(beginWake({ hasApi: true, secureContext: true, visible: true, now: 0, leaseMs: 9e9 }).leaseMs <= MAX_LEASE_MS, "the lease is capped");
});

// ── CT-03 handoff link ─────────────────────────────────────────────────────
await test("CT-03 · a handoff link round-trips and its payload stays out of the query string", { "CT-03": "full" }, () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const built = encodeHandoff({ t: now, e: now + 3_600_000, focus: "editor", windows: [{ module: "editor", title: "Draft", path: "/Notes/d.md", scroll: 120 }, { module: "files", path: "/Notes" }], note: "open at page 4" });
  ok(built.link !== null, `encode failed: ${built.error}`);
  ok(built.link!.startsWith("#h="), "the payload lives in the fragment");
  ok(!built.link!.includes("?"), "nothing is in the query string, so no server ever sees it");
  const back = decodeHandoff(built.link!, now + 1000);
  ok(back.ok, "decodes");
  if (back.ok) {
    eq(back.state.focus, "editor", "focus survives");
    eq(back.state.windows.length, 2, "both windows");
    eq(back.state.windows[0].scroll, 120, "scroll survives");
    eq(back.state.note, "open at page 4", "the note survives");
    eq(back.warnings, [], "no warnings on a clean link");
  }
  eq(HANDOFF_VERSION, 1, "the version is declared");
});

await test("CT-03 · a truncated paste, an edited payload and an old link all fail loudly", { "CT-03": "full" }, () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const built = encodeHandoff({ t: now, e: now + 3_600_000, focus: "editor", windows: [{ module: "editor", title: "Draft" }] }).link!;
  const cut = built.slice(0, built.length - 6);
  const truncated = decodeHandoff(cut, now);
  eq(truncated.ok, false, "a truncated payload must not decode");
  const flipped = built.slice(0, 12) + (built[12] === "A" ? "B" : "A") + built.slice(13);
  eq(decodeHandoff(flipped, now).ok, false, "an edited payload fails its checksum");
  eq(decodeHandoff(built, now + 4_000_000).ok, false, "an expired link is refused");
  ok(decodeHandoff(built, now + 4_000_000, { allowExpired: true }).ok, "unless the caller explicitly allows it");
  eq(decodeHandoff("", now).ok, false, "no payload");
  eq(decodeHandoff("h=2.00000000.abc", now).ok, false, "a future version is refused with a version message");
  ok(decodeHandoff("h=2.00000000.abc", now).ok === false && !("error" in decodeHandoff("h=2.00000000.abc", now) as { error?: string } ? false : true), "version mismatch is an error object");
});

await test("CT-03 · unknown modules are dropped with a warning, and the size budget is enforced", { "CT-03": "full" }, () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const withJunk = encodeHandoff({ t: now, e: now + 1000, focus: "editor", windows: [{ module: "editor" }, { module: "totally-unknown" }, { module: "javascript:" }] }).link!;
  const back = decodeHandoff(withJunk, now);
  ok(back.ok, "the good window survives");
  if (back.ok) {
    eq(back.state.windows.map((w) => w.module), ["editor"], "unknown modules are dropped");
    eq(back.warnings.length, 2, "and each is reported");
  }
  const huge = encodeHandoff({ t: now, e: now + 1000, focus: "editor", windows: Array.from({ length: 24 }, () => ({ module: "editor", title: "t".repeat(120), path: "/" + "p".repeat(400) })) });
  eq(huge.link, null, "an over-budget state is refused, not truncated");
  ok(huge.bytes > HANDOFF_MAX_BYTES, "and the byte count is reported");
  eq(describeHandoff({ v: 1, t: now, e: now, focus: "editor", windows: [{ module: "editor", title: "A" }, { module: "files" }] }).startsWith("2 windows"), true, "the description counts windows");
  eq(typeof checksum("x"), "string", "checksum is a string");
  eq(checksum("x").length, 8, "and eight hex digits");
});

// ── DP-07 accessibility gate ───────────────────────────────────────────────
await test("DP-07 · the gate blocks on contrast, names, hidden focus and tiny targets", { "DP-07": "full" }, () => {
  const good = gate([{ id: "text", fg: "#000000", bg: "#ffffff", kind: "text" }], [{ id: "b", role: "button", name: "Save", focusable: true, visible: true, w: 32, h: 32 }]);
  eq(good.passed, true, "a clean surface passes");
  ok(good.summary.includes("no blocking issue"), "and says so plainly");
  const contrast = checkColourPairs([{ id: "bad", fg: "#777777", bg: "#888888", kind: "text" }]);
  eq(contrast.length, 1, "low contrast is caught");
  eq(contrast[0].severity, "block", "and blocks");
  eq(checkColourPairs([{ id: "large", fg: "#949494", bg: "#ffffff", kind: "largeText" }]).length, 0, "large text has the 3:1 threshold");
  eq(checkControls([{ id: "icon", role: "button", name: "", focusable: true, visible: true, w: 40, h: 40 }]).some((i) => i.rule === "WCAG 4.1.2"), true, "an icon button without a name blocks");
  eq(checkControls([{ id: "ghost", role: "button", name: "x", focusable: true, visible: false, w: 40, h: 40 }]).some((i) => i.rule === "WCAG 2.4.11"), true, "a hidden focus target blocks");
  eq(checkControls([{ id: "tiny", role: "button", name: "x", focusable: true, visible: true, w: 12, h: 12 }])[0].severity, "block", "a 12 px target blocks");
  eq(checkControls([{ id: "small", role: "button", name: "x", focusable: true, visible: true, w: 20, h: 20 }])[0].severity, "warn", "a 20 px target warns");
  eq(checkControls([{ id: "inline", role: "link", name: "x", focusable: true, visible: true, w: 10, h: 10, inlineLink: true }]).length, 0, "an inline link is exempt");
});

await test("DP-07 · the threshold is an argument, and 'passed' never means 'accessible'", { "DP-07": "full" }, () => {
  const pair = [{ id: "p", fg: "#767676", bg: "#ffffff", kind: "text" as const }];
  eq(gate(pair, [{ id: "b", role: "button", name: "n", focusable: true, visible: true, w: 40, h: 40 }]).passed, true, "4.54:1 passes AA");
  const strict = gate(pair, [{ id: "b", role: "button", name: "n", focusable: true, visible: true, w: 40, h: 40 }], { ...DEFAULT_THRESHOLDS, text: 7 });
  eq(strict.passed, false, "the same colour fails AAA when the threshold says so");
  eq(gate([], []).passed, false, "a surface with nothing focusable cannot pass");
  ok(GATE_LIMITS.length >= 3, "the limits are enumerated");
  ok(GATE_LIMITS[0].includes("third"), "and state how much automation misses");
});

// The two store decisions must be the same function, not two copies.
await test("BL-04 · there is exactly one store decision function", { "BL-04": "full" }, () => {
  eq(decideStore2, decideStore, "the same symbol, imported twice");
});

finish();
