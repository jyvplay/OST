# TT67 — namespace-aware SpreadsheetML reading (FF-51) + IN-02 "Learn my mouse", IN-03 layout-aware shortcuts, SH-06 hot corner made real

## Runtime honesty

Used: the bash sandbox, Node 22 + tsc, Next 16.2.6 production build, Chromium 143 headless through Playwright 1.64.1
(with trusted input via the DevTools protocol: `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent` with buttons
back / forward / right), embedded Postgres 17.10, and the Python 3.11 venv (lxml, openpyxl) as independent oracles. Test
corpus: Apache POI test-data (353 .xlsx, Apache-2.0; 15 of them are unreadable zips), used for tests only.

Not available, so NOT claimed: Excel / LibreOffice (no "opens in Office" check), a physical mouse with remapped side
buttons, a non-US keyboard or an OS layout switch, Firefox / Safari, theorem provers. The AZERTY tests simulate what
such a keyboard REPORTS (code `KeyQ` with key `"a"`); the mouse tests use CDP's back / forward buttons (indices 3 / 4),
which is how Chromium reports a real side button.

## A. Formal model

**Namespaces (FF-51).** A part is a tree whose element and attribute names are expanded names (URI, local). The
reader matches literal names, so we define a canonical spelling `C: URI → prefix` (`SML_CANON`: the main, strict and
Excel 2007 beta SpreadsheetML URIs → `""`, relationships → `r`, mc, x14, xm, a, c, xdr) and a rewrite `N(x)` with:
1. `expanded(N(x)) = expanded(x)` for every element, attribute, text node, comment and PI (checked by lxml);
2. every element / attribute in a URI of `C` is spelled with `C`'s prefix; a foreign URI never carries a canonical
   prefix (it is aliased `nsK`, with K chosen so no source prefix is reused);
3. MCE attributes (`Ignorable`, `ProcessContent`, `Choice@Requires`, …) name prefixes, so their tokens are renamed with
   the elements; their meaning token by token is checked by the oracle;
4. `N(N(x)) = N(x)`, and `N(x) = x` (the same string, no copy) when `x` is already canonical (Excel's own output);
5. the knownRoot guard: if the root element's URI ∉ C, then `N(x) = x` (the TT66 namespace-blind reading), so the change
   can only add readable files, never lose one.
Default namespaces: all source `xmlns=` declarations are dropped. Each unprefixed output element gets exactly the
`xmlns="…"` its expanded name needs relative to the output default in scope (`outDef`, kept on the element stack and
restored after self-closing elements), including `xmlns=""` for no-namespace elements.

**Numeric character references.** `dec` maps `&#d;` / `&#xh;` to U+cp in ONE pass, together with the 5 predefined
entities (so `&amp;lt;` → the text `&lt;`). A cp that is not a character (surrogate, > U+10FFFF) stays literal.

**IN-02.** State `(back, forward)` ∈ {1, 3..31}², back ≠ forward, default (3, 4). `learn(which, b)`: refuse b ∈ {0, 2};
if b is the other action's button, swap the two; the guard cancels the navigation default for {3, 4, back, forward}.
Capture: a press is consumed at window capture; its trailing mouseup / pointerup / auxclick / click / contextmenu are
swallowed for 800 ms, **even if the capture is disposed in between**.

**IN-03.** A letter / digit chord names a physical key (`code`); `match(e, chord) ⇔ modifiers equal ∧ e.code =
code(chord)` (the produced character only when `e.code` is empty). Property: on 5 layouts × 3 presets, a chord's own
key fires that chord and no other. Labels = Keyboard Map ∪ learned (code → unshifted char) pairs; a pair evicts any
other code mapped to the same char.

**SH-06.** `fire(t) ⇔ inside(t) ∧ ¬inside(t−1)`: one fire per entry, and the state survives re-renders.

## B. Hypotheses

- H+ (confirmed): x: / s:-prefixed SpreadsheetML exists in real files. 7 corpus workbooks were rejected ("workbook has no
  readable sheets") or read empty by TT66; they open now, and every non-empty cell equals an independent lxml reader
  (and openpyxl on the 6 it can open; 65016.xlsx: 68 048 cells).
- H+ (confirmed): `&#10;` / `&#xA;` / `&#039;` were shown raw in 3 corpus files (12 strings); now they are decoded.
- H− (refuted, found in self-review): "alias every foreign default under a canonical `""`" would be safe. It made
  sample-beta.xlsx (the Excel 2007 beta namespace) unreadable. Fixed with the beta URI in the map plus the knownRoot guard.
- H∂ (partial): canonicalising for Word as well. `WML_CANON` exists, but the docx corpus has 0 non-`w:` prefixes, so
  nothing is wired without evidence.
- H+ (confirmed): TT66's matcher let Meta+Q fire Meta+A on AZERTY (before-evidence test against git 2edf699).

## C. Frontier (what is still not Class A here)

- Constant empty-text cells are dropped on read (COUNTA / ISBLANK differ; 84 cells in 59746).
- `xmlAttrs` reads only double-quoted attributes without spaces around `=` (no corpus file needs more).
- SH-06 is **partial**: one corner only; no edge triggers or gestures.
- IN-03 labels need the Keyboard Map API (Chromium) or typed keys; Firefox / Safari learn from typing only.
- A learned middle button cancels middle-click window-wide.

## D. Negative shapes tested (≥ 15)

1. Comment / CDATA / PI lookalikes of prefixed tags are left untouched.
2. A foreign namespace on the `x14` prefix is aliased and never read as CF (TT66: a false rule).
3. x14 as the default namespace.
4. A deep redeclaration of `x:` to x14 inside `x:extLst`.
5. MCE `Ignorable` / `ProcessContent` / `Requires` under renamed prefixes.
6. `>` inside an attribute value.
7. Single quotes and newlines inside tags.
8. `xml:space` is preserved.
9. Undeclaring the default namespace.
10. No-namespace siblings under a canonical output default.
11. A strict namespace with an `s:` prefix and `rs:id`.
12. Alias collision with a source `ns1`.
13. Declaration text inside an attribute value; xmlMaps.xml is the real case.
14. Unknown root namespace → unchanged.
15. A lone surrogate or > U+10FFFF reference stays literal.
16. `&amp;lt;` is not double-decoded.
17. A malformed part or an unreadable package is reported by the x14 oracle.
18. Mouse buttons 0 and 2 are refused, and the right press's context menu never reaches the page.
19. A stored pair with "03", " 3", "3.0", 0, 2, >31 or Back = Forward falls back to 3 / 4.
20. A password field teaches no layout pair.
21. Shifted symbols and modified presses teach nothing.
22. A pointer resting or jittering in the hot corner does not re-fire.

The modal-shortcut test: Meta+Q behind the learn overlay opens neither Overview nor the launcher (e2e). The holdModal
balance is covered in unit tests.

## E. Mechanism-distinct approaches considered (≥ 6)

1. A namespace-aware DOM parser for every part. Rejected: cost (4 MB sheets) and a rewrite of every reader.
2. Making the regex readers prefix-agnostic (`(?:\w+:)?c`). Rejected: still wrong for foreign namespaces on canonical
   prefixes; this is exactly the TT66 false-positive case.
3. **Chosen:** canonicalise once at the part-read boundary with a fast path.
4. Stripping all prefixes. Rejected: it merges x14 into the main namespace.
5. Rejecting non-canonical files with an error. Rejected: it loses files that open elsewhere.
6. Reading the default namespace from the root only. Rejected: inner schemas (xmlMaps) redeclare it.
7. IN-03 by character matching with a layout table. Rejected: it double-fires on AZERTY; physical codes are the spec'd
   `KeyboardEvent.code` semantics.

## F. Artifacts

- `src/lib/office/xml-ns.ts`; `src/lib/formula/xlsx.ts` (`get` wiring, `dec`).
- `src/lib/hot-corner.ts`; `src/lib/input.ts`; `src/lib/shortcuts.ts`; `src/lib/keyboard-layout.ts`.
- `src/components/MouseButtonsSettings.tsx`; `DesktopSurface.tsx`.
- Oracles (test-only): `scripts/oracle/xml_ns_equiv.py` (lxml equivalence), `scripts/oracle/xlsx_values_lxml.py`
  (independent namespace-aware cell reader); `xlsx_x14.py` now reports malformed input.
- Suites: `tt67-sheet-ns.mts` (12), `tt67-input.mts` (11), `e2e-tt67-input.mts` (5).
- Mutants: `tt67-sheet-ns-mutants.py` (15), `tt67-input-mutants.py` (25).
- Register: `src/db/seed-data/features-tt67.ts` (FF-51 new; FF-21, IN-02, IN-03, SH-06 updated); SEED 3.53.0.

## G. Second-order adversary

- The namespace mutants first scored **11/16**. The five survivors were:
  - no `xmlns=""`, outDef not restored, strict not canonical: shapes 10 and 11 were missing;
  - fast path trusting the global scan: the fake declaration was not even seen by the scan;
  - the sort: an equivalent mutant, so the sort was removed (output is canonical, so a second pass takes the fast path).
- After repair, all 15 remaining mutants are killed. 11 were killed in the full run; the 4 repaired survivors were rerun
  individually.
- The hot-corner mutants first left a boundary survivor (x = 6); the path now approaches the edge from outside.

## H. External verification

- lxml decides expanded-name equivalence for every rewritten part of the corpus plus 15 shapes.
- Cell values are checked against an lxml reader and openpyxl.
- MS-XLSX schemas validate x14 under renamed prefixes.
- Real Chromium input events drive the e2e: CDP keyboard and mouse.

## I. Repair + attack on the patch

The real-browser suite attacked the TT67 patches themselves and found three defects that the Node fakes could not:
1. **The trailing swallow was torn down by React's effect cleanup.** Accepting a press sets `learning = null`, the
   cleanup disposed the capture, and the disposer ended the trail before mouseup / auxclick arrived (`auxclick:4`
   reached the page). The disposer now leaves an active trail to expire. A unit test and a mutant pin it.
2. **The hot-corner tracker was reset by re-renders.** Shell passes a new callback on every render, and the effect
   re-created the tracker, forgetting the pointer was inside. The tracker now lives in a ref (e2e: 3 s of jitter after
   Escape no longer reopens the launcher).
3. **The learn overlay was confined to the Settings window** (a transformed ancestor). It is now portalled to `<body>`
   (e2e asserts it covers the viewport; checked visually).

Bug repair stayed within the ~1/10 budget. Every fix is a few lines.

## J. Stopping

Stopped when:
- every TT67 suite passed: tt67-sheet-ns 12/12, tt67-input 11/11, e2e-tt67-input 5/5, tt66-input 2/2, unit 23/23;
- mutants were 15/15 and 25/25;
- the whole-corpus differential showed 0 regressions;
- the full gate ran (counts in the PR section).

Not pursued this turn, and stated:
- NC-02 focus-mode suppression reasons (needs server rules and schema);
- Word namespace wiring (no evidence);
- the empty-text-cell limit.
