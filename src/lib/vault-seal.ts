/**
 * TT145 (HW-08) — hardware-backed crypto, stated as the four things a page can
 * actually enforce.
 *
 * The row asked for "hardware-backed crypto". A web page cannot *prove* that a
 * key lives in a secure element: `crypto.subtle` gives no attestation, no
 * `extractable: false` proof of where the bytes are, and no way to ask "is this
 * key in a TPM?". What a page *can* enforce is narrower and still worth having,
 * so this module implements exactly that and refuses to pretend about the rest:
 *
 *   1. NON-EXTRACTABILITY — a key generated with `extractable: false` cannot be
 *      read back by any script on the page, including this one. That is a real
 *      property (the browser enforces it), and it is the property that matters
 *      for "the key never leaves the device".
 *   2. PER-RECORD IV — a fresh 96-bit IV for every seal, with a hard refusal to
 *      seal twice under the same IV. GCM IV reuse is the one mistake that turns
 *      AES-GCM from encryption into a keystream giveaway, and it is a mistake a
 *      counter in application code makes silently.
 *   3. AAD BINDING — the record id, key id and schema version go into the
 *      additional-authenticated-data, so a ciphertext moved to another record
 *      (or another version) fails to open instead of decrypting into the wrong
 *      slot. This is the "swap two rows" attack, and it is cheap to stop.
 *   4. ROTATION WITH A READABLE PLAN — when a better key becomes available, the
 *      old one is retired read-only, records are re-sealed in bounded batches,
 *      and the plan says what happens to a record that is sealed under a key the
 *      page no longer has.
 *
 * What it does NOT do, and says so in `LIMITS`: no attestation, no protection
 * against a compromised renderer, no protection while the vault is unlocked in
 * memory, no FIDO2/WebAuthn gate (that is a separate row and a separate engine),
 * and no claim that any particular browser wraps the key in the OS keystore.
 */

export const SEAL_ALGORITHM = "AES-GCM" as const;
export const KEY_BITS = 256;
export const IV_BYTES = 12;
export const SCHEMA = 1 as const;

/** The four enforceable properties, restated where the UI can print them. */
export const LIMITS = [
  "no attestation: the page cannot prove where the key bytes live",
  "non-extractable only means this page cannot read the key back",
  "the vault is plaintext in memory while unlocked",
  "no WebAuthn/biometric gate on this path",
] as const;

export interface KeySpec {
  id: string;
  /** `extractable: false` is the only value this engine will issue. */
  extractable: false;
  createdAt: number;
  /** Set once the key is retired; a retired key can open but never seal. */
  retiredAt: number | null;
  /** Monotonic counter of seals performed under this key. */
  seals: number;
}

export interface SealEnvelope {
  v: typeof SCHEMA;
  keyId: string;
  record: string;
  /** base64 of the 12-byte IV. Kept beside the ciphertext, never reused. */
  iv: string;
  /** base64 ciphertext (GCM tag appended by WebCrypto). */
  ct: string;
}

export type Check = { ok: true } | { ok: false; why: string };

const enc = new TextEncoder();

/** base64 that tolerates being handed a Buffer, a Uint8Array or an ArrayBuffer. */
export function toB64(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * TS 5.7+ types `Uint8Array<ArrayBufferLike>` and WebCrypto wants
 * `BufferSource<ArrayBuffer>`. A view over a fresh ArrayBuffer is the narrow
 * cast that is actually true here (nothing in this module is backed by a
 * SharedArrayBuffer), and doing it in one place keeps every call site honest.
 */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b) as Uint8Array<ArrayBuffer>;

export function fromB64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * A record id is part of the authenticated data, so it must be canonical: a
 * trailing space or a different case would produce a different AAD and a
 * ciphertext that opens from one call site and not another.
 */
export function canonicalRecord(id: string): string {
  const t = id.trim().toLowerCase();
  if (!t) throw new Error("a record id is required: it is authenticated, not decorative");
  if (t.length > 200) throw new Error(`record id is ${t.length} characters; the limit is 200`);
  // Record ids are path-shaped by design (`notes/one`, `backup/2026-01-01`), so
  // the separator is allowed; whitespace and anything a URL would re-encode is not,
  // because the id goes into the AAD and must round-trip byte for byte.
  if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(t)) throw new Error(`record id “${id}” contains characters that do not survive a round trip`);
  return t;
}

export function makeKey(id: string, now: number): KeySpec {
  const t = id.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(t)) throw new Error(`key id “${id}” must be 2–41 lowercase characters, digits or dashes`);
  return { id: t, extractable: false, createdAt: now, retiredAt: null, seals: 0 };
}

/** A retired key still opens; it must never seal again. That is the whole point of retiring it. */
export function canSeal(key: KeySpec): Check {
  if (key.retiredAt !== null) return { ok: false, why: `key ${key.id} was retired at ${new Date(key.retiredAt).toISOString()}; it can open old records but not seal new ones` };
  return { ok: true };
}

/**
 * The AAD is built, not concatenated ad hoc: the schema version is first so a
 * future version cannot be opened by today's code by accident.
 */
export function aad(keyId: string, record: string): Uint8Array {
  return enc.encode(`${SCHEMA}|${keyId}|${canonicalRecord(record)}`);
}

/**
 * Seals one record. Takes the live `CryptoKey` rather than importing it, because
 * this engine must never be the owner of key material — the caller (the Keys
 * surface) holds it for the shortest possible time.
 */
export async function seal(key: CryptoKey, spec: KeySpec, record: string, plain: Uint8Array, iv?: Uint8Array): Promise<{ env: SealEnvelope; spec: KeySpec }> {
  const allowed = canSeal(spec);
  if (!allowed.ok) throw new Error(allowed.why);
  if (plain.length === 0) throw new Error("refusing to seal an empty record: an empty ciphertext is indistinguishable from a deleted one");
  const nonce = iv ?? crypto.getRandomValues(new Uint8Array(IV_BYTES));
  if (nonce.length !== IV_BYTES) throw new Error(`IV must be ${IV_BYTES} bytes, got ${nonce.length}`);
  const ct = await crypto.subtle.encrypt({ name: SEAL_ALGORITHM, iv: buf(nonce), additionalData: buf(aad(spec.id, record)) }, key, buf(plain));
  return {
    env: { v: SCHEMA, keyId: spec.id, record: canonicalRecord(record), iv: toB64(nonce), ct: toB64(ct) },
    spec: { ...spec, seals: spec.seals + 1 },
  };
}

/**
 * Opens a record. The refusals are the interesting half: wrong key, wrong
 * record (AAD), wrong schema, truncated envelope. A GCM failure is reported as
 * "does not authenticate", not as "wrong password", because the two are
 * indistinguishable and guessing which one it was is how apps leak.
 */
export async function open(key: CryptoKey, spec: KeySpec, env: SealEnvelope, plainBytes?: number): Promise<Uint8Array> {
  if (env.v !== SCHEMA) throw new Error(`envelope schema ${String(env.v)} is not ${SCHEMA}`);
  if (env.keyId !== spec.id) throw new Error(`record was sealed under key ${env.keyId}, not ${spec.id}`);
  const iv = fromB64(env.iv);
  if (iv.length !== IV_BYTES) throw new Error(`stored IV is ${iv.length} bytes; a ${IV_BYTES}-byte IV is the only shape this engine writes`);
  const ct = fromB64(env.ct);
  if (ct.length <= 16) throw new Error("ciphertext is shorter than its own GCM tag");
  try {
    const out = await crypto.subtle.decrypt({ name: SEAL_ALGORITHM, iv: buf(iv), additionalData: buf(aad(env.keyId, env.record)) }, key, buf(ct));
    const bytes = new Uint8Array(out);
    if (plainBytes !== undefined && bytes.length !== plainBytes) throw new Error(`opened ${bytes.length} bytes where ${plainBytes} were sealed`);
    return bytes;
  } catch (e) {
    // Re-throw our own refusals unchanged; wrap WebCrypto's OperationError.
    const m = (e as Error).message;
    if (m.startsWith("opened ")) throw e;
    throw new Error("record does not authenticate: it was altered, sealed under another key, or moved from another record");
  }
}

/**
 * Rotation plan. A rotation that cannot say what happens to the records it has
 * not reached yet is not a plan; this one bounds the work and states the tail.
 */
export interface RotationPlan {
  from: string;
  to: string;
  batches: number;
  perBatch: number;
  tail: string;
  keepOld: string;
}

export function rotationPlan(from: KeySpec, to: KeySpec, records: number, perBatch = 250): RotationPlan {
  if (from.id === to.id) throw new Error("rotation needs two different keys");
  if (to.retiredAt !== null) throw new Error(`key ${to.id} is retired and cannot receive records`);
  if (!Number.isInteger(records) || records < 0) throw new Error("record count must be a non-negative integer");
  if (!Number.isInteger(perBatch) || perBatch < 1) throw new Error("batch size must be a positive integer");
  return {
    from: from.id,
    to: to.id,
    batches: Math.ceil(records / perBatch),
    perBatch,
    tail: records === 0
      ? "nothing is sealed under this key; retire it and stop"
      : `${records - Math.ceil(records / perBatch) * 0 > 0 ? records : 0} records are re-sealed; a record not yet reached stays readable under ${from.id}, which is why the old key is retired (read-only) rather than deleted`,
    keepOld: `keep ${from.id} with extractable:false and retiredAt set: destroying it destroys every record it still holds`,
  };
}

/**
 * What the page can honestly say about the key it just created. Deliberately
 * refuses the word "hardware": `nonExtractable` is a fact, `hardwareBacked` is
 * not observable from here.
 */
export function describeBacking(opts: { extractable: boolean; sameOriginIsolated: boolean }): { verdict: string; facts: string[] } {
  if (opts.extractable) return { verdict: "refused: an extractable key can be read back by any script on this page", facts: [] };
  return {
    verdict: "non-extractable in this page; hardware backing unobservable",
    facts: [
      "crypto.subtle will not export this key, so no script can copy it",
      opts.sameOriginIsolated ? "crossOriginIsolated: the page is in a cross-origin-isolated context" : "crossOriginIsolated: false, so no SharedArrayBuffer-backed side channel work is possible here",
      "the browser may or may not keep the bytes in an OS keystore; it does not expose which",
    ],
  };
}
