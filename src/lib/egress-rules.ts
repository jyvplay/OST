/**
 * TT143 (SC-04) — egress rules for the app's own network traffic.
 *
 * What this can and cannot be, stated first because the difference is the whole
 * feature: a web page cannot filter another application's traffic, cannot change
 * the machine's DNS resolver, and cannot see a request made by a different
 * origin. What it CAN do is govern every request this app makes, because the
 * privacy layer already wraps `fetch` once for the whole shell (TT18).
 *
 * So the model is a **rule list with a stated default**, not a "firewall":
 *
 *   · default-allow, because the app's own inventory of destinations is large and
 *     changing (tiles, syndication, bridges) and a default-deny list would break
 *     a legitimate fetch the user did not know to allow — the classic
 *     filter-that-silently-eats-traffic failure;
 *   · explicit `deny` rules win over `allow` at equal specificity, and the most
 *     specific rule wins overall (host+path beats host beats `*`);
 *   · credentials in a URL are always refused, because a URL with a password
 *     lands in logs and in the history of every hop;
 *   · non-http(s) schemes are refused by the rule engine rather than passed to
 *     `fetch`, which would throw a less useful error.
 *
 * Matching is glob-based (no patterns compiled to regex), so a hostile rule
 * cannot make matching expensive. A rule list is bounded, and a rule that does
 * not parse is reported instead of being ignored: a filter that silently drops
 * half its rules is worse than one that refuses to load.
 */

export type EgressAction = "allow" | "deny";
export interface EgressRule { id: string; action: EgressAction; host: string; path?: string; note?: string }
export interface EgressPolicy { rules: EgressRule[]; defaultAction: EgressAction }
export interface EgressDecision {
  action: EgressAction;
  /** Which rule decided it, or `default` when nothing matched. */
  by: string;
  reason: string;
  host: string;
}

export const MAX_RULES = 200;
export const MAX_HOST_LENGTH = 253;

/** Host glob: `*` matches within one label, `**` matches across labels. Case-folded. */
function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, "");
  const h = host.toLowerCase().replace(/\.$/, "");
  if (p === "*" || p === "**") return true;
  const pp = p.split(".");
  const hh = h.split(".");
  // Recursive label match with `**` allowed to absorb any number of labels.
  const walk = (i: number, j: number): boolean => {
    if (i === pp.length && j === hh.length) return true;
    if (i === pp.length) return false;
    if (pp[i] === "**") {
      for (let k = j; k <= hh.length; k++) if (walk(i + 1, k)) return true;
      return false;
    }
    if (j === hh.length) return false;
    if (pp[i] === "*") return walk(i + 1, j + 1);
    return pp[i] === hh[j] && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/** Path glob: `*` matches within a segment, `**` matches across segments. */
function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  const walk = (i: number, j: number): boolean => {
    if (i === p.length && j === s.length) return true;
    if (i === p.length) return false;
    if (p[i] === "**") {
      for (let k = j; k <= s.length; k++) if (walk(i + 1, k)) return true;
      return false;
    }
    if (j === s.length) return false;
    if (p[i] === "*") return walk(i + 1, j + 1);
    return p[i] === s[j] && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/** Specificity: host labels + path segments, so `a.example.com/x/y` beats `**`. */
function specificity(rule: EgressRule): number {
  const labels = rule.host === "*" || rule.host === "**" ? 0 : rule.host.split(".").filter((l) => l !== "*" && l !== "**").length;
  const segs = rule.path ? rule.path.split("/").filter((l) => l !== "*" && l !== "**" && l !== "").length : 0;
  return labels * 10 + segs;
}

/**
 * Parse a rule list. Unparseable rules are returned in `rejected` with the reason;
 * they are never silently dropped and never partially applied.
 */
export function parsePolicy(input: unknown): { policy: EgressPolicy; rejected: string[] } {
  const rejected: string[] = [];
  const out: EgressRule[] = [];
  if (input === null || input === undefined) return { policy: { rules: [], defaultAction: "allow" }, rejected };
  const raw = Array.isArray(input) ? input : (input as { rules?: unknown }).rules;
  if (!Array.isArray(raw)) return { policy: { rules: [], defaultAction: "allow" }, rejected: ["the policy has no rule list"] };
  const defaultAction: EgressAction = (input as { defaultAction?: string })?.defaultAction === "deny" ? "deny" : "allow";
  for (const [i, r] of raw.entries()) {
    if (out.length >= MAX_RULES) { rejected.push(`rule ${i}: the list is capped at ${MAX_RULES} rules`); continue; }
    if (!r || typeof r !== "object") { rejected.push(`rule ${i}: not an object`); continue; }
    const rr = r as Record<string, unknown>;
    const action = rr.action === "deny" ? "deny" : rr.action === "allow" ? "allow" : null;
    if (!action) { rejected.push(`rule ${i}: action must be “allow” or “deny”`); continue; }
    const host = typeof rr.host === "string" ? rr.host.trim() : "";
    if (!host || host.length > MAX_HOST_LENGTH) { rejected.push(`rule ${i}: host must be 1–${MAX_HOST_LENGTH} characters`); continue; }
    if (/[^A-Za-z0-9.*\-_]/.test(host)) { rejected.push(`rule ${i}: host “${host}” has characters a host cannot contain`); continue; }
    const path = typeof rr.path === "string" && rr.path.trim() ? rr.path.trim() : undefined;
    if (path && !path.startsWith("/")) { rejected.push(`rule ${i}: a path must start with “/”`); continue; }
    out.push({ id: typeof rr.id === "string" && rr.id ? rr.id : `r${i}`, action, host, path, note: typeof rr.note === "string" ? rr.note.slice(0, 200) : undefined });
  }
  return { policy: { rules: out, defaultAction }, rejected };
}

/** Decide one request. The URL is parsed here, so a malformed URL is a decision, not a throw. */
export function decideEgress(policy: EgressPolicy, rawUrl: string): EgressDecision {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { action: "deny", by: "url", reason: "the address is not a URL", host: "" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { action: "deny", by: "scheme", reason: `“${u.protocol}” is not a fetch scheme (only http and https are)`, host: u.hostname };
  }
  if (u.username || u.password) {
    return { action: "deny", by: "credentials", reason: "the address contains a password; credentials in a URL are logged at every hop", host: u.hostname };
  }
  let best: { rule: EgressRule; score: number } | null = null;
  for (const rule of policy.rules) {
    if (!hostMatches(rule.host, u.hostname)) continue;
    if (rule.path && !pathMatches(rule.path, u.pathname)) continue;
    const score = specificity(rule);
    // At equal specificity a deny wins: the safe reading of a contradiction.
    if (!best || score > best.score || (score === best.score && rule.action === "deny" && best.rule.action === "allow")) best = { rule, score };
  }
  if (!best) {
    return {
      action: policy.defaultAction,
      by: "default",
      reason: policy.defaultAction === "deny" ? "no rule allows this address, and the default is deny" : "no rule mentions this address, and the default is allow",
      host: u.hostname,
    };
  }
  return {
    action: best.rule.action,
    by: best.rule.id,
    reason: best.rule.action === "deny" ? `rule ${best.rule.id} denies ${best.rule.host}${best.rule.path ?? ""}` : `rule ${best.rule.id} allows ${best.rule.host}${best.rule.path ?? ""}`,
    host: u.hostname,
  };
}

/** One line for a UI or a log; never includes the query string (it can carry a token). */
export function describeDecision(d: EgressDecision, method = "GET"): string {
  const verb = d.action === "deny" ? "blocked" : "allowed";
  return `${method} ${d.host || "(no host)"} ${verb} — ${d.reason}`;
}
