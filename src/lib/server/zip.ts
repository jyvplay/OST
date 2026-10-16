import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry { name: string; size: number; compressed: number; method: number; offset: number }

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Guards, applied before any allocation (FF-12). */
export const ZIP_LIMITS = { maxEntries: 4000, maxTotalBytes: 64 * 1024 * 1024, maxRatio: 120 };

export function readCentralDirectory(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip container (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > ZIP_LIMITS.maxEntries) throw new Error(`zip entry count ${count} exceeds guard`);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    total += size;
    if (total > ZIP_LIMITS.maxTotalBytes) throw new Error("zip expands beyond the size guard");
    if (compressed > 0 && size / Math.max(compressed, 1) > ZIP_LIMITS.maxRatio) {
      throw new Error(`zip bomb guard: entry ${name} ratio ${(size / compressed).toFixed(0)}:1`);
    }
    if (name.includes("..") || name.startsWith("/")) throw new Error(`zip-slip guard: ${name}`);
    entries.push({ name, size, compressed, method, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (buf.readUInt32LE(entry.offset) !== LOC_SIG) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressed);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} in ${entry.name}`);
}

const stripTags = (xml: string) => xml.replace(/<[^>]+>/g, "");
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/* ------------------------------------------------------------ FM-05 writer */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Standards-conformant ZIP writer (PKWARE APPNOTE 4.3): real CRC-32, UTF-8 name
 * flag (bit 11), deflate only when it actually shrinks the entry (else store),
 * DOS timestamps. Output opens in Info-ZIP / Windows Explorer / macOS Archive Utility.
 */
export function writeZip(files: { name: string; data: Buffer; mtime?: Date }[]): Buffer {
  const locals: Buffer[] = []; const cens: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/^\/+/, ""), "utf8");
    const deflated = deflateRawSync(f.data);
    const store = deflated.length >= f.data.length;
    const body = store ? f.data : deflated;
    const crc = crc32(f.data);
    const d = f.mtime ?? new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LOC_SIG, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CEN_SIG, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); cens.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cen = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cen.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, end]);
}

/** Read + verify CRC: a corrupted entry is reported, never silently extracted. */
export function readEntryVerified(buf: Buffer, entry: ZipEntry): Buffer {
  const data = readEntry(buf, entry);
  const stored = buf.readUInt32LE(entry.offset + 14);
  if (stored !== 0 && crc32(data) !== stored) throw new Error(`CRC mismatch in ${entry.name} — archive is corrupt`);
  if (data.length !== entry.size) throw new Error(`size mismatch in ${entry.name}: header says ${entry.size}, got ${data.length}`);
  return data;
}

/**
 * FF-08 PSD: grade E, header + section lengths only. Reads the 26-byte header
 * (signature 8BPS, version 1=PSD / 2=PSB), then walks the color-mode and image-
 * resource sections to reach the layer-count field. Never decodes pixels.
 */
export function readPsdHeader(buf: Buffer) {
  if (buf.length < 26 || buf.toString("ascii", 0, 4) !== "8BPS") throw new Error("not a PSD (missing 8BPS signature)");
  const version = buf.readUInt16BE(4);
  if (version !== 1 && version !== 2) throw new Error(`unknown PSD version ${version}`);
  const channels = buf.readUInt16BE(12);
  const height = buf.readUInt32BE(14);
  const width = buf.readUInt32BE(18);
  const depth = buf.readUInt16BE(22);
  const modeId = buf.readUInt16BE(24);
  const modes: Record<number, string> = { 0: "Bitmap", 1: "Grayscale", 2: "Indexed", 3: "RGB", 4: "CMYK", 7: "Multichannel", 8: "Duotone", 9: "Lab" };
  let p = 26;
  const colorLen = buf.readUInt32BE(p); p += 4 + colorLen;
  const resLen = buf.readUInt32BE(p); p += 4 + resLen;
  let layers: number | null = null;
  try {
    const lmLen = version === 2 ? Number(buf.readBigUInt64BE(p)) : buf.readUInt32BE(p);
    p += version === 2 ? 8 : 4;
    if (lmLen > 0) {
      p += version === 2 ? 8 : 4; // layer-info length
      layers = Math.abs(buf.readInt16BE(p)); // negative = first alpha is merged transparency
    } else layers = 0;
  } catch { layers = null; }
  return {
    format: version === 2 ? "PSB" : "PSD", width, height, channels, depth,
    colorMode: modes[modeId] ?? `mode ${modeId}`, layers,
    imageResourcesBytes: resLen,
  };
}

/**
 * FF-10 EPUB: container.xml → OPF → spine order → XHTML chapters as text.
 * Order comes from the spine, not the zip directory (which is arbitrary).
 */
export function extractEpub(buf: Buffer) {
  const entries = readCentralDirectory(buf);
  const get = (name: string) => {
    const e = entries.find((x) => x.name === name);
    return e ? readEntry(buf, e).toString("utf8") : null;
  };
  const container = get("META-INF/container.xml");
  if (!container) throw new Error("not an EPUB (META-INF/container.xml missing)");
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error("container.xml has no rootfile");
  const opf = get(opfPath) ?? "";
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const title = decode(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? "Untitled");
  const author = decode(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/.exec(opf)?.[1] ?? "");
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    if (id && href) manifest.set(id, href);
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  const chapters = spine.slice(0, 200).map((idref, i) => {
    const href = manifest.get(idref);
    const xml = href ? get(base + decodeURIComponent(href)) ?? "" : "";
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(xml)?.[1] ?? xml;
    const text = decode(body.replace(/<\/(p|div|h[1-6]|li|br)>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
    return { index: i + 1, href: href ?? idref, text };
  });
  return { title, author, chapters };
}

/** Grade D extraction: structure-aware text, explicitly not a round-trip. */
export function extractOoxml(buf: Buffer): { kind: string; text: string; parts: string[]; dropped: string[] } {
  const entries = readCentralDirectory(buf);
  const names = entries.map((e) => e.name);
  const get = (name: string) => {
    const e = entries.find((x) => x.name === name);
    return e ? readEntry(buf, e).toString("utf8") : null;
  };

  if (names.includes("word/document.xml")) {
    const xml = get("word/document.xml") ?? "";
    const paras = xml.split(/<\/w:p>/).map((p) => decode(stripTags(p)).trim()).filter(Boolean);
    return {
      kind: "docx",
      text: paras.join("\n\n"),
      parts: names.filter((n) => n.startsWith("word/")),
      dropped: ["styles", "numbering", "images", "comments", "headers/footers", "tracked changes"],
    };
  }
  if (names.some((n) => n.startsWith("xl/"))) {
    const shared = get("xl/sharedStrings.xml") ?? "";
    const strings = [...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(stripTags(m[1])));
    const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    const out: string[] = [];
    for (const s of sheets) {
      const xml = get(s) ?? "";
      out.push(`# ${s}`);
      for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const c of rowMatch[1].matchAll(/<c[^>]*?(?:t="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)) {
          const type = c[1];
          const v = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1] ?? "";
          const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2])?.[1];
          cells.push(type === "s" ? (strings[Number(v)] ?? "") : inline ? decode(inline) : decode(v));
        }
        out.push(cells.map((x) => (x.includes(",") ? `"${x.replace(/"/g, '""')}"` : x)).join(","));
      }
    }
    return { kind: "xlsx", text: out.join("\n"), parts: sheets, dropped: ["formulas (values only)", "formatting", "charts", "pivot tables", "macros"] };
  }
  const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(
    (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
  );
  if (slides.length) {
    const out: string[] = [];
    slides.forEach((s, i) => {
      const xml = get(s) ?? "";
      const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decode(m[1]));
      out.push(`## Slide ${i + 1}\n\n${runs.join("\n")}`);
    });
    return { kind: "pptx", text: out.join("\n\n"), parts: slides, dropped: ["layouts", "themes", "images", "animations", "speaker notes formatting"] };
  }
  return { kind: "zip", text: names.join("\n"), parts: names, dropped: [] };
}
