/**
 * TT140 (PR-07p, PR-07s) — Content filtering and page-media casting.
 *
 * PR-07p: a browser in a web app cannot filter inside a cross-origin frame. The
 * frame is opaque (same-origin policy), so no amount of DOM walking reaches it.
 * What CAN be done reliably, and is what this module implements:
 *
 *   1. Refuse to navigate to a listed host at all, before the request.
 *   2. Attach a CSP to OUR OWN documents so a subresource cannot load from a
 *      listed host even if the page asks.
 *   3. Say precisely which of the three happened, because "blocked" is three
 *      different things and only the first two are guarantees.
 *
 * Blocklists are matched on the HOST, never a substring of the URL: a rule for
 * `ads.example` must not block `notads.example` or a query string containing it,
 * which is the classic way content blockers break pages and let trackers through
 * at the same time.
 *
 * PR-07s: `HTMLMediaElement.remote` (Remote Playback API) only works for media
 * the page is allowed to control. A cross-origin <video> in an iframe cannot be
 * remoted by us — the element belongs to another document. So the module
 * classifies each media element and says per-tab whether casting is possible,
 * instead of offering a button that fails on press.
 */

// ══ PR-07p: content filtering ════════════════════════════════════════════

export interface FilterRule {
  /** Host to block, with an optional leading `.` for subdomains. */
  host: string;
  /** Optional path prefix; when set the rule only applies below it. */
  pathPrefix?: string;
  /** Human reason, shown in the UI so a user can audit the filter. */
  reason: string;
}

export interface FilterPolicy {
  rules: FilterRule[];
  /** When true, a rule for `example.com` also blocks `a.example.com`. */
  blockSubdomains: boolean;
  /** Hosts never blocked, checked first. Wins over every rule. */
  allow: string[];
}

export const DEFAULT_POLICY: FilterPolicy = {
  rules: [],
  blockSubdomains: true,
  allow: [],
};

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

/** Validate a rule at construction, not at match time. */
export function validateRule(rule: FilterRule): string[] {
  const problems: string[] = [];
  const host = normalizeHost(rule.host);
  if (!host) problems.push("A rule needs a host");
  // Reject anything that would silently never match or match everything.
  if (host === "*") problems.push("'*' is not a rule; use an allow entry or a policy flag");
  if (/[/:?#]/.test(host)) problems.push(`'${rule.host}' contains URL syntax; a rule is a host, and a path belongs in pathPrefix`);
  if (host && !/^[a-z0-9.-]+$/.test(host)) problems.push(`'${rule.host}' is not a valid hostname`);
  if (rule.pathPrefix !== undefined && !rule.pathPrefix.startsWith("/")) problems.push("pathPrefix must start with '/'");
  if (!rule.reason.trim()) problems.push("Every rule needs a reason a user can read");
  return problems;
}

export function createFilterPolicy(rules: FilterRule[], opts: Partial<Omit<FilterPolicy, "rules">> = {}): FilterPolicy {
  const problems = rules.flatMap((r) => validateRule(r));
  if (problems.length) throw new Error(`Invalid filter rule(s): ${problems.join("; ")}`);
  const p: FilterPolicy = { ...DEFAULT_POLICY, ...opts, rules: rules.map((r) => ({ ...r, host: normalizeHost(r.host) })) };
  p.allow = p.allow.map(normalizeHost).filter(Boolean);
  return p;
}

function hostMatches(host: string, ruleHost: string, blockSubdomains: boolean): boolean {
  if (host === ruleHost) return true;
  return blockSubdomains && host.endsWith(`.${ruleHost}`);
}

export type FilterVerdict =
  | { blocked: false; kind: "allowed" | "explicit-allow"; reason: string }
  | { blocked: true; kind: "rule" | "invalid"; reason: string; rule?: FilterRule };

/**
 * Decide whether to refuse a navigation.
 *
 * Order: a malformed URL is refused (never guessed at), then an explicit allow
 * wins, then the first matching rule. First-match is deliberate: the rules are
 * shown to the user in order, so the order they see is the order that applies.
 */
export function checkNavigation(policy: FilterPolicy, rawUrl: string): FilterVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { blocked: true, kind: "invalid", reason: `Not a parseable URL: ${rawUrl}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { blocked: true, kind: "invalid", reason: `Only http and https navigate in the browser module; '${url.protocol}' does not` };
  }
  const host = normalizeHost(url.hostname);
  if (policy.allow.some((a) => hostMatches(host, a, policy.blockSubdomains))) {
    return { blocked: false, kind: "explicit-allow", reason: `${host} is on the allow list` };
  }
  for (const rule of policy.rules) {
    if (!hostMatches(host, rule.host, policy.blockSubdomains)) continue;
    if (rule.pathPrefix && !url.pathname.startsWith(rule.pathPrefix)) continue;
    return { blocked: true, kind: "rule", reason: rule.reason, rule };
  }
  return { blocked: false, kind: "allowed", reason: "No rule matches" };
}

/**
 * The CSP a page of ours should carry so a listed host cannot be loaded as a
 * subresource. This is the half that IS enforceable: our own documents honour a
 * CSP we send, and a blocked subresource never leaves the device.
 *
 * `frame-src` is left out on purpose: a cross-origin frame we cannot inspect is
 * exactly the case this cannot fix, and pretending to block it with a directive
 * that a page could also satisfy would be theatre. Refusing the navigation in
 * `checkNavigation` is the real control.
 */
export function buildCsp(policy: FilterPolicy, opts: { selfOrigin: string }): string {
  const hosts = policy.rules.map((r) => r.host).filter(Boolean);
  const self = opts.selfOrigin.replace(/\/$/, "");
  if (!hosts.length) {
    return `default-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'`;
  }
  // A CSP cannot express "everything except these"; it expresses "only these".
  // So the emitted policy is opaque-origin style: no third-party host may be
  // contacted at all, which is stronger than a blocklist and is the behaviour
  // this module actually delivers for our own pages.
  return [
    `default-src 'self' ${self}`,
    `script-src 'self' ${self}`,
    `img-src 'self' data: blob: ${self}`,
    `style-src 'self' 'unsafe-inline' ${self}`,
    `connect-src 'self' ${self}`,
    `media-src 'self' blob: ${self}`,
    `frame-src 'self' ${self}`,
  ].join("; ");
}

/** What the UI may claim, per action. Nothing here exceeds what is enforced. */
export function filterCapabilityReport(): Array<{ action: string; enforced: boolean; detail: string }> {
  return [
    { action: "Refuse to navigate to a listed host", enforced: true, detail: "Checked before the frame is given a URL" },
    { action: "Stop our own pages loading a third-party subresource", enforced: true, detail: "CSP on our own documents" },
    { action: "Remove an element inside a cross-origin page", enforced: false, detail: "The frame is opaque to us; no DOM access exists" },
    { action: "Filter inside a cross-origin iframe", enforced: false, detail: "Not possible without the frame's cooperation" },
    { action: "Block a request a page makes from its own origin", enforced: false, detail: "Belongs to that page's CSP, not ours" },
  ];
}

// ══ PR-07s: casting page media ═══════════════════════════════════════════

export interface MediaElementInfo {
  /** Stable id for the element in our own DOM. */
  id: string;
  /** Where the media came from: our own origin, or someone else's. */
  origin: "self" | "cross-origin";
  kind: "video" | "audio";
  /** True when the element has a src/srcObject the page controls. */
  controllable: boolean;
  /** True when HTMLMediaElement.remote exists in this browser. */
  remoteApiPresent: boolean;
  /** True when the element is inside a document we can script. */
  inOurDocument: boolean;
  /** MIME type, if known. Used to warn about formats that cannot be remoted. */
  type?: string;
}

export type Castability =
  | { canCast: true; why: string; whatWouldWork?: string }
  | { canCast: false; why: string; whatWouldWork: string };

const REMOTEABLE_TYPES = ["video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "video/ogg"];

/**
 * Decide whether a media element can be sent to a remote receiver.
 *
 * The rule is narrow on purpose. `remote.prompt()` is a request to the browser,
 * and the browser answers for the element's own document. An element in a
 * cross-origin frame is not ours to remote, so the button must not appear.
 */
export function castabilityOf(m: MediaElementInfo): Castability {
  if (!m.inOurDocument) {
    return {
      canCast: false,
      why: "The media element belongs to another document (a cross-origin frame), so this page cannot call remote.prompt() on it",
      whatWouldWork: "Open that video in its own tab and use the browser's own cast control, or download it and play it here",
    };
  }
  if (!m.remoteApiPresent) {
    return {
      canCast: false,
      why: "This browser has no HTMLMediaElement.remote (Remote Playback API)",
      whatWouldWork: "Use the operating system's cast/mirror control, or the Presentation API path in Beam",
    };
  }
  if (m.origin === "cross-origin") {
    return {
      canCast: true,
      why: "The element is in our document but its media is cross-origin; the browser will refuse to remote it unless the source permits it (no CORS/`remote` restriction)",
      whatWouldWork: "Remote playback of a cross-origin source depends on the source's own policy",
    };
  }
  if (!m.controllable) {
    return {
      canCast: false,
      why: "The element has no src or srcObject this page controls",
      whatWouldWork: "Give the element a source first",
    };
  }
  if (m.type && !REMOTEABLE_TYPES.includes(m.type.toLowerCase())) {
    return {
      canCast: false,
      why: `The receiver is unlikely to decode ${m.type}`,
      whatWouldWork: "Convert to MP4 (H.264/AAC) or WebM, which every receiver in this build accepts",
    };
  }
  return { canCast: true, why: `Ready: ${m.kind} from this origin${m.type ? ` (${m.type})` : ""}` };
}

/** Per-tab summary for the cast panel. */
export function castSummary(elements: MediaElementInfo[]): {
  castable: number;
  blocked: Array<{ id: string; why: string }>;
  headline: string;
} {
  const blocked: Array<{ id: string; why: string }> = [];
  let castable = 0;
  for (const m of elements) {
    const v = castabilityOf(m);
    if (v.canCast) castable++;
    else blocked.push({ id: m.id, why: v.why });
  }
  const headline = elements.length === 0
    ? "No media on this page"
    : castable === 0
      ? `${elements.length} media element(s), none castable from here — see why per element`
      : `${castable} of ${elements.length} media element(s) can be sent to a receiver`;
  return { castable, blocked, headline };
}
