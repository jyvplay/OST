/**
 * TT139 (AX-06) — dictation that never becomes a hidden microphone.
 *
 * The Web Speech API (`SpeechRecognition`) is the only in-browser path to voice
 * text, and it is a bad citizen by design: in Chromium the audio is sent to the
 * vendor's speech service, it fires `result` events for *interim* hypotheses as
 * well as final ones, and it can stop on silence without saying why. A desktop
 * that wires it to a text field and calls it "voice input" is therefore
 * misreporting where the user's voice goes.
 *
 * This module is the policy layer:
 *   - a dictation session is impossible unless the user turned on the privacy
 *     switch that says "my audio may leave the device";
 *   - interim results replace the tail of the field and final results commit it,
 *     with an explicit character budget so a runaway recogniser cannot paste a
 *     wall of text;
 *   - every stop reason is classified, including "silence", so the UI can say
 *     what happened instead of silently turning the mic off;
 *   - the fallback for browsers without the API is *nothing*: no bundled model is
 *     claimed, and the module reports "no on-device dictation available".
 *
 * Limits: no on-device speech model ships here (size and licence), so "offline
 * dictation" is explicitly unsupported rather than degraded.
 */

export type DictationState = "idle" | "requesting" | "listening" | "stopped" | "refused";

export interface DictationPolicy {
  allowed: boolean;
  reason: string;
  /** true when recognised audio is processed off-device by the browser vendor */
  audioLeavesDevice: boolean;
  /** what the disclosure must say before the first session */
  disclosure: string;
}

export function dictationPolicy(opts: { hasApi: boolean; secureContext: boolean; networkCloudConsent: boolean; language: string }): DictationPolicy {
  if (!opts.hasApi) return { allowed: false, reason: "this browser has no speech-recognition API", audioLeavesDevice: false, disclosure: "Dictation is unavailable. Nothing is recorded." };
  if (!opts.secureContext) return { allowed: false, reason: "speech recognition needs a secure context", audioLeavesDevice: false, disclosure: "Serve over https to enable dictation." };
  if (!opts.networkCloudConsent) return { allowed: false, reason: "cloud speech processing is switched off in Privacy", audioLeavesDevice: true, disclosure: "Dictation is off because your audio would be processed by the browser vendor's service. Settings → Privacy has the switch (“allow cloud speech”); leave it off and keep typing if you prefer." };
  return { allowed: true, reason: "ok", audioLeavesDevice: true, disclosure: `Your voice is sent to the browser vendor's speech service for ${opts.language}. Fusion stores only the resulting text.` };
}

export interface RecognisedChunk { text: string; final: boolean }

export interface DictationBuffer {
  committed: string;
  interim: string;
  /** total characters written in this session */
  written: number;
  stoppedBecause: string | null;
}

export const DICTATION_MAX_CHARS = 4000;

export function startDictation(baseText: string): DictationBuffer {
  return { committed: baseText ?? "", interim: "", written: 0, stoppedBecause: null };
}

/**
 * Apply one recognition event. Interim text replaces the previous interim tail
 * (that is how the API behaves), final text is appended and the interim cleared.
 * The budget is counted on committed characters so a speaker cannot exceed it by
 * repeating interim hypotheses.
 */
export function applyRecognition(buffer: DictationBuffer, chunk: RecognisedChunk): DictationBuffer {
  const text = String(chunk.text ?? "").trim();
  if (!text) return buffer;
  if (chunk.final) {
    // The budget is over the *document* text in this field, not over what this
    // session happened to add: starting from a full field must not grant another
    // 4000 characters.
    const room = DICTATION_MAX_CHARS - buffer.committed.length;
    if (room <= 0) return { ...buffer, interim: "", stoppedBecause: `reached the ${DICTATION_MAX_CHARS}-character limit` };
    const accepted = text.slice(0, room);
    const joiner = buffer.committed && !/\s$/.test(buffer.committed) ? " " : "";
    return { ...buffer, committed: buffer.committed + joiner + accepted, interim: "", written: buffer.written + accepted.length };
  }
  return { ...buffer, interim: text };
}

/** The text as it should appear in the field right now. */
export function displayText(buffer: DictationBuffer): string {
  if (!buffer.interim) return buffer.committed;
  const joiner = buffer.committed && !/\s$/.test(buffer.committed) ? " " : "";
  return `${buffer.committed}${joiner}${buffer.interim}`;
}

export type StopReason = "user" | "silence" | "no-speech" | "network" | "not-allowed" | "aborted" | "budget" | "unknown";

export function classifyStop(code: string, message: string, buffer: DictationBuffer): { reason: StopReason; sentence: string; keepText: boolean } {
  const c = (code || "").toLowerCase();
  if (buffer.written >= DICTATION_MAX_CHARS) return { reason: "budget", sentence: `Stopped at the ${DICTATION_MAX_CHARS}-character limit. Your text is kept.`, keepText: true };
  switch (c) {
    case "not-allowed": case "service-not-allowed":
      return { reason: "not-allowed", sentence: "Microphone permission was refused. Nothing was recorded.", keepText: true };
    case "no-speech":
      return { reason: "no-speech", sentence: "No speech was heard.", keepText: true };
    case "audio-capture":
      return { reason: "unknown", sentence: "No microphone was found.", keepText: true };
    case "network":
      return { reason: "network", sentence: "The speech service could not be reached; dictation needs the network on this browser.", keepText: true };
    case "aborted":
      return { reason: "aborted", sentence: "Dictation was interrupted.", keepText: true };
    case "":
      return { reason: "silence", sentence: "Dictation ended after a pause.", keepText: true };
    default:
      return { reason: "unknown", sentence: message ? `Dictation stopped: ${message}` : `Dictation stopped (${code || "unknown"}).`, keepText: true };
  }
}

/** Language tags the API accepts, minus the ones it silently rejects. */
export function pickLanguage(wanted: string, supported: readonly string[], fallback = "en-US"): { language: string; exact: boolean } {
  const norm = (s: string) => s.replace("_", "-").toLowerCase();
  const hit = supported.find((s) => norm(s) === norm(wanted));
  if (hit) return { language: hit, exact: true };
  const base = norm(wanted).split("-")[0];
  const sameBase = supported.find((s) => norm(s).split("-")[0] === base);
  if (sameBase) return { language: sameBase, exact: false };
  return { language: fallback, exact: false };
}
