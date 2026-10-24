# TT25 — professional styles and Business / Art layouts

## 1. Why these two professional styles

The request: two professional palettes that suit a modern open office and look like one of the common core
operating systems. "Common" was measured on **desktop** share, because that is where office work happens
(web searches run on 2026‑10‑16/17):

| Source | Windows | macOS | Linux | ChromeOS |
|---|---|---|---|---|
| StatCounter desktop, Sep 2026 | 76.36 % | 16.78 % (OS X 10.68 % + macOS 6.1 %, summed*) | 4.54 % | 2.31 % |
| Cloudflare Radar, human traffic, 28 days to 13 Sep 2026 | 73.87 % | 19.86 % | 4.72 % | 1.53 % |
| techlila summary, Jan–Aug 2026 | 74.9 % | 18.3 % | — | — |

\*Chrome on a Mac reports "OS X 10_15_7" whatever the real version, so StatCounter splits macOS over two labels.
Summing them is the usual correction (the techlila article explains why). A June 2026 StatCounter reading that put
Windows at 56.55 % came from 21 % "Unknown" traffic and was debunked, so it is not used here.

Windows and macOS together cover about 93 % of desktops on every source, so there is one style after each:

* **Enterprise** (after a managed Windows desktop). Flat, small‑radius (rx 4) single‑colour tiles like Start tiles,
  in a desaturated corporate range (navy, steel, slate, teal, muted amber/brick). White glyphs on every tile, neutral
  charcoal/grey surfaces, and a Windows‑style blue accent. The accent is **#4ca0ec**, not Windows' #0078d4: buttons carry
  #04102b text, and #0078d4 only reaches 4.16:1 against it (measured by a11y‑unit when temporarily swapped in). WCAG 1.4.3
  needs 4.5:1. The window bubbles are grey, with a soft red Close. The wallpaper "Enterprise glass" (original) is
  a calm navy glass facade.
* **Graphite** (after the macOS Graphite appearance). One brushed‑aluminium stock for every tile (squircle rx 10.5,
  cool light → mid grey, a specular top edge, a dark lower bevel). Module colour is carried by dark, desaturated ink
  glyphs. Surfaces use the familiar macOS window greys (#ececec / #1e1e1e), the accent is a quiet grey (#a3a9b2), and
  the window bubbles use the macOS traffic‑light colours. The wallpaper "Graphite dunes" (original) has layered grey
  dunes at dusk.

Neither style uses vendor artwork, logos or fonts. Both are "after" a system, not copies of it.

**Checks.** a11y‑unit checks every glyph ≥3:1 on its tile across the whole glyph area, plus chrome ink, dark and light
text tokens, glass panels over black and white, and the accent ≥4.5:1. Two mutations were caught: a light Graphite sun
ink, and #0078d4 as the accent. axe runs in both themes for each style (e2e‑a11y covers all 11 styles; e2e‑layout covers
Enterprise in Business and Graphite in Art).

## 2. Layouts

`appearance.layout` = `fusion` (default, the original hybrid) | `business` | `art`. You can switch it in
**Settings → Display & readability → Layout** or in the **Quick panel → Layout**. Both are native radio groups. It can
also be set from a routine (`layout art`). The server validates the value.

### Business (after Windows 11)
* No top bar. A full‑width taskbar runs along the bottom:
  * **Start** opens the Start menu above the taskbar at the bottom‑left. It has a search field (Enter launches the top
    match), a Pinned grid, All apps, and Settings / Lock.
  * Also on the taskbar: a **Search** box (the command palette), **Task view** (Overview), and the desktops on the left.
  * **Apps**: pinned and running apps are centred. A short bar marks an app with windows; a long accent bar plus a
    highlight marks the focused one. Clicking a focused single window minimises it, and clicking an app with several
    windows cycles through them. Shift‑click or middle‑click opens a new window. Right‑click opens the jump list (window
    list, New window, Close all).
  * **Tray**: privacy and cast badges, a governor dot, Blackout, Quick settings, and a stacked time/date clock that opens
    Planner.
  * **Show desktop** is the sliver at the far right. A second press brings back exactly the windows it hid. Opening or
    focusing a window in between makes it forget them.
* Windows get Windows caption buttons: flat, full title‑bar height, and Close turns #c42b1c on hover.
* The Quick panel and toasts sit at the bottom‑right.

### Art (after macOS)
* **Menu bar**: the Fusion menu (About, System Settings, Launchpad, Force Quit → Monitor, Lock, Blackout), then the
  focused app's name in bold, then File / Window / Help. These follow the WAI‑ARIA APG menu‑button pattern. The Window
  menu has Minimise, Zoom, Move to Left/Right Side, Centre, Bring All to Front and the list of windows. On the right are
  Spaces, Mission Control, Spotlight, Control Centre and the day‑date‑time clock. Toasts appear at the top‑right.
* **Dock**: centred and floating, and it holds every app (37). Launchpad comes first, then the groups Core | Create |
  Connect | System split by separators, then minimised windows after a separator, then Trash (Files on its trash view).
  * The base icon size is fitted to the width.
  * Magnification: scale = 1 + (max−1)·½(1+cos(π·d/R)), with max 1.75 and R = 2.5 icon widths. It is computed from the
    resting geometry and measured from the dock's fixed centre, so the icon under the pointer stays under it while the
    dock widens.
  * Keyboard focus magnifies too, and touch never does.
  * Other details: a name bubble, running dots, a bounce on launch, and a right‑click menu (window list, New window,
    Show all, Quit).
  * Under reduced motion or Motion off there is no bounce and no transitions. A setting turns magnification off.
  * On phones the dock scrolls inside itself with magnification off, and the page never scrolls sideways.
* **Windows**: traffic lights on the left in close / minimise / zoom order (24 px targets, 14 px lights). Glyphs show on
  hover or focus, and the lights turn grey when the window is inactive. The title is centred. A zoomed window fills the
  space from the menu bar to the dock.
* **Launchpad**: a full‑screen blurred grid of every app with search. Esc or a click on the background closes it.

### Not reproduced (declared)
* Windows: live thumbnails on hover, widgets, Snap layouts flyout.
* macOS: genie / scale minimise animation, dock auto‑hide and drag‑to‑reorder, window thumbnails for minimised windows
  (an app icon is shown instead), and app‑specific menus beyond File / Window / Help.
* Neither layout has been screen‑reader tested.

## 3. Evidence
* `scripts/layout-unit.mts` (8 tests) covers the dock maths, fitting, taskbar click rules, the Show desktop reducer,
  validation and seed, and the style facts. Four deliberate mutations made 4 tests fail (cycle direction, falloff
  shape, peek clearing, z‑order on restore).
* `scripts/e2e-layout.mts` (11 tests, headless Chromium, production build) is driven through the UI and checked by
  measured geometry, persisted settings and axe. On an earlier build it caught a real bug: the jump list was clipped by
  the scrolling app row. It also led to the desk being isolated so that window z‑indices can never paint over the
  taskbar, menu bar or dock.
* Screenshots (visual inspection, not committed): `/home/user/shots/tt25-*.png`.
