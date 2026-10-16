# Fusion Shell Web — v3.0 (PWA conversion of the Fusion Shell Android master spec v2.1)

This repository is the executable form of the conversion. The authoritative feature
register is **data, not prose**: it lives in the `features` table, is rendered by the
**Spec** module inside the running app, and is exported as `requirements.csv` from
`/api/features?format=csv`. 252 rows, each with: tier, phase, the concrete web
mechanism, the nuance that makes the implementation different from the obvious one,
a status, and a falsification test.

## 0. Runtime honesty

Executed in this sandbox, by me, this turn:

| Tool | Use | Result |
|---|---|---|
| `bash` + Node 20 / Next 16 toolchain | `next typegen`, `tsc --noEmit`, `next build` | all passed |
| `drizzle-kit push` | applied the 19-table schema to the local PostgreSQL | applied |
| `psql` | verified table creation | 19 tables |
| `curl` against a locally started production server | health, bootstrap, features, fs list/write/move, search, jobs, entitlement, together, CSV export | all returned `ok:true`; journal rows recorded; 252 spec rows seeded |
| `generate_image` | one PWA icon | `public/icon-512.png` |

**Not** executed: no browser automation, no multi-device test, no AirPlay/Cast receiver
on a LAN, no screen-reader pass, no load test at 100 k index rows. Every number in the
app's performance panel is measured live on the viewer's own hardware (DP-08); nothing
is quoted from a benchmark I did not run.

## 1. Mapping the Android spec onto the browser

| Android construct | Web construct used here |
|---|---|
| H1 in-app compositor | DOM compositor, pure reducer `src/lib/windowing/state.ts` |
| H2 system windows | **Document Picture-in-Picture** (true always-on-top) + popup fallback |
| H3 external-app broker (freeform / split / fullscreen / PiP) | **server-side embeddability probe** (`/api/embed-probe`) → iframe window / split / handoff tab |
| External display + BlackTop | `getScreenDetails()` → `/display` route with its own desktop state + blackout/touchpad surface |
| Capability probe | `src/lib/capabilities.ts`, ~50 real feature detections incl. async refinements |
| ADPF / thermal governor | `src/lib/governor.ts`: frame-cost EWMA + long-task rate + battery as a **thermal proxy** |
| FileOps journaled state machine | identical state machine in PostgreSQL (`file_ops`), SHA-256 verify before publish |
| Forge format router + fidelity grades | `src/lib/forge.ts` table + server OOXML extraction (`node:zlib`) at grade D |
| Beam (AirPlay/Cast/DLNA/Together) | Remote Playback API, Presentation API, multi-screen, Document PiP, WebRTC, Together anchor clock; RAOP/castv2/FairPlay/DLNA/Miracast/receiver marked **blocked with the missing primitive** |
| Lens (camera prefilter) | canvas composite pipeline, FaceDetector when present, no bundled ML model; virtual camera for other origins **blocked** |
| Vault / StrongBox | WebCrypto PBKDF2-600k → AES-GCM-256, zero-knowledge blob; WebAuthn as the only hardware binding |
| Play Billing / licence keys | self-hosted Ed25519 authority (`node:crypto`), offline-verifiable signed claims |
| iMessage / RCS / SMS | connector seam with a reachability probe; the three impossible routes are declared blocked |

## 2. Status vocabulary (enforced in the UI)

`built` runs end to end here · `partial` runs with a named degradation ·
`probe` ships as a runtime capability check plus honest degrade UI ·
`skeleton` is a typed seam with no engine · `blocked` is provably impossible on this
platform **and renders the missing primitive**.

Current distribution: **147 built · 40 partial · 22 probe · 21 skeleton · 22 blocked**.

## 3. The twelve nuances that matter most

1. **Buttons 3/4 triple-suppression.** A desktop shell must `preventDefault()` on
   `pointerdown`, `pointerup` *and* `auxclick`, or the mouse side buttons navigate the
   tab and unmount the entire session.
2. **Drag writes DOM, not state.** Geometry is committed to the reducer once, on
   pointerup. Dispatch-per-pointermove is the common design and it collapses past ~6
   windows.
3. **Embeddability is measured server-side** before a browser window is offered — the
   honest replacement for Android's freeform broker.
4. **Document PiP needs stylesheet adoption**, or the portalled React tree renders
   unstyled. That one step is what makes always-on-top real on the web.
5. **The journal is written outside the data transaction**, so a rollback still leaves
   evidence of the attempt.
6. **Office = grade D by construction.** No WYSIWYG claim, an itemised loss report
   before any export, and saving back is disabled rather than lossy.
7. **ZIP has three guards** (entry count, expansion ratio, zip-slip) applied before
   allocation, using the platform's own inflate.
8. **No ML model is bundled** for segmentation or semantic search: the download would
   break the offline budget, so the matte is graded "C — heuristic" and semantic search
   is off rather than fake.
9. **Together corrects drift with playbackRate nudges**, never seeks, against a server
   anchor clock with an NTP-style offset estimate.
10. **The governor is closed-loop on observed cost** because the web exposes no thermal
    sensor; it degrades effects → background work → cast resolution, in that order.
11. **Service worker never serves stale API data.** A cached file listing is a lie; the
    SW returns an explicit offline envelope instead.
12. **Licensing verifies offline.** Ed25519 claim + cached public key; no feature ever
    disappears because the network did, and there is no remote wipe.

## 4. Verifying the claims yourself, inside the app

| Claim | Where to check it |
|---|---|
| Journaled, verified moves | Files → journal strip, Monitor → Jobs, or `mv` in Terminal |
| Pure, replayable reducer | Monitor → Compositor (state hash + command log) |
| Capability honesty | Settings → Capabilities; every `blocked` spec row names its primitive |
| Governor reacts to load | Monitor → "Inject a long task" |
| Backup verification | Backup → build bundle → Verify digests (recomputed in the browser) |
| Licence signature | Settings → Licence → Issue, then edit one character and Verify |
| Search provenance | Find → every hit shows source and `fts`/`substring` |
| Embeddability probe | Browser → enter `google.com` (DENY → handoff offered, no blank frame) |

## 4b. v3.1 — audit, new engines, executable verification

**Audit fixes.** v3.0 marked six rows `built` with no code behind them: PR-10 clock, MD-04 voice
recorder, PR-13 stickies, AU-02 presets, PR-07r sessions (tabs lived in component state, so a
restored session would have lost them), and PR-12 clipboard UI. All six are now implemented, and
each row's nuance starts with `AUDIT:` so the correction stays visible.

**Bug found by verification.** The reducer property test (10 000 seeded adversarial commands)
failed on its first run: with a fractional viewport (e.g. 718.586 px), `Math.round` ran *after*
clamping and pushed a window's x up to 0.5 px past the title-bar bound. Fix: integer viewport,
round-then-clamp. The test is now part of the suite.

**New engines:** Clock, Planner (tasks + shell-owned reminder daemon + RFC 5545 ICS with
unfolding/escaping/UID dedup), Devices (voice, QR, colour, audio routing, Web Serial console,
HID/USB/BT, gamepad), Share (WebRTC screen share + data-channel file bridge, Postgres signalling,
RTCStats-driven quality governor), Routines (whitelisted, dry-run, interval/time/display triggers)
+ presets/sessions, Clipboard, Storage (digest duplicates, quota, persistence), Local disk (File
System Access, IndexedDB-persisted handle, re-grant flow, sync with conflict inbox), desktop
widgets (sandboxed, heartbeat watchdog) + stickies, PSD header (grade E), EPUB (grade C, spine
order), captions (SRT→VTT), trim (1× re-encode), relight, AudioWorklet voice gate, opt-in web
search, offline write queue with ordered replay, consent-gated SW updates.

**Verification you can run:**

```
node --experimental-strip-types scripts/unit.mts          # 20 unit/property tests
npm run build && npx next start -p 3999 &
BASE=http://localhost:3999 node scripts/integration.mjs    # 17 adversarial HTTP tests
```

The integration suite attacks contracts, not only happy paths: journal state order, refusal of
dir-into-itself moves, traversal normalisation, version snapshots, digest duplicates, stale-revision
409, preset deletion guard, routine whitelist bypass, ICS re-import idempotency, signalling
targeting/size caps, the anchor clock frozen on pause, Forge grades and the zip-slip guard,
backup tamper refusal with no partial write, licence tamper and wrong-client refusal, and locked settings (423).

## 5. Known gaps (next highest-information tests)

1. **WS-10** index latency at 100 k documents (current corpus is seed-scale).
2. **WS-12** persistent File System Access handles across reloads (needs IndexedDB handle storage).
3. **WS-02/05** Beam transports and Together drift against real receivers and a second device.
4. Screen-reader and keyboard-only passes (AX-* are implemented structurally, not yet audited).
5. WebRTC screen-share signalling (CA-09) is a skeleton: the Postgres channel exists, the
   peer-connection plumbing does not.
