/**
 * TT139 (PR-07) — can this URL be shown inside a window?
 *
 * A web desktop that embeds a site has to answer that *before* creating the
 * window, and the answer is in two response headers the browser will not hand us
 * cross-origin: `X-Frame-Options` and CSP `frame-ancestors`. The shell fetches
 * them through its own proxy and this module reads them the way a browser does.
 *
 * The parsing rules that matter, and that a naive `includes("deny")` gets wrong:
 *   - header names are case-insensitive and may repeat; the *most restrictive*
 *     answer wins;
 *   - `X-Frame-Options: ALLOW-FROM` is obsolete and treated as deny by every
 *     current engine — matching that is the only honest behaviour;
 *   - CSP `frame-ancestors` overrides `X-Frame-Options` when both appear;
 *   - host sources may carry scheme, wildcard subdomain and port; `'self'` is an
 *     origin match, and a missing policy means "allowed" (the browser default),
 *     not "blocked" — but the caller is told the answer is a default.
 *
 * Limits: this is an *advisory* check. A site can vary the header by request
 * (cookies, UA, geo), so the report always says how it was obtained and the UI
 * keeps a handoff button for the case where the frame still refuses to load.
 */

export type EmbedVerdict = "allow" | "deny" | "unknown";

export interface HeaderLike { name: string; value: string }

export interface EmbedDecision {
  verdict: EmbedVerdict;
  /** one short line, safe to show next to a disabled button */
  reason: string;
  /** which header produced the decision */
  source: "x-frame-options" | "csp-frame-ancestors" | "none";
  /** true when the answer came from a default rather than a stated policy */
  inferred: boolean;
  /** headers that repeated with different values — worth surfacing in a debug panel */
  conflicts: string[];
}

function normalise(headers: readonly HeaderLike[] | Record<string, string | string[]>): HeaderLike[] {
  // Array form is what `response.headers` iteration gives you; names arrive in
  // their original case, so they must be normalised here as well as in the object
  // form. Forgetting this made `X-Frame-Options: SAMEORIGIN` invisible.
  if (Array.isArray(headers)) return (headers as HeaderLike[]).map((h) => ({ name: String(h.name).toLowerCase(), value: String(h.value) }));
  const out: HeaderLike[] = [];
  for (const [name, value] of Object.entries(headers as Record<string, string | string[]>)) {
    for (const v of Array.isArray(value) ? value : [value]) out.push({ name: name.toLowerCase(), value: String(v) });
  }
  return out;
}

export function originOf(url: string): { scheme: string; host: string; port: string; origin: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { scheme: u.protocol.slice(0, -1), host: u.hostname.toLowerCase(), port: u.port || (u.protocol === "https:" ? "443" : "80"), origin: u.origin };
  } catch { return null; }
}

function hostMatchesSource(source: string, target: { scheme: string; host: string; port: string }): boolean {
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?$/i.exec(source.trim());
  if (!m) return false;
  const [, scheme, wildcard, host, port] = m;
  if (scheme) {
    const s = scheme.toLowerCase();
    // http source does not allow an https target in CSP (and vice versa).
    if (s !== target.scheme) return false;
  }
  const wantHost = host.toLowerCase();
  const hostOk = wildcard ? target.host === wantHost || target.host.endsWith(`.${wantHost}`) : target.host === wantHost;
  if (!hostOk) return false;
  if (port && port !== "*" && port !== target.port) return false;
  return true;
}

/**
 * Evaluate the headers for a page that wants to be framed by `selfOrigin`.
 * `selfOrigin` is the shell's own origin — the one that would be the parent.
 */
export function decideEmbed(headers: readonly HeaderLike[] | Record<string, string | string[]>, pageUrl: string, selfOrigin: string): EmbedDecision {
  const list = normalise(headers);
  const conflicts: string[] = [];
  const xfo = list.filter((h) => h.name === "x-frame-options").map((h) => h.value.trim().toLowerCase());
  const cspRows = list.filter((h) => h.name === "content-security-policy").map((h) => h.value);
  const frameAncestors: string[] = [];
  for (const raw of cspRows) {
    for (const directive of raw.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name && name.toLowerCase() === "frame-ancestors") frameAncestors.push(...sources.filter(Boolean));
    }
  }
  if (new Set(xfo).size > 1) conflicts.push(`X-Frame-Options repeats with ${[...new Set(xfo)].join(" and ")}`);

  const target = originOf(pageUrl);
  const self = originOf(selfOrigin);

  // CSP wins when present.
  if (frameAncestors.length) {
    const selfHost = self ? self.origin : selfOrigin;
    if (frameAncestors.includes("'none'")) return { verdict: "deny", reason: "the page forbids every frame (frame-ancestors 'none')", source: "csp-frame-ancestors", inferred: false, conflicts };
    if (!self || !target) return { verdict: "deny", reason: "frame-ancestors is set and the parent origin could not be read", source: "csp-frame-ancestors", inferred: false, conflicts };
    const allowed = frameAncestors.some((src) => {
      const s = src.toLowerCase();
      if (s === "'self'") return self.origin === target.origin;
      if (s === "*") return true;
      if (s === "'none'") return false;
      if (s.startsWith("'")) return false; // 'unsafe-inline' & co. are not valid here
      return hostMatchesSource(s, { scheme: self.scheme, host: self.host, port: self.port });
    });
    void selfHost;
    return allowed
      ? { verdict: "allow", reason: "the page names this origin in frame-ancestors", source: "csp-frame-ancestors", inferred: false, conflicts }
      : { verdict: "deny", reason: "frame-ancestors does not include this origin", source: "csp-frame-ancestors", inferred: false, conflicts };
  }

  if (xfo.length) {
    // Most restrictive wins across repeats.
    if (xfo.some((v) => v === "deny")) return { verdict: "deny", reason: "the page sends X-Frame-Options: DENY", source: "x-frame-options", inferred: false, conflicts };
    if (xfo.some((v) => v === "sameorigin")) {
      const same = Boolean(self && target && self.origin === target.origin);
      return same
        ? { verdict: "allow", reason: "X-Frame-Options: SAMEORIGIN and this is the same origin", source: "x-frame-options", inferred: false, conflicts }
        : { verdict: "deny", reason: "X-Frame-Options: SAMEORIGIN, and this shell is a different origin", source: "x-frame-options", inferred: false, conflicts };
    }
    if (xfo.some((v) => v.startsWith("allow-from"))) {
      return { verdict: "deny", reason: "ALLOW-FROM is obsolete; current browsers ignore it and block the frame", source: "x-frame-options", inferred: false, conflicts };
    }
    return { verdict: "deny", reason: `unrecognised X-Frame-Options value "${xfo[0]}" is treated as DENY`, source: "x-frame-options", inferred: false, conflicts };
  }
  return { verdict: "unknown", reason: "no framing policy was returned — the frame is allowed by default, which is not a promise", source: "none", inferred: true, conflicts };
}

/** A one-line, non-technical label for the window's chrome. */
export function embedLabel(d: EmbedDecision): string {
  switch (d.verdict) {
    case "allow": return "Embeds here";
    case "deny": return "Opens in a tab";
    default: return "Tries to embed";
  }
}
