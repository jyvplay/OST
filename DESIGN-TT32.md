# TT32: Fusion Voice (AX-15), plus TT31 leftovers

**Blocker addressed:** "Narrator: audible speech is unverified (0 voices)". Through TT31, Fusion's Narrator spoke only through the browser's `speechSynthesis`.
- On many Linux machines, and in this sandbox's headless Chromium, that engine has **zero voices**, so the Narrator could only caption.
- TT32 gives Fusion its **own text-to-speech**, written from scratch. It is wired into the Narrator so speech exists wherever Web Audio exists.

**TT31 leftovers, now done:**
- **Touch tap-lift tested:** e2e-tt31 includes a CDP touch test (tap lifts a wall, finger drag moves a pin, tap-away settles it).
- **Pinboard overflow at 1440 is asserted** (LY-12).
- **Updated:** the e2e-tt31 header and the LY-22 test count (×10).

## Runtime honesty (what was actually executed)

- **Tools:**
  - Node 22 and TypeScript (`--experimental-strip-types`);
  - Playwright 1.64 against the sandbox's headless Chromium (launched with `--autoplay-policy=no-user-gesture-required`);
  - a Next 16.2.6 production build on :3999.
- **Oracle:** **CMU PocketSphinx 5.1.1** from PyPI (CMU BSD-style licence), installed in the tools venv by `scripts/sandbox/bootstrap.sh`.
  - It is used **only as a test oracle** (`scripts/oracle/asr.py`). Its bundled US-English acoustic model, LM and CMUdict never ship in Fusion.
  - Vosk, Whisper and Hugging Face models are unreachable from this sandbox.
- **Nobody listened to the audio.** I cannot hear, and the sandbox has no audio device.
  - Intelligibility claims rest entirely on the recogniser and on acoustic measurements.
  - "A human finds it pleasant" is **not** claimed.
- **What the browser tests verify:** the PCM handed to `AudioBufferSourceNode.start()`, captured by wrapping the prototype (the real call still runs).
  - Loudspeaker output is **not** verifiable here.
- **Code provenance:** no speech library, recording, model download or network call.
  - `voice-text.ts` and `voice-synth.ts` are original code: hand-written rule tables, hand transcriptions and textbook acoustic phonetics.
  - espeak and meSpeak are GPL and were not used or consulted.

## A. Formal model

**Pipeline:** `text → normalize → words → pronounce → ARPAbet phones (+stress) → segmentPhrase (durations) → phraseFrames (5 ms parameter tracks) → renderFrames (16 kHz PCM)`.

**Normalisation:**
- camelCase is split.
- Clock times `h:mm` → "h mm" / "h oh m" / "h o'clock".
- Abbreviations whose dot is not a sentence end: e.g., i.e., etc., vs., Dr., Mr., Mrs., Ms., approx., and no. before a digit.
- URL schemes are dropped.
- A dot or colon between word characters is spoken ("dot") or kept inside the token.
- Numbers become words, with `$` → dollars, `%` → percent, and ordinals (`3rd`) exempt from the letter|digit split.
- Key names (Ctrl, Cmd, Esc, Del…) are read as words.
- Acronyms (all caps, ≤ 5 letters, not in the lexicon, or vowel-less) are spelled.

**Pronunciation:**
- The order is lexicon (434 hand transcriptions) → compound split → morphology (`-ing`, `-ed`, `-s`, `-ly`, `-ness`…) → letter-to-sound rules with stress assignment.
- Rules have the form `left|letters|right=PH`, with the first match by longest letters.
- `-ed`/`-s` voicing agrees with the preceding phone.

**Synthesis (per phrase):**
- **Durations:** `D = Dmin + (Dinh − Dmin)·k`, with `k` from stress, word position, pre-voiceless shortening, clustering and phrase-final ×1.35, then ÷ rate.
- **Stops** are closure + burst + aspiration. TT32 makes burst duration and VOT place-specific:

  | Place | Burst | VOT voiceless / voiced |
  |---|---|---|
  | P | 10 ms | 55 / 6 ms |
  | T | 14 ms | 65 / 9 ms |
  | K | 22 ms | 75 / 14 ms |

- **Tracks:** formants are smoothed at τ 16 ms, amplitudes at τ 4 ms.
  - A phrase starting with a sonorant gets a 35 ms voicing rise.
  - The last voiced stretch decays over 70 ms.
- **Source:** a polynomial glottal pulse (OQ 0.6), one-pole tilt and ±0.3 % jitter.
- **Noise:** aspiration noise is half white and half first-differenced, and goes through the cascade. In aspiration, F1 bandwidth is 500 Hz (tracheal coupling).
- **Cascade:** F5…F1 plus a nasal pole/zero.
- **Parallel frication:** differenced noise through F2–F6 resonators, plus a **flat** bypass.
- **Output** is peak-normalised with 4 ms fades.

**Engine policy** (`chooseEngine`, pure):
- `fusion` → fusion.
- `system` → system if the Web Speech API exists, else fusion (never silent by surprise).
- `auto` → system iff the API exists, has ≥ 1 voice and has not failed this session; else fusion.

**Player** (`FusionSpeaker`): one AudioContext.
- Each phrase is synthesised on its own task and scheduled at `max(now + 20 ms, endOfQueue)`.
- `cancel()` bumps a generation counter, clears the pending task and stops every live source.

**Narrator integration:**
- `say()` picks the engine per utterance.
- Interrupting utterances cancel both engines.
- In auto mode, a system-engine error marks it failed and re-speaks the text through Fusion Voice.
- The caption bar names the engine (`data-engine`).
- Settings → Narrator → Voice (Automatic / System voice / Fusion Voice) and the Fusion Voice preset (Standard 112 Hz / Bright 150 Hz ×1.08 / High 195 Hz ×1.15) are seeded settings validated by the server.

## B. Hypotheses

**H+ (claimed and tested):**
- Single words are intelligible to an independent recogniser in forced choice: dev ≥ 85 %, digits ≥ 80 %, held-out ≥ 70 %.
- Letter-to-sound PER on random dictionary words is ≤ 30 %.
- In a voiceless Chromium, the Narrator speaks through Fusion Voice automatically.
- Its real focus announcements are recognised ≥ 75 % in forced choice.
- Ctrl stops it.
- The speed setting changes it live.
- Forcing System voice is honoured.
- The settings persist.

**H− (claimed false and tested):**
- Time-reversed speech does **not** pass.
- Noise does **not** pass.
- A spell-it-out letter-to-sound does **not** pass.
- Auto mode never calls `speechSynthesis.speak` when there are no voices.
- Nothing new is scheduled after a cancel.

**H∂ (partial, honest):**
- Whole-sentence open-vocabulary recognition is weak: WER **42.5–47.5 %** depending on the noise realisation (informational).
- The voice is intelligible but plainly synthetic (a 1980s-formant-synth class of voice).
- Results depend on the listening condition: see the sensitivity in G.

## C. Frontier (what is not covered)

- **Not tested:** loudspeaker playback (no device); human listening tests; non-English text (English only); SSML; voices other than the three presets' pitch/formant scaling.
- **Weak spots:** sentence-level naturalness, and monosyllables with /ow/ or /h/ (100-way errors: go→both, home→called, house→both).
- **Scope:** the Narrator still reads only Fusion's own page; it is not NVDA, JAWS or VoiceOver (unchanged from AX-14).
- **Mid-session voice installs:** when the browser later gains voices, Automatic switches to them on the next utterance (`voiceschanged`). A system engine that failed once stays replaced by Fusion Voice for the session.
- **Still open from TT31:** resting side walls remain thin targets (scale ≈ 0.14 at 1440); focus after Esc on a lifted wall is not asserted.

## D. Negative shapes (each has a test that must reject it)

1. Time-reversed speech scores at the gate (tt32-voice M1: 3/20).
2. Noise scores at the gate (M2: 0/20).
3. Letter-to-sound that spells words passes the PER gate (M3: 143 %).
4. Auto picks the system engine with 0 voices, giving silence (policy unit test; e2e-tt32 test 1 asserts `speak` was never called).
5. Auto keeps a failed system engine (policy unit test).
6. Forced "system" with no API at all goes silent (policy unit test).
7. Forced "system" still plays Fusion audio (e2e-tt32 settings test: 0 buffers).
8. Fusion "speaks" empty or near-silent buffers (e2e test 1: > 2 s, RMS > 0.03).
9. The wrong buffer sample rate (e2e test 1: all 16 kHz).
10. Ctrl leaves queued phrases playing (e2e Ctrl test: stops ≥ 1).
11. Phrases still start after a cancel (e2e Ctrl test: 0 buffers in the next 1.2 s).
12. The speed setting is ignored (e2e speed test: 2× < 0.7 × 1×).
13. A silent 2× run counts as "faster" (e2e speed test requires both > 0.3 s; see repair 6).
14. Two different announcements are compared for speed (the caption-equality assertion).
15. "3rd" is read as "three R D" (normalisation test).
16. "10:30" breaks into two sentences (normalisation test).
17. "Dr." or "e.g." ends a sentence or gets spelled (normalisation test).
18. "https://" is read letter by letter (normalisation test).
19. An unknown preset or rate > 2 crashes or runs unbounded (`fusionOpts` unit test).
20. The Voice selection is not persisted (e2e settings test).

**Modal-shortcut test:** with the Narrator's **modal help dialog open** while Fusion Voice reads the long help text, Ctrl must stop the audio (it is not swallowed by the modal), the dialog must stay open, and Escape must then close it (e2e-tt32, "modal").

## E. Mechanisms (independent ways the claims are checked)

1. **Independent recogniser, forced choice** (PocketSphinx JSGF grammar): word-, digit- and announcement-level gates.
2. **Independent recogniser, open vocabulary** (60k-word LM): sentence WER, informational.
3. **Independent dictionary** (CMUdict, frozen seeded sets in `scripts/oracle/g2p-sets.json`): letter-to-sound PER.
4. **Phone-level decoding** (allphone search): used to find the stop-consonant collapse.
5. **Acoustic measurement:** per-portion RMS against the vowel, and spectral centroid of bursts and aspiration (a /tmp diagnostic script; the findings are recorded under I).
6. **Real-browser observation:** an `AudioBufferSourceNode.start/stop` and `speechSynthesis.speak` spy, with the PCM pulled out and decoded.
7. **Pure unit tests** of the policy and normalisation.
8. **Mutants** for the oracle and G2P gates.

## F. Artifacts

| Path | Contents |
|---|---|
| `src/lib/voice-text.ts`, `voice-synth.ts`, `fusion-voice.ts`, `voice-engine.ts` | product code |
| `src/lib/narrator-dom.ts`, `src/components/NarratorHost.tsx`, `DisplaySettings.tsx`, `src/lib/settings-validate.ts`, `src/db/seed.ts` | integration and settings |
| `src/db/seed-data/features-tt32.ts` | AX-15 register row |
| `scripts/tt32-voice.mts` | gates, policy, normalisation, mutants, informational numbers |
| `scripts/e2e-tt32.mts` | real-browser suite |
| `scripts/oracle/asr.py`, `g2p-sets.mts`, `g2p-sets.json` | test oracle and frozen G2P sets |
| `scripts/sandbox/bootstrap.sh` | installs pocketsphinx==5.1.1, test-only |
| `scripts/e2e-tt30.mts` | pins `narratorVoice=system`, because that suite checks the system-engine path |

## G. Adversary (attacks tried)

**Oracle cheating.** Can the gate be passed by something that isn't speech?
- Reversed audio gives 3/20, noise 0/20, spelled G2P 143 % PER.
- The gates discriminate.

**Held-out leakage.**
- The held-out words were used for nothing but scored looks, all reported:
  - look #1: 20/20 (initial synth);
  - look #2: 19/20, notes→photos (after the stop fix);
  - a regression run on the same frozen synth gave the same 19/20.
- The G2P hold and rand sets were looked at once (hold 10.5 %, rand 18.0 %), and no hold or rand word was ever added to the lexicon.

**Listening-condition sensitivity** (measured on the pre-stop-fix synth, dev set):

| Condition | Dev | Digits |
|---|---|---|
| Frozen: noise ±0.001 | 19/20 | — |
| Noise ±0.0003 | 17/20 | — |
| −84 dBFS dither | 15/20 | 6/10 |

- The informational numbers move with the noise realisation alone (same synth): 100-way 78 vs 79, stop place 16 vs 19/30, WER 42.5 vs 45.0 %.
- The gates were met under the frozen condition only, which is stated wherever they are quoted.

**Test honesty.**
- The first speed test **passed with a 0.00 s 2× measurement**. That was a false pass, fixed in repair 6.
- The first engine test passed nothing until settings were changed through the UI (the API does not reach an open page).

## H. External verification

- **PocketSphinx:**
  - It is CMU's recogniser with an acoustic model trained on recorded human speech, and is not tuned to this synthesiser.
  - The forced-choice candidate lists are fixed word lists, or the page's own announcements.
- **CMUdict** is the external pronunciation reference for G2P.
- No human evaluation was possible.

## I. Repairs (each followed by a new attack)

1. **Stop place collapse** (diagnosed with the allphone decode and a 6-way stop test: **8/30**, chance 5/30).
   - Measurement showed the aspiration centroid at 0.8–1.1 kHz (whisper-like, F1-dominated) and the P burst centroid at 5.5 kHz (alveolar-like, from the differenced bypass).
   - Fix: aspiration F1 bandwidth 500 Hz with half-differenced noise, and a flat bypass (with √2 power compensation).
   - **Result: 15/30.**
   - *New attack:* velars were still never recognised.
2. **Velars:**
   - Burst duration and VOT are now place-specific (P/T/K), and the velar burst is a compact F2-centred peak.
   - *New attack:* loudness confound. The longer bursts escaped the 4 ms smoothing and came out +7 to +8 dB *above* the vowel.
3. **Burst recalibration:**
   - A bisection on `af` restored each stop's previous measured burst level (P −19.7, B −19.2, T −6.4, D −14.4, K −9.3, G −18.4 dB).
   - The velar locus blend was unified to 0.3.
   - **Result: 19/30.**
   - *New attack:* do the declared gates regress? Dev 19→**20/20**, digits 10/10, held look #2 **19/20**, 100-way 76→79.
4. **Onset ramp:**
   - The phrase-initial voicing rise was first applied to the vowel after a voiceless stop, which softens the VOT cue.
   - It is now restricted to sonorant-initial phrases.
   - *New attack:* the stop test was rerun with and without the ramp; scores were equal.
5. **Ordinals:**
   - "3rd" was split by the letter|digit rule.
   - Ordinal suffixes are now exempt, and clock times, abbreviations, key names and URL schemes were added.
   - *New attack:* "21st, 2nd", "100th", "no. 5", "min and max" (not "minutes"), "a:b" all pass.
6. **False pass in the speed test:**
   - Both durations must now be real speech (> 0.3 s), the same caption must be compared, and the rate is changed through the Settings control (the live path).
   - *New attack:* result 4.26 s → 2.50 s.
7. **The new settings were unknown to the server** ("unknown setting").
   - They are now seeded (seed 3.21.x) and validated.
   - *New attack:* the persistence assertion in e2e-tt32.
8. **e2e-tt30 would break by design** (Automatic now routes a voiceless browser to Fusion Voice).
   - That suite now pins `narratorVoice=system` and restores it.
   - *New attack:* the full run.

**Budget:** repairs 6–8 are test-harness fixes; 1–5 are product work on the new feature, not bug repair of old features.

## Results

**Full run:** 54 suites (`run-all.sh`, now including `tt32-voice` and `e2e-tt32`).
- The full run had one failure: e2e-tabletop "moved on the wall", a known full-run flake. That suite passed 14/14 when re-run alone.
- e2e-tt32 was then extended with the modal test and re-run: 6/6.
- **Ledger: 538/538** tests passing.

**Register:** 336 rows (AX-15 added); built 252 full / 62 partial / 22 blocked; tested 133 full / 77 partial / 126 untested.

**Fusion Voice numbers** (frozen condition: 300 ms pad + noise ±0.001):

| Measure | Result | Gate |
|---|---|---|
| Dev UI words | 20/20 | ≥ 85 % |
| Digits | 10/10 | ≥ 80 % |
| Held-out app names | 19/20 at look #2 (20/20 at look #1) | ≥ 70 % |
| G2P rand PER | 18.0 % (word-exact 40.5 %) | ≤ 30 % |
| In-browser focus announcements (0 system voices) | 13/14 | ≥ 75 % |
| 100-way, informational | 78–79/100 | — |
| Stop place/voicing 6-way, informational | 16–19/30 (8/30 before) | — |
| Sentence WER, informational | 42.5–45.0 % | — |
| Speed | 4.26 s at 1× → 2.50 s at 2× | — |

**Visual check:** `docs/screenshots/tt32-narrator-settings.png` and `tt32-caption-fusion-voice.png`.
- The Voice selector matches the existing Narrator controls.
- The caption bar reads "Narrator · Fusion Voice".

**Tails ledger:** unchanged (39 rows: 9 / 10 / 20).

## J. Stopping

The stopping criteria are:
- every H+ claim has a passing test;
- every D shape has a rejecting test;
- the full suite is green (see the ledger);
- the declared gates were met without moving them.

Stop here. Section C lists what is not claimed.
