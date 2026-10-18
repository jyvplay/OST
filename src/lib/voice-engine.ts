/**
 * Speech engines for the Narrator (TT32, AX-15).
 *
 *  - "system": the browser's Web Speech API (speechSynthesis) — whatever voices the OS has installed.
 *  - "fusion": Fusion Voice — our own text-to-speech (voice-text.ts → voice-synth.ts), rendered on this device and
 *    played through Web Audio. It needs no installed voice, no download and no network, so the Narrator can speak
 *    on machines (and headless browsers) that have zero system voices.
 *
 * chooseEngine() is the pure policy; FusionSpeaker is the browser player (one AudioContext, a queue of
 * AudioBufferSourceNodes scheduled back to back, cancel = stop everything that is queued).
 */
import { synthPhrases, type VoiceOpts } from "./voice-synth";
import { textToPhrases } from "./voice-text";
import { FUSION_VOICES } from "./fusion-voice";

export type VoicePref = "auto" | "system" | "fusion";
export type EngineId = "system" | "fusion";

export const VOICE_PREFS: readonly VoicePref[] = ["auto", "system", "fusion"];
export const FUSION_VOICE_IDS = Object.keys(FUSION_VOICES);

/**
 * Which engine speaks the next utterance.
 *  - "system" / "fusion" are honoured as asked, except that "system" with no Web Speech API at all falls back to
 *    Fusion Voice (otherwise the user would get silence they did not choose).
 *  - "auto": the system engine when it exists, has at least one voice and has not failed; Fusion Voice otherwise.
 */
export function chooseEngine(pref: VoicePref, sys: { api: boolean; voices: number; failed: boolean }): EngineId {
  if (pref === "fusion") return "fusion";
  if (pref === "system") return sys.api ? "system" : "fusion";
  return sys.api && sys.voices > 0 && !sys.failed ? "system" : "fusion";
}

/** Fusion Voice options for a named voice + Narrator rate (rates above 2 are clamped: intelligibility drops fast) */
export function fusionOpts(voice: string, rate: number): VoiceOpts {
  const v = FUSION_VOICES[voice] ?? FUSION_VOICES.standard;
  return { pitch: v.pitch, formant: v.formant, rate: Math.min(2, Math.max(0.5, rate || 1)) };
}

type AudioCtor = typeof AudioContext;

/** plays Fusion Voice through Web Audio; synthesis is phrase by phrase so long text starts at once and stays interruptible */
export class FusionSpeaker {
  private ctx: AudioContext | null = null;
  private live: AudioBufferSourceNode[] = [];
  private gen = 0;
  private endAt = 0;
  private timer = 0;
  /** total audio scheduled (seconds) — for diagnostics/tests */
  scheduled = 0;

  static available(): boolean {
    return typeof window !== "undefined" && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext);
  }

  private context(): AudioContext {
    if (!this.ctx) {
      const C = window.AudioContext || (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
      this.ctx = new C();
    }
    // autoplay policy: a context created before a user gesture starts suspended; resume() is a no-op once running
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => { /* resumes on the next gesture */ });
    return this.ctx;
  }

  /** speak text; interrupt = drop whatever is queued first. onError reports a failure (the caller keeps captions). */
  speak(text: string, opts: VoiceOpts, interrupt: boolean, onError?: (e: string) => void) {
    if (interrupt) this.cancel();
    let ctx: AudioContext;
    try { ctx = this.context(); } catch (e) { onError?.(String((e as Error)?.message ?? e)); return; }
    const phrases = textToPhrases(text);
    const gen = this.gen;
    let i = 0;
    const step = () => {
      if (gen !== this.gen || i >= phrases.length) return;
      try {
        const pcm = synthPhrases([phrases[i++]], opts);
        const sr = opts.sr ?? 16000;
        const buf = ctx.createBuffer(1, pcm.length, sr);
        buf.getChannelData(0).set(pcm);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        const at = Math.max(ctx.currentTime + 0.02, this.endAt);
        src.start(at);
        this.endAt = at + buf.duration;
        this.scheduled += buf.duration;
        this.live.push(src);
        src.onended = () => { this.live = this.live.filter((s) => s !== src); };
      } catch (e) { onError?.(String((e as Error)?.message ?? e)); return; }
      // render the next phrase on a later task so a long "read all" never blocks input
      this.timer = window.setTimeout(step, 0);
    };
    step();
  }

  cancel() {
    this.gen++;
    window.clearTimeout(this.timer);
    for (const s of this.live) { try { s.stop(); } catch { /* already stopped */ } }
    this.live = [];
    this.endAt = 0;
  }

  get speaking(): boolean { return this.live.length > 0; }

  close() { this.cancel(); void this.ctx?.close().catch(() => {}); this.ctx = null; }
}
