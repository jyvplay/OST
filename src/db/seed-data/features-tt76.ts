import { F, type SpecRow } from "./row";

/**
 * TT76 register additions + changes (user-directed: "turn both the spreadsheet apps and slides to Class A features this
 * turn … complete one other core feature into class A" → CA-02 presenter view / audience screen; "increase the number
 * of features in a testable state" → two new rows, each with a passing headless gate AND a real-browser test).
 * Class A is raised ONLY on a passing whole-corpus gate whose oracle is independent of the app: openpyxl + ClosedXML /
 * PhpSpreadsheet expectations for filters; lxml (pptx_motion.py) + python-pptx + the ECMA-376 PML XSDs for slide
 * motion (docs/DESIGN-TT76.md). Excel and PowerPoint are not available in this sandbox; "A" means ordinary-app grade
 * on the measurable corpus, not "verified in Excel / PowerPoint".
 */
const S76 = "tt76-sheet.mts", SE76 = "e2e-tt76-sheet.mts", P76 = "tt76-slides.mts", PE76 = "e2e-tt76-slides.mts";
export const tt76Features: SpecRow[] = [
  F("FF-62", "FF", "Spreadsheet AutoFilter criteria evaluated like Excel: custom (two rules, And / Or, wildcards, typed comparisons), Top / Bottom N and N %, above / below average, dynamic date periods, value lists with date grouping, cell / font colour and icon filters — authored in a Condition dialog and saved as real filterColumn XML",
    "A", "P2", "src/lib/formula/filtereval.ts (criteria model, evaluator, wildcard matcher without regex, half-open dynamic ranges, dxf colours) + filterui.ts (Condition dialog model) + sheetfilter.ts setFilterCriteria / applyAutoFilter + xlsx / xlsx-patch (filterColumn + dxf round trip) + Spreadsheet.tsx (Values / Condition tabs)",
    "Semantics from ECMA-376 §18.3.2 and the ClosedXML / PhpSpreadsheet AutoFilter test expectations (MIT; test data only). Comparison operators only match cells of the criterion's detected type; ties are included in Top N; percent count = max(1, floor(n·p/100)). The thousands-separator sample is the one declared locale boundary (18 of 19 oracle filters agree). Excel itself was not run.",
    "built", `${S76} O1 (19 oracle filters from ClosedXML / LibreOffice / POI files: 18 agree, 1 declared locale boundary), S1–S4, D1, R1–R5, U1, N1–N18; ${SE76} (Condition dialog: Top 2, Below average, wildcards Or, And across columns, This year, colour filter → openpyxl sees the same hidden rows)`),
  F("FF-63", "FF", "Slides transitions and entrance animations: Fade (smooth / through black), Cut, Push, Wipe, Cover, Uncover, Split, Zoom, Random with duration, on-click and after-time advance, Apply to all; Appear / Fade / Fly In / Wipe / Zoom on click / with / after previous with direction, duration, delay and order — edited in a Motion panel and played in the slide show and presenter view",
    "A", "P2", "src/lib/office/pmlanim.ts (transitions read / written as mc:AlternateContent p14:dur + Fallback spd, the main sequence as a typed effect list, foreign effects kept as XML with renumbered ids, read-only for timelines it cannot model, pruning on shape delete) + pmlplay.ts (CSS playback: build steps, transition layers, reduced motion) + slides/motion.tsx (Motion panel, play-order badges, ShowStage) + Slides.tsx (show steps, advance-after timer)",
    "Every other effect (emphasis, exit, motion paths, by-paragraph builds, other presets) and p14 transitions (vortex, ripple, …) are kept byte-for-byte in their place and play approximately (entrance appears, exit hides, a p14 transition plays as its Fallback kind). Interactive trigger sequences are kept, not played. Media is kept, not played. PowerPoint itself was not run.",
    "built", `${P76} M1 (95 decks / 551 slides: 216 transitions + 237 effects agree with an lxml oracle), M2 (26 decks / 301 slides re-emitted from Fusion's model: XSD-valid, python-pptx opens, lxml agrees, reread identical), M3–M6, N1–N17; ${PE76} E1–E6 (authored in the UI → saved → oracle; undo; show plays builds and a mid-wipe clip is observed; foreign effects kept; modal-shortcut test)`),
];

const UP: Record<string, { note: string; test: string; tier?: SpecRow["tier"]; status?: SpecRow["status"]; route?: string }> = {
  "FF-23": {
    tier: "A", status: "built",
    note: "TT76 class A: Slides now edits and plays slide transitions and entrance animations (FF-63) on top of lossless open / save, slide operations, notes, shape / picture / text editing, undo and Present, and adds a presenter view with an audience screen (CA-02). Deleting a shape prunes the animations that targeted it (before TT76 a dangling target was left behind — PowerPoint repairs such files). Not available: PowerPoint itself, PDF export, media playback.",
    test: `${P76} M1–M6 N1–N17 L1; ${PE76} E1–E7`,
  },
  "CA-02": {
    status: "built",
    route: "Slides ▸ Presenter view → a second window running /present?show=<sid> (drag / place it on a projector, TV or second display; moved there automatically when the Window Management permission is granted) + src/lib/office/showlink.ts (validated protocol over BroadcastChannel; PresentationConnection adapter)",
    note: "TT76: the audience screen receives the deck once (its own copy) and renders each state message locally — transitions and builds included — while the presenter keeps notes, the next build / slide, a timer and the audience link state. Clicks / keys on the audience screen ask the presenter to advance. Messages are validated strictly (another session, a stale window or junk on the channel is ignored). The Presentation API (Chromecast-class receivers) uses the same protocol as text frames but is NOT exercised here — no receiver device in the sandbox.",
    test: `${P76} L1 (real BroadcastChannel round trip, 11 hostile messages + 5 garbage frames dropped); ${PE76} E7 (two real pages: deck delivered, console → audience, audience click → console, End closes the audience)`,
  },
  "FF-21": {
    note: "TT76: AutoFilter criteria are evaluated (FF-62) instead of only kept.",
    test: `${S76}; ${SE76}`,
  },
};
export function patchTT76(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, tier: u.tier ?? f.tier, status: u.status ?? f.status, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
