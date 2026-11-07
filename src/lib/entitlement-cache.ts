/**
 * TT145 (BL-02) — the entitlement cache a client can honestly run.
 *
 * The row is "offline-tolerant entitlement cache with grace period". The honest
 * version of that sentence needs three things a demo usually skips:
 *
 *   1. **A signature you can check without a server.** An entitlement blob that
 *      is only "valid if the server says so" is not offline-tolerant; it is a
 *      cache of a fetch. So a grant is checked against an Ed25519 public key
 *      held by the client, and the check is done with WebCrypto — no network.
 *   2. **A clock you do not trust.** The device clock can be moved backwards to
 *      extend a grace period forever. This engine keeps a monotonic high-water
 *      mark of every time it has ever seen and refuses a grant whose `issuedAt`
 *      is older than that high-water minus a small slack. A rolled-back clock
 *      therefore cannot resurrect an expired grant.
 *   3. **An explicit product/tier shape.** "Pro" is not a boolean: a grant names
 *      the product, the seats, the features and an expiry, and the engine
 *      answers one question — *may this feature be used right now, and if not,
 *      why*. The "why" is the deliverable; a bare false is what makes an app
 *      feel broken offline.
 *
 * What this is NOT: it is not a store, it cannot issue anything, and it cannot
 * stop a user who edits the client. It is an honest cache with a stated
 * threat model — a user who patches the client has a patched client, and no
 * client-side scheme changes that. The signature protects against *another
 * party* minting grants and against a *tampered storage blob*, which is what a
 * cache actually needs.
 */

export const GRANT_VERSION = 1 as const;
export const MAX_GRANT_BYTES = 4096;
export const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated clock rollback before a grant is treated as replayed. */
export const CLOCK_SLACK_MS = 10 * 60 * 1000;
/** Re-check at least this often even while a grant is valid. */
export const RECHECK_MS = 6 * 60 * 60 * 1000;

export type Verdict = "granted" | "grace" | "expired" | "unknown-product" | "clock-rollback" | "bad-signature" | "absent" | "corrupt";

export interface Grant {
  v: typeof GRANT_VERSION;
  /** Product id, lower-case, stable. */
  product: string;
  /** Feature ids this product turns on. */
  features: string[];
  seats: number;
  issuedAt: number;
  expiresAt: number;
  /** Opaque purchase reference, shown to the user, never used for logic. */
  reference: string;
}

export interface CacheEntry {
  grant: Grant;
  /** base64 Ed25519 signature over `signedBytes(grant)`. */
  signature: string;
  /** When the client last confirmed it with a server, or null if it never has. */
  confirmedAt: number | null;
}

export interface Decision {
  verdict: Verdict;
  /** True only for "granted" and "grace". */
  allowed: boolean;
  feature: string;
  /** Always a sentence: the UI shows this and nothing else. */
  why: string;
  /** ms until hard expiry, negative once past it; null when there is no grant. */
  msLeft: number | null;
}

const enc = new TextEncoder();

/**
 * The exact bytes that are signed. Sorted keys and a fixed field order, so a
 * re-serialisation in another language cannot produce a different signature for
 * the same grant.
 */
export function signedBytes(g: Grant): Uint8Array {
  const canonical = [g.v, g.product, [...g.features].sort().join(","), g.seats, g.issuedAt, g.expiresAt, g.reference].join("\n");
  return enc.encode(canonical);
}

/** Structural validation, before any crypto: a malformed blob must never reach the verifier. */
export function parseGrant(raw: unknown): { ok: true; grant: Grant } | { ok: false; why: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, why: "not an object" };
  const g = raw as Record<string, unknown>;
  if (g.v !== GRANT_VERSION) return { ok: false, why: `version ${String(g.v)} is not ${GRANT_VERSION}` };
  if (typeof g.product !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(g.product)) return { ok: false, why: "product id is missing or malformed" };
  if (!Array.isArray(g.features) || g.features.some((f) => typeof f !== "string" || !/^[a-z0-9][a-z0-9.:-]*$/.test(f))) return { ok: false, why: "features must be an array of stable ids" };
  if (g.features.length > 200) return { ok: false, why: "more than 200 features" };
  if (!Number.isInteger(g.seats) || (g.seats as number) < 1 || (g.seats as number) > 10_000) return { ok: false, why: "seats must be an integer 1–10000" };
  for (const k of ["issuedAt", "expiresAt"] as const) {
    if (!Number.isFinite(g[k]) || !Number.isInteger(g[k])) return { ok: false, why: `${k} must be an integer epoch ms` };
  }
  if ((g.expiresAt as number) <= (g.issuedAt as number)) return { ok: false, why: "expiresAt must be after issuedAt" };
  if (typeof g.reference !== "string" || g.reference.length > 120) return { ok: false, why: "reference must be a short string" };
  const grant = g as unknown as Grant;
  if (enc.encode(JSON.stringify(grant)).length > MAX_GRANT_BYTES) return { ok: false, why: `grant exceeds ${MAX_GRANT_BYTES} bytes` };
  return { ok: true, grant };
}

/**
 * The decision. The order of the checks is the design:
 *   corrupt → absent → signature → clock → expiry → product → feature.
 *
 * Signature before clock, because an unsigned clock claim is not evidence.
 * Expiry before feature, because an expired Pro grant is not a partial grant.
 */
export function decide(
  entry: CacheEntry | null,
  feature: string,
  now: number,
  opts: { highWater: number; graceMs?: number; signatureValid: boolean; knownProducts: readonly string[] },
): Decision {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  if (!entry) return { verdict: "absent", allowed: false, feature, why: `no entitlement is cached for ${feature}; connect once to enable it offline`, msLeft: null };
  const parsed = parseGrant(entry.grant);
  if (!parsed.ok) return { verdict: "corrupt", allowed: false, feature, why: `the cached entitlement is unreadable (${parsed.why}); it will be replaced on the next connection`, msLeft: null };
  if (!opts.signatureValid) return { verdict: "bad-signature", allowed: false, feature, why: "the cached entitlement does not match its signature; it was edited or truncated in storage", msLeft: null };
  if (now + CLOCK_SLACK_MS < opts.highWater) {
    return { verdict: "clock-rollback", allowed: false, feature, why: `this device's clock is ${Math.round((opts.highWater - now) / 60000)} min behind the last time it saw; an expired entitlement cannot be revived by moving the clock`, msLeft: null };
  }
  const g = parsed.grant;
  const msLeft = g.expiresAt - now;
  if (msLeft <= -graceMs) return { verdict: "expired", allowed: false, feature, why: `the entitlement expired ${Math.round(-msLeft / 86400000)} days ago and the ${Math.round(graceMs / 86400000)}-day offline grace is over`, msLeft };
  if (!opts.knownProducts.includes(g.product)) return { verdict: "unknown-product", allowed: false, feature, why: `product “${g.product}” is not one this build knows; refusing rather than guessing its features`, msLeft };
  if (!g.features.includes(feature)) return { verdict: "granted", allowed: false, feature, why: `${g.product} does not include ${feature}`, msLeft };
  if (msLeft > 0) return { verdict: "granted", allowed: true, feature, why: `${g.product} covers ${feature} for another ${Math.max(1, Math.round(msLeft / 86400000))} days`, msLeft };
  return {
    verdict: "grace",
    allowed: true,
    feature,
    why: `expired ${Math.max(1, Math.round(-msLeft / 86400000))} days ago; still allowed inside the ${Math.round(graceMs / 86400000)}-day offline grace — reconnect to renew`,
    msLeft,
  };
}

/**
 * Clock high-water mark. Called whenever the app learns the real time from any
 * source (a server Date header, a signed grant's issuedAt, a successful sync).
 * The mark only ever moves forward.
 */
export function raiseHighWater(prev: number, now: number): number {
  return now > prev ? now : prev;
}

/**
 * Merge what a server said into the cache. A server answer that is OLDER than
 * what is cached is refused rather than written: a stale replica must not
 * shorten a user's entitlement, which is the classic offline-cache bug.
 */
export function mergeRefresh(entry: CacheEntry | null, incoming: CacheEntry, now: number): { entry: CacheEntry; note: string } {
  if (!entry) return { entry: { ...incoming, confirmedAt: now }, note: "stored the first entitlement for this device" };
  const a = parseGrant(entry.grant), b = parseGrant(incoming.grant);
  if (!b.ok) return { entry, note: `refused a malformed refresh (${b.why}); the cached entitlement is unchanged` };
  if (!a.ok) return { entry: { ...incoming, confirmedAt: now }, note: "replaced an unreadable cache entry" };
  if (b.grant.issuedAt < a.grant.issuedAt) return { entry, note: `refused an older grant (issued ${a.grant.issuedAt - b.grant.issuedAt} ms earlier); a stale replica must not shorten an entitlement` };
  return { entry: { ...incoming, confirmedAt: now }, note: `replaced the cached grant with one issued ${b.grant.issuedAt - a.grant.issuedAt} ms later` };
}

/** Whether the cache is due a refresh even though it still works. */
export function dueForRefresh(entry: CacheEntry | null, now: number): boolean {
  if (!entry) return true;
  const confirmed = entry.confirmedAt;
  return confirmed === null || now - confirmed >= RECHECK_MS;
}

/**
 * The threat model, printed in the UI. A cache that hides this is marketing.
 */
export const THREAT_MODEL = [
  "a tampered storage blob fails the signature check",
  "another party cannot mint grants without the private key",
  "a rolled-back device clock cannot revive an expired grant",
  "a user who edits the client has an edited client; no client-side scheme prevents that",
  "the public key ships with the app; rotating it requires a release",
] as const;
