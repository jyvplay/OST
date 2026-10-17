/**
 * Constructed .ai / PDF / EPS fixtures for FF-04 tests (ai-format engine suite + e2e).
 *
 * These are CONSTRUCTED, labelled as such: they reproduce the byte-level structures Illustrator writes (AIPrivateData
 * streams, Adobe's "saved without PDF Content" placeholder page, compressed object streams), so the edge cases can be
 * tested deterministically. Real Illustrator files are covered separately: the committed MIT/Apache fixtures in this
 * folder and the held-out corpus fetched by scripts/oracle-ai.mts.
 *
 * PDFs get a correct xref table so an independent parser (pypdf) can read them.
 */
import { deflateSync } from "node:zlib";

const enc = (s: string) => Buffer.from(s, "latin1");

/** Build a PDF from object bodies (1-based ids). A body may contain one binary stream payload. */
export function makePdf(objects: (string | { dict: string; stream: Uint8Array })[], opts: { info?: number; prefix?: string; version?: string } = {}): Uint8Array {
  const parts: Buffer[] = [enc(`${opts.prefix ?? ""}%PDF-${opts.version ?? "1.6"}\n%\xe2\xe3\xcf\xd3\n`)];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(offset);
    const chunk = typeof o === "string"
      ? enc(`${i + 1} 0 obj\n${o}\nendobj\n`)
      : Buffer.concat([enc(`${i + 1} 0 obj\n${o.dict.replace("%LEN%", String(o.stream.length))}\nstream\n`), Buffer.from(o.stream), enc("\nendstream\nendobj\n")]);
    parts.push(chunk); offset += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(enc(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${opts.info ? ` /Info ${opts.info} 0 R` : ""} >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

const page = (contentId: number, extra = "") => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${contentId} 0 R${extra} >>`;
const flate = (s: string | Uint8Array) => new Uint8Array(deflateSync(typeof s === "string" ? enc(s) : s));
const drawing = "0.18 0.39 0.39 rg 20 20 160 60 re f\n";

/**
 * Uncompressed XMP packet like the one Illustrator writes near the start of every .ai (several KB in real files). Real
 * files therefore have their /AIPrivateData names well past byte 1 350, which matters to oracles that skip the
 * header (file-type 16 ignores the first 1 350 bytes before searching).
 */
const xmp = (creator: string) => enc(`<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<xmp:CreatorTool>${creator.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</xmp:CreatorTool><dc:format>application/pdf</dc:format>
</rdf:Description></rdf:RDF></x:xmpmeta>
${" ".repeat(100).concat("\n").repeat(20)}<?xpacket end="w"?>`);

/** Illustrator-style .ai WITH PDF compatibility: page content draws the artwork, private data rides along. */
export function aiWithPdf(creator = "Adobe Illustrator 28.5 (Macintosh)"): Uint8Array {
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R /Metadata 3 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    { dict: "<< /Type /Metadata /Subtype /XML /Length %LEN% >>", stream: xmp(creator) },
    page(5, " /PieceInfo << /Illustrator 7 0 R >>"),
    { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate(drawing) },
    `<< /Creator (${creator.replace(/[()\\]/g, (c) => "\\" + c)}) /Producer (constructed fixture) >>`,
    "<< /LastModified (D:20261016) /Private 8 0 R >>",
    "<< /AIMetaData 9 0 R /AIPrivateData1 10 0 R /NumBlock 1 /RoundTripVersion 28 >>",
    { dict: "<< /Length %LEN% >>", stream: enc(`%!PS-Adobe-3.0\n%%Creator: ${creator}\n%AI5_FileFormat 14.0\n%%EndComments\n`) },
    { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate("%AI24_ZStandard_Data constructed private payload") },
  ], { info: 6 });
}

/** Illustrator .ai saved WITHOUT PDF compatibility: the only page is Adobe's placeholder text, compressed. */
export function aiWithoutPdf(): Uint8Array {
  const placeholder = "BT /F1 12 Tf 20 60 Td (This is an Adobe\xae Illustrator\xae File that was) Tj 0 -14 Td (saved without PDF Content.) Tj ET\n";
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R /Metadata 3 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    { dict: "<< /Type /Metadata /Subtype /XML /Length %LEN% >>", stream: xmp("Adobe Illustrator 27.1 (Windows)") },
    page(5, " /PieceInfo << /Illustrator 7 0 R >>"),
    { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate(placeholder) },
    "<< /Creator (Adobe Illustrator 27.1 \\(Windows\\)) >>",
    "<< /LastModified (D:20261016) /Private 8 0 R >>",
    "<< /AIPrivateData1 9 0 R /NumBlock 1 >>",
    { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate("constructed private payload") },
  ], { info: 6 });
}

/** Creator only inside a compressed object stream (PDF 1.5+): the plain-text scan cannot see it, inflate must. */
export function creatorInObjectStream(): Uint8Array {
  const inner = "5 0 << /Creator (Adobe Illustrator CC 23.0 \\(Windows\\)) >>";
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    page(4),
    { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate(drawing) },
    { dict: "<< /Type /ObjStm /N 1 /First 4 /Length %LEN% /Filter /FlateDecode >>", stream: flate(inner) },
  ], { version: "1.5" });
}

/** UTF-16BE (BOM) Info string with octal escapes, as some writers emit. */
export function utf16Creator(): Uint8Array {
  const text = "Adobe Illustrator 26.0";
  let lit = "\\376\\377";
  for (const ch of text) lit += `\\000${ch === "(" || ch === ")" ? "\\" + ch : ch}`;
  return makePdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(4), { dict: "<< /Length %LEN% >>", stream: enc(drawing) }, `<< /Creator (${lit}) >>`], { info: 5 });
}

/** A highly compressible stream (64 MiB of zeros, ~64 KiB compressed) next to AIPrivateData: the inflate cap must hold. */
export function inflateBomb(): Uint8Array {
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(4),
    { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate(new Uint8Array(64 * 1024 * 1024)) },
    "<< /AIPrivateData1 6 0 R >>",
    { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate("x") },
  ]);
}

/** 1 000 tiny Flate streams: the stream-count cap must hold. */
export function manyStreams(): Uint8Array {
  const objs: (string | { dict: string; stream: Uint8Array })[] = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(4), "<< /AIPrivateData1 5 0 R >>"];
  for (let i = 0; i < 1000; i++) objs.push({ dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: flate(`chunk ${i}`) });
  return makePdf(objs);
}

/** Flate stream with garbage bytes: inflate must return null, the sniff must not throw. */
export function corruptFlate(): Uint8Array {
  return makePdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(4), { dict: "<< /Length %LEN% /Filter /FlateDecode >>", stream: enc("\x78\x9c this is not deflate data at all") }, "<< /AIPrivateData1 4 0 R >>"]);
}

/** DOS-EPS header whose PostScript section points past the end of the file. */
export function damagedDosEps(): Uint8Array {
  const b = Buffer.alloc(64);
  b.set([0xc5, 0xd0, 0xd3, 0xc6]); b.writeUInt32LE(30, 4); b.writeUInt32LE(10_000, 8);
  return new Uint8Array(b);
}

/** A valid DOS-EPS wrapper around a tiny Illustrator PostScript body with a fake TIFF preview section. */
export function dosEpsIllustrator(): Uint8Array {
  const ps = enc("%!PS-Adobe-3.1 EPSF-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n%%Title: (constructed.eps)\n%%BoundingBox: 0 0 120 80\n%AI5_FileFormat 4.0\n%%EndComments\nshowpage\n");
  const tiff = Buffer.alloc(16, 0x49);
  const h = Buffer.alloc(30);
  h.set([0xc5, 0xd0, 0xd3, 0xc6]); h.writeUInt32LE(30, 4); h.writeUInt32LE(ps.length, 8); h.writeUInt32LE(0, 12); h.writeUInt32LE(0, 16);
  h.writeUInt32LE(30 + ps.length, 20); h.writeUInt32LE(tiff.length, 24); h.writeUInt16LE(0xffff, 28);
  return new Uint8Array(Buffer.concat([h, ps, tiff]));
}

/** PDF header preceded by junk (allowed within the first 1 024 bytes by common readers). */
export function junkBeforeHeader(): Uint8Array {
  return makePdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(4), { dict: "<< /Length %LEN% >>", stream: enc(drawing) }], { prefix: "garbage-from-a-mail-gateway\r\n".repeat(10) });
}
