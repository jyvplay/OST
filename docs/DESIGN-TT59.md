# DESIGN-TT59: Writer and Spreadsheet spell check, Paste Special links + Paste Link, x14 formula CF rules, GIF / BMP export

This tier follows the tier-5 protocol (A–J). Each section names the code and the suite that checks it. The numbers are under "Results".

## Runtime honesty

**What ran:**
- A bash sandbox with 2 cores and 3 GB.
- Node 22 with `--experimental-strip-types`, `tsc`, Next 16.2.6 (`next build` + `next start`).
- Playwright 1.64.1 driving headless Chromium 143 (the @sparticuz build).
- Embedded PostgreSQL 17.10.
- A Python 3.11 venv with lxml, python-docx and openpyxl, plus **spylls 0.1.7** (MPL-2.0, PyPI), a pure-Python port of Hunspell. spylls is used only as a black-box test oracle. It is not shipped, not imported by the app, and none of its code was ported. The engine is original code written against the Hunspell file-format documentation (hunspell(5)) and checked against spylls' answers.

**Not available, so nothing here claims them:**
- Theorem provers and parallel agents.
- Microsoft Word / Excel and LibreOffice. There is no check that Word underlines the same words, or that Excel draws our x14 cross-sheet rules. Those claims rest on the MS-XLSX / ECMA-376 text plus openpyxl / lxml parsing the files.
- Firefox and Safari. The CSS Custom Highlight API underlines are verified in Chromium 143 only.

**Shipped dictionary:** npm `dictionary-en@4.0.0` (wooorm), the SCOWL en_US Hunspell dictionary 2020.12.07, licence "(MIT AND BSD)". It is copied to `public/dict/` with its licence file. 49,568 entries.

## A. Formal model

**Spell engine (src/lib/spell/hunspell.ts).**
- A dictionary is `D = (Aff, Dic)`. Aff gives the flag syntax (`FLAG` char/long/num/UTF-8), `PFX`/`SFX` rules `(flag, cross, strip, add, cond)`, `KEEPCASE`, `FORBIDDENWORD`, `NEEDAFFIX`, `NOSUGGEST`, `ONLYINCOMPOUND`, `BREAK`, `COMPOUNDRULE`, `ICONV`/`OCONV`, `REP`, `MAP`, `KEY`, `TRY`, `WORDCHARS`. Dic maps a stem to its flag set.
- `check(w)` holds iff some casing variant `v ∈ variants(capType(w))` has an analysis `v = pfx·stem·sfx` where:
  - `stem ∈ Dic`, the suffix's flag ∈ flags(stem) (or the prefix's flag, or the cross-product chain);
  - the strip/condition of every applied rule holds;
  - `NEEDAFFIX` stems need at least one affix; `FORBIDDENWORD` beats every other analysis;
  - `KEEPCASE` stems accept only the stored case;
  - or `BREAK` splits w into parts that each check.
- `capType ∈ {NO, INIT, ALL, HUH, HUHINIT}` decides the variants, as in Hunspell: ALL tries the word, its lower case and its title case; INIT tries the word and its lower case.
- `suggest(w, n)` returns at most n words, every one satisfying `check`, never a `NOSUGGEST` stem, in category order: case fix → REP table → MAP → swap / KEY neighbour / delete / insert TRY char / move → split into two words → n-gram similarity. Within a category, earlier candidates rank first.
- Unsupported features (`COMPOUNDFLAG`, `CIRCUMFIX`, two-level affixes, `PHONE`, a non-UTF-8 `SET`) throw at load. A wrong verdict is never given silently.

**Tokenizer.** `tokenize(text, {skipUpper})` yields `{word, start, end}`. Words are letter runs with inner `'` / `’` / `-`. URLs, e-mail addresses, paths and tokens with digits are skipped, except ordinals (21st, 113th). With skipUpper on, all-uppercase words are skipped.

**Writer document layer (src/lib/office/wordspell.ts).**
- `spellIssues(doc, sp, opts)` = for each body paragraph (tables included) in order: tokenize the *visible* text. Text inside `w:del` is skipped. Runs with `w:noProof` are skipped, and so are runs whose `w:lang` is not English.
- Issues are `{kind: spell | repeat, pid, off, len, word}`. `repeat` = the same word twice in a row, ignoring case, separated only by whitespace.
- `fixIssue(doc, i, to)` refuses an issue whose text has changed (stale). Under Track Changes it writes `w:del` + `w:ins`.
- `changeAll` fixes right to left inside a paragraph so offsets stay valid.

**Sheet layer (src/lib/formula/sheetspell.ts).**
- Only text constants are checked. A cell starting with `=` is a formula and is skipped. Numbers, booleans and errors are skipped too.
- A leading `'` is not part of the text. Offsets are relative to the input.
- Order is row-major, which is Excel's order: row 1 left to right, then row 2.
- A fix whose result would parse as a number or formula is stored with a `'` prefix, so text stays text.

**Paste Special links (sheetops.ts).**
- With `pasteSpecial(what = all)`, every non-skipped target cell takes the source cell's link state: link or no link. With Transpose, the source (i, j) goes to the target (j, i).
- With `what ∈ {values, formulas, formats}`, target links are unchanged.
- `pasteLink(sheet, clip, srcSheet, col, row)`: target (i, j) := `=` + prefix + `$` col(origin.col + j) + `$` (origin.row + i + 1).
  - prefix = "" on the same sheet.
  - Otherwise prefix = `name!`. The name is quoted (`'…'`, with `'` doubled) unless it is a plain identifier and not A1-like or R1C1-like.

**x14 formula rules (xlsx.ts).**
- Reading: every `<x14:cfRule>` whose type is not dataBar / iconSet / colorScale, and that is not linked from a main rule, is decoded with the same function as main rules (`decodeBasic`).
  - Operands come from its `<xm:f>` children.
  - The format comes from its inline `<x14:dxf>` (`dxfFrom`, shared with styles.xml dxfs).
  - Provenance is `x<n>`, the same index the lossless patcher uses for deletion.
- Writing: a non-visual rule whose operand or formula contains a `!` outside string literals is emitted only as an x14 rule (`xm:f`, then `x14:dxf`, as in the MS-XLSX schema). Every other rule is unchanged.

**GIF / BMP export (src/lib/image/rasterenc.ts, FF-05).**
- BMP(img) = 54-byte header (BITMAPFILEHEADER + BITMAPINFOHEADER, 24 bpp, BI_RGB) + rows bottom-up, each padded to a multiple of 4 bytes. A pixel with alpha a becomes round((v·a + 255·(255 − a)) / 255) per channel.
- GIF(img):
  - P = the distinct opaque colours if |P| ≤ 255 (minus one slot if any alpha < 128); otherwise median cut to that many boxes over a 5-bit histogram, each box's count-weighted mean.
  - Each pixel maps to the nearest entry (weighted 2:4:3 RGB distance) after Floyd–Steinberg error diffusion. Diffusion only runs when the palette is not exact.
  - Alpha < 128 maps to the transparent index, declared in a Graphic Control Extension.
  - LZW: min code size = max(2, palette bits); clear first; the code width grows when the next code no longer fits; at 4096 codes, clear and reset; then EOI. Data goes in ≤ 255-byte sub-blocks, then the 0x3B trailer.

## B. Hypotheses

- **H+1:** our verdict equals spylls' verdict on every en_US word tested. *Confirmed:* 0 mismatches on 22,358 words.
- **H+2:** the hand dictionary features (FLAG long, KEEPCASE, FORBIDDENWORD, NEEDAFFIX, NOSUGGEST, BREAK, COMPOUNDRULE ?) behave like spylls. *Confirmed.*
- **H+3:** fixes in Writer save valid OOXML (lxml read-back), including as w:del/w:ins under Track Changes. *Confirmed.*
- **H+4:** a sheet fix never changes a formula or another sheet. *Confirmed* with an openpyxl fixture.
- **H+5:** Paste Link targets follow source edits. *Confirmed* in unit tests and the browser.
- **H+6:** x14 cross-sheet rules are drawn and follow edits on the other sheet. *Confirmed.*
- **H+7:** GIF ≤ 255 colours and BMP decode bit-exact in Pillow, including LZW streams past the 4096-code reset. *Confirmed.*
- **H−1:** "suggestions equal Hunspell's". *Rejected as a claim.* Ours contain spylls' first choice for 97 % of the sampled misspellings, and our first equals it for 92 %. Disclosed as "approximate".
- **H−2:** "lowercase ok is a word". *Rejected:* en_US only has "OK", and spylls agrees.
- **H∂1:** Excel 2010+ accepting our x14 cross-sheet rules. *Undecidable here* (no Excel). The structure follows MS-XLSX, and openpyxl / lxml open the file.
- **H∂2:** Safari / Firefox underline painting. *Not testable here.*

## C. Frontier

- No grammar checking, no autocorrect-as-you-type, en_US only.
- Writer headers, footers and notes are not checked.
- Sheet: no "continue on the next sheet". Notes, chart titles and shapes are not checked.
- The lossless patcher writes rules added in the app to the 2007 schema, including cross-sheet ones.
- Writer table revisions (`w:tblPrChange`, `w:trPr/w:ins`) are still not tracked.

## D. Negative shapes (≥ 15) + modal shortcut

1. A dictionary with COMPOUNDFLAG throws at load. It is never half-supported.
2. CIRCUMFIX / two-level affixes / a non-UTF-8 SET throw.
3. A FORBIDDENWORD form is rejected even when an affix rule would allow it.
4. A KEEPCASE stem ("OpenOffice" in the hand dictionary) accepts only its stored case, with the same verdicts as spylls.
5. A NOSUGGEST stem never appears in suggestions.
6. A spaced REP candidate whose parts don't check is dropped.
7. URLs, e-mail addresses and paths are never flagged, even when misspelled ("exampel.com").
8. Tracked-deleted text ("wrongg") is not flagged.
9. `w:noProof` and `w:lang fr-FR` runs are not flagged.
10. A stale issue (the text changed after the check) is refused in Writer and in Sheet.
11. A sheet formula containing a misspelled string literal is never touched.
12. A fix to "=1+1" is stored as the text `'=1+1`, not as a formula.
13. Hostile input never throws: a 5,000-char word, lone combining marks, titlecase digraphs, emoji, CJK, and a 100 kB text tokenized in < 1.5 s.
14. Paste Special Values / Formulas / Formats never copy source links and never remove target links.
15. Skip blanks keeps the target link under a blank source.
16. Paste Link is disabled with Transpose / Skip blanks / an operation.
17. A sheet called "Q1" or "R1C1" is quoted in Paste Link refs, so it is not misread as a cell.
18. An x14 rule with no usable operand is skipped. It is never drawn wrongly.
19. A same-sheet rule is never duplicated into x14.
19b. Zero-size, over-65535-px or short-buffer images are refused by the GIF / BMP encoders instead of writing a broken file.
20. **Modal shortcut:** Escape in the Writer spelling pane's text box does not close Writer. Escape in the right-click menu closes only the menu. Escape in the Sheet spelling bar closes only the bar. All are checked in e2e-tt59.

## E. Mechanism-distinct approaches (≥ 6)

1. **Differential oracle:** spylls (a separate implementation in another language) gives verdicts on 22k words.
2. **Hand-built dictionary** for features en_US doesn't use.
3. **Saved bytes read by independent parsers:** lxml / python-docx for docx, openpyxl for xlsx.
4. **Mutation testing:**
   - 6 engine mutants;
   - 4 sheet-spell mutants (one survived at first; a new test now kills it);
   - 5 paste mutants;
   - 4 x14 mutants;
   - 6 GIF/BMP mutants (one survived at first: dropping the right-hand dither term; an 8×8 block-mean check now kills it).
   All are killed.
5. **Real browser:** Playwright drives the UI and reads `CSS.highlights` directly. The screenshots were inspected.
6. **Performance and robustness bounds:** load < 1.5 s, 50k checks < 3 s, 20k cells < 4 s.
7. **Semantic follow-through:** edit the other sheet / the source, then the CF result / linked value changes.

## F. Artifacts

- Code: src/lib/image/rasterenc.ts + encode.ts / Photos.tsx (GIF, BMP export), src/lib/spell/{hunspell,client}.ts, src/lib/office/wordspell.ts, src/components/modules/writer/SpellPanel.tsx, src/lib/formula/sheetspell.ts, src/components/modules/sheet-spell.tsx, sheetops.ts (`pasteLink`, links in `pasteSpecial`), xlsx.ts (`decodeBasic`, `dxfFrom`, x14 reader / writer).
- Tests: scripts/tt59-raster.mts, tt59-writer-spell.mts, tt59-sheet-spell.mts, tt59-sheet-paste.mts, tt59-x14-cf.mts, e2e-tt59.mts.
- Oracles: scripts/oracle/spell_spylls.py, docx_spell.py.
- Screens: docs/screens/tt59-*.png.
- Register: src/db/seed-data/features-tt59.ts (new rows FF-38 and FF-39; FF-05 / FF-28 / FF-29 / FF-20 notes). SEED_VERSION 3.45.0.

## G. Second-order adversary

- *"The oracle shares your bugs."* spylls is an independent port with its own code. The dictionary is the only shared input, and both must read the same file. Mutants prove the comparison can fail.
- *"The e2e passes because the test reads your own DOM."* The underline check reads the browser's Highlight registry, and the save is read by lxml / openpyxl.
- *"Suggestion quality is cherry-picked."* Thresholds are fixed in the test (≥ 90 % / ≥ 85 %) over a seeded random sample, and the measured values are reported.
- *"The x14 fixture is your own invention."* It is built by openpyxl plus XML from the MS-XLSX element definitions (`xm:f` × ≤ 3, `x14:dxf` CT_Dxf). There was no Excel-authored file with such rules in the corpus. Disclosed.

## H. External verification

- spylls verdicts and suggestions.
- python-docx / lxml / openpyxl parse every saved file.
- Chromium's CSS Highlight registry.
- MS Learn "Paste options" and the Mac doc ("Paste Link … Excel enters an absolute reference").
- excelforum 1224624: Values onto a linked cell keeps the link.
- MS-XLSX ConditionalFormattingRule (Open XML SDK docs).

## I. Repairs, and a new attack on each patch

1. **Right-click menu inside a transformed window.** Found by this tier's own screenshot.
   - *Bug:* the menu was positioned relative to the window, not the viewport. Its autoFocus also scrolled the window body, so the toolbar went off-screen and later clicks missed the text.
   - *Fix:* portal the menu to `<body>` and clamp it to the viewport.
   - *Attack on the patch:* the e2e asserts the menu box sits at the pointer (or is lifted to stay on screen) and the toolbar does not move.
2. **Menu and context box unreadable in dark themes.** They were white on white. Both now use theme variables (`--fs-panel-solid`, `--fs-field`). Checked visually.
3. **Last typed misspelling never flagged.** The "don't flag the word being typed" rule had no re-check, so a misspelled last word stayed unmarked until the next edit.
   - *Fix:* re-check 1.55 s after typing pauses.
   - *Attack on the patch:* the e2e types a coinage and waits for the flag with no further input.
4. **Focus lost to `<body>` after the last fix.** The pressed pane button disappears, and Ctrl+S then stopped reaching Writer.
   - *Fix:* the pane keeps focus inside itself.
   - *Attack on the patch:* the e2e presses Ctrl+S right after Add to Dictionary and reads the saved file.
5. **Survivor mutant in `changeAllCells`.** Right-to-left order within a cell was untested. A new assertion (two hits in one cell, a longer replacement) kills it.

## J. Stopping

The tier stops when:
- every TT59 suite passes on the final build;
- the Office regression subset passes;
- the ledger is regenerated and the blockers are listed.

## Results

**TT59 suites on the final build:**

| Suite | Result | Notes |
|---|---|---|
| tt59-writer-spell | 8/8 | 0 / 22,358 verdict mismatches vs spylls; suggestion top-1-in 0.97, our top-1 0.92, ~84 ms/word; 6/6 mutants killed |
| tt59-sheet-spell | 5/5 | 20,000 cells in ~0.15 s; 4/4 mutants killed (one after the new test) |
| tt59-sheet-paste | 3/3 | 5/5 mutants killed |
| tt59-x14-cf | 3/3 | 4/4 mutants killed |
| tt59-raster | 5/5 | gradient mean error 4.3, block-mean 0.62; 1 MP in ~1.3 s; 6/6 mutants killed (one after the new check) |
| e2e-tt59 | 4/4 | Writer spelling, Sheet spelling + Paste Link, Photos GIF/BMP, no page errors |

**Regression subset on the final builds:** all passed. e2e-office 11, e2e-sheet-layout 7, e2e-tt49-writer 6, e2e-tt49 5, e2e-tt56 10, e2e-tt57 3, e2e-tt58 3, e2e-a11y 9, e2e-beauty 6, e2e-tt54 8, tt54-meta 6. Unit: names 7, oracle-xlsx 5, sheet-layout 6, tt46-xlsx-patch 8, tt47-sheet 8, tt49-sheet 10, tt50-charts 10, tt56-sheet-paste 4, tt57-sheet-links 6, tt58-sheet-pivot 5, office-engine-2 (exit 0).

**Not run this tier:** the full 125-suite run-all gate. It takes about 1 h on this 2-core sandbox. The subsets above cover every file changed this tier.

**Bugs found by this tier's own tests and screenshots, all fixed:** see I.1–I.5.

**Ledger:** 370 features (+2: FF-38, FF-39); built full 294 / partial 54 / blocked 21 / none 1. Tested full **208** (was 205) / partial 72 / untested 90. Tests 1095/1095. Tails: 39 rows, full 9 / partial 10 / none 20.
