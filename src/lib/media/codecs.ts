/**
 * TT146 (HW-03) — hardware codec capability, asked instead of assumed.
 *
 * `HTMLVideoElement.canPlayType("video/mp4; codecs=avc1.42E01E")` answers a
 * different question than people think: it says the *media pipeline* will
 * attempt the type, in a browser-chosen implementation, at whatever resolution
 * the element happens to use. It cannot tell you whether 4K AV1 decoding is
 * backed by silicon, and it cannot tell you anything at all about *encoding*.
 *
 * WebCodecs' `VideoDecoder.isConfigSupported()` / `VideoEncoder.isConfigSupported()`
 * take a concrete `{codec, codedWidth, codedHeight}` and answer for exactly that
 * configuration. Passing `hardwareAcceleration: "prefer-hardware"` turns it into
 * a usable probe: if the hardware-preferring configuration is refused while the
 * same configuration without the preference is accepted, the browser could only
 * have satisfied it in software.
 *
 * What that inference does NOT establish — and this is the part most capability
 * screens get wrong — is the reverse. A "prefer-hardware" configuration that is
 * accepted means the configuration is supported *with that preference*; the
 * browser is free to fall back to software while still saying yes, and no web
 * API reports which one it used. So this module never prints "hardware
 * accelerated". It prints exactly one of:
 *
 *   hardware-preferred  — accepted with the preference, rejected without the
 *                         software escape hatch… (see below)
 *   software-only       — the preference was refused but the plain config worked
 *   either-way          — both accepted; the browser chose, and it does not say
 *   unavailable         — neither accepted at this size
 *
 * The third case is the common one on desktop, and calling it "hardware" is the
 * lie this module exists to prevent.
 *
 * Nothing here performs I/O beyond the probe the caller supplies, so the whole
 * matrix is testable with a table of fake answers, and the real answers come
 * from Chromium in the e2e suite.
 */

export type CodecId = "h264" | "hevc" | "av1" | "vp9" | "vp8";

export interface CodecSpec {
  id: CodecId;
  label: string;
  /** An RFC 6381 codec string that names a concrete profile and level. */
  codec: string;
  /** Royalty position, stated because it decides what a product may ship. */
  note: string;
}

/**
 * Concrete strings, not family names. `avc1` alone is not a config; the level
 * decides the resolution ceiling (`avc1.640028` = High profile, level 4.0,
 * 1080p). AV1 Main level 3.1 (`av01.0.04M.08`) covers 1080p30; 4K needs 5.x.
 */
export const VIDEO_CODECS: readonly CodecSpec[] = [
  { id: "h264", label: "H.264 High 4.0", codec: "avc1.640028", note: "universally available; patent-encumbered" },
  { id: "hevc", label: "HEVC Main 4.0", codec: "hvc1.1.6.L120.B0", note: "patent-encumbered; browser support varies" },
  { id: "av1", label: "AV1 Main 3.1", codec: "av01.0.04M.08", note: "royalty-free; hardware on recent silicon" },
  { id: "vp9", label: "VP9 Profile 0 4.0", codec: "vp09.00.10.08", note: "royalty-free; widely used by WebM" },
  { id: "vp8", label: "VP8", codec: "vp8", note: "royalty-free; legacy WebRTC path" },
] as const;

export interface SizeClass {
  name: string;
  width: number;
  height: number;
}

export const SIZES: readonly SizeClass[] = [
  { name: "720p", width: 1280, height: 720 },
  { name: "1080p", width: 1920, height: 1080 },
  { name: "4K", width: 3840, height: 2160 },
] as const;

export type HwPreference = "no-preference" | "prefer-hardware" | "prefer-software";
export type Direction = "decode" | "encode";

export interface ProbeConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  hardwareAcceleration?: HwPreference;
}

export interface ProbeAnswer {
  supported: boolean;
  /** The browser's own refusal text, when it gives one. */
  reason?: string;
}

export type Probe = (config: ProbeConfig, direction: Direction) => Promise<ProbeAnswer>;

export type Verdict = "hardware-preferred" | "software-only" | "either-way" | "unavailable" | "unanswered";

export interface Cell {
  codec: CodecId;
  direction: Direction;
  size: string;
  width: number;
  height: number;
  /** Plain configuration (the browser may still pick hardware). */
  plain: ProbeAnswer | null;
  /** Same configuration with `prefer-hardware`. */
  preferred: ProbeAnswer | null;
  /** Same configuration with `prefer-software`, used to prove the preference is honoured at all. */
  forcedSoftware: ProbeAnswer | null;
  verdict: Verdict;
}

export interface CodecReport {
  at: number;
  cells: Cell[];
  /** Present only when WebCodecs is missing entirely. */
  unavailableReason?: string;
}

const ANSWER_TIMEOUT_MS = 4_000;

/** The timeout is an option so a test can prove the guard without waiting 4 s per probe. */

/** A probe that never answers must not hang a settings pane. */
async function withTimeout<T>(p: Promise<T>, fallback: T, ms: number = ANSWER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function verdictOf(plain: ProbeAnswer | null, preferred: ProbeAnswer | null, forcedSoftware: ProbeAnswer | null): Verdict {
  if (!plain) return "unanswered";
  if (!plain.supported) return "unavailable";
  if (preferred?.supported) {
    // `prefer-software` being accepted while `prefer-hardware` is accepted too
    // proves the browser honours the knob in at least one direction; it still
    // does not prove that the hardware preference was satisfied. Say so.
    return forcedSoftware?.supported === false ? "hardware-preferred" : "either-way";
  }
  if (preferred && !preferred.supported) return "software-only";
  return "either-way";
}

/**
 * Probe every codec × direction × size, plus both preference hints.
 *
 * 5 codecs × 2 directions × 3 sizes × 3 preferences = 90 questions. They are
 * independent and cheap, but they are still serialised in small batches: a
 * browser that is already decoding something should not be asked 90 questions
 * at once, and a headless one will time out rather than answer.
 */
export async function probeCodecMatrix(
  probe: Probe,
  at: number,
  opts: { codecs?: readonly CodecSpec[]; sizes?: readonly SizeClass[]; batch?: number; answerTimeoutMs?: number } = {},
): Promise<CodecReport> {
  const codecs = opts.codecs ?? VIDEO_CODECS;
  const sizes = opts.sizes ?? SIZES;
  const batch = Math.max(1, Math.min(8, opts.batch ?? 4));
  const jobs: (() => Promise<Cell>)[] = [];

  for (const codec of codecs) {
    for (const direction of ["decode", "encode"] as const) {
      for (const size of sizes) {
        jobs.push(async () => {
          const base = { codec: codec.codec, codedWidth: size.width, codedHeight: size.height };
          const timeout = opts.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
          const [plain, preferred, forced] = await Promise.all([
            withTimeout(probe(base, direction), { supported: false, reason: "probe timed out" }, timeout),
            withTimeout(probe({ ...base, hardwareAcceleration: "prefer-hardware" }, direction), { supported: false, reason: "probe timed out" }, timeout),
            withTimeout(probe({ ...base, hardwareAcceleration: "prefer-software" }, direction), { supported: false, reason: "probe timed out" }, timeout),
          ]);
          return {
            codec: codec.id, direction, size: size.name, width: size.width, height: size.height,
            plain, preferred, forcedSoftware: forced, verdict: verdictOf(plain, preferred, forced),
          };
        });
      }
    }
  }

  const cells: Cell[] = [];
  for (let i = 0; i < jobs.length; i += batch) {
    const slice = jobs.slice(i, i + batch);
    cells.push(...await Promise.all(slice.map((j) => j())));
  }
  return { at, cells };
}

/** The rows a person actually reads: best verdict per codec for encoding at a size. */
export interface SummaryRow {
  codec: CodecId;
  label: string;
  decode: Verdict | "not probed";
  encode: Verdict | "not probed";
  maxHeight: number | null;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  "hardware-preferred": "hardware accepted, preference honoured",
  "software-only": "software only",
  "either-way": "supported; browser does not say which",
  unavailable: "not supported",
  unanswered: "no answer",
};

export function verdictText(v: Verdict): string { return VERDICT_TEXT[v]; }

export function summarise(report: CodecReport): SummaryRow[] {
  return VIDEO_CODECS.map((codec) => {
    const cells = report.cells.filter((c) => c.codec === codec.id);
    const verdictFor = (direction: Direction) => {
      const row = cells.filter((c) => c.direction === direction);
      if (!row.length) return "not probed" as const;
      // Report the verdict at the largest size that is supported at all: that is
      // the question "can this machine encode 1080p AV1", not "can it encode 720p".
      const supported = row.filter((c) => c.verdict !== "unavailable" && c.verdict !== "unanswered");
      if (!supported.length) return row[0].verdict;
      return supported.sort((a, b) => b.width - a.width)[0].verdict;
    };
    const supportedDecode = cells.filter((c) => c.direction === "decode" && c.verdict !== "unavailable" && c.verdict !== "unanswered");
    const maxHeight = supportedDecode.length
      ? supportedDecode.map((c) => c.height).sort((a, b) => b - a)[0]
      : null;
    return { codec: codec.id, label: codec.label, decode: verdictFor("decode"), encode: verdictFor("encode"), maxHeight };
  });
}

export interface EncoderChoice {
  codec: CodecId;
  label: string;
  codecString: string;
  /** `true` only when the browser refused the software escape hatch. */
  hardwarePreferred: boolean;
  width: number;
  height: number;
  reason: string;
}

/**
 * Choose an encoder for a real export.
 *
 * `prefer` is a genuine ordering, not a single codec: a deck export wants AV1
 * first for size, an editor export wants H.264 first for compatibility, and a
 * machine that supports neither must fall back rather than fail — unless the
 * caller said software encoding is not acceptable, in which case a refusal is
 * the honest answer instead of a silently slow export.
 */
export function chooseVideoEncoder(
  report: CodecReport,
  want: { width: number; height: number },
  opts: { prefer?: readonly CodecId[]; allowSoftware?: boolean } = {},
): EncoderChoice | null {
  const order = opts.prefer ?? (["av1", "h264", "vp9"] as const);
  const allowSoftware = opts.allowSoftware ?? true;
  let softwareFallback: EncoderChoice | null = null;

  for (const id of order) {
    const spec = VIDEO_CODECS.find((c) => c.id === id);
    if (!spec) continue;
    const cell = report.cells.find((c) =>
      c.codec === id && c.direction === "encode" && c.width >= want.width && c.height >= want.height);
    if (!cell || cell.verdict === "unavailable" || cell.verdict === "unanswered") continue;
    const choice: EncoderChoice = {
      codec: id, label: spec.label, codecString: spec.codec,
      hardwarePreferred: cell.verdict === "hardware-preferred",
      width: want.width, height: want.height,
      reason: cell.verdict === "hardware-preferred"
        ? `${spec.label} at ${want.width}×${want.height}: hardware preference accepted and software refused`
        : `${spec.label} at ${want.width}×${want.height}: ${verdictText(cell.verdict).toLowerCase()}`,
    };
    if (cell.verdict === "hardware-preferred") return choice;
    if (allowSoftware && !softwareFallback) softwareFallback = choice;
  }
  return softwareFallback;
}

const encodeUsable = (v: Verdict | "not probed") => v !== "not probed" && v !== "unavailable" && v !== "unanswered";

/** Short line for a capability row; no promises beyond what was asked. */
export function describeCodecReport(report: CodecReport): string {
  if (report.unavailableReason) return `WebCodecs not exposed: ${report.unavailableReason}`;
  const enc = summarise(report).filter((r) => encodeUsable(r.encode)).map((r) => r.codec);
  return enc.length ? `Encoders: ${enc.join(", ")} (verdict per size in Devices)` : "No encoder configuration was accepted";
}

/** The real probe, bound to the platform API. Absent API is a stated reason, not a thrown error. */
export function webCodecsProbe(source: {
  VideoDecoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean; config?: unknown }> };
  VideoEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
}): { probe: Probe; reason?: string } {
  const hasDecoder = typeof source.VideoDecoder?.isConfigSupported === "function";
  const hasEncoder = typeof source.VideoEncoder?.isConfigSupported === "function";
  if (!hasDecoder && !hasEncoder) return { probe: async () => ({ supported: false, reason: "WebCodecs is not exposed" }), reason: "WebCodecs is not exposed" };
  const probe: Probe = async (config, direction) => {
    const api = direction === "decode" ? source.VideoDecoder : source.VideoEncoder;
    if (!api || typeof api.isConfigSupported !== "function") return { supported: false, reason: `no ${direction} API` };
    try {
      const out = await api.isConfigSupported(config);
      return { supported: out.supported === true };
    } catch (e) {
      // A malformed or unsupported configuration throws TypeError by spec.
      return { supported: false, reason: (e as Error)?.name ?? "rejected" };
    }
  };
  return { probe };
}
