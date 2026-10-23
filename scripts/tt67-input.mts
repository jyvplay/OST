/**
 * TT67 IN-02 (Learn my mouse) + IN-03 (keyboard layout awareness) — the pure halves, in Node.
 *
 * Ground truth used here (not our own code):
 *  - layout tables: what the physical keys used by our bindings type, unshifted and shifted, on US QWERTY, French
 *    AZERTY, German QWERTZ, US Dvorak and Russian JCUKEN (the standard OS layouts; only the dozen keys our bindings use);
 *  - UI Events KeyboardEvent.code = the physical key (layout-independent), .key = the character the layout produced;
 *  - the settings server validator (src/lib/settings-validate.ts) must agree with the client rule.
 * The "before" test loads the TT66 shortcuts.ts from git and shows the old matcher violates the layout property, so
 * the defect is demonstrated by a run, not asserted.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt67-input.mts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { BINDINGS, BINDING_CODES, chordLabel, codeOfToken, comboFor, LAYOUT_CODE, learnLayoutPair, matchChord, mergeLayoutPair, type Preset } from "../src/lib/shortcuts.ts";
import { captureNextButton, DEFAULT_MOUSE, guardedButtons, learnButton, mouseConfigFrom, MOUSE_BACK_KEY, MOUSE_FORWARD_KEY, navActionFor, validMouseButtonSetting } from "../src/lib/input.ts";
import { validateSetting } from "../src/lib/settings-validate.ts";
import { holdModal, isAskOpen } from "../src/lib/ask.ts";

const { test, finish } = makeHarness("tt67-input");
const IN2 = { "IN-02": "full" } as const;
const IN3 = { "IN-03": "full" } as const;
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

/* ------------------------------------------------------------------ layouts: code → [unshifted, shifted] */
type Layout = Record<string, [string, string]>;
const letters = (over: Record<string, string>): Layout => {
  const out: Layout = {};
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") { const ch = over[`Key${c}`] ?? c.toLowerCase(); out[`Key${c}`] = [ch, ch.toUpperCase()]; }
  return out;
};
const LAYOUTS: Record<string, Layout> = {
  "US QWERTY": { ...letters({}), Backquote: ["`", "~"], Slash: ["/", "?"] },
  "FR AZERTY": { ...letters({ KeyA: "q", KeyQ: "a", KeyZ: "w", KeyW: "z", KeyM: "," }), KeyM: [",", "?"], Backquote: ["²", "³"], Slash: ["!", "§"] },
  "DE QWERTZ": { ...letters({ KeyZ: "y", KeyY: "z" }), Backquote: ["^", "°"], Slash: ["-", "_"] },
  "US Dvorak": { ...letters({ KeyQ: "'", KeyW: ",", KeyE: ".", KeyR: "p", KeyT: "y", KeyY: "f", KeyU: "g", KeyI: "c", KeyO: "r", KeyP: "l", KeyS: "o", KeyD: "e", KeyF: "u", KeyG: "i", KeyH: "d", KeyJ: "h", KeyK: "t", KeyL: "n", KeyZ: ";", KeyX: "q", KeyC: "j", KeyV: "k", KeyB: "x", KeyN: "b" }),
    KeyQ: ["'", "\""], KeyW: [",", "<"], KeyE: [".", ">"], KeyZ: [";", ":"], Backquote: ["`", "~"], Slash: ["z", "Z"] },
  "RU JCUKEN": { ...letters({ KeyA: "ф", KeyQ: "й", KeyZ: "я", KeyE: "у", KeyN: "т", KeyI: "ш", KeyF: "а", KeyW: "ц", KeyM: "ь", KeyT: "е" }), Backquote: ["ё", "Ё"], Slash: [".", ","] },
};
const lookupOf = (L: Layout) => (code: string) => L[code]?.[0];
/** The KeyboardEvent a layout produces for a chord pressed on its physical key. */
function eventFor(chord: string, L: Layout) {
  const parts = chord.split("+");
  const code = codeOfToken(parts[parts.length - 1]);
  const shift = parts.includes("Shift");
  const key = L[code] ? L[code][shift ? 1 : 0] : parts[parts.length - 1];
  return { code, key, ctrlKey: parts.includes("Ctrl"), altKey: parts.includes("Alt"), shiftKey: shift, metaKey: parts.includes("Meta") } as unknown as KeyboardEvent;
}
const PRESETS: Preset[] = ["hybrid", "windows", "mac"];
/** Violations of: "pressing chord c's physical key matches c and no other chord of the preset". */
function violations(match: (e: KeyboardEvent, c: string) => boolean): string[] {
  const out: string[] = [];
  for (const [lname, L] of Object.entries(LAYOUTS)) for (const p of PRESETS) {
    const chords = [...new Set(BINDINGS.map((b) => comboFor(b, p)))].filter((c) => !c.endsWith("Arrows"));
    for (const c of chords) {
      if (!LAYOUT_CODE.test(codeOfToken(c.split("+").pop()!))) continue;
      const e = eventFor(c, L);
      if (!match(e, c)) out.push(`${lname}/${p}: ${c} does not match its own key`);
      for (const o of chords) if (o !== c && match(e, o)) out.push(`${lname}/${p}: pressing ${c} (types "${e.key}") also fires ${o}`);
    }
  }
  return out;
}

await test("IN-03 layout property: on 5 layouts × 3 presets, a chord's physical key fires that chord and NO other (incl. the AZERTY Meta+A / Meta+Q case)", IN3, () => {
  const v = violations(matchChord);
  ok(v.length === 0, v.slice(0, 6).join(" | "));
  // the concrete report: AZERTY, hybrid — physical KeyQ types "a"
  const az = LAYOUTS["FR AZERTY"];
  ok(matchChord(eventFor("Meta+Q", az), "Meta+Q") && !matchChord(eventFor("Meta+Q", az), "Meta+A"), "AZERTY KeyQ ('a') = Overview only");
  ok(matchChord(eventFor("Meta+A", az), "Meta+A") && !matchChord(eventFor("Meta+A", az), "Meta+Q"), "AZERTY KeyA ('q') = Launcher only");
});

await test("IN-03 before: the TT66 matcher (git 2edf699) violates the same property — the defect is real, not asserted", IN3, async () => {
  const src = execFileSync("git", ["show", "2edf699:src/lib/shortcuts.ts"], { encoding: "utf8" });
  const path = `/tmp/tt67-shortcuts-before-${process.pid}.ts`;
  writeFileSync(path, src);
  const old = (await import(path)) as { matchChord: (e: KeyboardEvent, c: string) => boolean };
  const v = violations(old.matchChord);
  ok(v.some((x) => x.startsWith("FR AZERTY/hybrid: pressing Meta+Q (types \"a\") also fires Meta+A")), `expected the AZERTY collision, got: ${v.slice(0, 4).join(" | ")}`);
  ok(v.length >= 3, `old matcher violations: ${v.length}`);
});

await test("IN-03 fallbacks: an event without a code (synthetic / virtual keyboard) still matches by character; named keys, Arrows and modifiers are exact", IN3, () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ code: "", key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o }) as KeyboardEvent;
  ok(matchChord(ev({ key: "q", metaKey: true }), "Meta+Q"), "codeless 'q' → Meta+Q");
  ok(!matchChord(ev({ key: "q", metaKey: true, shiftKey: true }), "Meta+Q"), "extra Shift refused");
  ok(matchChord(ev({ code: "ArrowLeft", key: "ArrowLeft", metaKey: true, shiftKey: true }), "Meta+Shift+Arrows"), "Arrows by code");
  ok(matchChord(ev({ key: "ArrowUp", metaKey: true, altKey: true }), "Meta+Alt+Arrows"), "Arrows by key when code is empty");
  ok(matchChord(ev({ code: "F4", key: "F4", altKey: true }), "Alt+F4") && !matchChord(ev({ code: "F4", key: "F4" }), "Alt+F4"), "named key exact");
  ok(matchChord(ev({ code: "Space", key: " ", ctrlKey: true }), "Ctrl+Space"), "Space by code");
  ok(!matchChord(ev({ code: "Digit1", key: "&", metaKey: true }), "Meta+A"), "a digit key never matches a letter");
});

await test("IN-03 labels: chordLabel shows what the physical key types on each layout; named keys untouched; '+' spelled Plus; dead / multi-char values ignored", IN3, () => {
  const az = lookupOf(LAYOUTS["FR AZERTY"]), ru = lookupOf(LAYOUTS["RU JCUKEN"]), dv = lookupOf(LAYOUTS["US Dvorak"]);
  eq(chordLabel("Meta+Q", az), "Meta+A", "AZERTY Overview"); eq(chordLabel("Meta+A", az), "Meta+Q", "AZERTY Launcher");
  eq(chordLabel("Ctrl+Backquote", az), "Ctrl+²", "AZERTY Backquote"); eq(chordLabel("Shift+Slash", az), "Shift+!", "AZERTY Slash");
  eq(chordLabel("Meta+Q", ru), "Meta+Й", "Cyrillic upper-cased"); eq(chordLabel("Meta+Z", dv), "Meta+;", "Dvorak punctuation");
  eq(chordLabel("Meta+ArrowLeft", az), "Meta+ArrowLeft", "arrow untouched"); eq(chordLabel("Alt+F4", az), "Alt+F4", "F-key untouched");
  eq(chordLabel("Ctrl+Space", az), "Ctrl+Space", "Space untouched"); eq(chordLabel("Meta+Q"), "Meta+Q", "no layout → neutral");
  eq(chordLabel("Ctrl+Equal", () => "+"), "Ctrl+Plus", "+ spelled Plus");
  eq(chordLabel("Meta+Q", () => "Dead"), "Meta+Q", "multi-char value ignored"); eq(chordLabel("Meta+Q", () => " "), "Meta+Q", "whitespace ignored");
  eq(chordLabel("", az), "", "empty chord");
  // injectivity: on every layout and preset, different chords never show the same label
  for (const [n, L] of Object.entries(LAYOUTS)) for (const p of PRESETS) {
    const chords = [...new Set(BINDINGS.map((b) => comboFor(b, p)))];
    const labels = chords.map((c) => chordLabel(c, lookupOf(L)));
    ok(new Set(labels).size === chords.length, `${n}/${p}: duplicate labels ${labels.join(",")}`);
  }
});

await test("IN-03 learner: only unmodified, non-secret, non-composing presses of binding keys teach; shifted symbols never; CapsLock/Shift letters fold to the key's letter", IN3, () => {
  const k = (code: string, key: string, o: Record<string, boolean> = {}) => ({ code, key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...o });
  eq(learnLayoutPair(k("KeyQ", "a")), ["KeyQ", "a"], "plain AZERTY Q");
  eq(learnLayoutPair(k("KeyQ", "A")), ["KeyQ", "a"], "CapsLock letter");
  eq(learnLayoutPair(k("KeyQ", "A", { shiftKey: true })), ["KeyQ", "a"], "Shift letter");
  eq(learnLayoutPair(k("Slash", "§", { shiftKey: true })), null, "shifted symbol refused");
  eq(learnLayoutPair(k("Slash", "!")), ["Slash", "!"], "unshifted symbol");
  for (const m of ["ctrlKey", "altKey", "metaKey", "isComposing"]) eq(learnLayoutPair(k("KeyQ", "a", { [m]: true })), null, `${m} refused`);
  eq(learnLayoutPair(k("KeyQ", "a"), true), null, "secret field refused");
  eq(learnLayoutPair(k("KeyJ", "j")), null, "a key no binding uses is never recorded (privacy)");
  eq(learnLayoutPair(k("Space", " ")), null, "space refused"); eq(learnLayoutPair(k("Backquote", "Dead")), null, "dead key refused");
  ok(!BINDING_CODES.has("KeyJ") && BINDING_CODES.has("KeyQ") && BINDING_CODES.has("Backquote") && BINDING_CODES.has("Slash"), "binding code set");
  ok(BINDING_CODES.size <= 16, `recorded key set stays small: ${BINDING_CODES.size}`);
});

await test("IN-03 layout switch: a learned pair evicts the stale key that typed the same character, so labels stay distinct after AZERTY → QWERTY", IN3, () => {
  const t = new Map<string, string>();
  for (const [c, ch] of [["KeyQ", "a"], ["KeyA", "q"]] as const) mergeLayoutPair(t, [c, ch]); // AZERTY session
  eq(chordLabel("Meta+Q", (c) => t.get(c)), "Meta+A", "AZERTY label");
  ok(mergeLayoutPair(t, ["KeyQ", "q"]), "QWERTY Q learned"); // user switches to QWERTY and types q
  ok(!t.has("KeyA"), "stale KeyA→q evicted");
  const l1 = chordLabel("Meta+Q", (c) => t.get(c)), l2 = chordLabel("Meta+A", (c) => t.get(c));
  ok(l1 !== l2, `labels distinct: ${l1} / ${l2}`);
  ok(!mergeLayoutPair(t, ["KeyQ", "q"]), "re-learning the same pair is not a change");
});

await test("IN-02 config: stored indices are validated (0 / 2 / non-numbers / >31 / Back = Forward fall back to 3 / 4); the server validator agrees with the client rule on every input", IN2, () => {
  eq(mouseConfigFrom({}), DEFAULT_MOUSE, "default");
  eq(mouseConfigFrom({ [MOUSE_BACK_KEY]: "4", [MOUSE_FORWARD_KEY]: "3" }), { ...DEFAULT_MOUSE, back: 4, forward: 3 }, "swapped device");
  eq(mouseConfigFrom({ [MOUSE_BACK_KEY]: "5" }), { ...DEFAULT_MOUSE, back: 5, forward: 4 }, "extra button");
  for (const bad of ["0", "2", "x", "32", "-1", "1.0", "", "03"]) eq(mouseConfigFrom({ [MOUSE_BACK_KEY]: bad }).back, 3, `bad "${bad}"`);
  eq(mouseConfigFrom({ [MOUSE_BACK_KEY]: "4", [MOUSE_FORWARD_KEY]: "4" }), DEFAULT_MOUSE, "Back = Forward → default pair");
  const inputs = [...Array.from({ length: 41 }, (_, i) => String(i)), "", "03", "-1", "1.0", " 3", "3 ", "1e1", "x"];
  for (const v of inputs) {
    const client = validMouseButtonSetting(v), server = validateSetting(MOUSE_BACK_KEY, v) === null && validateSetting(MOUSE_FORWARD_KEY, v) === null;
    ok(client === server, `client/server disagree on "${v}": ${client} vs ${server}`);
  }
});

await test("IN-02 learning: main / secondary refused with a reason; learning the other action's index swaps them; re-learning the same index is a no-op; navAction + guard follow", IN2, () => {
  const r0 = learnButton(DEFAULT_MOUSE, "back", 0), r2 = learnButton(DEFAULT_MOUSE, "back", 2);
  ok(!r0.ok && /main/.test(r0.reason) && !r2.ok && /secondary/.test(r2.reason), "0 / 2 refused");
  const s = learnButton(DEFAULT_MOUSE, "back", 4);
  ok(s.ok && s.swapped && s.cfg.back === 4 && s.cfg.forward === 3, `swap: ${JSON.stringify(s)}`);
  const same = learnButton(DEFAULT_MOUSE, "back", 3);
  ok(same.ok && !same.swapped && same.cfg.back === 3 && same.cfg.forward === 4, "same index: no swap");
  const x = learnButton(DEFAULT_MOUSE, "forward", 6);
  ok(x.ok && !x.swapped && x.cfg.forward === 6 && x.cfg.back === 3, "a 6th button");
  if (!s.ok || !x.ok) throw new Error("unreachable");
  eq([navActionFor(s.cfg, 4), navActionFor(s.cfg, 3), navActionFor(s.cfg, 1)], ["back", "forward", null], "navAction under the swap");
  eq(guardedButtons(DEFAULT_MOUSE), [3, 4], "guard default");
  eq(guardedButtons(x.cfg), [3, 4, 6], "guard keeps the browser's 3 / 4 AND the learned 6");
  ok(!learnButton(DEFAULT_MOUSE, "back", 32).ok && !learnButton(DEFAULT_MOUSE, "back", 1.5).ok, "out of range refused");
});

/* ------------------------------------------------------------------ captureNextButton on a plain EventTarget */
function mouse(type: string, button: number) { const e = new Event(type, { cancelable: true }); Object.defineProperty(e, "button", { value: button }); return e; }
function key(k: string) { const e = new Event("keydown", { cancelable: true }); Object.defineProperty(e, "key", { value: k }); return e; }

await test("IN-02 capture: refused presses keep listening and still swallow their context menu; the accepted press is consumed with its trailing mouseup / auxclick (800 ms), then released — even when React disposes the capture right after the press; Escape cancels; dispose is idempotent", IN2, async () => {
  const t = new EventTarget() as unknown as Window;
  const got: number[] = []; let cancelled = 0;
  const dispose = captureNextButton((b) => { got.push(b); return b !== 0 && b !== 2; }, () => { cancelled++; }, t);
  // the page's own listeners (registered after the capture = what a window capture listener precedes in a real DOM)
  const later: string[] = [];
  for (const ty of ["mouseup", "auxclick", "contextmenu", "keydown", "pointerdown"]) t.addEventListener(ty, () => later.push(ty));
  const cm = mouse("contextmenu", 2);
  t.dispatchEvent(mouse("pointerdown", 2)); t.dispatchEvent(mouse("mousedown", 2)); t.dispatchEvent(cm);
  ok(cm.defaultPrevented, "refused right press: context menu cancelled");
  eq(got, [2], "pointerdown + mousedown of one press counted once");
  const down = mouse("pointerdown", 4); t.dispatchEvent(down);
  eq(got, [2, 4], "accepted 4"); ok(down.defaultPrevented, "accepted press cancelled");
  const up = mouse("mouseup", 4), aux = mouse("auxclick", 4); t.dispatchEvent(up); t.dispatchEvent(aux);
  ok(up.defaultPrevented && aux.defaultPrevented, "trailing events cancelled");
  t.dispatchEvent(mouse("pointerdown", 3)); eq(got, [2, 4], "finished: later presses are not captured");
  // a bare EventTarget has no capture phase, so only "captured presses never reach the page" is modelled here; the
  // trailing-event propagation through a real window capture phase is checked in Chromium (e2e-tt67-input)
  eq(later.filter((x) => x === "pointerdown").length, 1, `page listeners saw only the post-capture press: ${later}`);
  await new Promise((r) => setTimeout(r, 850));
  const up2 = mouse("mouseup", 3); t.dispatchEvent(up2); ok(!up2.defaultPrevented && later.includes("mouseup"), "trail released after 800 ms");
  dispose(); dispose();
  // Escape path
  const t2 = new EventTarget() as unknown as Window; let n = 0;
  const d2 = captureNextButton(() => { n++; return true; }, () => { cancelled++; }, t2);
  const other = key("q"); t2.dispatchEvent(other); ok(other.defaultPrevented && cancelled === 0, "other keys swallowed, not cancelling");
  t2.dispatchEvent(key("Escape")); ok(cancelled === 1, "Escape cancels");
  t2.dispatchEvent(mouse("pointerdown", 4)); ok(n === 0, "nothing captured after cancel"); d2();
  // React path (TT67 real-browser finding): the effect cleanup disposes the capture right after the accepted press,
  // before its mouseup / auxclick — the trail must survive the disposer
  const t3 = new EventTarget() as unknown as Window;
  const d3 = captureNextButton(() => true, () => undefined, t3);
  t3.dispatchEvent(mouse("pointerdown", 4)); d3();
  const up3 = mouse("mouseup", 4), aux3 = mouse("auxclick", 4); t3.dispatchEvent(up3); t3.dispatchEvent(aux3);
  ok(up3.defaultPrevented && aux3.defaultPrevented, "trailing events swallowed even after an immediate dispose");
  const d4 = mouse("pointerdown", 4); t3.dispatchEvent(d4); ok(!d4.defaultPrevented, "disposed: no new press is captured");
  await new Promise((r) => setTimeout(r, 850));
  const up4 = mouse("mouseup", 4); t3.dispatchEvent(up4); ok(!up4.defaultPrevented, "trail ends on its own after 800 ms");
});

await test("IN-02 modal hold: holding keeps isAskOpen() true (Shell + Switcher ignore global chords); a double release can't unbalance it", IN2, () => {
  ok(!isAskOpen(), "closed at start");
  const r1 = holdModal(), r2 = holdModal();
  ok(isAskOpen(), "held"); r1(); r1(); ok(isAskOpen(), "still held by the second hold after a double release of the first");
  r2(); ok(!isAskOpen(), "released");
});

await test("SH-06 hot corner: fires once on ENTRY, never again while the pointer rests or jitters inside, re-arms after leaving; the TT66 rule (re-fire every 1.2 s inside) reopened a just-closed launcher", { "SH-06": "full" }, async () => {
  const { hotCornerTracker, TOP_LEFT_ZONE } = await import("../src/lib/hot-corner.ts");
  const step = hotCornerTracker();
  const path: [number, number][] = [[300, 300], [2, 20], [3, 21], [2, 22], [1, 20], [300, 300], [0, 0], [5, 41], [6, 10], [1, 42], [-1, 5], [300, 300], [6, 10], [2, 42], [5, 41]];
  const fired = path.map(([x, y]) => step(x, y));
  eq(fired, [false, true, false, false, false, false, true, false, false, false, false, false, false, false, true], "fires (x = 6 / y = 42 are outside)");
  ok(TOP_LEFT_ZONE.w === 6 && TOP_LEFT_ZONE.h === 42, "zone");
  // before: the TT66 debounce rule, replayed on a resting pointer sampled every 100 ms for 3 s
  let last = -1e9, tt66 = 0, now = 0;
  const s2 = hotCornerTracker(); let ours = 0;
  for (let t = 0; t <= 3000; t += 100) { now = t; const [x, y] = [2 + (t / 100) % 2, 20]; if (x < 6 && y < 42 && now - last > 1200) { last = now; tt66++; } if (s2(x, y)) ours++; }
  ok(tt66 === 3 && ours === 1, `resting 3 s: TT66 rule fired ${tt66}x, now ${ours}x`);
});

await finish();
