/**
 * TT147 (FF-06) — HEIC and AVIF: identify the container honestly, then let the
 * engine answer.
 *
 * Both formats are ISO base media files, so a byte-level extension check is not
 * enough: the `ftyp` box carries the brand, and the brand is what decides. The
 * two formats also differ in what a browser does with them today — Chromium
 * decodes AVIF natively and has no HEIC decoder at all — so the useful contract
 * is "what is this file, and can this engine decode it", never "it is HEIF".
 *
 * The decoder itself is `createImageBitmap`, which is the browser's own image
 * pipeline: nothing here reimplements HEVC or AV1. What this module adds is the
 * refusal path, which is the part that is usually missing: a HEIC file that
 * cannot be decoded produces a sentence naming the format and the engine, not a
 * broken thumbnail or a silent "unknown image".
 */

export type ContainerKind = "avif" | "heic" | "png" | "jpeg" | "webp" | "gif" | "bmp" | "svg" | "unknown";

/** Brands that mean AVIF (still or sequence) and brands that mean HEIF/HEIC. */
const AVIF_BRANDS = ["avif", "avis", "av01"] as const;
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"] as const;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/**
 * Identify by the bytes that matter.
 *
 * For ISO-BMFF the first box must be `ftyp`; a file whose first four bytes are
 * a size and whose next four are not `ftyp` is not an image we can name, so it
 * comes back as `unknown` rather than being guessed from the extension.
 */
export function sniffContainer(bytes: Uint8Array): ContainerKind {
  if (bytes.length < 12) return "unknown";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 0, 3) === "GIF") return "gif";
  if (ascii(bytes, 0, 2) === "BM") return "bmp";
  if (ascii(bytes, 0, 5) === "<?xml" || (ascii(bytes, 0, 4) === "<svg" ) || ascii(bytes, 0, 4) === "<!DO") return "svg";
  if (ascii(bytes, 4, 4) !== "ftyp") return "unknown";
  const size = be32(bytes, 0);
  if (size < 8 || size > bytes.length) return "unknown";
  // The major brand is at 8; compatible brands follow, and a file may declare
  // `mif1` as major while listing `avif` as compatible — that is a real AVIF.
  const brands: string[] = [ascii(bytes, 8, 4)];
  for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(bytes, at, 4));
  if (brands.some((b) => (AVIF_BRANDS as readonly string[]).includes(b))) return "avif";
  if (brands.some((b) => (HEIC_BRANDS as readonly string[]).includes(b))) return "heic";
  return "unknown";
}

export const MIME_OF: Record<Exclude<ContainerKind, "unknown">, string> = {
  avif: "image/avif", heic: "image/heic", png: "image/png", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml",
};

export interface DecodeOutcome {
  ok: boolean;
  kind: ContainerKind;
  width: number | null;
  height: number | null;
  /** The sentence a caller shows when ok is false. */
  reason: string;
  /** True when this engine is known not to implement the codec, rather than a corrupt file. */
  unsupportedFormat: boolean;
}

/**
 * Decode through the engine's own image pipeline.
 *
 * `decode` is injected (`createImageBitmap` in a browser) so the policy is
 * testable and so a caller can pass a Worker-side implementation. A format the
 * engine refuses is reported as `unsupportedFormat` only when the container is
 * one the engine is known to lack — otherwise it is a broken file, and saying
 * "unsupported" would be a lie about the file.
 */
export async function decodeForeign(
  bytes: Uint8Array,
  decode: (blob: Blob) => Promise<{ width: number; height: number }>,
  knownUnsupported: (kind: ContainerKind) => boolean = (k) => k === "heic",
): Promise<DecodeOutcome> {
  const kind = sniffContainer(bytes);
  if (kind === "unknown") {
    return { ok: false, kind, width: null, height: null, reason: "the bytes are not a container this app recognises", unsupportedFormat: false };
  }
  try {
    const bitmap = await decode(new Blob([bytes as BlobPart], { type: MIME_OF[kind] }));
    return { ok: true, kind, width: bitmap.width, height: bitmap.height, reason: `decoded ${kind} at ${bitmap.width}×${bitmap.height}`, unsupportedFormat: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const unsupported = knownUnsupported(kind);
    return {
      ok: false, kind, width: null, height: null, unsupportedFormat: unsupported,
      reason: unsupported
        ? `this engine has no ${kind.toUpperCase()} decoder (${message}); the file is intact but unreadable here`
        : `the ${kind.toUpperCase()} file could not be decoded: ${message}`,
    };
  }
}

/** Which of the two modern containers this engine claims to handle, in words. */
export function describeContainerSupport(kinds: { avif: boolean; heic: boolean }): string {
  if (kinds.avif && kinds.heic) return "AVIF and HEIC both decode here";
  if (kinds.avif) return "AVIF decodes here; HEIC does not — no browser ships an HEVC decoder for images";
  if (kinds.heic) return "HEIC decodes here but AVIF does not, which is unusual enough to verify before trusting";
  return "neither AVIF nor HEIC decodes in this engine; the app falls back to a converted copy";
}

/** Probe both formats with a 1×1 encoded sample supplied by the caller. */
export async function probeContainerSupport(
  samples: { avif?: Uint8Array; heic?: Uint8Array },
  decode: (blob: Blob) => Promise<{ width: number; height: number }>,
): Promise<{ avif: boolean; heic: boolean }> {
  const tryOne = async (bytes?: Uint8Array) => {
    if (!bytes) return false;
    const r = await decodeForeign(bytes, decode);
    return r.ok;
  };
  return { avif: await tryOne(samples.avif), heic: await tryOne(samples.heic) };
}
