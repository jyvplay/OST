import { F, type SpecRow } from "./row";

/**
 * TT30 register changes. Blocker addressed with original code: "AX-13 is not a real screen reader" — Fusion now
 * ships its own screen reader (AX-14). It is NOT NVDA / JAWS / VoiceOver; it reads Fusion's own page only.
 */
export const tt30Features: SpecRow[] = [
  F("AX-14", "AX", "Narrator: a built-in screen reader — speaks what gets focus (name, role, states, value, 'N of M', description) and the dialog or landmark being entered, echoes typing, announces live regions (polite queued, assertive interrupting), and reads the page with the Narrator key (hold Caps Lock or Insert): next / previous item, heading, landmark, field, link, read from here, where am I, repeat, speed; Ctrl stops speech; captions panel and a cursor highlight; Ctrl+Win+Enter (Cmd+F5 on the Mac preset) turns it on or off; Settings and Quick panel switches, speed and captions-only options",
    "A", "P2", "src/lib/narrator-core.ts (accessible name + role computation, utterances, live-region rules, reading order, commands); src/lib/narrator-dom.ts (DOM adapter + Narrator controller on speechSynthesis); src/components/NarratorHost.tsx",
    "Original code written from the W3C accname 1.2 / HTML-AAM / WAI-ARIA live-region rules. Verified against an independent oracle: Chromium's own accessibility tree (the one platform screen readers receive) read over the DevTools protocol for every visible control, heading, landmark, image and table part in all 40 modules and three layouts — agreement thresholds declared in advance (names ≥ 98 %, roles ≥ 99 %); deliberate alignments with Chromium are documented (CSS text-transform applies; HTML data-table rows get no name). Speech uses the browser's speechSynthesis; the tests capture the utterances (rate, text, interruption) — audible output is not verifiable in the headless sandbox (no audio device). Honest boundary: reads Fusion's page only (not other programs or the OS), Caps Lock's own toggle cannot be suppressed by a web page (Insert is the alternative), and using it together with a real screen reader doubles speech.",
    "built", "tt30-unit.mts ×7; e2e-tt30.mts (Chromium AX-tree oracle ×2, focus / dialog / live / cursor / stop / toggle behaviour)"),
];
