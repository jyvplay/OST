/**
 * TT139 (TD-04) — a text-import pipeline, which is what "a Linux userland" can
 * honestly be in a browser.
 *
 * A 30–80 MB WASM distribution is out of the install budget and would need a
 * licence audit, so nothing here claims to run `bash`. What the desktop actually
 * needs from a userland is the *text toolchain* people reach for on real files,
 * and that is implementable exactly:
 *
 *   - `sortLines` with the POSIX options that change results (`-n`, `-r`, `-u`,
 *     `-f`, `-k`), stable and locale-independent (byte order, like `LC_ALL=C`);
 *   - `uniqLines` with the run-length semantics of the real `uniq` (only
 *     *adjacent* duplicates collapse unless the input was sorted);
 *   - `cutFields` with `-d` and a 1-based field list;
 *   - `pasteColumns` with a tab delimiter;
 *   - `wcCount` counting bytes, characters, words and lines the way POSIX does;
 *   - `trSet` for range and complement translation.
 *
 * Where the semantics differ from GNU coreutils, the difference is written down
 * and is a refusal rather than an approximation (see each function).
 */

export type SortMode = { numeric?: boolean; reverse?: boolean; unique?: boolean; foldCase?: boolean; key?: number; fieldSeparator?: string };

/** Fold only ASCII, so offsets and byte counts stay exact (same rule as ED-11). */
function asciiFold(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** A numeric prefix as `sort -n` sees it: leading blanks, optional sign, digits, one dot. */
export function numericPrefix(line: string): number {
  const m = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(line);
  if (!m) return Number.NaN;
  const n = Number(m[0].trim());
  return Number.isFinite(n) ? n : Number.NaN;
}

export function sortLines(text: string, mode: SortMode = {}): { lines: string[]; removed: number; comparedNumerically: number } {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const keyOf = (line: string) => {
    if (!mode.key) return line;
    const sep = mode.fieldSeparator ?? "\t";
    const fields = line.split(sep);
    return fields[mode.key - 1] ?? "";
  };
  let comparedNumerically = 0;
  const decorated = lines.map((line, index) => ({ line, index, key: keyOf(line) }));
  decorated.sort((a, b) => {
    let cmp: number;
    if (mode.numeric) {
      const na = numericPrefix(a.key), nb = numericPrefix(b.key);
      const aNaN = Number.isNaN(na), bNaN = Number.isNaN(nb);
      // `sort -n` puts non-numeric lines first, in byte order among themselves.
      if (aNaN && bNaN) cmp = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      else if (aNaN) cmp = -1;
      else if (bNaN) cmp = 1;
      else { cmp = na - nb; comparedNumerically++; }
    } else {
      const ka = mode.foldCase ? asciiFold(a.key) : a.key;
      const kb = mode.foldCase ? asciiFold(b.key) : b.key;
      cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    }
    if (cmp === 0) cmp = a.index - b.index; // stable
    return mode.reverse ? -cmp : cmp;
  });
  let removed = 0;
  let out = decorated.map((d) => d.line);
  if (mode.unique) {
    const seen = new Set<string>();
    out = out.filter((line) => {
      const k = mode.foldCase ? asciiFold(keyOf(line)) : keyOf(line);
      if (seen.has(k)) { removed++; return false; }
      seen.add(k);
      return true;
    });
  }
  return { lines: out, removed, comparedNumerically };
}

/** Real `uniq`: only adjacent duplicates. Returns counts for the `-c` form. */
export function uniqLines(text: string, opts: { count?: boolean; foldCase?: boolean } = {}): { lines: string[]; groups: { line: string; count: number }[] } {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const groups: { line: string; count: number }[] = [];
  for (const line of lines) {
    const key = opts.foldCase ? asciiFold(line) : line;
    const last = groups[groups.length - 1];
    if (last && (opts.foldCase ? asciiFold(last.line) : last.line) === key) last.count++;
    else groups.push({ line, count: 1 });
  }
  return { lines: groups.map((g) => (opts.count ? `${String(g.count).padStart(7)} ${g.line}` : g.line)), groups };
}

export function cutFields(text: string, opts: { delimiter?: string; fields: number[] }): { lines: string[]; missing: number } {
  const delim = opts.delimiter && opts.delimiter.length === 1 ? opts.delimiter : "\t";
  if (opts.delimiter && opts.delimiter.length !== 1) throw new Error("cut: the delimiter must be a single character");
  const fields = opts.fields.filter((f) => Number.isInteger(f) && f >= 1).sort((a, b) => a - b);
  if (!fields.length) throw new Error("cut: at least one 1-based field is required");
  let missing = 0;
  const lines = text.split("\n").filter((_, i, all) => !(i === all.length - 1 && all[i] === "")).map((line) => {
    const parts = line.split(delim);
    const taken = fields.map((f) => {
      if (f > parts.length) { missing++; return ""; }
      return parts[f - 1];
    });
    return taken.join(delim);
  });
  return { lines, missing };
}

export function pasteColumns(columns: readonly string[][], delimiter = "\t"): string[] {
  const rows = Math.max(0, ...columns.map((c) => c.length));
  return Array.from({ length: rows }, (_, r) => columns.map((c) => c[r] ?? "").join(delimiter));
}

/** POSIX `wc`: bytes, characters, words (runs of non-blank), lines (newline count). */
export function wcCount(text: string): { bytes: number; chars: number; words: number; lines: number } {
  const bytes = new TextEncoder().encode(text).length;
  const chars = [...text].length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = (text.match(/\n/g) ?? []).length + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
  return { bytes, chars, words, lines };
}

/** `tr` with ranges (a-z) and an optional complement set. Unmappable characters pass through. */
export function trSet(text: string, from: string, to: string, opts: { complement?: boolean; delete?: boolean } = {}): { text: string; replaced: number; warnings: string[] } {
  const warnings: string[] = [];
  const expand = (spec: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < spec.length; i++) {
      const ch = spec[i];
      if (ch === "\\" && i + 1 < spec.length) {
        const next = spec[++i];
        out.push(next === "n" ? "\n" : next === "t" ? "\t" : next);
        continue;
      }
      if (spec[i + 1] === "-" && i + 2 < spec.length) {
        const a = spec.charCodeAt(i), b = spec.charCodeAt(i + 2);
        if (b < a) { warnings.push(`tr: range ${spec.slice(i, i + 3)} is reversed and was ignored`); out.push(ch); continue; }
        if (b - a > 512) { warnings.push(`tr: range ${spec.slice(i, i + 3)} is too large and was ignored`); out.push(ch); continue; }
        for (let c = a; c <= b; c++) out.push(String.fromCharCode(c));
        i += 2;
        continue;
      }
      out.push(ch);
    }
    return out;
  };
  const fromSet = expand(from);
  const toSet = expand(to);
  if (!fromSet.length) throw new Error("tr: the first set is empty");
  if (!opts.delete && !toSet.length) throw new Error("tr: the second set is empty (use delete for removal)");
  const map = new Map<string, string | null>();
  if (opts.complement) {
    const set = new Set(fromSet);
    for (const ch of new Set([...text])) if (!set.has(ch)) map.set(ch, opts.delete ? null : toSet[0]);
  } else {
    fromSet.forEach((ch, i) => { map.set(ch, opts.delete ? null : toSet[Math.min(i, toSet.length - 1)]); });
  }
  let replaced = 0;
  let out = "";
  for (const ch of text) {
    if (map.has(ch)) {
      const to1 = map.get(ch)!;
      replaced++;
      if (to1 !== null) out += to1;
    } else out += ch;
  }
  return { text: out, replaced, warnings };
}

/** What the module says it is, so a UI cannot oversell it. */
export const TEXT_TOOLCHAIN_DISCLOSURE = "sort, uniq, cut, paste, wc and tr run here on text you open. No shell, no executables, no WASM distribution.";
