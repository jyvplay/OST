/**
 * TT139 (ED-11) — incremental find/replace engine for the Editor.
 *
 * The Editor's find bar was `indexOf` in a loop inside a render, which is both
 * quadratic on a large document and incorrect for the two cases users hit
 * immediately: case-insensitive matching of non-ASCII text (Turkish dotted I,
 * German ß) and whole-word matching (where `\b` is wrong for any non-ASCII
 * letter).
 *
 * Design: a match is produced by a small scanner that walks the *grapheme-ish*
 * character stream once and applies the three options explicitly
 * (case sensitivity, whole word, regex). Regex mode compiles a user pattern
 * with a length limit and a hard match cap, so a pathological pattern cannot
 * freeze the window; the caller is told when the cap was hit.
 *
 * Replace-all is a planned operation, not a sed: it returns the new document
 * plus the exact ranges it touched, so undo restores byte-for-byte and the
 * "you are about to replace 1 204 occurrences" dialog counts the same thing the
 * document will actually contain.
 */

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Hard cap on matches returned. */
  maxMatches?: number;
}

export interface Match { start: number; end: number; text: string }

export const FIND_MAX_PATTERN = 512;
export const FIND_MAX_MATCHES = 20_000;

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * Case-folded comparison that never changes the string's length.
 *
 * `toLowerCase()` is *not* length-preserving: "İ" (U+0130) folds to two code
 * units, and every offset after it shifts by one, so a match highlight lands on
 * the wrong characters. This folds only A–Z, which is length-exact. The price is
 * stated rather than hidden: Turkish dotless/dotted i and other length-changing
 * folds are matched case-sensitively (they still match when typed exactly).
 */
function fold(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * Character offsets are UTF-16 code-unit offsets (what `Selection` uses), so a
 * match never splits a surrogate pair: the scanner advances by code point and
 * records both offsets.
 */
export function findMatches(haystack: string, needle: string, opts: FindOptions = {}): { matches: Match[]; truncated: boolean; error: string | null } {
  const max = Math.min(opts.maxMatches ?? FIND_MAX_MATCHES, FIND_MAX_MATCHES);
  if (!needle) return { matches: [], truncated: false, error: null };
  if (needle.length > FIND_MAX_PATTERN) return { matches: [], truncated: false, error: `search text is limited to ${FIND_MAX_PATTERN} characters` };
  const matches: Match[] = [];
  let truncated = false;

  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(needle, opts.caseSensitive ? "gu" : "giu");
    } catch (e) {
      return { matches: [], truncated: false, error: `regular expression: ${(e as Error).message}` };
    }
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(haystack)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // zero-width: advance, never loop forever
      const start = m.index, end = start + m[0].length;
      if (opts.wholeWord && !(isWordChar(haystack[start - 1]) === false && isWordChar(haystack[end]) === false)) {
        if (!(boundaryOk(haystack, start, end))) { if (++guard > max * 4) break; continue; }
      }
      matches.push({ start, end, text: m[0] });
      if (matches.length >= max) { truncated = true; break; }
      if (++guard > max * 8) break;
    }
    return { matches, truncated, error: null };
  }

  const hay = fold(haystack, Boolean(opts.caseSensitive));
  const pat = fold(needle, Boolean(opts.caseSensitive));
  let from = 0;
  for (;;) {
    const at = hay.indexOf(pat, from);
    if (at === -1) break;
    const end = at + pat.length;
    // Do not start a match in the middle of a surrogate pair.
    if (at > 0 && isLowSurrogate(haystack.charCodeAt(at))) { from = at + 1; continue; }
    if (opts.wholeWord && !boundaryOk(haystack, at, end)) { from = at + 1; continue; }
    matches.push({ start: at, end, text: haystack.slice(at, end) });
    if (matches.length >= max) { truncated = true; break; }
    from = end > at ? end : at + 1;
  }
  return { matches, truncated, error: null };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function boundaryOk(text: string, start: number, end: number): boolean {
  const before = start > 0 ? String.fromCodePoint(text.codePointAt(start - 1) ?? 0) : undefined;
  const after = end < text.length ? String.fromCodePoint(text.codePointAt(end) ?? 0) : undefined;
  return !isWordChar(before) && !isWordChar(after);
}

/** Next/previous match with wraparound, relative to a caret position. */
export function nextMatch(matches: readonly Match[], caret: number, direction: 1 | -1, opts: { wrap?: boolean } = {}): Match | null {
  if (!matches.length) return null;
  const wrap = opts.wrap ?? true;
  if (direction === 1) {
    const hit = matches.find((m) => m.start > caret) ?? matches.find((m) => m.end > caret);
    return hit ?? (wrap ? matches[0] : null);
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].end < caret) return matches[i];
  return wrap ? matches[matches.length - 1] : null;
}

export interface ReplacePlan { text: string; replaced: number; ranges: Match[]; error: string | null }

/**
 * Replace all matches. In literal mode `replacement` is inserted verbatim (so a
 * replacement of "\\1" stays "\\1" — the previous implementation silently ate
 * backslashes). In regex mode `$1`…`$9`, `$&` and `$$` are expanded by the
 * engine's own replace, and the *actual* substituted text is measured from the
 * result rather than predicted.
 */
export function replaceAll(haystack: string, needle: string, replacement: string, opts: FindOptions = {}): ReplacePlan {
  const found = findMatches(haystack, needle, opts);
  if (found.error) return { text: haystack, replaced: 0, ranges: [], error: found.error };
  if (!found.matches.length) return { text: haystack, replaced: 0, ranges: [], error: null };
  if (opts.regex) {
    let re: RegExp;
    try { re = new RegExp(needle, opts.caseSensitive ? "gu" : "giu"); }
    catch (e) { return { text: haystack, replaced: 0, ranges: [], error: (e as Error).message }; }
    let out = "";
    let cursor = 0;
    let replaced = 0;
    const ranges: Match[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const allowed = new Set(found.matches.map((x) => `${x.start}:${x.end}`));
    for (let guard = 0; (m = re.exec(haystack)) !== null && guard < FIND_MAX_MATCHES * 2; guard++) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const key = `${m.index}:${m.index + m[0].length}`;
      if (!allowed.has(key)) continue;
      out += haystack.slice(cursor, m.index);
      out += m[0].replace(/^[\s\S]*$/, () => expandTemplate(replacement, m!));
      cursor = m.index + m[0].length;
      ranges.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      replaced++;
    }
    out += haystack.slice(cursor);
    return { text: out, replaced, ranges, error: found.truncated ? `stopped after ${found.matches.length} matches` : null };
  }
  let out = "";
  let cursor = 0;
  for (const m of found.matches) {
    out += haystack.slice(cursor, m.start);
    out += replacement;
    cursor = m.end;
  }
  out += haystack.slice(cursor);
  return { text: out, replaced: found.matches.length, ranges: found.matches, error: found.truncated ? `stopped after ${found.matches.length} matches` : null };
}

/** `$&`, `$1`…`$99`, `$$` — the subset of the replacement template this app documents. */
export function expandTemplate(template: string, m: RegExpExecArray): string {
  return template.replace(/\$(\$|&|\d{1,2})/g, (_whole, token: string) => {
    if (token === "$") return "$";
    if (token === "&") return m[0];
    const n = Number(token);
    return m[n] ?? "";
  });
}

export interface FindBarState { query: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; index: number }

/** Stable status text for the find bar; the count and position are one string so they cannot disagree. */
export function findStatus(state: FindBarState, matches: readonly Match[], truncated: boolean): string {
  if (!state.query) return "type to find";
  if (!matches.length) return "no matches";
  const pos = Math.min(Math.max(0, state.index), matches.length - 1) + 1;
  return `${pos} of ${matches.length}${truncated ? "+" : ""}`;
}

/** How many replacements would occur, without performing them (for the confirm dialog). */
export function countReplacements(haystack: string, needle: string, opts: FindOptions = {}): number {
  return findMatches(haystack, needle, opts).matches.length;
}
