/** A deliberately small Markdown view, not a CommonMark claim. No HTML
 * interpreter, remote images, CSS, embedded frames or automatic network I/O. */
export type NoteInline = { kind: "text" | "code" | "strong" | "em" | "strike"; text: string } | { kind: "link"; text: string; href: string | null };
export type NoteBlock = { kind: "heading"; level: number; line: number; text: string }
  | { kind: "paragraph" | "quote" | "item" | "code"; line: number; text: string }
  | { kind: "task"; line: number; text: string; checked: boolean }
  | { kind: "rule"; line: number; text: string };
export const NOTE_PREVIEW_LINES = 5_000;
export interface NoteMarkdownDoc { blocks: NoteBlock[]; truncated: boolean }
export function safeNoteLink(value: string): string | null {
  if (/[\x00-\x20\x7f]/.test(value)) return null;
  try { const u = new URL(value); return ["https:", "http:", "mailto:"].includes(u.protocol) ? u.href : null; } catch { return null; }
}
export function noteInline(text: string): NoteInline[] {
  const out: NoteInline[] = [];
  // Delimiter searches advance monotonically. Cache an absent/future closing
  // marker so a million unmatched '[' characters cannot cause quadratic scans.
  const ends = new Map<string, number>();
  const next = (marker: string, from: number) => {
    const cached = ends.get(marker);
    if (cached !== undefined && (cached === -1 || cached >= from)) return cached;
    const found = text.indexOf(marker, from); ends.set(marker, found); return found;
  };
  let at = 0, i = 0;
  while (i < text.length && out.length < 256) {
    let token: NoteInline | null = null, end = i;
    const newline = next("\n", i);
    if (text[i] === "[") {
      const labelEnd = next("](", i + 1);
      if (labelEnd > i + 1 && (newline < 0 || labelEnd < newline)) {
        const urlEnd = next(")", labelEnd + 2);
        if (urlEnd > labelEnd + 2 && (newline < 0 || urlEnd < newline)) {
          token = { kind: "link", text: text.slice(i + 1, labelEnd), href: safeNoteLink(text.slice(labelEnd + 2, urlEnd)) }; end = urlEnd + 1;
        }
      }
    } else {
      const marker = text.startsWith("**", i) ? "**" : text.startsWith("~~", i) ? "~~" : text[i] === "`" ? "`" : text[i] === "*" ? "*" : "";
      if (marker) {
        const close = next(marker, i + marker.length);
        if (close > i + marker.length && (newline < 0 || close < newline)) {
          token = { kind: marker === "**" ? "strong" : marker === "~~" ? "strike" : marker === "`" ? "code" : "em", text: text.slice(i + marker.length, close) }; end = close + marker.length;
        }
      }
    }
    if (!token) { i++; continue; }
    if (i > at) out.push({ kind: "text", text: text.slice(at, i) });
    out.push(token); at = end; i = end;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
export function noteMarkdown(source: string): NoteMarkdownDoc {
  const lines = source.split("\n", NOTE_PREVIEW_LINES + 1), blocks: NoteBlock[] = [];
  const count = Math.min(lines.length, NOTE_PREVIEW_LINES);
  for (let i = 0; i < count; i++) {
    const text = lines[i].replace(/\r$/, "");
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      const line = i, content: string[] = [], close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      for (i++; i < count && !close.test(lines[i]); i++) content.push(lines[i].replace(/\r$/, ""));
      blocks.push({ kind: "code", line, text: content.join("\n") }); continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, line: i, text: heading[2] }); continue; }
    const task = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) { blocks.push({ kind: "task", line: i, text: task[2], checked: task[1] !== " " }); continue; }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) { blocks.push({ kind: "rule", line: i, text: "" }); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(text), item = /^\s*(?:[-+*]|\d+[.)])\s+(.*)$/.exec(text);
    blocks.push({ kind: quote ? "quote" : item ? "item" : "paragraph", line: i, text: quote?.[1] ?? item?.[1] ?? text });
  }
  return { blocks, truncated: lines.length > count };
}
export function toggleNoteTask(source: string, line: number): string {
  const lines = source.split("\n");
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) throw new Error("Task line no longer exists");
  const m = /^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\]\s+[^\n]*)$/.exec(lines[line]);
  if (!m) throw new Error("This line is not a Markdown task");
  lines[line] = m[1] + (m[2] === " " ? "x" : " ") + m[3];
  return lines.join("\n");
}
