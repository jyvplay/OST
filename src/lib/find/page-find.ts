/**
 * TT139 (PR-07n) — Find in page.
 *
 * Pure matcher over a plain-text projection of the rendered document. The
 * caller supplies the text; this module supplies match enumeration, navigation
 * with wraparound, mode switching, and highlight ranges.
 *
 * Why it is not `String.replace` and a regex: the built-in browser find is not
 * reachable from script, so the honest way to implement Cmd-F in an app that
 * renders its own content is to build the projection, match it deterministically,
 * and scroll the Nth hit into view. That means the matching rules have to be
 * *specified*, not inherited.
 *
 * Rules this module implements, each with the reason:
 *   • Literal mode is case-insensitive by default, matching every browser's
 *     find bar. Case-sensitive is one of four explicit modes, not a flag
 *     combination that can contradict itself.
 *   • Whole-word uses Unicode-aware boundaries via \p{L}\p{N}, so "café" is a
 *     word and "naïve" is one word, not three. A `\b`-based implementation
 *     treats é as a boundary and silently splits words.
 *   • Regex mode is CASE-SENSITIVE and does not add the `i` flag. The three
 *     literal modes choose case for the user; in regex mode the pattern is the
 *     user's own expression, so silently adding `i` would change what they
 *     wrote. A caller who wants insensitive matching writes `[Qq]`, which is
 *     the only spelling that behaves the same in every engine (JS has no `(?i)`
 *     inline flag). Catastrophic backtracking is the
 *     caller's problem, but a pattern that fails to compile must not take the
 *     UI down, so it yields zero matches plus an `error` field.
 *   • Matches never overlap. "aa" in "aaa" is one match at 0, not two; an
 *     overlapping second match would make the counter disagree with the
 *     number of times the user sees a highlight.
 *   • `replaceAll` refuses to run on a zero-length pattern (which would be an
 *     infinite loop or an insert between every character, depending on how a
 *     naive implementation reads it).
 */

export type FindMode = "literal" | "case-sensitive" | "whole-word" | "regex";

export interface FindMatch {
  start: number;
  end: number;
  text: string;
}

export interface FindState {
  query: string;
  mode: FindMode;
  matches: FindMatch[];
  currentIndex: number;
  /** Set when the query is a bad regex; the UI shows it and matches stay empty. */
  error?: string;
}

export const MAX_QUERY_LENGTH = 512;
export const MAX_MATCHES = 10000;

export function createFind(text: string, query: string, mode: FindMode = "literal"): FindState {
  return withMatches(text, { query, mode, currentIndex: 0 });
}

function withMatches(text: string, base: { query: string; mode: FindMode; currentIndex: number }): FindState {
  if (!base.query) {
    return { ...base, matches: [], currentIndex: 0 };
  }
  if (base.query.length > MAX_QUERY_LENGTH) {
    return { ...base, matches: [], currentIndex: 0, error: `Query too long (>${MAX_QUERY_LENGTH})` };
  }
  let matches: FindMatch[];
  try {
    matches = findAll(text, base.query, base.mode);
  } catch (e) {
    return { ...base, matches: [], currentIndex: 0, error: (e as Error).message };
  }
  const currentIndex = matches.length ? Math.min(base.currentIndex, matches.length - 1) : 0;
  // Build a fresh object: reusing `base` would carry a stale `error` forward,
  // which made a query that had once been an invalid regex keep reporting an
  // error after the user fixed it.
  const state: FindState = { query: base.query, mode: base.mode, matches, currentIndex };
  return state;
}

export function setQuery(state: FindState, text: string, query: string): FindState {
  return withMatches(text, { query, mode: state.mode, currentIndex: state.currentIndex });
}

export function cycleMode(state: FindState, text: string): FindState {
  const order: FindMode[] = ["literal", "case-sensitive", "whole-word", "regex"];
  const next = order[(order.indexOf(state.mode) + 1) % order.length];
  // Regex mode adopts the literal query as a pattern, and leaving regex mode
  // keeps whatever the pattern was: no silent rewriting of what the user typed.
  return withMatches(text, { query: state.query, mode: next, currentIndex: 0 });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findAll(text: string, query: string, mode: FindMode): FindMatch[] {
  if (!query) return [];
  if (query.length > MAX_QUERY_LENGTH) throw new Error(`Query too long (>${MAX_QUERY_LENGTH})`);

  let re: RegExp;
  switch (mode) {
    case "literal":
      re = new RegExp(escapeRegex(query), "giu");
      break;
    case "case-sensitive":
      re = new RegExp(escapeRegex(query), "gu");
      break;
    case "whole-word":
      // Unicode-aware boundaries. \b alone splits "café" and "naïve".
      re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(query)}(?![\\p{L}\\p{N}_])`, "giu");
      break;
    case "regex":
      // No `i` flag on purpose: the pattern is the user's expression.
      re = new RegExp(query, "gu");
      break;
    default:
      throw new Error(`Unknown find mode: ${mode}`);
  }

  const out: FindMatch[] = [];
  // A zero-length pattern would loop forever with lastIndex += 0.
  let guard = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      if (++guard > MAX_MATCHES) break;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

export function nextMatch(s: FindState): FindState {
  if (!s.matches.length) return s;
  return { ...s, currentIndex: (s.currentIndex + 1) % s.matches.length };
}

export function prevMatch(s: FindState): FindState {
  if (!s.matches.length) return s;
  return { ...s, currentIndex: (s.currentIndex - 1 + s.matches.length) % s.matches.length };
}

export function currentMatch(s: FindState): FindMatch | null {
  return s.matches[s.currentIndex] ?? null;
}

export function setCurrentIndex(s: FindState, index: number): FindState {
  if (!s.matches.length) return s;
  if (!Number.isInteger(index) || index < 0 || index >= s.matches.length) {
    throw new Error(`Match index ${index} out of range (0..${s.matches.length - 1})`);
  }
  return { ...s, currentIndex: index };
}

/** "3 of 17" — the only count the find bar shows. */
export function describeFind(s: FindState): string {
  if (s.error) return s.error;
  if (!s.query) return "No search term";
  if (!s.matches.length) return `No results for "${s.query}"`;
  return `${s.currentIndex + 1} of ${s.matches.length}`;
}

export interface ReplaceResult {
  text: string;
  count: number;
}

/**
 * Replace every match. Replacement text is inserted literally: `$&` and `$1`
 * are NOT special, because a user typing `$5` into a price field must get a
 * dollar sign and a five.
 */
export function replaceAll(text: string, query: string, replacement: string, mode: FindMode): ReplaceResult {
  if (!query) throw new Error("Cannot replace an empty query");
  const matches = findAll(text, query, mode);
  if (!matches.length) return { text, count: 0 };
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + replacement;
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, count: matches.length };
}

/** Replace exactly one match, identified by index. */
export function replaceOne(text: string, query: string, replacement: string, mode: FindMode, index: number): ReplaceResult {
  if (!query) throw new Error("Cannot replace an empty query");
  const matches = findAll(text, query, mode);
  const m = matches[index];
  if (!m) return { text, count: 0 };
  return { text: text.slice(0, m.start) + replacement + text.slice(m.end), count: 1 };
}

export interface HighlightRange {
  start: number;
  end: number;
  /** True for the active match so the UI can style it differently. */
  active: boolean;
}

export function highlightRanges(s: FindState): HighlightRange[] {
  return s.matches.map((m, i) => ({ start: m.start, end: m.end, active: i === s.currentIndex }));
}

/**
 * Split text into alternating plain/highlight segments, ready for rendering.
 * Returning segments (rather than asking the caller to slice) guarantees the
 * highlight cannot drift from the match list.
 */
export function highlightSegments(text: string, s: FindState): Array<{ text: string; highlight: boolean; active: boolean }> {
  const out: Array<{ text: string; highlight: boolean; active: boolean }> = [];
  let cursor = 0;
  for (let i = 0; i < s.matches.length; i++) {
    const m = s.matches[i];
    if (m.start > cursor) out.push({ text: text.slice(cursor, m.start), highlight: false, active: false });
    out.push({ text: text.slice(m.start, m.end), highlight: true, active: i === s.currentIndex });
    cursor = m.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), highlight: false, active: false });
  return out;
}
