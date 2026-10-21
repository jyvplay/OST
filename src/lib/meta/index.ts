/**
 * TT54 (FF-13) — the metadata service entry point. `readMetadata(bytes, name)` sniffs the content (never trusts
 * the extension alone), dispatches to the container readers and returns one normalised record. Isomorphic and
 * dependency-free: runs in the thumbnail worker, the Files info panel, Photos, and Node tests.
 *
 * Guards: 512 MiB input cap; readers are header-only (no pixel / sample decoding); every reader is wrapped so a
 * hostile file yields warnings, never an exception.
 */
import { readImage } from "./image";
import { readExif, exifSummary, gpsFrom, orientationOf, type ExifIfds } from "./exif";
import { readXmp } from "./xmp";
import { readAudio, type Picture } from "./audio";
import { readBmff, readMatroska, sniffBmff, sniffMatroska } from "./av";
import { readPdfMeta, readZipDocMeta, readText } from "./docs";

export type MetaKind = "image" | "audio" | "video" | "document" | "text" | "other";
export interface FileMeta {
  kind: MetaKind; format: string; mime: string; size: number;
  /** stored pixel size */
  width?: number; height?: number;
  /** size as displayed after EXIF orientation / HEIF irot */
  displayWidth?: number; displayHeight?: number;
  orientation?: number; frames?: number;
  duration?: number; sampleRate?: number; channels?: number; bitrate?: number; bitsPerSample?: number; codecs?: string[];
  pages?: number; words?: number; slides?: number; sheets?: number; lines?: number; characters?: number;
  pageSize?: { w: number; h: number; unit: "pt" };
  encrypted?: boolean;
  /** normalised tags: title artist album date track genre creator subject keywords created modified make model lens dateTaken exposure fNumber iso focalLength ... */
  tags: Record<string, string>;
  gps?: { lat: number; lon: number; alt?: number };
  exif?: ExifIfds; xmp?: Record<string, string>;
  /** embedded preview: EXIF IFD1 JPEG, ID3 / FLAC / MP4 cover, OOXML / ODF thumbnail, Matroska cover attachment */
  picture?: { mime: string; data: Uint8Array; source: string };
  warnings: string[];
}

export const MAX_META_BYTES = 512 << 20;

export async function inflateZlib(d: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const out = new Response(new Blob([d.slice().buffer as ArrayBuffer]).stream().pipeThrough(ds));
  const buf = new Uint8Array(await out.arrayBuffer());
  if (buf.length > 64 << 20) throw new Error("inflated text chunk too large");
  return buf;
}

const pickPicture = (ps: Picture[]) => ps.find((p) => p.type === 3) ?? ps[0];

export async function readMetadata(bytes: Uint8Array, name = ""): Promise<FileMeta> {
  const base: FileMeta = { kind: "other", format: "unknown", mime: "application/octet-stream", size: bytes.length, tags: {}, warnings: [] };
  if (bytes.length > MAX_META_BYTES) { base.warnings.push("file larger than the 512 MiB metadata cap; size only"); return base; }
  try {
    const img = await readImage(bytes, name, inflateZlib);
    if (img) {
      const m: FileMeta = { ...base, kind: "image", format: img.format, mime: img.mime, width: img.width, height: img.height, frames: img.frames, warnings: img.warnings };
      for (const [k, v] of Object.entries(img.text)) m.tags[k === "Title" ? "title" : k === "Author" ? "creator" : k === "Description" ? "description" : k === "Comment" ? "comment" : k === "Software" ? "software" : k] = v;
      let turn = false;
      if (img.exif) {
        const x = readExif(img.exif); m.exif = x; m.warnings.push(...x.warnings);
        Object.assign(m.tags, exifSummary(x));
        const g = gpsFrom(x.gps); if (g) m.gps = g;
        // HEIF: irot / imir govern display and EXIF Orientation is informational only (HEIF spec + every decoder)
        if (img.format !== "heif" && img.format !== "avif") { m.orientation = orientationOf(x); turn = m.orientation >= 5; }
        if (x.thumbnail) m.picture = { mime: "image/jpeg", data: x.thumbnail, source: "EXIF IFD1 thumbnail" };
      }
      if (img.heifRotation) turn = img.heifRotation % 2 === 1;
      if (img.xmp) {
        const x = readXmp(img.xmp); m.xmp = x;
        if (x["dc:title"] && !m.tags.title) m.tags.title = x["dc:title"];
        if (x["dc:creator"] && !m.tags.creator) m.tags.creator = x["dc:creator"];
        if (x["dc:description"] && !m.tags.description) m.tags.description = x["dc:description"];
        if (x["xmp:Rating"]) m.tags.rating = x["xmp:Rating"];
        if (x["dc:subject"]) m.tags.keywords = x["dc:subject"];
        if (!m.tags.dateTaken) { const d = x["exif:DateTimeOriginal"] ?? x["photoshop:DateCreated"] ?? x["xmp:CreateDate"]; if (d) m.tags.dateTaken = d; }
      }
      m.displayWidth = turn ? img.height : img.width; m.displayHeight = turn ? img.width : img.height;
      return m;
    }
    const au = await readAudio(bytes, name, inflateZlib);
    const av = au ?? (sniffBmff(bytes) ? readBmff(bytes) : sniffMatroska(bytes) ? readMatroska(bytes) : null);
    if (av) {
      const p = pickPicture(av.pictures);
      return {
        ...base, kind: av.kind, format: av.format, mime: av.mime, width: av.width, height: av.height, displayWidth: av.width, displayHeight: av.height,
        duration: av.duration, sampleRate: av.sampleRate, channels: av.channels, bitrate: av.bitrate, bitsPerSample: av.bitsPerSample, codecs: av.codecs,
        tags: av.tags, gps: av.gps, picture: p ? { mime: p.mime, data: p.data, source: "embedded cover art" } : undefined, warnings: av.warnings,
      };
    }
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 || /\.pdf$/i.test(name) && new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
      const d = readPdfMeta(bytes);
      return { ...base, kind: "document", format: d.format, mime: d.mime, pages: d.pages, pageSize: d.pageSize, encrypted: d.encrypted, tags: d.tags, warnings: d.warnings };
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
      const d = await readZipDocMeta(bytes);
      if (d) return { ...base, kind: "document", format: d.format, mime: d.mime, pages: d.pages, words: d.words, slides: d.slides, sheets: d.sheets, characters: d.characters, tags: d.tags, picture: d.thumbnail ? { ...d.thumbnail, source: "document thumbnail" } : undefined, warnings: d.warnings };
      return { ...base, format: "zip", mime: "application/zip" };
    }
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return { ...base, kind: "document", format: "cfb", mime: "application/x-cfb", encrypted: undefined, warnings: ["OLE2 compound file (legacy Office or an encrypted OOXML package): properties not read"] };
    }
    const t = readText(bytes);
    if (t) return { ...base, kind: "text", format: /\.(md|markdown)$/i.test(name) ? "markdown" : /\.csv$/i.test(name) ? "csv" : /\.json$/i.test(name) ? "json" : "text", mime: "text/plain", lines: t.lines, words: t.words, characters: t.characters };
  } catch (e) { base.warnings.push(`metadata: ${(e as Error).message}`); }
  return base;
}

/** The rows the info panel shows, in order; values pre-formatted for people. */
export function describe(m: FileMeta): [string, string][] {
  const r: [string, string][] = [];
  const fmtDur = (s: number) => { const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60; return h ? `${h}:${String(mi).padStart(2, "0")}:${se.toFixed(0).padStart(2, "0")}` : `${mi}:${se.toFixed(1).padStart(4, "0")}`; };
  r.push(["Type", `${m.format.toUpperCase()} ${m.kind}`]);
  if (m.displayWidth && m.displayHeight) r.push(["Dimensions", `${m.displayWidth} × ${m.displayHeight}${m.orientation && m.orientation !== 1 ? ` (stored ${m.width} × ${m.height}, orientation ${m.orientation})` : ""}`]);
  if (m.frames && m.frames > 1) r.push(["Frames", String(m.frames)]);
  if (m.duration !== undefined) r.push(["Duration", fmtDur(m.duration)]);
  if (m.codecs?.length) r.push(["Codecs", m.codecs.join(", ")]);
  if (m.sampleRate) r.push(["Audio", `${(m.sampleRate / 1000).toFixed(1)} kHz${m.channels ? `, ${m.channels === 1 ? "mono" : m.channels === 2 ? "stereo" : `${m.channels} channels`}` : ""}${m.bitsPerSample ? `, ${m.bitsPerSample}-bit` : ""}`]);
  if (m.bitrate) r.push(["Bit rate", `${Math.round(m.bitrate / 1000)} kb/s`]);
  if (m.pages) r.push(["Pages", String(m.pages)]);
  if (m.pageSize) r.push(["Page size", `${m.pageSize.w} × ${m.pageSize.h} pt (${(m.pageSize.w / 72 * 25.4).toFixed(0)} × ${(m.pageSize.h / 72 * 25.4).toFixed(0)} mm)`]);
  if (m.slides) r.push(["Slides", String(m.slides)]);
  if (m.sheets) r.push(["Sheets", String(m.sheets)]);
  if (m.words) r.push(["Words", m.words.toLocaleString("en-US")]);
  if (m.lines !== undefined) r.push(["Lines", m.lines.toLocaleString("en-US")]);
  if (m.encrypted) r.push(["Encrypted", "yes"]);
  const L: Record<string, string> = { title: "Title", artist: "Artist", album: "Album", albumArtist: "Album artist", date: "Date", track: "Track", disc: "Disc", genre: "Genre", composer: "Composer", creator: "Author", subject: "Subject", keywords: "Keywords", description: "Description", comment: "Comment", created: "Created", modified: "Modified", lastModifiedBy: "Last modified by", application: "Application", producer: "Producer", company: "Company", make: "Camera make", model: "Camera model", lens: "Lens", dateTaken: "Date taken", exposure: "Exposure", fNumber: "Aperture", iso: "ISO", focalLength: "Focal length", focalLength35: "35 mm equivalent", flash: "Flash", software: "Software", artistExif: "Artist", copyright: "Copyright", rating: "Rating", encoder: "Encoder" };
  for (const [k, label] of Object.entries(L)) if (m.tags[k]) r.push([label, m.tags[k]]);
  if (m.gps) r.push(["Location", `${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}${m.gps.alt !== undefined ? `, ${m.gps.alt.toFixed(0)} m` : ""}`]);
  return r;
}
