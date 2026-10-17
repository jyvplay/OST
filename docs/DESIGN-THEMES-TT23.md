# TT23 — five reach-backed design themes

Request: *"Research 5 additional major distinct design themes and color palettes, confirmed via web grounding as of
Oct 16 2026 to be the most popular (honestly) among ALL internet users globally."*

## What can and cannot be claimed

No survey ranks "design themes" by popularity across all internet users. Dark-mode polls are self-selected
(Android Authority readers: ~73% always-dark, Jun 2026). NN/g's sample of 115 mobile users split roughly 1/3 dark,
1/3 light and 1/3 mixed. **So no theme is called "the most popular" here.** Two measurable proxies were used instead:

1. **Reach.** The share of devices whose operating system ships the design language, so billions of people see it
   every day.
2. **The 2026 colour authorities.** The two colour-of-the-year programmes that product, fashion and interior
   industries follow worldwide.

| # | Style id | Design language | Evidence (web search on 2026-10-16) |
|---|---|---|---|
| 1 | `expressive` | Google **Material 3 Expressive** (Android 16 QPR1, Sep 2025 → Android 17) | Android = 69.17% of global mobile OS use (StatCounter, Sep 2026); about 3.9 bn active Android devices. Android 16 is the most-used Android version (StatCounter Sep 2026 via webtribunal ≈37.6%; Wikipedia ≈26%). |
| 2 | `liquidglass` | Apple **Liquid Glass** (iOS 26, Sep 2025) | Apple's App Store figures (Jun 2026): 79% of all iPhones and 86% of 4-year-old-or-newer iPhones run iOS 26. TelemetryDeck end of Sep 2026: iOS 26 74.6% + iOS 27 16.3%. iOS = 30.81% of global mobile (StatCounter Sep 2026). |
| 3 | `fluent` | Microsoft **Fluent / Mica** (Windows 11) | Windows 11 = 71.5% of Windows worldwide (StatCounter Sep 2026, reported by The Register, 5 Oct 2026). Windows ≈56.6% of global desktop OS share (Jun 2026). |
| 4 | `clouddancer` | **PANTONE 11-4201 Cloud Dancer**, Pantone Colour of the Year 2026 (announced 4 Dec 2025; the first white chosen) | Published sRGB approximation #F0EEE9 (TCX). |
| 5 | `teal` | **Transformative Teal**, WGSN × Coloro Colour of the Year 2026 (Coloro 092-37-14) | Published digital approximations range #2E6364–#306263 (several design blogs; WGSN publishes Coloro codes, not hex). Used here: #2F6364. Companion A/W 26/27 key colours: Wax Paper, Fresh Purple, Cocoa Powder, Green Glow. |

Ranking by reach: Android/Material is first by device count. iOS 26 and Windows 11 each reach hundreds of millions to
billions of users. The two colours of the year are cultural signals, not usage measurements, and are labelled that
way in the app's style blurbs.

## How each is interpreted (original art, not copies)

None of these styles copies vendor artwork, icons, wallpapers or fonts. The shell stays on Nunito. Each style is an
interpretation built on the TT22 style system (`src/lib/style-core.ts`), so all 13 icon roles, the logo, the
wallpaper, the accent, the chrome and both dark and light surface tokens change together.

| Style | Tile finish (AppIcon.tsx) | Palette idea | Accent (button text #04102b) |
|---|---|---|---|
| Liquid Glass | `glass`: frosted top specular, white rim, bottom caustic line | vivid system-like colours; ink glyphs except blue/indigo (white ≥3:1). The shell's own panels are more translucent (0.84 dark / 0.80 light) over the 16 px backdrop blur | #0A84FF (Apple's dark-mode systemBlue value, from memory; not web-verified) |
| Material Expressive | `tonal`: flat tone-90 container on a generated **12-lobe "cookie"** shape | M3 role model: container + on-container (tone 10) for every hue; lilac primary | #D0BCFF (the M3 baseline dark-scheme primary, from memory) |
| Fluent | `mica`: small 9 px radius, 1 px top highlight, hairline edge | Fluent shared colours (yellow #FFB900, blue #0078D4 → #005FB8, green #107C10…), Mica neutrals #202020 / #F3F3F3 | #60CDFF (a Windows 11 dark-surface accent value, from memory) |
| Cloud Dancer | `paper`: one off-white stock (#FBFAF7 → #E6E2DA) with a hairline. The module colour moves into the ink glyph | Cloud Dancer as the light background (and as the dark-theme text colour), powdered pastels for details | #F2B8A2 (powdered peach) |
| Transformative Teal | `lacquer`: deep-teal tile with a pearl sheen and a rim tinted by the glyph colour | tiles from #2F6364 down to #123C3D. Glyphs in Green Glow, Fresh Purple and Wax Paper plus warm glows | #5FD0C2 |

Vendor hex values marked "from memory" were not re-verified on the web this turn. They are close approximations
used for flavour only, and nothing depends on them being exact.

## Verification

* `scripts/a11y-unit.mts` "style system":
  * every glyph ≥3:1 on its tile over y 11–38 (minimum across the new styles: 3.67 Fluent orange, 3.73 Liquid Glass blue);
  * chrome ink ≥4.5:1;
  * accent buttons ≥4.5:1;
  * dark and light text ≥4.5:1 on solid panels **and** on translucent panels composited over pure black and pure white
    (new in TT23; a mutation to 0.5 alpha is caught: 2.96 and 1.73);
  * each style has its own finish.
* `scripts/e2e-a11y.mts` "style switch": four new styles are picked in Settings and one from the Quick panel. Accent,
  wallpaper, logo colours and launcher pill are asserted, the cookie-shaped logo is detected, and all 5 SVGs are served
  as `image/svg+xml`.
* `scripts/e2e-a11y.mts` test 8: axe runs over **9 styles × light/dark** (18 boots) on chrome + Files + Spreadsheet,
  with 0 serious violations required.
* Screenshots: `docs/screenshots/tt23-style-*.png` (made by `scripts/shots-tt22.mts`, `ONLY=tt23`).
