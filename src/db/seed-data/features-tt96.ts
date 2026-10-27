import type { SpecRow } from "./row";

/** Bounded calculator expansion; not a canonical Class A promotion. */
export function patchTT96(row: SpecRow): SpecRow {
  if (row.code === "LY-06") return {
    ...row,
    nuance: `${row.nuance} The classic desktop context menu is measured and kept inside the desk; an oversized menu scrolls. Placement is remeasured when the desk or menu changes size.`,
    test: `${row.test}; e2e-tt96-desktop-menu.mts checks lower edges, resize, Art dock and large-text scrolling, plus an injected offscreen-placement detection case in headless Chromium.`,
  };
  if (row.code === "FM-09" || row.code === "AX-08") return {
    ...row,
    test: `${row.test}; e2e-tt96-files-contrast.mts checks a selected Files server badge with axe under 13 light/dark styles, hovered and unhovered, plus an injected old-color detection case.`,
  };
  if (row.code !== "PR-09") return row;
  return {
    ...row,
    status: "partial",
    route: "Calculator scientific mode + local fixed-width programmer mode + optional browser-local history",
    nuance: "Scientific mode and the command palette share the existing no-eval Number evaluator, selected unit conversions and 12-significant-digit formatting. Programmer mode separately evaluates bounded 8/16/32/64-bit BigInt integer expressions, bitwise operations and shifts with word wrapping and explicit signedness. History is in memory by default; an explicit opt-in stores records unencrypted in this browser's localStorage, not as Notes, not in global Search or backups, and never in an amnesic session. The UI displays up to 40 recent records and prunes after successful saves. Browser storage can be cleared, unavailable or corrupted; Web Locks coordinate participating tabs when available. Without locks, concurrent pruning and clearing are best effort and can leave extra records; other devices and non-cooperating clients are not coordinated. Full scientific/keypad/unit breadth and device coverage are not established.",
    test: "tt95-calculator-audit.mts checks the partial register, scientific/palette behavior and default session-only history. tt96-programmer.mts checks bounds, precedence and 2,112 deterministic cases against a separate Python integer oracle; tt96-calc-history.mts exercises storage fault doubles; e2e-tt96-calculator.mts tests the UI, real localStorage, opt-in, reload, filtering, deletion, quota/corruption, amnesia, offline and a held Web Lock across two Chromium tabs. tt96-calculator-mutants.py tests selected mutations in a temporary copy. None proves all devices or histories.",
  };
}
