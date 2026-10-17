/**
 * FF-04 — Adobe Illustrator (.ai) and EPS detection. Pure and hook-free, so it is shared by Peek (browser) and the tests (Node).
 *
 * Spec row: "`.ai` open (PDF-compatible); non-PDF AI labeled limited", routed to the FF-03 PDF route.
 *
 * What an .ai file can actually be (these kinds are also what we report):
 *   ai-pdf          Illustrator 9+ saved WITH "Create PDF Compatible File": a valid PDF plus Illustrator private data
 *                   (/AIPrivateDataN streams). The browser's PDF engine renders the PDF part.
 *   ai-no-pdf       Illustrator 9+ saved WITHOUT PDF compatibility: the PDF page is only Adobe's placeholder text
 *                   ("…saved without PDF Content…") and the artwork lives in private data we cannot render → limited.
 *   illustrator-pdf A PDF exported by Illustrator (Creator says Illustrator, no private data) → renders as PDF.
 *   pdf             Any other PDF (e.g. a renamed file) → renders as PDF; we say it is not an Illustrator file.
 *   ai-ps           Illustrator ≤8 (or another app writing Illustrator's PostScript dialect, e.g. FreeHand) → limited:
 *                   no PostScript interpreter is bundled, so we show the DSC header (creator, title, bounding box) only.
 *   eps             Generic (E)PS → metadata only.
 *   unknown         Anything else.
 * A DOS-EPS binary header (C5 D0 D3 C6) is unwrapped first; its PostScript section is classified as above, and the
 * WMF/TIFF preview sections are reported but not drawn.
 *
 * FF-12 bomb guards: at most MAX_STREAMS Flate streams are inflated, each compressed ≤ MAX_STREAM_IN and inflated
 * ≤ MAX_STREAM_OUT bytes, with a total inflate budget; the caller's inflate must enforce the per-call cap.
 */

export type AiKind = "ai-pdf" | "ai-no-pdf" | "illustrator-pdf" | "pdf" | "ai-ps" | "eps" | "unknown";

export interface AiSniff {
  kind: AiKind;
  /** true → hand the original bytes to the browser PDF engine (FF-03 route) */
  renderable: boolean;
  /** one-line human label for the UI */
  label: string;
  creator?: string;
  /** Illustrator version as written by the app ("27.1", "CC 23.0", "CS6", "88") */
  illustratorVersion?: string;
  /** %AI5_FileFormat value for PostScript-dialect files */
  aiFileFormat?: string;
  pdfVersion?: string;
  title?: string;
  boundingBox?: [number, number, number, number];
  dosEps?: { psOffset: number; psLength: number; wmfLength: number; tiffLength: number };
  /** what we checked and what we could not (shown in the UI) */
  notes: string[];
}

/** Inflate zlib/deflate data; must return null (not throw) on corrupt input and must stop at maxOut bytes. */
export type Inflate = (data: Uint8Array, maxOut: number) => Promise<Uint8Array | null>;

export const MAX_STREAMS = 300;
export const MAX_STREAM_IN = 512 * 1024;
export const MAX_STREAM_OUT = 4 * 1024 * 1024;
export const MAX_TOTAL_OUT = 32 * 1024 * 1024;
const NO_PDF_MARKER = "saved without PDF Content";

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** PDF literal string body → text (handles \( \) \\ escapes, octal escapes and a UTF-16BE BOM). */
export function pdfLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) { let oct = n; while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? "")) oct += raw[++i]; out += String.fromCharCode(parseInt(oct, 8) & 0xff); }
    else out += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
  }
  if (out.charCodeAt(0) === 0xfe && out.charCodeAt(1) === 0xff) {
    let u = "";
    for (let i = 2; i + 1 < out.length; i += 2) u += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1));
    return u;
  }
  return out;
}

/** Read a balanced PDF literal string starting just after its opening "(". */
function readLiteral(s: string, start: number): string {
  let depth = 1, i = start;
  for (; i < s.length && depth > 0; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
  }
  return pdfLiteral(s.slice(start, i - 1));
}

const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function findCreator(text: string): string | undefined {
  const xmp = /<xmp:CreatorTool>([^<]{1,200})<\/xmp:CreatorTool>/.exec(text) ?? /xmp:CreatorTool="([^"]{1,200})"/.exec(text);
  if (xmp) return xmlUnescape(xmp[1]).trim();
  const info = /\/Creator\s*\(/.exec(text);
  if (info) return readLiteral(text, info.index + info[0].length).trim();
  const dsc = /%%Creator:\s*([^\r\n]{1,200})/.exec(text);
  if (dsc) return dsc[1].replace(/^\(|\)$/g, "").trim();
  return undefined;
}

/** "Adobe Illustrator 27.1 (Macintosh)" → "27.1"; "Adobe Illustrator CC 23.0 (Windows)" → "CC 23.0"; "Adobe Illustrator(R) 8.0" → "8.0". */
export function illustratorVersion(creator: string | undefined): string | undefined {
  if (!creator || !/Illustrator/i.test(creator)) return undefined;
  const m = /Illustrator(?:\s*\((?:R|TM)\))?\s*((?:CC|CS\d*)(?:\s+\d+(?:\.\d+)*)?|\d+(?:\.\d+)*)/i.exec(creator);
  return m ? m[1].trim() : undefined;
}

interface StreamRef { dict: string; data: Uint8Array }

/** Flate streams in file order, bounded by MAX_STREAMS / MAX_STREAM_IN. */
function flateStreams(bytes: Uint8Array, text: string): StreamRef[] {
  const out: StreamRef[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < MAX_STREAMS) {
    if (text.slice(m.index - 3, m.index) === "end") continue;
    const dictStart = text.lastIndexOf("<<", m.index);
    if (dictStart < 0 || m.index - dictStart > 4096) continue;
    const dict = text.slice(dictStart, m.index);
    if (!/\/FlateDecode/.test(dict) || /\/DecodeParms/.test(dict)) continue; // predictors would need un-filtering; skip rather than misread
    const begin = m.index + m[0].length;
    const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let end = lenM ? begin + Number(lenM[1]) : text.indexOf("endstream", begin);
    if (end < begin || end > bytes.length) end = text.indexOf("endstream", begin);
    if (end < begin) break;
    if (end - begin <= MAX_STREAM_IN) out.push({ dict, data: bytes.subarray(begin, end) });
    re.lastIndex = end;
  }
  return out;
}

function analysePostScript(text: string, notes: string[]): Omit<AiSniff, "notes" | "renderable" | "label"> {
  const endC = text.indexOf("%%EndComments");
  const head = text.slice(0, endC > 0 ? Math.min(endC, 65536) : 65536);
  const creator = findCreator(head);
  const title = /%%Title:\s*([^\r\n]{1,200})/.exec(head)?.[1].replace(/^\(|\)$/g, "").trim();
  const bbM = /%%BoundingBox:\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(head);
  const aiFileFormat = /%AI5_FileFormat\s+([^\r\n]{1,40})/.exec(text.slice(0, 262144))?.[1].trim();
  const procsets = /procset\s+Adobe_(?:Illustrator\w*|\w*_AI\d+)/.test(head);
  const byIllustrator = !!creator && /Illustrator/i.test(creator);
  const aiDialect = byIllustrator || !!aiFileFormat || procsets;
  if (aiDialect && !byIllustrator) notes.push(`Written in Illustrator's PostScript dialect by ${creator ?? "an unnamed application"}.`);
  return {
    kind: aiDialect ? "ai-ps" : "eps",
    creator, title, aiFileFormat,
    illustratorVersion: illustratorVersion(creator),
    boundingBox: bbM ? [Number(bbM[1]), Number(bbM[2]), Number(bbM[3]), Number(bbM[4])] : undefined,
  };
}

export async function sniffAi(bytes: Uint8Array, inflate?: Inflate): Promise<AiSniff> {
  const notes: string[] = [];
  let body = bytes;
  let dosEps: AiSniff["dosEps"];

  if (bytes.length >= 30 && bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const psOffset = u32le(bytes, 4), psLength = u32le(bytes, 8), wmfLength = u32le(bytes, 16), tiffLength = u32le(bytes, 24);
    if (psOffset < 30 || psLength === 0 || psOffset + psLength > bytes.length) {
      return { kind: "unknown", renderable: false, label: "Damaged DOS-EPS header", notes: [`DOS-EPS header points outside the file (PostScript at ${psOffset}+${psLength}, file is ${bytes.length} bytes).`] };
    }
    dosEps = { psOffset, psLength, wmfLength, tiffLength };
    body = bytes.subarray(psOffset, psOffset + psLength);
    notes.push(`DOS-EPS wrapper: PostScript ${psLength} B${tiffLength ? `, TIFF preview ${tiffLength} B` : ""}${wmfLength ? `, WMF preview ${wmfLength} B` : ""}. Previews are not drawn (no TIFF/WMF decoder in the browser).`);
  }

  const head = latin1(body.subarray(0, 1024));
  const pdfAt = head.indexOf("%PDF-");
  if (pdfAt >= 0 && !dosEps) {
    const text = latin1(body);
    const pdfVersion = /%PDF-(\d\.\d)/.exec(head)?.[1];
    // /AIPrivateDataN streams hold the editable artwork; /PieceInfo <</Illustrator …>> alone is just page-piece
    // metadata that Illustrator also writes into plain "Save as PDF" output, so it does not make a file an .ai.
    const hasPrivate = /\/AIPrivateData\d+/.test(text);
    let creator = findCreator(text);
    let noPdf = text.includes(NO_PDF_MARKER);
    if (inflate && ((!creator) || (hasPrivate && !noPdf))) {
      let budget = MAX_TOTAL_OUT, inflated = 0;
      for (const st of flateStreams(body, text)) {
        if (budget <= 0) { notes.push("Inflate budget reached; remaining streams were not searched."); break; }
        const out = await inflate(st.data, Math.min(MAX_STREAM_OUT, budget));
        if (!out) continue;
        budget -= out.length; inflated++;
        const s = latin1(out);
        if (!creator) creator = findCreator(s);
        if (hasPrivate && s.includes(NO_PDF_MARKER)) { noPdf = true; break; }
      }
      notes.push(`Searched ${inflated} compressed stream(s).`);
    } else if (!inflate) notes.push("Compressed streams were not searched (no inflater supplied).");
    const version = illustratorVersion(creator);
    const kind: AiKind = hasPrivate ? (noPdf ? "ai-no-pdf" : "ai-pdf") : version ? "illustrator-pdf" : "pdf";
    const label = {
      "ai-pdf": `Adobe Illustrator${version ? ` ${version}` : ""} file with PDF compatibility; rendered by the browser's PDF engine`,
      "ai-no-pdf": `Adobe Illustrator${version ? ` ${version}` : ""} file saved WITHOUT PDF content; limited, artwork is in Illustrator-only data`,
      "illustrator-pdf": `PDF exported by Adobe Illustrator${version ? ` ${version}` : ""}; rendered by the browser's PDF engine`,
      pdf: "A PDF without Illustrator data; rendered by the browser's PDF engine",
    }[kind as "ai-pdf" | "ai-no-pdf" | "illustrator-pdf" | "pdf"];
    if (kind === "ai-pdf") notes.push("The PDF-compatible part is shown (Illustrator writes one PDF page per artboard). Illustrator-only data (live effects, appearance stacks, editability) is not interpreted.");
    return { kind, renderable: kind !== "ai-no-pdf", label, creator, illustratorVersion: version, pdfVersion, notes };
  }

  const psHead = latin1(body.subarray(0, 64));
  if (/^%!PS-Adobe/.test(psHead.replace(/^\s+/, ""))) {
    const text = latin1(body.subarray(0, Math.min(body.length, 262144)));
    const r = analysePostScript(text, notes);
    const eps = /EPSF-/.test(psHead);
    const label = r.kind === "ai-ps"
      ? `Legacy Illustrator PostScript${r.illustratorVersion ? ` (Illustrator ${r.illustratorVersion})` : ""}; limited, header only, no PostScript renderer`
      : `${eps ? "Encapsulated PostScript" : "PostScript"}; limited, header only, no PostScript renderer`;
    notes.push("No PostScript interpreter is bundled (Ghostscript is AGPL and several MB); only the DSC header comments are read.");
    return { ...r, renderable: false, label, dosEps, notes };
  }

  return { kind: "unknown", renderable: false, label: "Not an Illustrator, PDF or PostScript file", dosEps, notes: [...notes, "No %PDF- or %!PS-Adobe signature in the first bytes."] };
}

/**
 * The shipping inflater (browser and Node 18+): DecompressionStream("deflate") = zlib framing, which is what PDF
 * FlateDecode uses. Stops reading at maxOut bytes (returns the bytes so far) and returns null on corrupt data, so a
 * crafted stream can neither throw through the sniffer nor allocate past the cap.
 */
export const streamInflate: Inflate = async (data, maxOut) => {
  try {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    void writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined);
    void writer.close().catch(() => undefined);
    const reader = ds.readable.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value); n += value.length;
      if (n >= maxOut) { void reader.cancel().catch(() => undefined); break; }
    }
    const out = new Uint8Array(Math.min(n, maxOut));
    let o = 0;
    for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break; }
    return out;
  } catch {
    return null;
  }
};
