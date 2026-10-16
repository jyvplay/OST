# Accessibility & readability (TT21, revised TT22)

## What the law asks for (California), and what that means here

| Source | Who it binds | Technical standard |
|---|---|---|
| ADA Title III + Unruh Civil Rights Act (Civ. Code §51) | private businesses serving Californians; an ADA violation is automatically an Unruh violation | courts and settlements benchmark **WCAG 2.1 AA** |
| ADA Title II, DOJ final rule (April 2024) | state and local government | **WCAG 2.1 AA** (compliance April 2026 / April 2027 depending on size) |
| Gov. Code §11546.7 (AB 434) with §§11135, 7405 | California state agencies | **WCAG 2.0 AA or later**, certified on the agency's home page |

**There is no legal minimum font size in pixels.** WCAG has none. The criteria that govern text size and readability are:

- **1.4.4 Resize text:** 200 % without loss of content or function.
- **1.4.3 Contrast:** 4.5:1, or 3:1 for large text.
- **1.4.11 Non-text contrast:** 3:1 for icons and controls.
- **1.4.10 Reflow:** usable at 320 CSS px wide.
- **1.4.12 Text spacing.**
- **2.5.3 Label in name.**
- **2.5.8 Target size:** 24×24 px (WCAG 2.2).

Common practice is 16 px body text and relative (rem) units, so the user's own browser font setting applies.

## What Fusion Shell does

- **Text 125 % by default; Large text mode is an opt-in switch (TT22).**
  - Every UI font size is `fz(n)` = `n × --fs-ts × 1rem/16`, and `--fs-ts` defaults to 1.25.
  - At a 16 px browser default, body text is 16.25 px and the smallest UI text is 12.5 px.
  - **Large text mode** (Settings and Quick panel switch) sets 200 %: body 26 px, smallest 20 px. Turning it off returns to 125 %.
  - TT21 made 200 % the default; the user reversed that in TT22. Existing installs still at the old 200 % default were moved to 125 % once (seed v3.10). A value the user picked themselves is never overwritten.
  - The user's browser font size multiplies on top of that (rem), and so does browser zoom.
  - Titlebars, buttons, the top bar, the shelf, icons, the launcher, the Spreadsheet grid and default window sizes scale with it.
- **Setting:**
  - Settings → *Display & readability* offers **100** / **125 (default)** / 150 / 175 / **200 (large)** / 250 / 300 % (radio group), plus A−/A+ and the Large text mode switch.
  - The Quick panel has A−/A+ and the Large text mode switch.
  - Routines accept `textsize 250`.
  - The server rejects values outside 100–300 (HTTP 422).
- **Document content is not scaled.** A Writer heading or a Vector text shape keeps its document size; zoom is a separate document feature.
- **Pinch-zoom allowed:** the viewport no longer sets `maximum-scale=1` (it did before TT21, which failed 1.4.4).
- **Icons:**
  - Every module, file type and window control is an SVG tile. Emoji rendered blank wherever there is no colour-emoji font, and the before-screenshots show blank shelf icons and invisible window buttons.
  - Glyph contrast against the gradient is ≥3:1 everywhere the glyph can sit; the lowest is 4.1:1.
- **Layout at large text:**
  - New windows are clamped inside the desktop. At 2× text the default sizes used to overflow under the shelf.
  - The Vector, Image, Lens, Notes and Quick Edit side panels have widths that scale with the text, capped at a share of the window.
  - The Spreadsheet formatting toolbar is one row that scrolls sideways (`.fs-toolbar`, `role=toolbar`) instead of wrapping onto five rows and squeezing the grid to about 150 px.
- **Names match visible labels (WCAG 2.5.3):** a short visible label such as "Clear fmt" gets the name "Clear formatting · Clear fmt". axe ignores parenthesised text, so `(Clear fmt)` did not count.
- **Forced colours and `prefers-contrast: more`:** both are honoured. Register row AX-03 claimed this before TT21, but no CSS existed.
- **Styles (TT22, AX-11; TT23, AX-12):** Poolside (default), Vice, Ocean Drive, Bubbly, and the TT23 five: Liquid Glass, Material Expressive, Fluent, Cloud Dancer and Transformative Teal (see DESIGN-THEMES-TT23.md).
  - TT23: translucent panel text is also checked composited over pure black and pure white.
  - Every style's tile/glyph pairs (≥3:1), chrome ink, accent buttons and dark/light text tokens (≥4.5:1) are checked numerically.
  - The high-contrast and forced-colours modes override every style.
- **Light theme fixes (TT22):** inputs were dark grey with dark text, and status badges kept their pale dark-theme colours. Both now use theme tokens.
  - Spreadsheet cells with a fill but no font colour get automatic black/white ink. Pure black is used because near-black cannot reach 4.5:1 on mid-greys.
  - The Terminal keeps light ink on its always-dark surface.

## How it is verified

| Check | Tool | Suite |
|---|---|---|
| WCAG 2.0/2.1/2.2 A+AA rules on all 34 module windows, plus the desktop, launcher, palette and quick panel | **axe-core 4.14** (Deque; external rules engine) in headless Chromium | `e2e-a11y.mts` |
| At the 125 % default: no visible text below 12 px and body ≥16 px (8 modules). In Large text mode: nothing below 20 px (3 modules). Measured with `getComputedStyle` over every text node | Chromium | `e2e-a11y.mts` |
| Style switch from Settings and the Quick panel (data-style, logo, wallpaper, accent, persistence, 422) | Chromium | `e2e-a11y.mts` |
| axe serious/critical rules in the **light and dark** themes for all 9 styles (18 boots; chrome + Files + Spreadsheet) | axe-core in Chromium | `e2e-a11y.mts` |
| Whiteboard (TT23): axe in three states, and a keyboard route to every element via the Layers list | axe-core + Playwright keyboard | `e2e-whiteboard.mts` |
| 300 % text at 1280×800 and a 360×640 phone: no sideways page scroll, window content fits | Chromium | `e2e-a11y.mts` |
| Icon glyph contrast, token contrast, no raw px font sizes left, no emoji in the chrome, validator | Node | `a11y-unit.mts` |
| Forced colours + more contrast emulation | Chromium | `e2e-a11y.mts` |

## Limits (honest)

- axe-core cannot judge everything:
  - whether alt text is meaningful;
  - whether reading order makes sense;
  - whether a screen-reader user can complete a task.

  No screen-reader run (NVDA/VoiceOver) has been done.
- The full axe run covers each module in its **opening state** in the dark Poolside default. Both themes are scanned for every style (TT23), but only for the chrome, Files and Spreadsheet. The Whiteboard needs a pointer to draw *new* shapes. Dialogs deeper inside modules are not scanned.
- Toolbars that scroll sideways hide their overflow until you scroll or Tab to it. Every control stays keyboard-reachable.
- Symbols outside the bundled Nunito font (arrows, some math symbols in module toolbars) depend on the device's fallback fonts.
- This is engineering evidence, not a legal opinion or a conformance certification.
