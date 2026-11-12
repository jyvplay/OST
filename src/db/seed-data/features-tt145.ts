import { F } from "./row";
import type { SpecRow } from "./row";

/**
 * TT145 — twenty rows that were either partial or built-with-a-caveat, taken to
 * Class A against engines that exist in this tree.
 *
 * The writing rule for every nuance below is the one the register has been held to
 * all along: a row may claim what a test asserts, and it must name the thing it does
 * not do. Each claim here is backed by a case in `scripts/tt145-engines.mts` that
 * fails if the refusal disappears.
 *
 * Three rows are deliberately *not* claimed at A in their original form and are
 * listed at the bottom in `TT145_STILL_PARTIAL`, because turning them green would
 * require a server, an OS integration or a capture surface this build does not have.
 * A false A is worse than an honest partial: the partial states the boundary.
 */
export const tt145Features: SpecRow[] = [
  F("HW-08", "HW", "Hardware-backed crypto, as non-extractability + AAD binding + rotation", "A", "P2",
    "src/lib/vault-seal.ts + Vault → Sealed records",
    "A page cannot attest where a key lives, so this row claims exactly the four properties WebCrypto enforces: a key generated with extractable:false cannot be read back by any script; every seal uses a fresh 96-bit IV; the record id, key id and schema version are in the GCM additional data, so a ciphertext moved to another record fails its tag instead of decrypting into the wrong slot; and rotation retires a key read-only rather than deleting it, because destroying it destroys every record it still holds. The Vault pane demonstrates the tag failure with a real GCM decrypt of a swapped record. Not claimed: hardware backing (unobservable), protection from a compromised renderer, or a WebAuthn gate on this path.",
    "built", "tt145-engines.mts HW-08"),

  F("SH-10", "SH", "BlackTop: external-display desktop with a budgeted blackout source screen", "A", "P2",
    "src/lib/blackout-budget.ts + Monitor → Blackout budget",
    "The panel is still lit — a page cannot dim it — so the only honest lever is presentations, and the engine budgets that lever: a flat single-layer fill requests 1 fps instead of the display's 60, which removes 98 % of presentations, while a gradient, a video, an animation or a hidden tab is refused with the reason. Touch coalescing keeps the last move in each frame window and refuses a window shorter than one frame, so a black screen is still a working touchpad. What it does not do: set brightness, stop the compositor, or save power beyond the frames it stops asking for.",
    "built", "tt145-engines.mts SH-10"),

  F("BL-02", "BL", "Entitlement cache with a verified signature, a clock high-water mark and a stated grace period", "A", "P3",
    "src/lib/entitlement-cache.ts + Privacy → Entitlement cache",
    "An offline-tolerant cache is only honest if it can check a grant without a server, so a grant is verified against an Ed25519 key with WebCrypto and eight verdicts are distinguished: absent, corrupt, bad-signature, clock-rollback, expired, unknown-product, grace and granted. The clock high-water mark is the part that most caches miss: moving the device clock backwards cannot revive an expired grant, because the mark only moves forward. A stale replica that answers with an older issue time is refused rather than written, so a lagging server cannot shorten a paid entitlement. No signing key ships with this build, so the panel reports bad-signature rather than trusting a grant on faith; and a user who patches the client has a patched client, which no client-side scheme changes.",
    "built", "tt145-engines.mts BL-02"),

  F("PR-01", "PR", "Text/Markdown editor: journaled autosave, revision compaction, conflict forks", "A", "P2",
    "src/lib/autosave-journal.ts + Editor",
    "Autosave is a journal, not an overwrite: every flush appends an immutable revision with a parent link, a no-op save appends nothing, and a flush whose parent has moved forks a conflict revision that carries both bodies rather than picking a winner. A save that was scheduled but never flushed is visible as dirty, so crash recovery hands back the unsaved body and says that is what it is; compaction collapses byte-identical neighbours and never drops the last distinct version, which is the one a user asks for after a bad paste. Still not the Android SAF temp/reopen/replace contract — that is FM-18, and this row does not claim it.",
    "built", "tt145-engines.mts PR-01"),

  F("PR-07p", "PR", "Content filtering on the paths this app opens and embeds", "A", "P3",
    "src/lib/content-filter.ts + Privacy → Content filter",
    "A declarative rule file (block/allow over host, path and query, with an embed scope) resolved by a specificity tuple, not by rule order: scope first, then exact-versus-wildcard, then literal length — so an allow for cdn.tracker.example beats a wildcard block regardless of how long the patterns are, and a *.suffix rule cannot swallow a two-label look-alike. A malformed line is reported with its number, never dropped, because a silently dropped rule is the difference between a bank being excluded and a bank having been excluded until someone typed a trailing space. It is cooperative and it says so: it filters this app's own fetch and embed paths, not the browser's requests, and it cannot see inside a cross-origin frame.",
    "built", "tt145-engines.mts PR-07p"),

  F("FM-14", "FM", "Drag and drop between windows and the OS, decided per capability", "A", "P2",
    "src/lib/drop-claim.ts + Files → Files mechanics",
    "The outbound drop has four distinct outcomes and the engine picks one explicitly instead of attempting and hoping: a real DownloadURL download, a same-origin link copy, an explicit Download-button handoff where the browser cannot drag a file out, or a refusal with the reason (read-only pane, an illegal filename, an item with no measured size). Inbound, the three refusals a naive handler misses are all modelled: a drop on a hidden tab, a batch above 50 files, and the fact that a file drop carries no text types at all. The limitation is stated in the pane rather than discovered: the OS gives a page no way to accept a drop onto another application's window.",
    "built", "tt145-engines.mts FM-14"),

  F("ST-03", "ST", "Default-apps guide and protocol-handler registration, with the answer the browser will not give", "A", "P3",
    "src/lib/handler-claim.ts + Settings",
    "Four states and one rule: only four things can be true — unsupported, offered, pending, unknown — and the word “default” may appear in none of them as a claim, because no API reports the current default handler. registerProtocolHandler resolving proves the call was accepted, not that the user agreed; a launchQueue launch proves the app was chosen at least once, not that it still is. Template validation refuses zero or two %s placeholders (two would leave the second literal) and any cross-origin target, and a scheme outside the browser-known list must be in the web+ namespace. The per-platform guide carries the command that actually works, e.g. xdg-settings on Linux.",
    "built", "tt145-engines.mts ST-03"),

  F("IN-04", "IN", "The web's 'global hotkeys', implemented as a hold-latch", "A", "P2",
    "src/lib/shortcut-latch.ts + Settings → Keys",
    "Limits first: a chord fires only while this app has focus and nowhere else — a page cannot register a system-wide hotkey — so the engine implements the part that matters: a hold-latch where the first match opens, a repeat or a second key advances, Escape cancels without committing, and a blur or modifier release closes the latch so no modifier stays stuck. Three refusals keep it usable: a bare printable key is refused because it would swallow typing, an OS-reserved chord (Ctrl+W, Meta+Q, Ctrl+Alt+Delete…) is refused with the reason it cannot work, and two actions on one chord are refused as ambiguous rather than resolved by order.",
    "built", "tt145-engines.mts IN-04"),

  F("HW-05", "HW", "Low-latency audio: a per-quantum graph budget, measured not asserted", "A", "P2",
    "src/lib/audio-quantum.ts + Monitor → Audio budget",
    "Three things are kept apart: the 128-frame render quantum (arithmetic: 2.67 ms at 48 kHz), the device latency the browser reports (or null, never zero), and the graph's own declared cost summed against a per-quantum budget. A convolver that needs 4 ms of a 2 ms budget is refused with the number, because a graph that misses its deadline glitches and a low-latency mode that silently glitches is worse than none. A suspended context reports that nothing was measured even when the latency fields exist, drift beyond one quantum is a stutter, and 44.1→48 kHz is proved exact to under one sample a minute.",
    "built", "tt145-engines.mts HW-05"),

  F("RC-15", "RC", "Sensitive-content exclusions and receipt redaction, closed under concatenation", "A", "P2",
    "src/lib/exclusion-rules.ts + Privacy → Recall exclusions",
    "Limits first: there is no automatic classifier, so a password that matches no literal and no token shape is not redacted, and the rules are declared by a person. Two sets that must not be conflated: capture exclusions (host, path, title) decide whether Save is offered, and redaction rules (query parameter names, literals, token shapes) run over every string that would land in a receipt. Redaction is closed under concatenation — parts are joined and redacted as one string — so a token split across a label and its suffix is still caught, which per-part redaction misses. Query values are replaced by an ASCII marker that survives form-encoding, the fragment is dropped entirely rather than redacted, and JWT/bearer/hex shapes are caught structurally in addition to the literal list. No automatic classifier claims to find passwords: the rules are declared by a person and the pane says so.",
    "built", "tt145-engines.mts RC-15"),

  F("FM-08", "FM", "Local disk and removable volumes, as granted handles with recovery", "A", "P2",
    "src/lib/volume-access.ts + Files → Volumes",
    "A page cannot enumerate volumes, so every entry is a grant, and the engine models the three ways a grant goes stale: a reload lapses permission to prompt, a moved or unplugged volume throws on read, and a file-picker entry is a copy with no write path at all. The distinction the UI depends on: an unplugged directory is reported as partial with the count read before the failure, never as an empty folder, because “this folder is empty” is the message that makes a person believe their files are gone. storage.estimate() is the origin's quota and is labelled as such; a missing field is unknown, not zero.",
    "built", "tt145-engines.mts FM-08"),

  F("HW-03", "HW", "Hardware codecs as a per-rendition plan, with 'maybe' never treated as yes", "A", "P2",
    "src/lib/codec-probe.ts + Monitor → Codec probe",
    "canPlayType has three answers and they mean different things: probably (a decoder matched this profile string), maybe (the container is understood but the codec string is not parsed confidently) and no. The engine never turns maybe into yes — it plans play-with-fallback so a lower rendition stays loaded — and it refuses to invent a profile from a bare family name, because the level is exactly what determines playability. mediaCapabilities.decodingInfo is the only source of powerEfficient, and its absence is reported as unmeasured rather than inferred from the codec name; a decoder that cannot keep real time is classed as software and not offered as the default.",
    "built", "tt145-engines.mts HW-03"),

  F("CK-01", "Clock", "Alarms: schedules, missed occurrences and snooze that cannot skip one", "A", "P2",
    "src/lib/alarm-due.ts + Planner → Alarms",
    "The hard part of an alarm is not the next time, it is the four ways a foreground page gets it wrong, and each is a branch: a window that closed reports every missed occurrence in order rather than pretending the newest is the only one; a backwards clock fires nothing, because a wall-clock jump is not a reason to replay a morning alarm at midnight; a weekly schedule with no days is refused at creation, because an alarm that never fires is worse than none; and a snooze that would run past the next natural occurrence is refused so it cannot skip it. Day arithmetic walks day anchors and verifies each candidate against the caller's civil-time function, so a DST-shifted 02:30 is reported as absent instead of invented. Limits: delivery needs a running page — a closed tab or a slept device cannot alarm, and the pane says so rather than implying a native wake-up.",
    "built", "tt145-engines.mts CK-01"),

  F("BK-05", "BK", "Backup health and restore drill: the verdict is the weakest of three clocks", "A", "P2",
    "src/lib/backup-health.ts + Backup → Backup evidence",
    "Written, verified and drilled are separate clocks and the verdict is the weakest of them, because a backup is not evidence — a restore is. Six verdicts: never, unreadable (an unknown status string, a future-dated archive, or impossible counts), stale, unproven (never verified, or verified before it was written), vacuous (a drill that restored zero files proves only that the sampler ran) and healthy. The drill sample is deterministic for a seed, spreads by a stride coprime with the manifest length rather than taking the first N files, and a partial restore is a failure with the count. Honest gaps: the drill restores a bounded sample into isolated tables, rollback is transactional not secure erasure, and no background scheduler exists.",
    "built", "tt145-engines.mts BK-05"),

  F("BK-01", "BK", "Timeline backup: a versioned chain that compacts without orphaning anything", "A", "P3",
    "src/lib/backup-timeline.ts + Backup → Backup evidence",
    "A snapshot names its parent, so verification proves a contiguous history rather than a folder of plausible filenames; the manifest's root digest is recomputed on every check, so an edited manifest fails instead of comparing two files that could both be wrong. Retention unions three windows (last N, daily, weekly) and always keeps the root; compaction then separates what an ancestor is needed for — its link (id, time, parent) or its payload (manifest and chunks) — because a first draft that kept every ancestor kept everything and compacted nothing, a flaw a test found. The result is three classes: retained (payload and link), tombstoned (link only, still a valid chain link, not a restore point) and dropped (an abandoned branch). Chunks are sealed per record under a key id, so one chunk restores without the whole archive.",
    "built", "tt145-engines.mts BK-01"),

  F("FM-11", "FM", "Trash with origin, date, size and a sweep that never takes the only copy", "A", "P2",
    "src/lib/trash-policy.ts + Files → Trash policy",
    "An item in the trash still occupies its bytes and the summary says so in MB, because “0 B freed” is a lie a trash tells. The sweep is a predicate with a reason per removal, and two rules are deliberately conservative: an item is never auto-emptied while it is the only copy of its content — a same-digest entry elsewhere is required — and an item that was restored and re-trashed gets double the retention window, because a second trash is evidence of experimenting rather than discarding. A restore whose origin path is taken again lands beside it with a stated suffix instead of overwriting. It is a namespace in the VFS, not the OS recycle bin: another application's deletions never appear here.",
    "built", "tt145-engines.mts FM-11"),

  F("WM-11", "WM", "Always-on-top mini window: placement and stylesheet adoption", "A", "P2",
    "src/lib/pip-placement.ts + Monitor → Window mechanics",
    "The always-on-top window is a browser window, so the engine budgets what a page can actually control: the size is clamped to the usable range and to the content aspect because it can only be chosen at creation; the stylesheet clone is budgeted against a 640 KB ceiling, since the step every demo skips is that the new document renders unstyled and then reflows; and the surface field distinguishes a real picture-in-picture window from the in-page fallback, so a test can assert which one was taken. Closing is modelled for all five reasons, including the user closing it, which returns the content to the desktop rather than destroying it. Not claimed: raising the window above other applications, or moving it programmatically.",
    "built", "tt145-engines.mts WM-11"),

  F("WM-06", "WM", "External-app broker: four lanes with a probe budget and a session memory", "A", "P2",
    "src/lib/workspace-lanes.ts + Monitor → External-app broker",
    "Four lanes and no pretence that a weaker one is stronger: embed a cooperative origin, split by narrowing our own window, hand off to the OS, or float our own window in picture-in-picture — which brings nothing foreign in and is labelled that way. A frame cannot be inspected before it loads, so S1 is try-then-verify inside a 4 second probe budget, and a timeout is treated as blocked because silence is not consent; the origin is remembered blocked for the session so the desktop does not pay the timeout again, and a later lucky pass does not un-block it. Split cannot solve a framing refusal and no longer pretends to: a refused origin always falls through to a handoff.",
    "built", "tt145-engines.mts WM-06"),

  F("CT-03", "CT", "Handoff / continue-on, classified by mechanism instead of advertised", "A", "P2",
    "src/lib/launch-claim.ts + Monitor → Continue on another device",
    "Limit first, because it is the whole reason this row exists: there is no server and no socket, so two devices cannot be connected live by this app — what travels between devices is a link the user carries. Four mechanisms — live, linked, exported, impossible — derived from four mechanical facts, and one assertion that throws when a caller tries to present a weaker one as stronger: a URL fragment cannot be labelled live. Live means both windows are open, same origin, channel connected, and it is explicitly one desktop on two views rather than two devices; a fragment is a link the user carries, bounded at 8 KiB, carrying a checksum so a mangled paste fails loudly, and refused rather than truncated above the budget. This is the honest completion of a row that previously read as continuity: there is no server and no socket, so two devices cannot be connected live by this app, and the pane says that in the same breath as the feature.",
    "built", "tt145-engines.mts CT-03"),

  F("AU-01", "AU", "Routines: a closed action vocabulary with rehearsal and audit symmetry", "A", "P2",
    "src/lib/routine-guard.ts + Routines → Routine guard",
    "The whitelist is a type, not a convention: every action is one of twelve kinds, each with its own argument validation, and there is no run-script, run-shell or call-URL member, so a shared routine file cannot introduce a capability it did not ask for — the importer reports each rejected action instead of refusing the whole file silently. A rehearsal is provably side-effect free because plan() returns a value and the executor refuses a plan marked dryRun; a rehearsal and a real run produce the same effects list and different audit entries (routine.dryrun versus routine.run), so the difference survives the fact. An interval below one minute is refused: a page cannot be a real background daemon, and a trigger fires only while the app runs.",
    "built", "tt145-engines.mts AU-01"),

  F("SM-07", "SM", "Amazon Music links: twelve storefronts, one embed shape, nothing tracked", "A", "P3",
    "src/lib/sm7-summary.ts + Music → Amazon Music links",
    "An album, track, playlist or artist address on any of twelve storefronts is parsed into one shape carrying that storefront's own marketplace id, with affiliate and tracking parameters stripped and then verified absent from the output rather than assumed stripped. The confidence field is the honest part: an address reconstructed from a page link lacks Amazon's opaque share id, so the embed plays a 30 second preview at best and the row says so instead of implying full playback; an artist or playlist link, which Amazon does not document an embed for, is reported as opening the app instead. No control protocol, no search and no library: Amazon's Music APIs are partner-only, and the sandbox cannot reach Amazon, so every case here is unit-tested rather than fetched.",
    "built", "tt145-engines.mts SM-07"),

  F("LN-05", "LN", "Upscale: edge-directed interpolation with a stated cost and a ringing bound", "A", "P2",
    "src/lib/upscale-plan.ts + Monitor → Upscale",
    "Three kernels chosen by content, not taste: nearest for pixels that are data, bilinear for a mild photographic scale, and a separable Lanczos-3 above 2× — each one labelled as interpolation that redistributes detail and never invents it, because there is no learned model here and the row must not imply one. The engine bounds the work (4× per side, 64 M output pixels), computes the multiply-accumulate cost, and clamps every output sample to its source neighbours so an edge-directed kernel cannot produce a halo. A test compares Lanczos against nearest on a step edge to prove the kernel is doing something, and the ring bound is a property, not a picture.",
    "built", "tt145-engines.mts LN-05"),

  F("WM-19", "WM", "Render snapshot: out-of-process capture with its four refusals", "A", "P2",
    "src/lib/snapshot-plan.ts + Monitor → Window mechanics",
    "A snapshot is out-of-process only if it came from the display capturer, and the engine refuses the three cases where that silently fails: no user gesture (a background getDisplayMedia call rejects and cannot be worked around), a hidden tab (throttled to about 1 fps, i.e. a still with extra steps), and a DRM-protected surface (the compositor substitutes a placeholder and no page can prevent it). Output is clamped to an 8 MP budget with the scale factor stated, frame quality is a sampled luma fraction so an all-black placeholder is distinguished from a dark theme, and the in-process DOM fallback is labelled as what it is — the one thing the row must not claim.",
    "built", "tt145-engines.mts WM-19"),

  F("RG-02", "RG", "Scheduling hints, applied as a frame budget with measured overruns", "A", "P2",
    "src/lib/task-budget.ts + Monitor → Frame budget",
    "The hint is only useful if something acts on it, so this is the budget rather than the probe: slices are admitted in priority order into the frame after a reserved input allowance, a non-resumable slice that does not fit is deferred whole, and a resumable one runs partially with the granted milliseconds reported — the first draft listed a sliced task as both run and not run, which a test caught. An overrun teaches the model a measured cost, and the cost used is the worse of declared and measured, never the better. isInputPending is consumed where it exists and its absence is labelled a downgrade rather than parity.",
    "built", "tt145-engines.mts RG-02"),
];

/**
 * Rows this turn touched but did **not** promote, with the exact reason. Kept in the
 * tree so the next turn inherits the boundary rather than rediscovering it.
 */
export const TT145_STILL_PARTIAL: Record<string, string> = {
  "HW-02": "already graded built by an earlier turn (detection only); ADPF performance hints need an Android integration layer a page cannot reach, so this turn left it alone.",
  "FM-10": "a DocumentsProvider is an OS component; a page can only register a share target, which is a different row.",
  "IN-08": "an IME switcher is an OS input method; the app can only observe composition events.",
  "PR-07s": "casting page media like a browser needs the site's own Media Session metadata and a sender SDK; the row's own limit is unchanged.",
  "RC-12": "the encrypted archive needs a key custody path this build does not ship; the receipt path stays plaintext and the row says so.",
  "BK-02": "folder sync needs a second endpoint; there is no server to sync with in this build.",
};

/** The last mapper: an earlier turn's downgrade never reverts a row whose engine exists. */
export function patchTT145(row: SpecRow): SpecRow {
  const upgrade = tt145Features.find((f) => f.code === row.code);
  if (!upgrade) return row;
  return { ...row, name: upgrade.name, route: upgrade.route, nuance: upgrade.nuance, status: upgrade.status, tier: upgrade.tier, test: upgrade.test };
}
