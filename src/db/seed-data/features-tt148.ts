import type { SpecRow, Status } from "./row";

/**
 * TT148 — the two rows this turn moved, and the reason each one is allowed to
 * move.
 *
 * Both were graded on what the platform does with a *label*: FF-06 trusted a
 * file extension, IN-04 trusted the word "hotkey". Neither row was missing an
 * engine — they were missing the distinction between what a name claims and
 * what the bytes (or the event) actually carry.
 */
const BUILT: Status = "built";

export function patchTT148(row: SpecRow): SpecRow {
  const core = "tt148-core.mts";
  const e2e = "e2e-tt148.mts";

  switch (row.code) {
    case "FF-06":
      return {
        ...row,
        status: BUILT,
        route: "src/lib/image/foreign-container.ts + src/lib/thumbs/render.ts (thumbnail path) + RuntimePanel containers",
        nuance:
          "HEIC and AVIF are the same ISO-BMFF container, so the extension is only a hint and the brand is the fact: sniffContainer reads the ftyp box and answers avif (avif/avis/av01, or mif1 with an avif compatible brand), heic (heic/heix/hevc/hevx/heim/heis and the mif1/msf1 family) or unknown, and refuses a box whose declared size is impossible before any decoder is handed the bytes. The consequence is visible: an AVIF saved as .heic — a routine mix-up — produces a real thumbnail because the bytes are decoded as AVIF, while a genuine HEIC returns the sentence that names the missing piece (this engine has no HEVC image decoder) plus a conversion route, and a corrupt AVIF is reported as corrupt instead of being miscalled an unsupported format. The fixtures are third-party: Pillow/libavif writes the AVIF and pillow-heif/libheif writes the HEIC, and each suite asserts that the container sniff, the ispe dimensions and the engine's own createImageBitmap answer agree. Limits: whether a HEIC decodes at all is the engine's decision, not ours — this Chromium cannot, Safari can, so the row is honest only with that split stated; and the thumbnail path is the only consumer today (the full-size viewer still uses the same sniff, but there is no HEVC software decoder in this build, and writing one is out of scope).",
        test: `${core} (brand matrix, malformed-box refusals, decode policy, a real Pillow AVIF's ispe box, a real libheif HEIC refused as a missing decoder), ${e2e} (a .heic-named AVIF really thumbnails in Files; a genuine HEIC is refused with the engine's own rejection quoted from the same page)`,
      };

    case "IN-04":
      return {
        ...row,
        status: BUILT,
        route: "src/lib/keyboard/system-keys.ts + src/components/ShortcutCapture.tsx (Settings → Shortcuts)",
        nuance:
          "The capture surface reports the chord from the physical key (event.code), so a layout switch cannot change what a shortcut means, and it prints them in one canonical order (Meta, Ctrl, Alt, Shift, key) however the fingers arrived. Three answers are kept apart instead of blurred: a bare modifier is not a chord at all, a browser-reserved combination is named with the browser's own use (the reserved list is written down with a reason per entry rather than inferred), and a combination this app already binds is reported as our clash, not the platform's. The plan behind the box states what it cannot do in the same breath — the chord is observed only while the page has focus, and the reserved keys are handed over only inside fullscreen through Keyboard Lock — and the quote is measured: navigator.keyboard.lock availability and document.fullscreenElement are read at the moment the panel renders. Capturing also consumes the event, so a chord pressed into the box cannot fire the shell behind it. Limits: there is no OS-wide hotkey in a web app and nothing here pretends there is; Keyboard Lock is Chromium-only and fullscreen-only, so on other engines even the locked row is unavailable, and a system-level shortcut (the OS window switcher) is never reachable at all.",
        test: `${core} (layout-independent chords, canonical order, modifier-only refusals, the reserved list with reasons, reserved vs own-binding classification, focus and fullscreen preconditions), ${e2e} (the box names a reserved chord as the browser's, an app binding as ours, states the focus limit without a global claim, clears, and swallows the chord so no window opens)`,
      };
  }
  return row;
}
