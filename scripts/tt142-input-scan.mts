/**
 * TT142 — IN-06 keyboard insets and MD-05 barcode payloads.
 *
 * Two features that are easy to write and easy to write WRONG:
 *
 *   • A keyboard inset guessed from a window resize makes a desktop layout
 *     jump whenever a text field is focused.
 *   • A QR payload treated as a URL turns a printed sticker into a
 *     `javascript:` link.
 */
import { makeHarness } from "./harness.mts";
import {
  planInset, scrollToReveal, shouldCompact, describeInset,
  MIN_KEYBOARD, MAX_KEYBOARD, type InsetProbe,
} from "../src/lib/input/keyboard-inset.ts";
import { classifyScan, describeScanner } from "../src/lib/scan/barcode.ts";

const { test, finish } = makeHarness("tt142-input-scan");

// ── IN-06 ────────────────────────────────────────────────────────────────
await test("IN-06 · the real API wins over the estimate", { "IN-06": "full" }, () => {
  // Both surfaces disagree; the VirtualKeyboard figure is exact and must win.
  const plan = planInset({ overlaysContent: true, insetHeight: 312, innerHeight: 800, visualHeight: 490, textFocused: true });
  if (plan.source !== "virtual-keyboard") throw new Error(`used ${plan.source} instead of the real API`);
  if (plan.bottom !== 312) throw new Error(`reserved ${plan.bottom}, want the exact 312`);
  if (plan.caveat) throw new Error(`the exact API should not need a caveat: ${plan.caveat}`);
});

await test("IN-06 · a closed keyboard through the real API is a real zero", { "IN-06": "full" }, () => {
  // This is the case the estimate gets wrong: overlaysContent is on, the
  // keyboard is shut, but visualViewport still differs from innerHeight by the
  // URL bar. Reporting that difference as a keyboard reserves 60 px forever.
  const plan = planInset({ overlaysContent: true, insetHeight: 0, innerHeight: 800, visualHeight: 740, textFocused: false });
  if (plan.bottom !== 0) throw new Error(`reserved ${plan.bottom} for a closed keyboard`);
  if (plan.open) throw new Error("claimed the keyboard was open");
  if (plan.source !== "virtual-keyboard") throw new Error("a definitive answer was downgraded to an estimate");
});

await test("IN-06 · the estimate is labelled as one", { "IN-06": "full" }, () => {
  const plan = planInset({ innerHeight: 800, visualHeight: 500, textFocused: true });
  if (plan.source !== "visual-viewport") throw new Error(`source ${plan.source}`);
  if (plan.bottom !== 300) throw new Error(`delta ${plan.bottom}, want 300`);
  if (!/estimate|chrome|too tall/i.test(plan.caveat)) throw new Error("the estimate did not admit it is an estimate");
});

await test("IN-06 · browser chrome is not mistaken for a keyboard", { "IN-06": "full" }, () => {
  // 60 px of URL bar is far below any keyboard; reserving it leaves a permanent
  // gap at the bottom of every page.
  const chrome = planInset({ innerHeight: 800, visualHeight: 740, textFocused: true });
  if (chrome.bottom !== 0) throw new Error(`reserved ${chrome.bottom} for browser chrome`);
  if (chrome.open) throw new Error("called the URL bar a keyboard");
  if (chrome.source !== "none") throw new Error(`source ${chrome.source}`);
  // And the same delta with nothing focused is definitely not a keyboard.
  const unfocused = planInset({ innerHeight: 800, visualHeight: 300, textFocused: false });
  if (unfocused.bottom !== 0) throw new Error("a huge delta with no focused field was treated as a keyboard");
});

await test("IN-06 · an absurd measurement is clamped and said so", { "IN-06": "full" }, () => {
  // Some WebViews report the whole window as an inset during a resize.
  const plan = planInset({ overlaysContent: true, insetHeight: 4000 });
  if (plan.bottom > MAX_KEYBOARD) throw new Error(`reserved ${plan.bottom}, above the ${MAX_KEYBOARD} cap`);
  if (!/clamped/i.test(plan.caveat)) throw new Error("the clamp was not reported");
  // A non-finite measurement is "unknown", not NaN padding.
  const nan = planInset({ overlaysContent: true, insetHeight: NaN, innerHeight: NaN, visualHeight: NaN });
  if (!Number.isFinite(nan.bottom) || nan.bottom !== 0) throw new Error(`NaN produced ${nan.bottom}`);
});

await test("IN-06 · iOS visual-viewport offset is accounted for", { "IN-06": "full" }, () => {
  // On iOS the page is scrolled within the visual viewport, so the delta alone
  // overstates the keyboard by the offset.
  const plan = planInset({ innerHeight: 844, visualHeight: 500, visualOffsetTop: 44, textFocused: true });
  if (plan.bottom !== 300) throw new Error(`offset not subtracted: ${plan.bottom}, want 300`);
  if (plan.top !== 44) throw new Error(`top offset ${plan.top}`);
});

await test("IN-06 · revealing a field scrolls by the overhang, not to the top", { "IN-06": "full" }, () => {
  // scrollIntoView({block:"nearest"}) does nothing when the element is
  // "visible" underneath a floating keyboard. The scroll must be computed
  // against the visible band.
  const scroll = scrollToReveal({ top: 600, bottom: 640 }, 800, 300, 8);
  if (scroll !== 640 - 500 + 8) throw new Error(`scrolled ${scroll}, want ${148}`);
  // A field already clear needs no scroll at all — scrolling anyway is what
  // makes the page jump on every keystroke.
  if (scrollToReveal({ top: 100, bottom: 140 }, 800, 300) !== 0) throw new Error("scrolled a field that was already visible");
  // A field above the top edge comes back down.
  if (scrollToReveal({ top: -20, bottom: 10 }, 800, 300) !== -28) throw new Error("did not bring an off-top field back");
});

await test("IN-06 · compact mode follows the inset, not the window", { "IN-06": "full" }, () => {
  // A phone with the keyboard open has the same innerHeight as one without;
  // only the reserved inset changed. Keying off height alone misses it.
  if (!shouldCompact(400, 0)) throw new Error("a 400 px viewport should be compact");
  if (!shouldCompact(400, 320)) throw new Error("400−320 is 80 px and must be compact");
  if (!shouldCompact(600, 300)) throw new Error("600−300=300 is below 420 and should be compact");
  if (shouldCompact(900, 0)) throw new Error("a 900 px viewport should not be compact");
  if (shouldCompact(NaN, 0)) throw new Error("a NaN viewport collapsed the layout");
});

await test("IN-06 · the description never claims geometry it does not have", { "IN-06": "full" }, () => {
  const none = describeInset(planInset({ innerHeight: 800, visualHeight: 800 }));
  if (!/does not report/i.test(none)) throw new Error(`unknown geometry described as: ${none}`);
  const real = describeInset(planInset({ overlaysContent: true, insetHeight: 300 }));
  if (!/300/.test(real)) throw new Error("the real API's number was not reported");
  if (MIN_KEYBOARD < 80) throw new Error("the chrome/keyboard threshold is implausibly low");
});

// ── MD-05 ────────────────────────────────────────────────────────────────
await test("MD-05 · a javascript: code is never navigable", { "MD-05": "full" }, () => {
  // The attack: print a sticker, get a phone to open an arbitrary scheme.
  const r = classifyScan("javascript:fetch('/api/steal')");
  if (r.url !== undefined) throw new Error("a javascript: payload was given a navigable URL");
  if (!r.warned) throw new Error("the refusal was silent");
  if (!/not opened/i.test(r.warned)) throw new Error(`unclear refusal: ${r.warned}`);
});

await test("MD-05 · other install/launch schemes are refused too", { "MD-05": "full" }, () => {
  // intent: can launch an app; data: can be a document; file: reaches the device.
  for (const payload of [
    "intent://scan/#Intent;scheme=zxing;end",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "about:blank",
  ]) {
    const r = classifyScan(payload);
    if (r.url !== undefined) throw new Error(`${payload.slice(0, 24)} was given a navigable URL`);
    if (!r.warned) throw new Error(`${payload.slice(0, 24)} was refused without a reason`);
  }
});

await test("MD-05 · ordinary links are classified and kept", { "MD-05": "full" }, () => {
  const https = classifyScan("https://example.com/a?b=c");
  if (https.kind !== "url" || https.url !== "https://example.com/a?b=c") throw new Error(`https misclassified: ${JSON.stringify(https)}`);
  if (classifyScan("mailto:a@b.c").kind !== "email") throw new Error("mailto not recognised");
  if (classifyScan("tel:+15551234").kind !== "phone") throw new Error("tel not recognised");
  if (classifyScan("geo:41.5,-81.6").kind !== "geo") throw new Error("geo not recognised");
  // A schemeless hostname is promoted to https, not left inert...
  const bare = classifyScan("example.com/path");
  if (bare.url !== "https://example.com/path") throw new Error(`bare hostname → ${bare.url}`);
  // ...but a single word is not a hostname.
  if (classifyScan("hello").url !== undefined) throw new Error("a plain word was promoted to a URL");
  // ...and neither is a host with no dot in the last label.
  if (classifyScan("http://").url !== undefined) throw new Error("a hostless http URL became navigable");
});

await test("MD-05 · a Wi-Fi code never echoes the password on screen", { "MD-05": "full" }, () => {
  // This string is displayed and often screenshotted; showing the PSK is a leak.
  const r = classifyScan("WIFI:T:WPA;S:HomeNet;P:hunter2;H:false;;");
  if (r.kind !== "wifi") throw new Error(`kind ${r.kind}`);
  if (/hunter2/.test(r.text)) throw new Error("the Wi-Fi password was put in the visible text");
  if (r.text !== 'Wi-Fi network "HomeNet" (WPA)') throw new Error(`visible text: ${r.text}`);
  if (r.fields?.ssid !== "HomeNet") throw new Error("the SSID was not extracted");
  // Escaped metacharacters must survive, or the SSID shown is wrong.
  const esc = classifyScan("WIFI:S:Bob\\;s\\:Net;T:WEP;P:;;");
  if (esc.fields?.ssid !== "Bob;s:Net") throw new Error(`escape handling broken: ${esc.fields?.ssid}`);
});

await test("MD-05 · vCard and OTP payloads are summarised, not dumped", { "MD-05": "full" }, () => {
  const v = classifyScan("BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+15550100\nEND:VCARD");
  if (v.kind !== "vcard" || !/Ada Lovelace/.test(v.text)) throw new Error(`vcard: ${JSON.stringify(v)}`);
  const o = classifyScan("otpauth://totp/ACME:ada?secret=JBSWY3DPEHPK3PXP&issuer=ACME");
  if (o.kind !== "otp") throw new Error(`otp kind ${o.kind}`);
  if (/JBSWY3DPEHPK3PXP/.test(o.text)) throw new Error("the TOTP secret is displayed");
});

await test("MD-05 · hostile and degenerate payloads do not throw", { "MD-05": "full" }, () => {
  // A detector returning junk must not take down the camera pipeline.
  const cases: unknown[] = [null, undefined, 42, {}, "", "   ", "\0\0\0", "x".repeat(10000)];
  for (const c of cases) {
    const r = classifyScan(c as string);
    if (typeof r.text !== "string") throw new Error(`payload ${String(c).slice(0, 12)} produced no text`);
    if (r.url !== undefined && r.kind !== "url") throw new Error("a non-url result carried a url");
  }
  if (!classifyScan("x".repeat(10000)).warned) throw new Error("an oversized payload was silently truncated");
  if (classifyScan("") .warned === undefined) throw new Error("an empty payload should say it was empty");
});

await test("MD-05 · the scanner text admits a missing detector", { "MD-05": "full" }, () => {
  const noDetector = describeScanner(false, true);
  if (!/no BarcodeDetector/i.test(noDetector)) throw new Error(`does not admit it: ${noDetector}`);
  if (!/No camera/i.test(describeScanner(true, false))) throw new Error("a missing camera is not stated");
  if (!/only http/i.test(describeScanner(true, true))) throw new Error("the scheme policy is not stated to the user");
});

finish();
