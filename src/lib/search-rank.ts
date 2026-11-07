/**
 * TT139 (SR-26) — search ranking and query language.
 *
 * The Find module used to filter by "does the substring appear", then sort by
 * title. That is not search: it cannot answer "notes about the budget that I
 * touched this month", and it treats a match in a 400 KB body exactly like a
 * match in a title.
 *
 * This module is the ranking half, as a pure function over already-retrieved
 * rows (retrieval, permission filtering and the 50 000-code-point index bound
 * stay in the server routes where they already are):
 *
 *   - field weights (title ≫ tags > path > body) with a documented saturation,
 *   - BM25-style length normalisation so a long document is not penalised for
 *     being long, only for matching weakly,
 *   - proximity and phrase bonuses when all query terms occur close together,
 *   - a small, explicit query grammar: `term`, `"exact phrase"`, `-excluded`,
 *     `field:value` (`title:`, `tag:`, `path:`, `type:`), `after:`/`before:`
 *     dates and `is:pinned`.
 *
 * Bounds and honesty: no stemming beyond a fixed suffix table, no synonyms
 * (they would need a dictionary we do not ship), Unicode-aware lower-casing but
 * no per-locale collation. Anything unrecognised is treated as a literal term
 * rather than being dropped, so a typo widens the query instead of silently
 * emptying it.
 */

export type SearchField = "title" | "tag" | "path" | "body" | "type";
export interface SearchDoc {
  id: string;
  title: string;
  body?: string;
  tags?: string[];
  path?: string;
  type?: string;
  /** epoch ms; used by after:/before: and as a mild recency tiebreak */
  updatedAt?: number;
  pinned?: boolean;
}

export interface ParsedQuery {
  terms: string[];
  phrases: string[][];
  negated: string[];
  fields: { field: SearchField; value: string }[];
  after?: number;
  before?: number;
  pinnedOnly: boolean;
  /** Every token that did not parse as an operator, for the "no results" help. */
  raw: string;
  error: string | null;
}

export const SEARCH_FIELDS: readonly SearchField[] = ["title", "tag", "path", "body", "type"];
const FIELD_ALIASES: Record<string, SearchField> = {
  title: "title", t: "title", tag: "tag", tags: "tag", path: "path", folder: "path",
  body: "body", text: "body", content: "body", type: "type", kind: "type",
};

/** Fixed, small suffix normaliser. Not a stemmer — a documented truncation. */
const SUFFIXES = ["ingly", "edly", "ing", "ies", "ied", "es", "ed", "ly", "s"];
export function normaliseTerm(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 4) return w;
  for (const suf of SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      let stem = w.slice(0, w.length - suf.length);
      if (suf === "ies" || suf === "ied") stem += "y";
      // "running" → "runn" would need a doubled-consonant rule; keep it honest
      // by undoubling only when the result is still ≥3 chars.
      if (/([bdfglmnprt])\1$/.test(stem) && stem.length > 3) stem = stem.slice(0, -1);
      return stem;
    }
  }
  return w;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map(normaliseTerm);
}

/** Parse the query grammar. Never throws: a bad date becomes a reported error. */
export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { terms: [], phrases: [], negated: [], fields: [], pinnedOnly: false, raw: input, error: null };
  const src = String(input ?? "");
  let i = 0;
  const push = (neg: boolean, value: string) => {
    if (!value) return;
    if (neg) q.negated.push(value);
    else q.terms.push(value);
  };
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    let neg = false;
    if (src[i] === "-" && i + 1 < src.length && !/\s/.test(src[i + 1])) { neg = true; i++; }
    if (src[i] === '"') {
      const end = src.indexOf('"', i + 1);
      const endAt = end === -1 ? src.length : end;
      const phrase = src.slice(i + 1, endAt);
      const words = tokenize(phrase);
      if (words.length) {
        if (neg) q.negated.push(phrase.toLowerCase());
        else q.phrases.push(words);
      }
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    let start = i;
    while (i < src.length && !/\s/.test(src[i])) i++;
    const token = src.slice(start, i);
    const colon = token.indexOf(":");
    if (colon > 0) {
      const key = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1);
      if (key === "after" || key === "before") {
        const ts = parseDateValue(value);
        if (ts === null) { q.error = `could not read the date "${value}" (use YYYY-MM-DD or a relative form like 7d)`; continue; }
        if (key === "after") q.after = ts; else q.before = ts;
        continue;
      }
      if (key === "is" && value.toLowerCase() === "pinned") { q.pinnedOnly = !neg; continue; }
      const field = FIELD_ALIASES[key];
      if (field) {
        if (value) q.fields.push({ field, value: value.toLowerCase() });
        continue;
      }
    }
    push(neg, token.toLowerCase());
  }
  return q;
}

/** `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, `now`, `Nh`/`Nd`/`Nw`/`Nm`/`Ny` ago, or `today`. */
export function parseDateValue(value: string, now = Date.now()): number | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === "now") return now;
  if (v === "today") { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
  if (v === "yesterday") { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 86_400_000; }
  const rel = /^(\d{1,4})([hdwmy])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000, y: 31_536_000_000 }[rel[2] as "h" | "d" | "w" | "m" | "y"];
    return now - n * unit;
  }
  const iso = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(v);
  if (iso) {
    const y = Number(iso[1]), mo = iso[2] ? Number(iso[2]) - 1 : 0, d = iso[3] ? Number(iso[3]) : 1;
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
    const ts = Date.UTC(y, mo, d);
    // reject impossible calendar dates (2025-02-30)
    const check = new Date(ts);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
    return ts;
  }
  return null;
}

export const FIELD_WEIGHTS: Record<SearchField, number> = { title: 8, tag: 5, path: 3, type: 2, body: 1 };
const BM25_K1 = 1.2;
const BM25_B = 0.62;

export interface RankedHit { id: string; score: number; reasons: string[]; fields: SearchField[] }

interface DocIndex {
  doc: SearchDoc;
  fieldTokens: Record<SearchField, string[]>;
  fieldSet: Record<SearchField, Set<string>>;
  lengths: Record<SearchField, number>;
  lower: Record<SearchField, string>;
}

function buildIndex(doc: SearchDoc): DocIndex {
  const fieldTokens: Record<SearchField, string[]> = {
    title: tokenize(doc.title ?? ""),
    body: tokenize(doc.body ?? ""),
    tag: (doc.tags ?? []).flatMap(tokenize),
    path: tokenize(doc.path ?? ""),
    type: tokenize(doc.type ?? ""),
  };
  const fieldSet = Object.fromEntries(Object.entries(fieldTokens).map(([k, v]) => [k, new Set(v)])) as Record<SearchField, Set<string>>;
  const lengths = Object.fromEntries(Object.entries(fieldTokens).map(([k, v]) => [k, v.length])) as Record<SearchField, number>;
  const lower: Record<SearchField, string> = {
    title: (doc.title ?? "").toLowerCase(),
    body: (doc.body ?? "").toLowerCase(),
    tag: (doc.tags ?? []).join(" ").toLowerCase(),
    path: (doc.path ?? "").toLowerCase(),
    type: (doc.type ?? "").toLowerCase(),
  };
  return { doc, fieldTokens, fieldSet, lengths, lower };
}

/** Does the document satisfy every *filter* (negation, fields, dates, pinned)? */
function passesFilters(ix: DocIndex, q: ParsedQuery): boolean {
  const d = ix.doc;
  for (const field of SEARCH_FIELDS) {
    for (const f of q.fields) {
      if (f.field !== field) continue;
      if (!ix.lower[field].includes(f.value)) return false;
    }
  }
  for (const n of q.negated) {
    const found = SEARCH_FIELDS.some((f) => ix.lower[f].includes(n));
    if (found) return false;
  }
  // A date filter is a statement about when the document was updated. A document
  // with no date (0 by default) must not silently read as 1970 and slip into a
  // "before:" query: unknown is unknown, so it does not satisfy the filter.
  if (q.after !== undefined && (d.updatedAt === undefined || d.updatedAt < q.after)) return false;
  if (q.before !== undefined && (d.updatedAt === undefined || d.updatedAt > q.before)) return false;
  if (q.pinnedOnly && !d.pinned) return false;
  return true;
}

/**
 * Rank docs. Score is comparable *within one call only* — it depends on the
 * average document length of the supplied set, which is the honest BM25
 * contract. `reasons` exist so the UI can explain a hit instead of asking the
 * user to trust a number.
 */
export function rankSearch(docs: readonly SearchDoc[], query: ParsedQuery | string): RankedHit[] {
  const q = typeof query === "string" ? parseQuery(query) : query;
  if (!q.terms.length && !q.phrases.length && !q.fields.length && !q.negated.length && !q.pinnedOnly && q.after === undefined && q.before === undefined) return [];
  const indexes = docs.map(buildIndex);
  const avgLen = { title: 0, body: 0, tag: 0, path: 0, type: 0 } as Record<SearchField, number>;
  for (const ix of indexes) for (const f of SEARCH_FIELDS) avgLen[f] += ix.lengths[f];
  for (const f of SEARCH_FIELDS) avgLen[f] = indexes.length ? Math.max(1, avgLen[f] / indexes.length) : 1;

  const hits: RankedHit[] = [];
  for (const ix of indexes) {
    if (!passesFilters(ix, q)) continue;
    // every positive term must appear somewhere (AND), which is what a user
    // expects from a search box; phrase pairs likewise.
    const positiveTerms = [...q.terms.map(normaliseTerm)];
    const phraseWords = q.phrases;
    const allTerms = [...positiveTerms, ...phraseWords.flat()];
    if (allTerms.length && !allTerms.every((t) => SEARCH_FIELDS.some((f) => ix.fieldSet[f].has(t)))) continue;

    let score = 0;
    const reasons: string[] = [];
    const usedFields = new Set<SearchField>();
    for (const term of positiveTerms) {
      let termScore = 0;
      for (const field of SEARCH_FIELDS) {
        const toks = ix.fieldTokens[field];
        let tf = 0;
        for (const t of toks) if (t === term) tf++;
        if (tf === 0) continue;
        const norm = 1 - BM25_B + BM25_B * (ix.lengths[field] / avgLen[field]);
        const sat = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
        termScore += FIELD_WEIGHTS[field] * sat;
        usedFields.add(field);
      }
      if (termScore === 0) {
        // substring fallback: "budg" should still find "budget". Weighted low so
        // it never outranks a real token match.
        for (const field of SEARCH_FIELDS) {
          if (ix.lower[field].includes(term)) { termScore += FIELD_WEIGHTS[field] * 0.35; usedFields.add(field); }
        }
      }
      score += termScore;
    }
    for (const phrase of phraseWords.length ? q.phrases : []) {
      const joined = phrase.join(" ");
      for (const field of SEARCH_FIELDS) {
        const idx = ix.fieldTokens[field];
        const hay = idx.join(" ");
        if (hay.includes(joined)) {
          score += FIELD_WEIGHTS[field] * 2.2;
          reasons.push(`phrase in ${field}`);
          usedFields.add(field);
        }
      }
    }
    // proximity: all terms inside one 40-token window of the body
    if (positiveTerms.length > 1) {
      const body = ix.fieldTokens.body;
      const sorted = positiveTerms.map((t) => body.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b);
      if (sorted.length === positiveTerms.length && sorted[sorted.length - 1] - sorted[0] <= 40) {
        score += 1.6;
        reasons.push("terms are close together");
      }
    }
    if (ix.doc.pinned) { score += 0.8; reasons.push("pinned"); }

    // A query made only of filters ("after:2026-06-01", "tag:finance") has no
    // term to score. Those documents passed every filter, so they are hits with
    // a baseline score rather than silently missing results — and the score must
    // not be boosted by anything else, or a *filter* quietly becomes a ranking.
    if (!allTerms.length) {
      hits.push({ id: ix.doc.id, score: 1, reasons: ["matched the filters"], fields: [] });
      continue;
    }
    // A document that passed every filter but matched no term is not a hit.
    if (score <= 0) continue;
    // mild recency tiebreak: at most ±10 % of a comparable score, never dominant
    if (ix.doc.updatedAt) {
      const days = Math.max(0, (Date.now() - ix.doc.updatedAt) / 86_400_000);
      score *= 1 + 0.10 / (1 + days / 30);
    }
    hits.push({ id: ix.doc.id, score: Math.round(score * 1000) / 1000, reasons, fields: [...usedFields] });
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, "en"));
  return hits;
}

/** Highlight spans (byte offsets into the original text) for a matched term. */
export function highlightSpans(text: string, terms: readonly string[]): { start: number; end: number }[] {
  if (!terms.length) return [];
  const spans: { start: number; end: number }[] = [];
  const lower = text.toLowerCase();
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term.toLowerCase(), from);
      if (at === -1) break;
      spans.push({ start: at, end: at + term.length });
      from = at + Math.max(1, term.length);
      if (spans.length > 500) break;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  // merge overlapping spans so the renderer never emits nested <mark>
  const merged: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** A compact, human-readable explanation of the query, used in the empty state. */
export function describeQuery(q: ParsedQuery): string {
  const parts: string[] = [];
  if (q.phrases.length) parts.push(`${q.phrases.length} phrase${q.phrases.length > 1 ? "s" : ""}`);
  if (q.terms.length) parts.push(`${q.terms.length} term${q.terms.length > 1 ? "s" : ""}`);
  if (q.fields.length) parts.push(q.fields.map((f) => `${f.field}:${f.value}`).join(", "));
  if (q.negated.length) parts.push(`excluding ${q.negated.join(", ")}`);
  if (q.pinnedOnly) parts.push("pinned only");
  if (q.after) parts.push(`after ${new Date(q.after).toISOString().slice(0, 10)}`);
  if (q.before) parts.push(`before ${new Date(q.before).toISOString().slice(0, 10)}`);
  return parts.join(" · ") || "everything";
}
