import type { SpecRow, Status } from "./row";

/**
 * TT146/TT147 — register rows for the engines built across the two turns, plus
 * the rows whose previously-stated gaps were closed by a suite that did not
 * exist before.
 *
 * The rule used to promote a row here: the row's own `nuance` may keep its
 * platform limits (those are facts about the web, not about us), but every
 * clause that described *missing work* has to be gone, and a named suite has to
 * exercise the primary contract plus at least one adversarial case. Nothing is
 * promoted because a similar row was promoted.
 */
const BUILT: Status = "built";

export function patchTT147(row: SpecRow): SpecRow {
  const core = "tt146-core.mts";
  const net = "tt146-net-quality.mts";
  const oracle = "tt146-oracle.mts";
  const http = "tt146-http.mts";
  const e2e146 = "e2e-tt146.mts";
  const e2e147 = "e2e-tt147.mts";

  switch (row.code) {
    case "HW-03":
      return { ...row, status: BUILT, route: "src/lib/media/codecs.ts + RuntimePanel CodecCard",
        nuance:
          "A real isConfigSupported/isConfigSupported matrix over five codecs and four sizes, asked through WebCodecs in this engine; the report names decode and encode separately and quotes the answers instead of translating them. The matrix is bounded by an answer timeout (4 s default, injectable) so one wedged configuration cannot hang the pane, and the pane prints the sentence that stops the usual misreading: a supported answer means the browser accepted the configuration, not that silicon did the work. In this container Chromium accepts H.264/AV1/VP9/VP8 for software decode, rejects HEVC, and encodes nothing — which is what the row now states. Limits: no bitstream is ever produced, so 'supported' is never a throughput or quality claim, and hardware acceleration cannot be distinguished from software beyond what the API reports.",
        test: `${core} (matrix verdicts, timeout, chooser), ${e2e146} (pane agrees with a direct WebCodecs call in the same page)` };

    case "HW-09":
      return { ...row, status: BUILT, route: "src/lib/net/quality.ts + src/lib/net/use-quality.ts + RuntimePanel NetworkCard; consumed by Photos, Media",
        nuance:
          "The browser's capped estimate and this app's own measurement are kept as two separate facts, and every decision names which one won: offline beats Save-Data, Save-Data beats a trusted measurement, a trusted measurement beats the browser estimate, and a missing Network API is reported as assumed rather than guessed. The ladder is four concrete rungs (thumbnail pixels, preview pixels, video height, prefetch bytes, parallel transfers) and a measured 40 Mbit/s really does raise the gallery from 256 px to 384 px while the painted gallery re-plans without a reload — one probe, every open surface. Rejection rules keep timer noise and cache hits out of the estimate, and an estimate older than its staleness window stops being an estimate. Limits: a single probe is a sample, not a capacity measurement (a busy radio reads low); Chromium caps downlink at 10 Mbit/s so the estimate alone can never justify the top rung; Safari and Firefox expose no NetworkInformation at all and get the stated middle rung.",
        test: `${net} (rules, bands, authority order, 20 000-case fuzz, hysteresis), ${core} (estimator + ladder), ${e2e146} (real probe, real gallery, thumbnail width follows the plan)` };

    case "HW-10":
      return { ...row, status: BUILT, route: "src/lib/wasm/probe.ts + RuntimePanel EngineCard",
        nuance:
          "The probe module is assembled in code (76 bytes) rather than shipped as a blob, so what is validated is what is executed: it validates, instantiates and returns its own expected constant, which distinguishes 'the engine parsed the SIMD opcode' from 'the engine ran it'. Threads are reported by their actual precondition — SharedArrayBuffer requires cross-origin isolation, which a normal tab does not have — so the honest answer here is a single-threaded path with the reason printed, and a worker handshake that reports pass or failure rather than assuming either. The chunk planner partitions any item count exactly once. Limits: no performance claim is made (a 76-byte module says nothing about throughput), and relaxed SIMD is detected only as a feature string, not exercised.",
        test: `${core} (execution constant, absence reasons, chunk partition), ${e2e146} (executed in this Chromium, threads explained)` };

    case "PR-06":
      return { ...row, status: BUILT, route: "src/lib/mail/handoff.ts + Mail module",
        nuance:
          "RFC 6068 mailto composition with the parts that are usually wrong done right: CRLF line endings, %20 rather than '+', unicode subject and body encoded as UTF-8, and header injection (a newline inside an address or subject) refused before anything is built. Over-long bodies are truncated at a boundary the reader can see and the byte count is shown against the limit. The module also states the channel plan and what it cannot do — no IMAP, no SMTP, no copy in Sent — and falls back from Web Share to clipboard to mailto, naming the branch it took. Limits: delivery is the mail client's business, and the browser may hand the URL to a web handler instead of a desktop client.",
        test: `${core} (encoding, refusals, truncation, round trip), ${e2e146} (real clipboard URL, browser parses it back, bad address refused)` };

    case "LN-05":
      return { ...row, status: BUILT, route: "src/lib/lens/resample.ts",
        nuance:
          "Separable windowed-sinc resampling (Lanczos-3, bicubic, linear) with normalised weights, support scaled by 1/ratio and clamped to the source, premultiplied alpha and an alpha threshold so ringing residuals cannot be unpremultiplied into white specks. Verified against a numpy float64 oracle for four size pairs and three kernels: worst channel difference ≤1, mean <0.02, fewer than 3% of channels differ; against Pillow's fixed-point Lanczos the comparison is a band (mean 0.26), because two correct implementations are allowed to differ at edges. Limits: no GPU path, no gamma-correct resampling (the pixels are treated as sRGB values, which is what the rest of the app does), and no EXIF orientation handling here.",
        test: `${core} (weights, identity, alpha), ${oracle} (numpy + Pillow, cross-implementation)` };

    case "LN-06":
      return { ...row, status: BUILT, route: "src/lib/lens/resample.ts applyRelight",
        nuance:
          "The key light is a direction, not a brightness knob: a Lambert term from a surface normal derived from a Sobel gradient, with the gradient clamped on coordinates rather than on a flattened index (the index-clamp bug silently substituted a middle-row neighbour and corrupted the last row and column — the oracle caught it, a visual check would not have). Verified channel-by-channel against numpy at four angle/intensity combinations: worst difference ≤2. Limits: single light, no specular term, no normal map, and no colour-management — it is a relight of the pixels the app already holds.",
        test: `${core} (direction semantics), ${oracle} (numpy, worst ≤2)` };

    case "AU-03":
      return { ...row, status: BUILT, route: "src/lib/automation/tokens.ts + /api/automation{,/tokens} + Routines AutomationPanel + ShellDaemons drain",
        nuance:
          "An external script can drive the open shell, and the whole path is built so that the secret exists once: the server stores only a SHA-256 of a 32-byte secret (constant-time comparison), the token is shown a single time in the panel, scopes are explicit, revocation is idempotent, and the queue is bounded. The shell — never the server — executes the actions, one run at a time, through the same executor the UI uses, and reports the outcome back; a run that fails is reported failed, never retried in a loop. A fixed-window limiter answers 429 with an honest Retry-After, and every refusal is audited. Limits: this is not an OS automation bridge; it drives this app's own whitelisted commands, and the token is a bearer secret, so its safety is the transport's (same-origin HTTPS).",
        test: `${core} (shape, hashing, scopes, limiter, terminal-once), ${http} (live server: mint, enqueue, settle, revoke, 429), ${e2e146} (panel mints once, external curl executes, outcome reported)` };

    case "PR-01":
      return { ...row, status: BUILT, route: "src/lib/editor/encoding.ts + Editor",
        nuance:
          "Encoding is detected, not assumed: BOMs, a NUL in every other byte for BOM-less UTF-16, and a strict UTF-8 validity pass before falling back to windows-1252. Save reports lossy conversions instead of silently writing '?', and a large file gets a chunked plan with an explicit whole/chunked boundary rather than freezing the tab. The editor keeps autosave, find and diff on top of that engine. Limits: no charset auto-detection beyond the four handled families, no EBCDIC/latin-9 edge cases, and native filesystem safe-save belongs to FM-18, not this row.",
        test: `${core} (sniffing, lossy encode, large-file plan)` };

    case "FM-14":
      return { ...row, status: BUILT, route: "src/lib/files/drag-payload.ts + Files drop targets",
        nuance:
          "Internal drags carry a private MIME type plus a text/plain fallback, so a Fusion window can tell 'this came from another Fusion window' from 'this came from the OS' and accepts both with different paths; a drop that is neither is refused with a reason. The payload is bounded, the path list is normalised, and the keyboard alternative (a real focusable affordance for a destination) exists because drag-and-drop is unusable with a keyboard and there is no web API that fixes that. Limits: the OS decides what it will hand over, and dragging *out* to other applications depends on the browser's download-vs-drag behaviour, which is not testable from inside the page.",
        test: `${core} (payload types, drop decisions, keyboard path)` };

    case "CT-03":
      return { ...row, status: BUILT, route: "src/lib/handoff/continue-link.ts + Shell boot adoption + RuntimePanel HandoffCard",
        nuance:
          "A layout travels as a link: versioned JSON, base64url, in the URL fragment — the part browsers never send to a server, so the link that carries the desktop cannot also leak it into an access log. Encoding drops windows whose module is not installed, ranks by z-order when the cap of 12 is reached, refuses anything over 8 000 characters with the measured size, and strips props whose names look like credentials at any nesting depth. Decoding treats the payload as hostile: it validates the version, refuses oversized or non-JSON payloads whole, re-clamps geometry, re-filters props and drops uninstalled modules. On load the shell adopts a link after hydration, then removes the fragment so a reload cannot silently overwrite later edits, and a refused link leaves the existing desktop untouched. Limits: window *content* is not carried (a link is a layout, not a transfer), file paths that the other device lacks will open empty, and the two devices must be running the same app version's fragment format.",
        test: `${core} (round trip, secrets, tamper matrix, caps), ${e2e146} (link built, opened in a second profile, tampered link refused)` };

    case "ST-02":
      return { ...row, status: BUILT, route: "src/lib/settings/deep-links.ts + SystemLinks (Settings → Default apps)",
        nuance:
          "A verified index of 14 OS panels with the URI scheme each platform actually registers — ms-settings: on Windows, x-apple.systempreferences: on macOS, gnome-control-center panels on Linux, Settings intents on Android. Platform detection handles the two cases that fool user-agent sniffing (an iPad reports MacIntel; an Android phone reports Linux) and returns 'unknown' rather than guessing. Coverage is stated per platform (Android exposes fewer addressable panels than Windows), a panel with no verified URI for the current platform is refused instead of silently linking to another OS, and iOS is told plainly that no public scheme exists. Every row carries the caveat that the browser may ask first, open a different page or do nothing, and that the app cannot see which. Limits: a URI is a request, not a result; the index is intentionally small, and adding an entry without a verified URI is treated as a defect.",
        test: `tt147-core.mts (scheme table, detection, search, refusals), ${e2e147} (coverage badge matches the platform, search narrows, URI scheme matches)` };

    case "HW-04":
      return { ...row, status: BUILT, route: "src/lib/gpu/accelerators.ts + RuntimePanel AcceleratorCard",
        nuance:
          "What the machine would compute an inference on, answered by the two APIs that know: WebGPU's adapter (with the strings it reports and its own fallback flag) and WebNN's device context, which is the only browser API that names an NPU. A software rasteriser is reported as software — the report tests isFallbackAdapter and also matches the vendor/architecture strings, so a SwiftShader adapter in a container reads 'GPU API present, but compute lands on the CPU' instead of 'WebGPU available'. WebNN is claimed only after a context is actually created, trying npu → gpu → cpu and reporting the device it really got; a refusal keeps the engine's words. Limits: no model is run, so nothing here is a throughput claim; WebNN is behind a flag in shipping engines; adapter strings are advisory and can be spoofed by the engine.",
        test: `tt147-core.mts (fallback detection, WebNN device order, exception paths), ${e2e147} (card agrees with a direct requestAdapter in the same page)` };

    case "HW-07":
      return { ...row, status: BUILT, route: "src/lib/peripherals/inventory.ts + RuntimePanel PeripheralCard",
        nuance:
          "HID, USB, serial and Bluetooth are read as what they are: the devices already granted to this origin, reported per bus, with a refusal (a permissions policy, a locked profile) kept separate from an empty list. Whether a chooser can be opened is a separate fact from whether a device exists, and a chooser needs a real click — no timer, load handler or Worker can open one. Request plans refuse the filterless forms the spec forbids or that would be dangerous: a HID request without a usage page (which would include keyboards) and a USB request without vendor and product ids. Limits: this is not the machine's device list; a grant says the origin may talk to a device, not that the device works; Bluetooth needs an explicit service filter and is not requestable from this panel.",
        test: `tt147-core.mts (granted vs refused, request plans), ${e2e147} (four bus rows agree with navigator presence)` };

    case "WM-16":
      return { ...row, status: BUILT, route: "src/lib/windowing/pointer-lock.ts + RuntimePanel ConfinementCard",
        nuance:
          "Cursor confinement as the web actually offers it: Pointer Lock on one element in one document, requested from a real gesture, with raw input asked for first and its refusal remembered so the retry asks for adjusted movement. The state machine treats a pending request as pending (Chromium ignores a re-entrant request, and believing otherwise is how a UI reports a lock it never got), and dropping confinement never requires a gesture. Verified in this Chromium by a real click: document.pointerLockElement is the card's own surface, then released through the same control. Limits: this confines the pointer to a window, not to a chosen display — no page can select a display for confinement, and the display count is reported only when the browser exposes it (here it does not, so the card says so).",
        test: `tt147-core.mts (state machine, refusal paths, honest description), ${e2e147} (real lock and release, or an explained refusal)` };

    case "PR-07o":
      return { ...row, status: BUILT, route: "src/lib/browserSession.ts profileSessionKey/profileSessionKeys + Browser + ProxyFrame + tt147-core",
        nuance:
          "Private proxy tabs choose a cookie jar: 'this tab only' (its own jar, keyed by the tab id) or a named profile (one jar shared by every tab that picks it, and by none other). The key derivation used to live inline in both the Browser and the proxy frame — a divergence there would silently split one profile into two jars — so it is now one tested function. Profile names come from untrusted input (saved sessions, imports) and are accepted only as 1–30 letters, digits, spaces, hyphens or underscores after whitespace normalisation; an invalid name loses the profile and keeps the tab. The URL guard underneath refuses non-http(s) schemes, userinfo (the https://bank.example@evil.example form) and same-origin frames, which could otherwise unsandbox themselves. Jars are amnesic: they live in memory while at least one tab uses the key and are dropped with the last one. Limits: a third-party frame that refuses to be framed, or a site that pins cookies to the top-level context, is outside this model; nothing here defeats a site that fingerprints the browser instead of the jar.",
        test: "tt147-core.mts (jar keys, name sanitisation, restore, URL guard)" };

    case "AU-01":
      return { ...row, status: BUILT, route: "src/lib/routines.ts + routines table + /api/routines + Routines module + shell trigger daemon",
        nuance:
          "A routine is a bounded list of whitelisted commands (13 of them, at most 30 per routine) with four trigger kinds, and the vocabulary is enforced when the routine is authored — a script containing anything else shows the refusal and disables Save, so an invalid routine cannot exist in the database. A rehearsal is a first-class action: it records routine.dryrun in the real audit log and executes nothing, and it deliberately does not move lastRun, so the list can never claim a routine ran when it was only rehearsed; a run records routine.run and the timestamp. Triggers run only while a shell window is open and honour the load governor. Limits: nothing runs while the app is closed (no OS scheduler is available to a PWA), and a missed interval is not back-filled.",
        test: "e2e-tt147.mts (preview → save → rehearse → run, audit rows differ, whitelist refusal), tt110-core.mts (engine)" };

    case "AP-05":
      return { ...row, status: BUILT, route: "src/components/modules/Apps.tsx (Background tab) + src/lib/background-inventory.ts + /sw.js",
        nuance:
          "The inventory is read, not remembered: service-worker registrations come from navigator.serviceWorker.getRegistrations() in this page, and each registration's one-off and periodic sync tags come from its own getTags(). The end-to-end test compares the panel's rows against a direct query made in the same page — scopes must match exactly and tag lists must match — so a stale copy would fail. Alongside it, the shell's own daemons report their callback counts, which are measured in this page's memory and reset on reload. The panel says in words that these are not operating-system wake counts and that Fusion registers no periodic sync job itself. Limits: other apps' background work is not visible to any page, and browser-side throttling or suspension of an inactive page cannot be observed or prevented from inside it.",
        test: "e2e-tt147.mts (panel rows equal getRegistrations() and getTags()), tt85-inventory.mts (counter model)" };
  }
  return row;
}
