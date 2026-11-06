/**
 * TT136 (CO-03) — routing decisions for the Shell and Browser.
 *
 * CO-03 is the honest reasoning layer: which outbound request is allowed, and
 * how to reach it if it is. Every rule is derived from the request itself and
 * from the declared bundle, never from a stored secret.
 *
 * Default-deny, and a *refusal* carries the reason it was refused, because a
 * silent drop is what makes a router look broken.
 */

export type DenyReason = "protocol" | "credentials" | "unsafe-redirect" | "not-in-manifest" | "size-limit" | "protocol-mismatch";

export interface Request {
  url: string;
  method: "GET" | "POST";
  /** Bytes that would be sent; GET requests must send none. */
  bodyBytes?: number;
}

export interface Manifest {
  /** A registered module that owns the request, e.g. "app.store" or "editor". */
  owner: string;
  allow: readonly string[];
  /** Reject redirects that leave the allowed set. */
  denyRedirects: boolean;
  /** Optional content-type whitelist, checked by the caller. */
  contentTypes?: readonly string[];
}

export type Verdict =
  | { ok: true; route: "direct" | "proxy"; target: string; reason: string }
  | { ok: false; reason: DenyReason; detail: string };

export const REDIRECT_MAX = 5;
export const BODY_LIMIT = 256 * 1024;

const PROXY_HOSTS = new Set(["fusion.io", "files.fusion.io", "proxy.fusion.io"]);

export function isTrustedProxy(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith(".fusion.io") || PROXY_HOSTS.has(u.hostname);
  } catch { return false; }
}

/** A URL the request would need to *proxy* rather than fetch directly. */
export function needsProxy(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.hostname.endsWith(".fusion.io") && !u.hostname.includes("localhost");
  } catch { return false; }
}

const unsafe = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`.replace(/\?$/, "");
  } catch { return ""; }
};

/**
 * Decide one request. `redirects` are previous hops, so a loop is refused rather
 * followed to a stack overflow.
 */
export function route(request: Request, manifest: Manifest, redirects: readonly string[] = []): Verdict {
  const { url, method, bodyBytes } = request;
  if (typeof url !== "string" || url.length === 0 || url.length > 4096) return { ok: false, reason: "protocol", detail: "URL is empty or too long" };
  if (redirects.length > REDIRECT_MAX) return { ok: false, reason: "unsafe-redirect", detail: "Redirect chain is too long" };
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  if (!u) return { ok: false, reason: "protocol", detail: "URL is malformed" };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "protocol", detail: `Protocol ${u.protocol.replace(":", "")} is not allowed` };
  if (u.username || u.password) return { ok: false, reason: "credentials", detail: "URLs with credentials are never allowed" };

  if (method === "GET" && bodyBytes !== undefined && bodyBytes > 0) return { ok: false, reason: "protocol", detail: "GET requests send no body" };
  if (method === "POST" && (bodyBytes === undefined || !Number.isSafeInteger(bodyBytes))) return { ok: false, reason: "protocol", detail: "POST requires a known byte count" };
  if (method === "POST" && bodyBytes! > BODY_LIMIT) return { ok: false, reason: "size-limit", detail: `Body exceeds ${BODY_LIMIT} bytes` };

  const allowed = manifest.allow.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === u.hostname) return true;
    if (pattern.startsWith(".") && u.hostname.endsWith(pattern)) return true;
    return false;
  });
  if (!allowed) return { ok: false, reason: "not-in-manifest", detail: `${u.hostname} is not allowed for ${manifest.owner}` };

  if (manifest.denyRedirects && redirects.includes(unsafe(url))) return { ok: false, reason: "unsafe-redirect", detail: "This URL appears earlier in the chain" };

  const route = needsProxy(url) ? "proxy" : "direct";
  return { ok: true, route, target: unsafe(url), reason: route === "proxy" ? `Proxied via a trusted proxy for ${manifest.owner}` : `Same-origin direct fetch for ${manifest.owner}` };
}

/** Build a request chain for a redirect hop; refuses when the hop leaves the allowed set. */
export function followRedirect(current: Verdict & { ok: true }, nextUrl: string, manifest: Manifest, redirects: readonly string[]): Verdict {
  if (!current.ok) return current;
  const next = new URL(nextUrl);
  if (!next) return { ok: false, reason: "protocol", detail: "Redirect target is malformed" };
  if (next.protocol !== "https:" && next.protocol !== "http:") return { ok: false, reason: "protocol", detail: "Redirect to a non-HTTP scheme" };
  if (next.hostname !== new URL(current.target).hostname && manifest.denyRedirects) return { ok: false, reason: "unsafe-redirect", detail: "Redirect leaves the allowed host set" };
  return route({ url: next.toString(), method: "GET" }, manifest, [...redirects, current.target]);
}

/** Manifest for the Shell's own same-origin calls. */
export const shellManifest: Manifest = { owner: "shell", allow: ["localhost", ".fusion.io", "*"], denyRedirects: true };

/** Manifest for a Store or Browser module download. */
export function moduleManifest(owner: string, allow: readonly string[]): Manifest {
  return { owner, allow: [...allow, "*.fusion.io", "*.github.io"], denyRedirects: true };
}

export function describeVerdict(v: Verdict): string {
  return v.ok ? `${v.route}: ${v.reason}` : `blocked (${v.reason}): ${v.detail}`;
}
