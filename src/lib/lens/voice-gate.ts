/**
 * LN-08 — voice isolation gate.
 *
 * The gate that runs on the audio thread. What lives here is the ENVELOPE
 * DECISION, factored out of the AudioWorklet so it can be tested: an
 * AudioWorkletProcessor cannot be instantiated in Node, and a gate whose
 * timings are only checked by ear is a gate whose timings are not checked.
 *
 * The failure this avoids is the naive noise gate: follow the instantaneous
 * amplitude, and every inter-word pause below the threshold mutes the mic,
 * so speech sounds chopped and listeners hear a duck quacking. The fix is an
 * attack/hold/release envelope — a fast opening, a hold long enough to bridge
 * the gap between words, and a slow close so the tail of a word is not cut.
 *
 * Numbers, all at 48 kHz:
 *   • attack  ~2 ms   — fast enough to not clip the first consonant
 *   • hold    100 ms  — longer than the pause inside "a bit", shorter than a breath
 *   • release ~200 ms — slow enough that a word's tail is not severed
 *
 * Everything is pure and frame-rate driven; the caller supplies the sample rate.
 */

/** Hold time in milliseconds: how long the gate stays open after the last loud sample. */
export const HOLD_MS = 100;
/** Attack coefficient per sample (48 kHz): reaches ~63 % in about 2 ms. */
export const ATTACK = 0.02;
/** Release coefficient per sample: reaches ~63 % closed in about 200 ms. */
export const RELEASE = 0.0008;
/** How fast the envelope itself decays, so a single click cannot hold the gate open. */
export const ENVELOPE_DECAY = 0.999;
/** Below this the input is treated as silence rather than amplified hiss. */
export const FLOOR = 1e-6;

/** The gate's memory. One instance per audio stream. */
export interface GateState {
  /** Peak-following envelope. */
  env: number;
  /** Current gain, 0..1. */
  gain: number;
  /** Remaining hold samples. */
  hold: number;
}

export function initialGate(): GateState {
  return { env: 0, gain: 0, hold: 0 };
}

const holdSamples = (sampleRate: number) => Math.max(1, Math.round((HOLD_MS / 1000) * sampleRate));

/**
 * Process one sample.
 *
 * Returns the new state and the gain to apply to this sample. Pure: the caller
 * can drop a frame and retry without corrupting the envelope.
 */
export function stepGate(
  state: GateState,
  sample: number,
  threshold: number,
  sampleRate: number,
): { state: GateState; gain: number } {
  const x = Number.isFinite(sample) ? Math.abs(sample) : 0;
  // Peak-follow with decay: a single spike (a door slam, a click) raises the
  // envelope for one sample and then it falls away, instead of pinning an
  // average upward and holding the gate open for a second.
  const env = Math.max(x, state.env * ENVELOPE_DECAY);

  const hold = env > threshold ? holdSamples(sampleRate) : Math.max(0, state.hold - 1);
  const target = hold > 0 ? 1 : 0;

  // Asymmetric smoothing. Opening fast is what makes speech intelligible;
  // closing slowly is what stops the last syllable being amputated.
  const coefficient = target > state.gain ? ATTACK : RELEASE;
  const gain = state.gain + (target - state.gain) * coefficient;

  return { state: { env, gain, hold }, gain };
}

/**
 * How long until the gain is effectively at `target`, in milliseconds.
 *
 * The UI uses this to explain the gate's behaviour instead of leaving the
 * listener to wonder why the mic seems to lag. Computed from the coefficient
 * rather than hardcoded, so changing ATTACK/RELEASE cannot leave the text lying.
 */
export function timeToReach(from: number, target: number, coefficient: number, sampleRate: number): number {
  if (coefficient <= 0 || coefficient >= 1) return 0;
  if (from === target) return 0;
  // (1 - c)^n is the remaining error; solve for n until error < 0.05.
  const remaining = Math.max(Math.abs(target - from) * 0.05, 1e-9);
  const total = Math.abs(target - from);
  const n = Math.log(remaining / total) / Math.log(1 - coefficient);
  return (n / sampleRate) * 1000;
}

/**
 * Whether a gate with these settings would actually isolate a voice, stated
 * honestly. A gate cannot remove music, a fan, or a room — it only mutes what
 * is quiet. Saying otherwise is the usual lie in this feature.
 */
export function describeGate(threshold: number, hasWorklet: boolean): string {
  if (!hasWorklet) return "No AudioWorklet — the mic track is passed through ungated.";
  if (threshold <= 0) return "Threshold is zero, so the gate never closes and nothing is isolated.";
  return (
    `Mutes input quieter than ${(threshold * 100).toFixed(1)}% with a ${HOLD_MS} ms hold. ` +
    "This isolates a voice from a quiet room; it cannot remove music, an echo, or a fan that is at the same level as the speaker."
  );
}
