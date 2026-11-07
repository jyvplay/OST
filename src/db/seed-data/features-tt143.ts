import type { SpecRow } from "./row";

/**
 * TT143 — twenty register rows taken to Class A by real engines and asserted
 * refusals, rather than by editing a status.
 *
 * Each entry states its mechanism **and** its limit, because a row that only
 * claims success is unauditable. Every one of these has a case in
 * `scripts/tt143-engines.mts` that makes it refuse something, which is the half
 * of behaviour a status badge cannot show.
 *
 * Four rows keep `partial` on purpose — see the note at the bottom. An honest
 * partial is worth more than a fabricated A, and the audit trail for those is in
 * the row's own nuance text.
 */
const TT143: Array<Pick<SpecRow, "code"> & Partial<SpecRow> & { name: string; route: string; nuance: string; test: string }> = [
  {
    code: "SC-04",
    name: "In-app egress rules and request ledger",
    route: "egress-rules.ts + Privacy request ledger",
    nuance:
      "A web page cannot filter another application's traffic and cannot change the system resolver, so this is stated as a rule engine over the app's OWN requests — the seam the privacy layer already owns. Rules are glob lists with a stated default; at equal specificity deny wins; host+path beats host beats wildcard; credentials in a URL and non-http schemes are refused before any rule runs. A malformed rule is reported with its field, never silently dropped, and the list is capped. A decision carries the rule id that made it.",
    test: "tt143-engines.mts SC-04",
  },
  {
    code: "SH-14",
    name: "Offline shell with a queued-write outbox",
    route: "offline-queue.ts + offline queue panel",
    nuance:
      "The queue collapses per key (a stale edit never replayed over a newer one), de-duplicates by content digest, orders by enqueue time, retries to a stated attempt cap and parks a 409 as a conflict instead of forcing it. It is bounded in entries and bytes and refuses at enqueue time with the reason. It does not claim durability the platform cannot give: the limits — storage eviction, a background-sync tag that may never fire, and a conflict meaning another device changed the item — are listed where the user sees the queue.",
    test: "tt143-engines.mts SH-14",
  },
  {
    code: "FM-18",
    name: "Safe-save contract (session copy → temp → validate → atomic replace)",
    route: "safe-save.ts + Files/Editor save path",
    nuance:
      "The four steps are a state machine, so each failure has its own recovery: a short session copy stops before the temp exists, an invalid file never reaches the target, and a replace before validation is refused rather than attempted. Crash recovery is a rule, not a guess: a temp with no session copy is discarded, and a session copy that disagrees with the target is OFFERED rather than restored, because neither side is provably newer. 'Saved' is the only state that says saved.",
    test: "tt143-engines.mts FM-18",
  },
  {
    code: "DP-04",
    name: "Concurrent desktop writes are merged, not dropped",
    route: "desktop-merge.ts + Shell 409 path",
    nuance:
      "Optimistic concurrency still refuses a stale write; what changed is that the refusing tab now merges instead of adopting the other desktop wholesale. Windows merge by id (newer geometry wins, with a stated tie-break), a window only one side knew about is kept, a close only wins over an older open, and z-order is renumbered densely so later stacking arithmetic has no gaps. The window set is the same whichever side is preferred, and the toast names what was kept and what was reconciled.",
    test: "tt143-engines.mts DP-04",
  },
  {
    code: "ST-09",
    name: "Per-context profiles (laptop / desk / tablet)",
    route: "context-profile.ts + Shell profile switch",
    nuance:
      "The profile is derived from four measured facts — screen count from Screen Details, the primary pointer's coarse/hover media queries, maxTouchPoints, and the viewport — and never from a user-agent string, so a touchscreen laptop stays a laptop and an iPad in desktop mode is still a tablet. A profile is a bundle of numbers the shell already understands (window scale, density, target size, soft keyboard), not a second code path. A change is announced only when the id changes, with the measurement that caused it.",
    test: "tt143-engines.mts ST-09",
  },
  {
    code: "CT-05",
    name: "Remote desktop: stream, handoff or refusal",
    route: "remote-desktop.ts + Streams",
    nuance:
      "A page cannot speak RDP or VNC: both need raw TCP. So the engine classifies an address into a WebRTC stream (the only real remote screen a web app can show, because a cooperating peer sends the picture), a handoff to a registered system handler, or a copy — and `vnc://` is deliberately a copy, because that scheme is rarely registered and a link that silently does nothing looks like a broken feature. Credentials are redacted from every string before display, and the clipboard control states that the web cannot sync clipboards silently.",
    test: "tt143-engines.mts CT-05",
  },
  {
    code: "WM-15",
    name: "Window-to-video: record, stream, or a stated refusal",
    route: "capture-plan.ts + Capture",
    nuance:
      "Three mechanisms are separated instead of conflated: record to a file, send a live track to a WebRTC peer, or view locally. Casting a live capture is refused WITH the reason (a remote playback receiver fetches a URL and a MediaStream has none) and the alternative that does work. Tab audio is disclosed as a picker choice the page cannot make, and a codec probe gates the recording path but not the peer path, which needs no codec.",
    test: "tt143-engines.mts WM-15",
  },
  {
    code: "MD-06",
    name: "Audio output routing with honest refusals",
    route: "audio-route.ts + Media output picker",
    nuance:
      "setSinkId is the only routing API and its three limits decide the design: it needs a secure context, it is Chromium-only, and it refuses a cross-origin stream so a page cannot probe which device is listening. Each is a named verdict, not a generic failure. Device labels are explained as hidden until a media permission is granted — a platform privacy feature, not a bug to work around — and outputs the platform groups are kept grouped.",
    test: "tt143-engines.mts MD-06",
  },
  {
    code: "MD-03",
    name: "Photos: non-destructive edit pipeline",
    route: "photo-edit.ts + Photos editor",
    nuance:
      "An edit is an ordered list, never new pixels: undo is truncation, and an identity operation is dropped so two versions of one photo are comparable. Tonal operations are a fixed-point ramp per channel, while saturation is computed in luma — applying it per channel is a contrast change, which is the specific bug the separate function exists to prevent. Geometry is validated against the pixel grid at the point in the chain where it applies, and the two dishonest operations (a generative 'enhance', a shadow removal) are absent rather than faked.",
    test: "tt143-engines.mts MD-03",
  },
  {
    code: "LN-06",
    name: "Virtual key light",
    route: "key-light.ts + Lens relight",
    nuance:
      "The light is modelled, not filtered: a gain from the measured subject luma to a target, a direction opposite the subject's own brightest side, and a pre-computed bounded falloff, so a still subject costs nothing per frame. It refuses the two dishonest claims — it fills a shadow, it cannot remove one or recover detail — and it caps its own gain at the clipping point instead of blowing highlights. A level that rounds to no light is reported as no light rather than shown as on.",
    test: "tt143-engines.mts LN-06",
  },
  {
    code: "AP-05",
    name: "Background/startup inventory, measured",
    route: "background-mechanisms.ts + Monitor platform facts",
    nuance:
      "Five mechanisms are reported separately because they are not interchangeable: a service worker the browser may stop, periodic sync whose minInterval is a floor the browser may ignore, background fetch that delivers progress and a result but not a resumed page, push that needs a push service this deployment does not run, and a page timer that is throttled when hidden. Counts are observations, never a rate, and the chooser for a need picks the weakest mechanism that is sufficient — a daily check is never promised.",
    test: "tt143-engines.mts AP-05",
  },
  {
    code: "WM-07",
    name: "Multi-display: per-display layouts, reversible hotplug restore",
    route: "hotplug-restore.ts + Shell screen placer",
    nuance:
      "Screens are identified by label plus rounded work-area bounds, so jitter is not a new screen and a renamed-but-unmoved screen is re-identified by geometry; two screens with identical geometry and no distinguishing label are reported as ambiguous instead of guessed at. Parking the windows of an unplugged screen records the exact rectangles it changed, so the restore is the inverse; a window the user moved while it was parked stays where the user put it. Overflow is named, never silently resized.",
    test: "tt143-engines.mts WM-07",
  },
  {
    code: "SH-13",
    name: "Installability and virtualised panels",
    route: "manifest + service worker + panel-layout.ts",
    nuance:
      "Install is gated on what the platform actually requires: name, start_url, an installed display mode, and 192/512 icons that are fetched (a 404 icon is why install prompts fail silently). Large surfaces are virtualised from a measured row height with a prefix-sum index, O(log n) lookup, one screen of overscan, and a measured zero that keeps the previous estimate instead of collapsing the index. The sticky row is reported separately so it cannot be virtualised away.",
    test: "tt142-browser.mts SH-13 · tt143-engines.mts SH-13",
  },
  {
    code: "SR-06",
    name: "Palette and bulk actions that cannot act on the wrong rows",
    route: "row-cluster.ts + palette bulk actions",
    nuance:
      "A bulk action targets a cluster of consecutive rows with the same provenance, never 'the visible ones' and never across a section boundary; a cluster too small to be worth a control is not offered as one; an empty provenance is its own cluster labelled unknown. Selection is a set of row ids, so a filtered list cannot shift a selection onto rows the user never saw, and 'select all' reports how many rows it left out.",
    test: "tt143-engines.mts SR-06",
  },
  {
    code: "PR-07m",
    name: "Download manager with honest accounting",
    route: "download-arbiter.ts + Files downloads",
    nuance:
      "Three concurrent streams, a queue, and an attempt budget; progress is monotonic within an attempt and a decrease is counted as a restart rather than smoothed away. A short body is truncated and a long one is an overrun — neither is 'complete' — and a response with no declared length is unverified, because an interrupted stream and a finished one are indistinguishable without a length. Cancellation is final (a late completion cannot resurrect a file), names are derived and collision-free, and the foreground-only limit is stated rather than papered over with a background-transfer claim.",
    test: "tt143-engines.mts PR-07m",
  },
  {
    code: "RC-29",
    name: "Archive audit: no half-published pair",
    route: "memory-audit.ts + Recall archive audit",
    nuance:
      "Two observed inventories are compared, and the verdict distinguishes an orphan payload (removable only past a grace period, because the writer may still be publishing) from a dangling record (never auto-removed — the record is the only evidence the payload existed) from a size mismatch (an interrupted write) from a checksum mismatch (corruption, and only claimed when the caller says the bytes were actually read). 'Clean' means every record has its bytes and every payload has a record at that instant, and no more.",
    test: "tt143-engines.mts RC-29",
  },
  {
    code: "CA-08",
    name: "Google Cast sender: offered only where it is real",
    route: "stream-plan.ts + Media cast",
    nuance:
      "The Cast SDK is proprietary, so it is never bundled: without it the sender is blocked with that reason, and the alternative offered is the browser's own remote-playback picker, which lists Cast devices on Chromium without any SDK. A receiver fetches the address itself, so a blob or data URL is refused and a locally-held file gets a real route instead — save it, then cast the saved copy.",
    test: "tt143-engines.mts CA-08",
  },
  {
    code: "CA-12",
    name: "Miracast and the native-protocol family: refused, not faked",
    route: "stream-plan.ts cast matrix",
    nuance:
      "Miracast, DLNA and RAOP are native protocols; a web origin cannot speak them without a reverse-engineered implementation or an installed helper, so the matrix returns blocked-with-reason for each and offers the platform picker where it exists. The refused targets stay in the matrix on purpose: a picker that silently omits what it cannot do is how users conclude the app is broken.",
    test: "tt143-engines.mts CA-12",
  },
  {
    code: "DP-03",
    name: "Named desktops by link, with the shared desktop as the default",
    route: "desktop-id.ts + page server component",
    nuance:
      "One desktop on several screens is the premise, so absence of a name means the shared row — a per-browser default was built, measured (it broke 184 fixtures and the multi-screen premise) and reverted, with the measurement recorded in the proxy. A named desktop is an opt-in link, validated (shape, reserved names, no trailing dash), and the shell says plainly that anyone with the link can open it. An unusable name is reported and falls back to the shared desktop rather than silently opening something else.",
    test: "tt142-platform.mts DP-03",
  },
  {
    code: "AX-10",
    name: "One token source, contrast computed",
    route: "design-tokens.ts + content-density.ts + a11y-unit",
    nuance:
      "Four surfaces, three inks, one accent, three elevations — a module cannot add a shade. Every ink-on-surface pair is measured with the WCAG luminance formula in a unit suite, and the interactive border is DERIVED by darkening the surface until it clears 3:1, because the first palette shipped a 1.39:1 border that a low-vision user cannot see. Word budgets are enforced the same way (labels ≤ 3 words, notes ≤ 24), so 'less wordy' is a number a turn can be held to.",
    test: "tt143-engines.mts visual · a11y-unit.mts",
  },
];

/** Codes that are already `built`; this patch only rewrites rows that exist. */
const TT143_UPGRADES: Record<string, SpecRow> = Object.fromEntries(
  TT143.map((f) => [
    f.code,
    {
      code: f.code,
      family: f.family ?? "",
      name: f.name,
      tier: "A" as const,
      phase: "P2" as const,
      route: f.route,
      nuance: f.nuance,
      status: "built" as const,
      test: f.test,
    },
  ]),
);

/**
 * Rows deliberately left partial, with the reason. Recorded here so a later turn
 * does not "fix" them by flipping a status.
 *
 *   BK-01 timeline backup   — export and restore are real, but a *timeline* (every
 *                             prior version retained and restorable) needs storage
 *                             the demo host does not have; the version chain is
 *                             per-file and bounded.
 *   BK-02 folder sync       — a conflict inbox exists, but a sync ENGINE needs a
 *                             second endpoint this deployment does not run; the
 *                             merge rules are implemented and tested, the transport
 *                             is a folder the user names.
 *   BL-02 entitlement cache — an offline grace period is implemented, but there is
 *                             no store to issue entitlements, so the cache is always
 *                             empty in this build and the UI says so.
 *   FM-08 local disk        — the File System Access API is real and used, but a
 *                             page cannot enumerate volumes; a directory handle the
 *                             user granted is the whole surface.
 */
export const TT143_PARTIAL_NOTES: Record<string, string> = {
  "BK-01": "timeline needs storage the host does not have; per-file versions are bounded",
  "BK-02": "merge rules are tested; no second endpoint to sync against",
  "BL-02": "no store issues entitlements here, so the cache is empty and says so",
  "FM-08": "a page cannot enumerate volumes; a granted directory handle is the surface",
};

export function patchTT143(row: SpecRow): SpecRow {
  const up = TT143_UPGRADES[row.code];
  if (!up) return row;
  // Keep the register's own family: this patch is about status, not taxonomy.
  return { ...row, name: up.name, tier: "A", route: up.route, nuance: up.nuance, status: "built", test: up.test };
}
