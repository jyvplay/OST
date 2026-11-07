/**
 * TT145 (PR-07p) — content filtering that is honest about what a client-side
 * filter can and cannot do.
 *
 * Three things are true at once, and a filter that ignores any of them is a
 * false comfort:
 *
 *   · **A filter you can bypass is a preference, not a control.** Anyone who can
 *     open dev tools, change settings, or install an extension is past it. So the
 *     UI labels enforcement as "cooperative": it stops the browse path this app
 *     drives, and it is not a parental control.
 *   · **Blocking by URL string is not blocking by content.** A host deny list
 *     cannot see inside an already-embedded iframe (cross-origin), cannot filter a
 *     video's frames, and cannot intercept the browser's own requests. This engine
 *     states that per rule, and the *only* rules it applies are the ones on the
 *     path the app itself fetches or embeds.
 *   · **Over-blocking is the common failure, not under-blocking.** A naive rule
 *     `example` must not block `notexample.com`, and a path rule must not make a
 *     host rule stop working. Both are tested.
 *
 * The matcher is deliberately the same *shape* as the egress engine's host/path
 * lattice (TT143, SC-04) but with different semantics — this is a block/allow
 * decision for the reader, not a fetch policy — so it is a separate module, not a
 * reuse, and the tests differ.
 */

export const MAX_RULES = 400;
export const MAX_PATTERN = 200;

export type Effect = "block" | "allow";
export type Scope = "host" | "path" | "query";

export interface Rule {
  id: string;
  effect: Effect;
  scope: Scope;
  /** For host scope: a bare host, `*.suffix` or `**.suffix`. For path/query: a substring or `*`-glob. */
  pattern: string;
  /** Human-facing category, shown on the block page. */
  category: string;
  /** Whether this rule is enforced on embeds the app creates, or only on top-level navigations. */
  appliesToEmbeds: boolean;
}

export type ParseResult = { ok: true; rules: Rule[]; rejected: { line: number; why: string }[] } | { ok: false; why: string };

const DOMAIN = /^(\*{0,2}\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A tiny declarative format, because a text box a person can read is the only
 * filter syntax that survives contact with a support request:
 *
 *   block host ads.example.com        category=ads  embeds
 *   allow host *.cdn.example.com
 *   block path /watch?autoplay=1
 *   block query utm_source            category=tracking
 */
export function parseRules(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const rules: Rule[] = [];
  const rejected: { line: number; why: string }[] = [];
  if (text.length > 200_000) return { ok: false, why: `rule text is ${text.length} characters; the limit is 200000` };
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts.length < 3) { rejected.push({ line: i + 1, why: "expected: <block|allow> <host|path|query> <pattern> [category=…] [embeds]" }); return; }
    const [effect, scope, pattern, ...rest] = parts;
    if (effect !== "block" && effect !== "allow") { rejected.push({ line: i + 1, why: `effect “${effect}” is neither block nor allow` }); return; }
    if (scope !== "host" && scope !== "path" && scope !== "query") { rejected.push({ line: i + 1, why: `scope “${scope}” is neither host, path nor query` }); return; }
    if (pattern.length > MAX_PATTERN) { rejected.push({ line: i + 1, why: `pattern is ${pattern.length} characters; the limit is ${MAX_PATTERN}` }); return; }
    if (scope === "host") {
      const p = pattern.toLowerCase();
      if (!DOMAIN.test(p)) { rejected.push({ line: i + 1, why: `“${pattern}” is not a host, *.suffix or **.suffix` }); return; }
    } else if (!/^[a-z0-9/._~%?=&*+-]+$/i.test(pattern)) {
      rejected.push({ line: i + 1, why: `“${pattern}” contains characters a URL path never has` }); return;
    }
    const category = rest.find((r) => r.startsWith("category="))?.slice(9) || "uncategorised";
    rules.push({ id: `r${i + 1}`, effect, scope, pattern, category, appliesToEmbeds: rest.includes("embeds") });
  });
  if (rules.length > MAX_RULES) return { ok: false, why: `${rules.length} rules exceed the ${MAX_RULES} limit` };
  return { ok: true, rules, rejected };
}

/** `*.a.com` matches exactly one label; `**.a.com` matches one or more. */
function hostMatch(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("**.")) { const s = pattern.slice(3); return host === s || host.endsWith(`.${s}`); }
  if (pattern.startsWith("*.")) { const s = pattern.slice(2); return host !== s && host.endsWith(`.${s}`) && host.slice(0, -s.length - 1).indexOf(".") === -1; }
  return false;
}

const globMatch = (pattern: string, value: string): boolean => {
  if (!pattern.includes("*")) return value.includes(pattern);
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(value);
};

/**
 * Specificity, as a tuple encoded in one number so the comparator stays trivial:
 * scope first (a path rule beats a host rule because it says more about this
 * request), then whether the pattern is a wildcard (an exact host beats `*.host`
 * *regardless of length* — the first draft compared pattern length, so
 * `*.tracker.example` outranked `cdn.tracker.example` and an allow could never win),
 * then the literal length as a tie-break.
 */
export function specificity(rule: Rule): number {
  const scope = rule.scope === "path" ? 2_000_000 : rule.scope === "query" ? 1_000_000 : 0;
  const exact = rule.pattern.includes("*") ? 0 : 100_000;
  return scope + exact + Math.min(99_999, rule.pattern.length);
}

export interface Decision {
  effect: Effect;
  /** null when no rule matched, which means allowed (a filter blocks; it does not allow-list). */
  rule: Rule | null;
  why: string;
  /** True when a host rule matched but its subresource clause did not apply. */
  skippedForEmbeds: boolean;
}

/**
 * Decides one URL. Precedence: an `allow` beats a `block` at equal specificity,
 * and specificity is (scope, pattern length). A block with no category is still a
 * block; the category only changes the sentence.
 */
export function decide(rules: Rule[], url: string, opts: { kind: "navigate" | "embed"; }): Decision {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { effect: "allow", rule: null, why: "not an absolute URL; nothing to match", skippedForEmbeds: false }; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { effect: "allow", rule: null, why: `scheme ${parsed.protocol} is not fetched by the reader`, skippedForEmbeds: false };
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const path = parsed.pathname + parsed.search;
  const candidates: { rule: Rule; weight: number }[] = [];
  let skippedForEmbeds = false;
  for (const rule of rules) {
    if (opts.kind === "embed" && !rule.appliesToEmbeds) { if (rule.scope === "host" && hostMatch(rule.pattern, host)) skippedForEmbeds = true; continue; }
    const hit = rule.scope === "host" ? hostMatch(rule.pattern, host) : rule.scope === "path" ? globMatch(rule.pattern, path) : globMatch(rule.pattern, parsed.search);
    if (hit) candidates.push({ rule, weight: specificity(rule) });
  }
  if (!candidates.length) return { effect: "allow", rule: null, why: "no rule matched", skippedForEmbeds };
  candidates.sort((a, b) => b.weight - a.weight || (a.rule.effect === "allow" ? -1 : 1));
  const top = candidates[0];
  const allowAtSame = candidates.find((c) => c.rule.effect === "allow" && c.weight === top.weight);
  const winner = allowAtSame ? allowAtSame : top;
  return {
    effect: winner.rule.effect,
    rule: winner.rule,
    why: winner.rule.effect === "block"
      ? `${winner.rule.category} rule ${winner.rule.id} blocks ${winner.rule.scope} “${winner.rule.pattern}”`
      : `allow rule ${winner.rule.id} beats the block at the same specificity`,
    skippedForEmbeds,
  };
}

/**
 * What the filter cannot do, in the words the settings pane shows. This list is
 * part of the feature: a filter that hides its own boundary is the negative-space
 * shape "a deny list is a firewall".
 */
export const LIMITS = [
  "it filters the addresses this app fetches and embeds, not the browser's own requests",
  "it cannot see inside a cross-origin iframe that is already loading",
  "it cannot inspect media frames, so it blocks by address, not by content",
  "it is cooperative: dev tools or an extension bypass it, and it is not parental controls",
  "it does not filter search results from a remote engine; it filters what is opened",
] as const;

/** One-line report for the settings pane. */
export function report(parsed: { rules: Rule[]; rejected: { line: number; why: string }[] }): string {
  const blocks = parsed.rules.filter((r) => r.effect === "block").length;
  const allows = parsed.rules.length - blocks;
  const cats = new Set(parsed.rules.map((r) => r.category)).size;
  return `${blocks} block · ${allows} allow · ${cats} categories${parsed.rejected.length ? ` · ${parsed.rejected.length} rejected` : ""}`;
}
