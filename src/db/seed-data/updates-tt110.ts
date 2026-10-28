import type { SpecRow, Status } from "./row";

/**
 * TT110 corrections. Every row below either had no test at all before this turn, or had a recorded
 * nuance that this turn's measurements made more accurate.
 *
 * Three entries are worth reading twice, because they record a measurement that contradicted what
 * the code or the test assumed: the display capture here DOES receive a shared-audio track (so the
 * honest test asserts the real outcome rather than a convenient refusal), the system clipboard
 * re-encodes images (so no claim of byte identity survives), and a configured refusal must not be
 * reported as an uncertain write.
 *
 * Nothing here upgrades a grade that was not earned by a passing assertion.
 */
type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };

export const UPDATES_TT110: Record<string, Patch> = {
  // ---- Recall capture pathways: implemented earlier, measured for the first time now -----------
  "RC-04": { status: "built", test: "e2e-tt110-recall.mts",
    nuance: "A human-authorized screen snapshot becomes a memory: the browser's own picker chooses the surface, a frame is taken from the live track, and it is filed with a receipt whose method is authorized-display-frame. Measured end to end, not asserted: a 1180x664 PNG of 29,618 bytes containing 99 distinct colours, re-read from the archive and decoded by an independent PNG reader inside the test, so a blank or placeholder surface would fail. The app never chooses the surface and cannot capture without the prompt; what is saved is decoded pixels, not the protected bytes of any source." },
  "RC-05": { status: "built", test: "e2e-tt110-recall.mts",
    nuance: "A human-authorized screen RECORDING becomes a memory: MediaRecorder encodes the live track and the finished container is published with the receipt method authorized-display-recording. Measured: a 141,410-byte WebM whose first four bytes are the EBML magic 1a45dfa3, read back out of the archive. Shared audio is requested, never assumed — this platform grants it (one audio track), so the audio-only option was measured too and produced a real 29,923-byte audio/webm memory; on a platform that withholds it the option refuses instead of saving a silent file. Caps stop a runaway recording at 8 MiB." },
  "RC-06": { status: "built", test: "e2e-tt110-recall.mts",
    nuance: "A single element inside the Fusion browser view can be captured instead of the whole screen, filed with the receipt method fusion-element-frame. Measured: a 320x240 PNG taken from the page's own canvas and re-decoded from the archive. This pathway reads what the page already rendered; a cross-origin or protected surface taints the canvas and the browser refuses the read, which the interface reports rather than working around." },
  "RC-11": { status: "built", test: "e2e-tt110-recall.mts",
    nuance: "Capture stops when the human says so, and stopping means the tracks are really released: after a save the page holds zero live tracks, verified by counting them in the page rather than trusting the button state, and the archive is unchanged four seconds later. Cancelling pending work leaves every already-saved memory untouched — four memories before, four after." },

  // ---- Devices and windowing rows that shipped without a test ----------------------------------
  "MD-04": { status: "built", test: "e2e-tt110-shell.mts",
    nuance: "The voice recorder encodes from a real microphone track through MediaRecorder and writes the result into Documents. Measured: a 21,259-byte file whose first four bytes are the EBML magic, read back from the server after the recording stopped. The input meter moves while recording. The microphone is synthetic in this environment (Chromium's fake device), which is a limit of the test rig, not of the pathway: the encoder, the container and the write are real." },
  "MD-06": { status: "partial", test: "e2e-tt110-shell.mts",
    nuance: "Audio output routing uses the platform's own setSinkId: the module enumerates real output devices (three here) and offers a test tone per device, and routing an AudioContext to an enumerated device id is accepted without error. What cannot be proved from inside the browser is that sound physically leaves the chosen device — no page can observe that — so this row stays partial by design rather than claiming an unobservable outcome." },
  "HW-11": { status: "built", test: "e2e-tt110-shell.mts",
    nuance: "The screen wake lock is really taken and really released: the sentinel reports type screen, reads released=false while held, released=true after release, and fires its release event so the control can show the true state. The quick panel control reads 'held — release' while the lock is held. Headless Chromium requires the screen-wake-lock permission to be granted to the context; without it the request is refused, which the interface reports instead of silently appearing to hold a lock." },

  // ---- Licensing, jobs, routines, search --------------------------------------------------------
  "BL-02": { status: "partial", test: "tt110-core.mts",
    nuance: "A licence is an Ed25519-signed claim that verifies offline against the public key the app publishes. The test verifies it OUTSIDE the app — Node's own crypto against the published PEM — so the proof does not come from the code that produced the signature, and an edited claim fails both that independent check and the server's activation path. The stated grace period is 14 days. What is not proved is revocation reaching an offline installation: by construction it cannot, which is the point of offline verification." },
  "BL-05": { status: "built", test: "tt110-core.mts",
    nuance: "There is no remote wipe and no kill switch. Proved two ways: structurally, no route in the whole API tree contains remote-erase or remote-disable machinery; and behaviourally, a file written before an entitlement is taken away is still readable afterwards. Losing an entitlement can only lower what the app offers, never remove what the user already has." },
  "DP-14": { status: "partial", test: "tt110-core.mts",
    nuance: "Every file operation leaves an observable journal entry carrying its operation, source, destination, byte count, digest and final state, readable over /api/jobs. Measured on a real write-then-copy pair, both recorded COMPLETE. The journal records what finished; it is not a resumable queue, and a process killed mid-operation is covered by the crash tests rather than by this row." },
  "AU-01": { status: "partial", test: "tt110-core.mts",
    nuance: "A routine can be rehearsed without doing anything: the dry run is audited as routine.dryrun and the real run as routine.run, both against the real audit log, so a human can see the difference between a rehearsal and an execution after the fact. Commands outside the whitelist are refused when the routine is created, not discovered when it runs." },
  "SR-05": { status: "partial", test: "tt110-core.mts",
    nuance: "Search can be confined to one folder and the confinement holds: two files containing the same unique token, one inside the scope and one outside, return both unscoped and exactly the one inside when scoped. The scope is a path prefix on the indexed reference, matched on segment boundaries so a sibling folder with a longer name cannot leak in." },
  "SR-08": { status: "partial", test: "tt110-core.mts",
    nuance: "Search explains itself. With no query it reports index coverage per source (files, notes, settings, specs) so a user can see what is searchable at all; with explain=1 a query that finds nothing reports how many documents were searched, which strategy ran (websearch_to_tsquery with ts_rank plus a substring fallback) and what is deliberately excluded (Private, encrypted, trashed and excluded paths). Measured against an index of 921 documents." },

  // ---- The capture policy touches the privacy register too --------------------------------------
  "SC-02": { status: "partial", test: "tt110-core.mts",
    nuance: "Privacy switches are enforced by the server, not only by the interface. The screen-capture switch is read inside the same transaction that would publish the memory, so a page that still shows the old state, or a request crafted by hand, is refused on identical terms. Invalid values for the switch are rejected at the settings endpoint with 422 and the stored value is left alone." },
};
