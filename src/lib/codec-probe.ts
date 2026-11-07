/**
 * TT145 (HW-03) — hardware codecs, as a decision over codec strings instead of a
 * boolean.
 *
 * `video.canPlayType("video/mp4; codecs=\"avc1.640028\"")` answers
 * `"probably"`, `"maybe"` or `""`. Those three answers mean three different
 * things and apps collapse them into one bit, which is why a video "supported"
 * by the browser fails on the user's machine:
 *
 *   · `"probably"` — the browser found a decoder *for this profile string*. It
 *     still does not say whether that decoder is hardware or software.
 *   · `"maybe"` — the container is understood but the codec string is not
 *     parsed with confidence. Treating `"maybe"` as yes is the bug.
 *   · `""` — no. This is the only answer that is a fact.
 *
 * So the engine's job is twofold: normalise a codec string into the shape
 * `canPlayType` understands (a surprising number of real-world strings are
 * malformed), and then build a *plan* that says, per rendition, whether to
 * transcode, remux or play, with the `"maybe"` case handled explicitly. The
 * hardware question is answered by a probe the caller runs
 * (`navigator.mediaCapabilities.decodingInfo`, which reports
 * `powerEfficient`), and when that API is missing the engine says so instead of
 * guessing from the codec name.
 */

export type Support = "probably" | "maybe" | "no";
export type Efficiency = "hardware-likely" | "software-likely" | "unmeasured";

export interface CodecSpec {
  container: string;
  codec: string;
  /** Optional explicit profile/level, e.g. "avc1.640028". */
  profile?: string;
}

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
};

/** Codec families whose strings `canPlayType` accepts in a codecs parameter. */
const FAMILIES: Record<string, string[]> = {
  h264: ["avc1", "avc3"], hevc: ["hvc1", "hev1"], av1: ["av01"], vp9: ["vp09", "vp9"], vp8: ["vp8"],
  aac: ["mp4a.40"], opus: ["opus"], vorbis: ["vorbis"], flac: ["flac"], mp3: ["mp4a.69", "mp4a.6b"], alac: ["alac"],
};

export function mimeFor(container: string): string | null {
  return CONTAINER_MIME[container.toLowerCase().replace(/^\./, "")] ?? null;
}

/**
 * Normalises a codec name into a codecs string. A bare family name (`h264`) is
 * NOT expanded into a profile: which profile is playable is exactly what the
 * caller must ask, and inventing `avc1.42E01E` would make a 4K HEVC file look
 * playable on a device that only decodes H.264 baseline.
 */
export function codecString(spec: CodecSpec): { ok: true; mime: string; codec: string } | { ok: false; why: string } {
  const mime = mimeFor(spec.container);
  if (!mime) return { ok: false, why: `container “${spec.container}” has no MIME type this engine knows` };
  const raw = spec.profile ?? spec.codec;
  const family = (FAMILIES[spec.codec.toLowerCase()] ?? FAMILIES[spec.profile?.split(".")[0].toLowerCase() ?? ""] ?? null);
  if (!family) return { ok: false, why: `codec “${spec.codec}” is not one of ${Object.keys(FAMILIES).join(", ")}` };
  if (spec.profile) {
    if (!raw.includes(".")) return { ok: false, why: `profile “${spec.profile}” is a bare family name; a full codec string needs its profile and level (e.g. avc1.640028)` };
    if (!family.some((f) => raw.toLowerCase().startsWith(f.split(".")[0]))) return { ok: false, why: `profile “${spec.profile}” does not belong to the ${spec.codec} family` };
    return { ok: true, mime, codec: raw };
  }
  return { ok: true, mime, codec: family[0] };
}

export function judge(answer: string): Support {
  const a = answer.trim().toLowerCase();
  if (a === "probably") return "probably";
  if (a === "maybe") return "maybe";
  return "no";
}

/**
 * The per-rendition plan. `maybe` is a *conditional play*: play it, but do not
 * hide the fallback, because a `maybe` that fails looks like a broken app.
 */
export interface Rendition { name: string; spec: CodecSpec; answer: string; efficiency: Efficiency }

export interface RenditionPlan {
  name: string;
  mime: string;
  codec: string;
  support: Support;
  action: "play" | "play-with-fallback" | "transcode" | "refuse";
  sentence: string;
}

export function planRendition(r: Rendition): RenditionPlan {
  const cs = codecString(r.spec);
  if (!cs.ok) return { name: r.name, mime: "", codec: "", support: "no", action: "refuse", sentence: `refused: ${cs.why}` };
  const support = judge(r.answer);
  const hw = r.efficiency === "hardware-likely" ? "a hardware decoder is likely" : r.efficiency === "software-likely" ? "decoding will be software, which costs battery" : "hardware versus software is unmeasured here";
  if (support === "probably") return { name: r.name, mime: cs.mime, codec: cs.codec, support, action: "play", sentence: `${cs.codec} plays; ${hw}` };
  if (support === "maybe") return { name: r.name, mime: cs.mime, codec: cs.codec, support, action: "play-with-fallback", sentence: `${cs.codec} may play — the browser answered “maybe”, so a lower rendition stays loaded` };
  return { name: r.name, mime: cs.mime, codec: cs.codec, support: "no", action: "transcode", sentence: `${cs.codec} has no decoder in this browser; transcode or offer another rendition` };
}

/**
 * The efficiency probe, kept as a pure mapping so the caller can inject what
 * `mediaCapabilities.decodingInfo` returned. Note `smooth` is part of the
 * decision: a decoder that cannot keep up is not "supported".
 */
export interface DecodingInfo { supported: boolean; smooth: boolean; powerEfficient: boolean }

export function efficiency(info: DecodingInfo | null): { efficiency: Efficiency; sentence: string } {
  if (!info) return { efficiency: "unmeasured", sentence: "mediaCapabilities is absent: hardware versus software cannot be observed, so it is reported as unknown" };
  if (!info.supported) return { efficiency: "unmeasured", sentence: "the browser reports no decoder at all for this configuration" };
  if (!info.smooth) return { efficiency: "software-likely", sentence: "a decoder exists but cannot keep real time, so it is treated as software and not offered as the default" };
  return info.powerEfficient
    ? { efficiency: "hardware-likely", sentence: "the browser reports powerEfficient: decoding is hardware-assisted as far as it will say" }
    : { efficiency: "software-likely", sentence: "the browser reports a smooth decoder that is not powerEfficient: software" };
}

/** Build the `codecs=` parameter, dropping duplicates and refusing an empty set. */
export function codecsParam(codecs: string[]): { ok: true; param: string } | { ok: false; why: string } {
  const uniq = [...new Set(codecs.map((c) => c.trim()).filter(Boolean))];
  if (!uniq.length) return { ok: false, why: "an empty codecs parameter is never what you meant" };
  if (uniq.length > 8) return { ok: false, why: `${uniq.length} codecs in one parameter; browsers stop reading after the first unsupported one, so more than 8 is noise` };
  return { ok: true, param: uniq.map((c) => `"${c}"`).join(",") };
}

export const LIMITS = [
  "canPlayType does not report hardware or software; only mediaCapabilities does, and it may be absent",
  "“maybe” is not “yes”, and this engine never turns it into one",
  "a reported decoder does not mean a reported profile: level and bit depth must be in the codec string",
  "no transcode is performed here; the plan names the work, the caller schedules it",
] as const;
