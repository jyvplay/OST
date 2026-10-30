/** TT117 NT-01 — note analysis: counts that exclude fenced/inline code from the
 * word total (code is not prose; counting it inflates reading time), a heading
 * outline with source line numbers, and link/image counts. Reading time uses
 * 200 words/minute and is reported in whole minutes, minimum 1 for non-empty text. */
export interface NoteStats {
  words: number; chars: number; charsNoSpaces: number; sentences: number; paragraphs: number;
  readingMinutes: number; headings: { level: number; text: string; line: number }[];
  links: number; images: number; codeBlocks: number; codeLines: number;
}
export function analyzeNote(text: string): NoteStats {
  const lines = String(text).split(/\r\n|\r|\n/);
  const headings: NoteStats["headings"] = [];
  let inFence = false, codeBlocks = 0, codeLines = 0;
  const prose: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; if (inFence) codeBlocks++; return; }
    if (inFence) { codeLines++; return; }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i + 1 });
    prose.push(line.replace(/`[^`]*`/g, " ")); // inline code is not prose either
  });
  const body = prose.join("\n");
  const words = (body.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const sentences = (body.match(/[.!?]+(?=\s|$)/g) ?? []).length;
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length;
  return {
    words,
    chars: String(text).length,
    charsNoSpaces: String(text).replace(/\s/g, "").length,
    sentences, paragraphs,
    readingMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / 200)),
    headings,
    links: (body.match(/(?<!!)\[[^\]]*\]\([^)\s]+\)/g) ?? []).length,
    images: (body.match(/!\[[^\]]*\]\([^)\s]+\)/g) ?? []).length,
    codeBlocks, codeLines,
  };
}
