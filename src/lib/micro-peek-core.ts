/**
 * TT26 — "micro peek": a file's real contents rendered as a miniature on its Tabletop card (and enlarged on hover /
 * focus). Pure: (name, mime, encoding, content) → a small description the card draws. No React, no DOM.
 *
 *   text  — first lines of text-like files; Markdown headings / bullets keep their role so the miniature has shape
 *   grid  — first rows × columns of CSV/TSV (RFC 4180 quoting), or of a JSON array of rows
 *   image — raster images (base64 in the VFS) and SVG as an <img> data: URL. An <img> never runs SVG script or
 *           loads external references, so no sanitising pass is needed for the peek.
 *   none  — binary or empty files: just the extension badge
 *
 * Only the first PEEK_SCAN characters are looked at (a peek of a 5 MB log costs the same as a 5 kB one). Sealed
 * /Private content is never peeked: the caller passes `sealed` and gets "none".
 */
export type PeekLine = { t: string; role: "h" | "li" | "p" | "code" };
export type Peek =
  | { kind: "text"; lines: PeekLine[]; more: boolean }
  | { kind: "grid"; rows: string[][]; more: boolean }
  | { kind: "image"; src: string }
  | { kind: "none"; label: string };

export const PEEK_SCAN = 4096;
export const PEEK_LINES = 14;
export const PEEK_COLS = 42;
export const PEEK_ROWS = 7;
export const PEEK_GRID_COLS = 5;

const ext = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
const TEXTY = new Set(["txt", "log", "ini", "env", "md", "markdown", "json", "js", "ts", "tsx", "jsx", "mjs", "css", "html", "htm", "xml", "yml", "yaml", "toml", "sh", "py", "rs", "go", "c", "h", "java", "sql", "ics", "vcf", "eml", "srt", "vtt"]);
const RASTER = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
const cut = (s: string, n = PEEK_COLS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** RFC 4180 record splitter over at most `maxRows` records (quoted commas/newlines/"" escapes). */
export function parseDelimited(src: string, delim = ",", maxRows = PEEK_ROWS + 1): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length && rows.length < maxRows; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (rows.length < maxRows && (cell !== "" || row.length)) { row.push(cell); rows.push(row); }
  return rows;
}

function textLines(src: string, markdown: boolean): { lines: PeekLine[]; more: boolean } {
  const all = src.replace(/\r\n?/g, "\n").split("\n");
  const lines: PeekLine[] = [];
  let fence = false, i = 0;
  for (; i < all.length && lines.length < PEEK_LINES; i++) {
    const raw = all[i].replace(/\t/g, "  ");
    if (markdown && /^\s*```/.test(raw)) { fence = !fence; continue; }
    if (!raw.trim()) { if (lines.length && lines[lines.length - 1].t !== "") lines.push({ t: "", role: "p" }); continue; }
    if (markdown && !fence) {
      const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
      const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
      if (h) { lines.push({ t: cut(h[1].replace(/[*_`]/g, "")), role: "h" }); continue; }
      if (li) { lines.push({ t: cut(li[1].replace(/[*_`]/g, "")), role: "li" }); continue; }
      lines.push({ t: cut(raw.trim().replace(/[*_`]/g, "")), role: "p" });
      continue;
    }
    lines.push({ t: cut(raw.trimEnd()), role: fence || !markdown ? "code" : "p" });
  }
  while (lines.length && lines[lines.length - 1].t === "") lines.pop();
  return { lines, more: i < all.length };
}

export function microPeek(f: { name: string; mime?: string; encoding?: string; content?: string; sealed?: boolean }): Peek {
  const e = ext(f.name);
  const label = (e || "file").toUpperCase().slice(0, 6);
  const content = typeof f.content === "string" ? f.content : "";
  const mime = (f.mime ?? "").toLowerCase();
  if (f.sealed) return { kind: "none", label: "SEALED" };
  if (f.encoding === "base64") {
    if ((mime.startsWith("image/") || RASTER.has(e)) && content && /^[A-Za-z0-9+/=\s]+$/.test(content.slice(0, 200))) {
      const m = mime.startsWith("image/") && mime !== "image/*" ? mime : `image/${e === "jpg" ? "jpeg" : e || "png"}`;
      return { kind: "image", src: `data:${m};base64,${content.replace(/\s+/g, "")}` };
    }
    return { kind: "none", label };
  }
  if (!content.trim()) return { kind: "none", label };
  if (e === "svg" || mime === "image/svg+xml") return { kind: "image", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.slice(0, 200_000))}` };
  const head = content.slice(0, PEEK_SCAN);
  if (e === "csv" || e === "tsv" || mime === "text/csv") {
    const rows = parseDelimited(head, e === "tsv" ? "\t" : ",");
    const more = rows.length > PEEK_ROWS || content.length > PEEK_SCAN;
    return { kind: "grid", rows: rows.slice(0, PEEK_ROWS).map((r) => r.slice(0, PEEK_GRID_COLS).map((c) => cut(c, 14))), more };
  }
  if (e === "json" || mime === "application/json") {
    try {
      const v: unknown = JSON.parse(content.length <= 200_000 ? content : head);
      if (Array.isArray(v) && v.length && v.every((r) => Array.isArray(r))) {
        return { kind: "grid", rows: (v as unknown[][]).slice(0, PEEK_ROWS).map((r) => r.slice(0, PEEK_GRID_COLS).map((c) => cut(String(c ?? ""), 14))), more: v.length > PEEK_ROWS };
      }
      return { kind: "text", ...textLines(JSON.stringify(v, null, 1), false) };
    } catch { /* fall through: show the raw text */ }
  }
  const md = e === "md" || e === "markdown" || mime === "text/markdown";
  if (md || TEXTY.has(e) || mime.startsWith("text/") || /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(head.slice(0, 512))) {
    return { kind: "text", ...textLines(head, md) };
  }
  return { kind: "none", label };
}
