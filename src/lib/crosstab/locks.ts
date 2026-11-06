/**
 * TT136 (SH-06) — cooperative cross-tab locking.
 *
 * Shell windows run in their own web-worker/DOM contexts; concurrent edits to
 * the same document must be serialised, and a stale tab must never be able to
 * steal a lock that a live tab holds.
 *
 * Model: each writer claims a lease named by a hash of the owner's identity +
 * document id. BroadcastChannel carries claim/release/renewal; a lease expires
 * if the owner has not renewed within `ttlMs`, and the *claimant* has to present
 * its own liveness proof (a heartbeat id) before it may renew.
 *
 * Scope: in-process coordination only, no central server. Cross-device locking
 * is a different feature (Server) and is not claimed here.
 */

export type LockState = "acquired" | "held-stale" | "waiting" | "denied";

export interface Lease {
  owner: string;
  document: string;
  /** Hash-bound identity of the owner: a tab that restarts presents a new one. */
  identity: string;
  expiresAt: number;
  /** Monotonically increasing lease revision; stale renewals carry an old one. */
  revision: number;
}

export const TTL_MS = 15_000;
export const IDLE_TTL_MS = 60_000;

export function leaseFor(document: string, owner: string, identity: string, now: number, ttlMs = TTL_MS): Lease {
  if (typeof document !== "string" || document.length === 0 || document.length > 128 || document.includes("\u0000")) throw new Error("Document id must be 1…128 characters");
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 64) throw new Error("Owner id must be 1…64 characters");
  if (typeof identity !== "string" || !/^[a-z0-9]{8,64}$/.test(identity)) throw new Error("Identity must be 8…64 lowercase alphanumerics");
  if (!Number.isFinite(now) || now < 0) throw new Error("now must be a finite timestamp");
  return { owner, document, identity, expiresAt: now + ttlMs, revision: 0 };
}

export interface Adjudication { state: LockState; lease: Lease | null; reason: string }

/** Decide whether a claim succeeds; an expired lease may be stolen. */
export function adjudicate(lease: Lease | null, claim: Lease, now: number): Adjudication {
  if (!lease) return { state: "acquired", lease: claim, reason: "No holder" };
  if (lease.expiresAt <= now) return { state: "acquired", lease: claim, reason: "Previous lease expired" };
  if (lease.identity === claim.identity) return { state: "acquired", lease, reason: "Same tab already holds it" };
  return { state: "waiting", lease, reason: "Another tab holds the lock until " + new Date(lease.expiresAt).toISOString() };
}

/**
 * Claim a lease: the claimant must present its own identity; a lease held by a
 * *different* identity can be renewed only if the holder has missed its TTL.
 */
export function claim(lease: Lease | null, candidate: Lease, now: number): Adjudication {
  if (lease && lease.expiresAt > now && lease.identity !== candidate.identity) {
    return { state: "waiting", lease, reason: `Lease held by ${lease.owner} until ${lease.expiresAt}` };
  }
  const fresh = { ...candidate, expiresAt: now + TTL_MS, revision: (lease?.revision ?? 0) + 1 };
  return { state: "acquired", lease: fresh, reason: lease && lease.expiresAt <= now ? "Lease expired; claiming" : "Claiming free lock" };
}

/** Renewal: only the current holder may renew, and only while its lease is live. */
export function renew(lease: Lease | null, identity: string, now: number): Adjudication {
  if (!lease) return { state: "denied", lease: null, reason: "No lease to renew" };
  if (lease.identity !== identity) return { state: "denied", lease, reason: "Renewal by a non-holder" };
  if (lease.expiresAt <= now) return { state: "held-stale", lease, reason: "Lease expired; re-claim needed" };
  return { state: "acquired", lease: { ...lease, expiresAt: now + TTL_MS, revision: lease.revision + 1 }, reason: "Renewed" };
}

export interface Heartbeat { id: string; identity: string; at: number }

/** A heartbeat proves liveness for a lease renewal; missing heartbeats are the audit trail. */
export function checkHeartbeat(lease: Lease, hb: Heartbeat, now: number): { ok: boolean; reason: string } {
  if (!lease) return { ok: false, reason: "No lease" };
  if (lease.identity !== hb.identity) return { ok: false, reason: "Heartbeat from a different identity" };
  if (!Number.isFinite(hb.at) || hb.at < 0 || hb.at > now) return { ok: false, reason: "Heartbeat timestamp is unusable" };
  if (now - hb.at > IDLE_TTL_MS) return { ok: false, reason: "Heartbeat older than the idle limit" };
  return { ok: true, reason: "Heartbeat accepted" };
}

/** Audit shape: what the log shows for each writer. */
export interface LockAudit { lease: Lease | null; heartbeat: Heartbeat | null; state: LockState; since: number }

export function describeAudit(a: LockAudit): string {
  if (!a.lease) return "No lock in this window";
  return `${a.lease.owner} holds ${a.lease.document} (rev ${a.lease.revision}, ${a.state}, until ${new Date(a.lease.expiresAt).toISOString()})`;
}

/** Compact claim line, for a StatusBar. */
export function describeLease(lease: Lease): string {
  const live = lease.expiresAt > Date.now();
  return `${lease.document} · ${live ? "live" : "expired"} · ${new Date(lease.expiresAt).toISOString()}`;
}
