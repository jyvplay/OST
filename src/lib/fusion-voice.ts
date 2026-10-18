/**
 * Fusion Voice (TT32): text → speech samples, entirely on this device. Original code (voice-text.ts front-end +
 * voice-synth.ts formant synthesiser); no speech library, no recordings, no model download, no network.
 */
import { synthPhrases, DEFAULT_VOICE, type VoiceOpts } from "./voice-synth";
import { textToPhrases } from "./voice-text";

export type { VoiceOpts };
export { DEFAULT_VOICE };

/** named voices offered in Settings (pitch / formant scale) */
export const FUSION_VOICES: Record<string, { label: string; pitch: number; formant: number }> = {
  // "standard" is the measured voice (DEFAULT_VOICE, 112 Hz); the others were measured too (DESIGN-TT32.md)
  standard: { label: "Standard", pitch: 112, formant: 1 },
  bright: { label: "Bright", pitch: 150, formant: 1.08 },
  high: { label: "High", pitch: 195, formant: 1.15 },
};

/** synthesise text → mono Float32 samples at opts.sr (16 kHz default) */
export function synthesizeText(text: string, opts: VoiceOpts = {}): Float32Array {
  return synthPhrases(textToPhrases(text), opts);
}
