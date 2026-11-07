/**
 * TT139 (FF-06 / HW-03) — what this browser can actually decode, and by what.
 *
 * There is no honest way to ship a HEIC decoder in a 1 MB budget, and bundling
 * one would drag a licence question into the build. So the shell asks the
 * platform instead, and shows the *answer* — including "no" — instead of
 * pretending. Three platform mechanisms disagree with each other, so all three
 * are used and their disagreement is reported rather than averaged:
 *
 *   - `HTMLVideoElement.canPlayType(type)` — the oldest, returns "probably" /
 *     "maybe" / "". It lies in both directions (Safari says "maybe" for some
 *     HEVC it cannot play).
 *   - `MediaCapabilities.decodingInfo()` — asynchronous and answers a *specific*
 *     configuration (resolution, framerate, bitrate), which is the only way to
 *     learn that 8K is refused while 1080p works.
 *   - `ImageDecoder.isTypeSupported()` — the WebCodecs image path, which is what
 *     actually decodes HEIC/AVIF outside an <img>.
 *
 * The decision table turns those into one of four states: native (the browser
 * decodes it itself), software (WebCodecs will, with a CPU cost), unsupported
 * (say so and offer conversion), or unknown (the probe itself failed — never
 * upgraded to "supported").
 */

export type SupportState = "native" | "software" | "unsupported" | "unknown";

export interface FormatSpec {
  id: string;
  label: string;
  kind: "image" | "audio" | "video";
  /** mime types to try, most specific first */
  mimes: string[];
  /** licence/patent note shown when the format is refused or degraded */
  note: string;
}

export const FORMATS: FormatSpec[] = [
  { id: "jpeg", label: "JPEG", kind: "image", mimes: ["image/jpeg"], note: "Universal." },
  { id: "png", label: "PNG", kind: "image", mimes: ["image/png"], note: "Universal." },
  { id: "webp", label: "WebP", kind: "image", mimes: ["image/webp"], note: "Chrome, Firefox, Safari 14+." },
  { id: "avif", label: "AVIF", kind: "image", mimes: ["image/avif"], note: "Royalty-free container; decoding is browser-provided." },
  { id: "heic", label: "HEIC / HEIF", kind: "image", mimes: ["image/heic", "image/heif", "image/heic-sequence"], note: "Patent-encumbered; never bundled, only used if the platform already has it (Safari does)." },
  { id: "gif", label: "GIF", kind: "image", mimes: ["image/gif"], note: "Animated, 256 colours." },
  { id: "flac", label: "FLAC", kind: "audio", mimes: ["audio/flac", "audio/x-flac"], note: "Lossless, royalty-free." },
  { id: "opus", label: "Opus", kind: "audio", mimes: ["audio/ogg; codecs=opus", "audio/opus"], note: "Royalty-free, low latency." },
  { id: "mp3", label: "MP3", kind: "audio", mimes: ["audio/mpeg"], note: "Patents expired 2017." },
  { id: "aac", label: "AAC", kind: "audio", mimes: ["audio/mp4; codecs=mp4a.40.2"], note: "Patent pool; platform decoder only." },
  { id: "webm", label: "WebM (VP9/Opus)", kind: "video", mimes: ["video/webm; codecs=vp9,opus", "video/webm"], note: "Royalty-free." },
  { id: "mp4", label: "MP4 (H.264)", kind: "video", mimes: ["video/mp4; codecs=avc1.42E01E", "video/mp4"], note: "Patent pool; platform decoder only." },
  { id: "h265", label: "HEVC (H.265)", kind: "video", mimes: ["video/mp4; codecs=hvc1.1.6.L93.B0", "video/mp4; codecs=hev1.1.6.L93.B0"], note: "Patent pool; Safari and some hardware only." },
];

/** The verdict for one format plus why, in words the UI can print. */
export interface FormatVerdict {
  id: string;
  state: SupportState;
  /** the mechanism that gave the answer */
  via: "canPlayType" | "imageDecoder" | "mediaCapabilities" | "none";
  detail: string;
}

/** Map canPlayType's three-valued answer onto a state, keeping "" distinct from "maybe". */
export function stateFromCanPlay(answer: string): SupportState {
  const a = (answer ?? "").toLowerCase();
  if (a === "probably") return "native";
  if (a === "maybe") return "unknown"; // "maybe" is not a promise; do not print "supported"
  return "unsupported";
}

/**
 * Pure evaluation of an already-collected probe set. Keeping this separate from
 * the DOM calls is what lets the decision table be tested without a browser.
 */
export interface ProbeData {
  canPlay: Record<string, string>;
  imageDecoder: Record<string, boolean>;
  mediaCapabilities: Record<string, { supported: boolean; smooth: boolean; powerEfficient: boolean }>;
}

export function evaluateFormats(probes: ProbeData): FormatVerdict[] {
  return FORMATS.map((f) => {
    if (f.kind === "image") {
      const anyImage = f.mimes.some((m) => probes.imageDecoder[m] === true);
      if (anyImage) return { id: f.id, state: "software", via: "imageDecoder", detail: "decodable through the platform image decoder" };
      const cp = f.mimes.map((m) => probes.canPlay[m]).find((v) => v && v !== "");
      if (cp) return { id: f.id, state: stateFromCanPlay(cp), via: "canPlayType", detail: `canPlayType says "${cp}"` };
      const mc = f.mimes.map((m) => probes.mediaCapabilities[m]).find(Boolean);
      if (mc) return { id: f.id, state: mc.supported ? "native" : "unsupported", via: "mediaCapabilities", detail: mc.supported ? "reported decodable" : "reported undecodable" };
      return { id: f.id, state: "unsupported", via: "none", detail: "no mechanism reported support" };
    }
    const mcRow = f.mimes.map((m) => probes.mediaCapabilities[m]).find(Boolean);
    if (mcRow?.supported) {
      const how = `${mcRow.smooth ? "smooth" : "unsmooth"}${mcRow.powerEfficient ? ", hardware" : ", software"}`;
      return { id: f.id, state: mcRow.powerEfficient ? "native" : "software", via: "mediaCapabilities", detail: how };
    }
    const cp = f.mimes.map((m) => probes.canPlay[m]).find((v) => v && v !== "");
    if (cp) return { id: f.id, state: stateFromCanPlay(cp), via: "canPlayType", detail: `canPlayType says "${cp}"` };
    if (mcRow && !mcRow.supported) return { id: f.id, state: "unsupported", via: "mediaCapabilities", detail: "MediaCapabilities refused this configuration" };
    return { id: f.id, state: "unsupported", via: "none", detail: "no mechanism reported support" };
  });
}

/** A sentence per state, so the UI never has to word these itself. */
export function supportSentence(v: FormatVerdict, spec: FormatSpec): string {
  switch (v.state) {
    case "native": return `${spec.label} plays natively.`;
    case "software": return `${spec.label} is decoded in software — expect more CPU use.`;
    case "unsupported": return `${spec.label} cannot be decoded here. ${spec.note} Convert it on the device you took it with.`;
    default: return `This browser would not say whether ${spec.label} works. Treat it as unsupported.`;
  }
}

/** Resolution ladder used when a format is only partly supported. */
export function pickVideoConfiguration(maxWidth: number, maxHeight: number, preferEfficient = true): { width: number; height: number; reason: string } {
  const cap = (w: number, h: number, r: string) => ({ width: w, height: h, reason: r });
  if (preferEfficient) return cap(maxWidth, maxHeight, "no hardware signal, so the requested size is kept and the first frame is measured");
  if (maxWidth >= 3840) return cap(3840, Math.round((3840 * maxHeight) / Math.max(1, maxWidth)), "4K is reported; step down on the first dropped frame");
  return cap(maxWidth, maxHeight, "requested size");
}
