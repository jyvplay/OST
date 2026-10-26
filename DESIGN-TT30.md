# TT30 — Narrator: a built-in screen reader (AX-14)

**Blocker addressed:** "AX-13 is not a real screen reader" (listed after TT28 and TT29). AX-13 only *snapshotted*
Chromium's accessibility tree. TT30 adds Fusion's own screen reader. It is original code, written from the W3C
texts: accname 1.2 (step order), HTML-AAM (implicit roles) and WAI-ARIA 1.2 (live regions, states).

**Honest boundary.** This is not NVDA, JAWS, VoiceOver or Orca:
- It reads **Fusion's page only**, not other programs or the operating system.
- It speaks through the browser's `speechSynthesis`.
- Running it alongside a real screen reader doubles the speech. Settings says so and recommends leaving it off in that case.

## Runtime honesty (what was actually executed)

- **Tools:** Node 22, TypeScript (`--experimental-strip-types`), esbuild 0.25 (already a transitive dev dependency), Playwright 1.64 against the sandbox's headless Chromium (@sparticuz), and Next 16 production build on :3999 with embedded Postgres.
- **Speech, measured in this sandbox:**
  - `speechSynthesis` exists, but `getVoices()` returns **0 voices**, and every utterance fails with **`synthesis-failed`**.
  - So **audible speech was never heard or verified**.
  - What *is* verified is what the Narrator asks the browser to say (text, rate, order) and when it interrupts (`cancel`). The tests wrap the real `speak`/`cancel` calls without replacing them.
  - The UI reports the failure honestly: the caption title shows "speech failed (synthesis-failed) — captions only".
- **No real screen reader was run** (none is installable here). The only external oracle is Chromium's accessibility tree, which is what platform readers consume.

## A. Formal model

```
NNode   = abstract node (el | text): attr, children, parent, hidden, byId, labels, value, block, ::before/::after, focusable, checked, disabled
role(n) = first valid explicit token (presentation/none ignored on focusable or labelled nodes) else implicit(tag, attrs, context)
name(n) = accname steps: hidden(skip unless labelledby-ref) → aria-labelledby (fresh visited set; refs may be hidden; self-reference allowed)
          → embedded control value (inside a label/content traversal) → aria-label (non-blank) → host language (label/for, alt,
          caption, legend, value of buttons, placeholder last) → name from content (role ∈ NAME_FROM_CONTENT, or inside a traversal;
          blocks space-separated; CSS ::before/::after; CSS text-transform applied) → title
utter(n)= name ‖ contentText (READ_CONTENT roles) , roleWords , states , value , "i of N" . description
live(n) = nearest explicit aria-live (or role default: alert=assertive+atomic, status=polite+atomic, log=polite, timer/marquee=off),
          busy ⇒ hold back, relevant default "additions text"
context = landmark/dialog/named group chain; entered(prev, next) = suffix of next not shared with prev (outermost first)
reading = landmarks (announced on arrival) | atomic items (controls, headings, images) | whole text blocks (no structure inside)
          | own text of mixed elements (once); jumps by kind, no wrap
```

## B. Hypotheses

| | Hypothesis | Result |
|---|---|---|
| H+ | Our names and roles agree with Chromium's on the real Fusion UI. Pre-declared bars: names ≥ 98 %, roles ≥ 99 %. | **Confirmed:** 9,957 element comparisons, 40 modules × 3 layouts, names 100.00 %, roles 100.00 % (after the repairs in I). |
| H− | The oracle is insensitive, so agreement would be meaningless. | **Rejected:** all three source mutants are caught. Ignoring aria-label drops names to 93.3 %; button → generic drops roles to 92.3 %; ignoring text-transform yields 14 mismatches. |
| H∂ | Audible speech works. | **Undecidable here** (0 voices, synthesis-failed). Downgraded to "utterances issued correctly". |

## C. Frontier (what is not covered)

- Other programs and the OS: impossible from a web page.
- Braille displays: there is no web API.
- Caps Lock's own toggle: a page cannot suppress it, so Insert is offered as the alternative Narrator key.
- Commands that have no e2e test: D (landmark), F (field), K (link), M (read all) and Enter (activate). D, F and K are covered at the core level (`nextIndex` unit tests).
- Shadow DOM and iframes: cross-origin embeds (YouTube, Spotify) are opaque, and their content is not read.
- Reading `aria-owns` and `aria-flowto` order.
- Names of math and SVG internals.
- The oracle covers only what Chromium exposes; Firefox and WebKit may compute some names differently.

## D. Negative shapes (each has a test that must reject or stay silent)

1. A hidden child is excluded from the name.
2. An aria-hidden child is excluded.
3. A blank aria-label is ignored.
4. A generic div gets no name from content.
5. `<a>` without href is generic.
6. presentation on a focusable element is ignored.
7. An unnamed section is generic, not a region.
8. An unnamed form is generic, not a form.
9. A decorative image (`alt=""`) gets role none.
10. Placeholder loses to label and to title.
11. An HTML data-table row gets no name; an ARIA-grid row does.
12. Explicit `aria-live=off` inside a status stays silent.
13. A timer is off.
14. A busy region is held back (unit and e2e).
15. A polite status does **not** interrupt (no cancel before it).
16. Heading jumps do not wrap ("No next heading").
17. An unbound Narrator chord does nothing.
18. A junk rate falls back to 0.75 or is clamped.
19. Captions-only mode issues **no** `speak` call.
20. The Narrator cursor does **not** move keyboard focus.
21. Turning off leaves no cursor box or caption panel behind.
22. The toggle chord conflicts with no shell binding in any preset and is not browser-reserved.
23. No shell binding uses Caps Lock or Insert.

**Modal-shortcut test:** Narrator key + F1 opens the command list, a modal dialog; Esc closes it and returns focus to the exact element focused before.

## E. Mechanisms (independent ways the claims are checked)

1. A unit suite on hand-built trees, with expectations written from the spec rather than captured from the code (`tt30-unit`, 7 tests).
2. An independent oracle: Chromium's AX tree over CDP (`scripts/ax-oracle.mts`).
3. Oracle sensitivity mutants, bundled by esbuild from mutated source.
4. **Candidate selection independent of our own roles** (markup selector). This was found necessary when mutant M2 first escaped.
5. Behaviour tests on the production build, using a speech-call observer.
6. Settings persistence through the API (the toggle chord, the rate and the checkbox).
7. Screenshot review in Fusion, Business and Art (`scripts/shots-tt30.mts`).

## F. Artifacts

- `src/lib/narrator-core.ts`, `src/lib/narrator-dom.ts`, `src/components/NarratorHost.tsx`.
- `scripts/tt30-unit.mts`, `scripts/e2e-tt30.mts`, `scripts/ax-oracle.mts`, `scripts/shots-tt30.mts`.
- Settings:
  - `accessibility.narrator`, `.narratorRate` (0.75–2), `.narratorCaptions` and `.narratorSpeech`, in the seed and in validated enums.
  - UI in Settings (Display & readability → Narrator) and a Quick panel switch.
- Shortcut binding `narrator`: Ctrl+Win+Enter (Windows Narrator's chord) in hybrid/windows; Cmd+F5 (VoiceOver's) on the Mac preset.
- Register row AX-14 (`src/db/seed-data/features-tt30.ts`); seed version 3.19.0.

## G. Adversary (attacks tried)

- **"The oracle only compares what you already classify."** True at first: M2 (buttons → generic) escaped because generic nodes dropped out of the sample. Repaired with markup-based selection; M2 is now caught at 92.3 %.
- **"100 % means the comparison is trivial."** Answered by the three mutants and the baseline/mutant contrast on the same page.
- **"Uppercase headings: you changed the expectation to match yourself."** No. The oracle is Chromium. Platform readers receive Chromium's text-transformed string, so matching it is fidelity; the mutant shows the check bites.
- **"Speech is faked."** The real `speechSynthesis.speak` is called (the observer forwards it). The failure is reported to the user, and no audio claim is made.

## H. External verification

Chromium's accessibility tree (CDP `Accessibility.getPartialAXTree`) is the external reference. It is independent code (Blink's AX implementation), not ours.

## I. Repairs (each followed by a new attack)

1. **Self-reference in aria-labelledby returned ""** (loop guard). Found while writing the spec example. Fix: a fresh visited set per labelledby traversal. Attack: the unit "Delete file.pdf".
2. **List items read only "2 of 3".** Fix: a content fallback for nameless text roles (names stay spec-pure). Attack: the unit list test.
3. **Text split around inline elements was read twice.** Fix: whole-block items and own text read once. Attack: the "Press OK to continue" unit.
4. **Oracle classes:** CSS text-transform (14 headings); Chromium gives `<tr>` no name except in `role=grid` tables; an unnamed `<form>` is generic (HTML-AAM). Attack: unit tests per class, plus the M3 mutant.
5. **Independent sampling exposed missing implicit roles:** file input → button, colour input → colour picker, summary → button with expanded/collapsed, svg → img, date/time inputs. Attack: a re-scan of all modules.
6. **Speech failures were silent.** Fix: `onSpeechError` with a visible status. Attack: the screenshot shows "speech failed (synthesis-failed)".

## J. Stopping

Stopped when both pre-declared bars held over the full 40 × 3 scan, every mutant was caught and all behaviour tests passed. Remaining gaps are listed in C.
