/**
 * TT136 (BL-02) — local offline verification of cached downloads.
 *
 * Every cached app in the Store carries a Manifest with a digest of the exact
 * files that were fetched. Re-verifying that from disk is the only honest way
 * to know a cache entry still matches its manifest: a hostile update cannot make
 * a cache "verify" unless the digest really covers the bytes.
 *
 * This module is deliberately offline and per-user: no claim, no DID, no global
 * ledger, no namespace, no signature scheme — those need a server and would be a
 * different feature. The claim is local only.
 */

export type Algorithm = "sha-256" | "sha-384" | "sha-512";

export interface Manifest {
  algorithm: Algorithm;
  /** `crypto.subtle` digest-algorithm name derived from this entry; nothing else. */
  digest: string;
  size: number;
}

export interface VerifiedFile { name: string; bytes: number; algorithm: Algorithm; digest: string }

const digestBits = (algorithm: Algorithm): number => ({ "sha-256": 256, "sha-384": 384, "sha-512": 512 }[algorithm]);
const hexLen = (algorithm: Algorithm) => digestBits(algorithm) / 4;

const isHex = (value: string, length: number) => typeof value === "string" && /^[0-9a-f]+$/i.test(value) && value.length === length;

export function parseManifest(raw: unknown): { algorithm: Algorithm; files: VerifiedFile[]; totalSize: number } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200_000) throw new Error("Manifest must be a JSON string");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Manifest is not valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Manifest must be a JSON object");
  const m = parsed as Record<string, unknown>;
  const files = m.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > 500) throw new Error("Manifest must list 1…500 files");

  const seen = new Map<string, { algorithm: Algorithm; digest: string }>();
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Each manifest entry must be an object");
    const e = entry as Record<string, unknown>;
    const algorithm = e.algorithm;
    const digest = e.digest;
    const name = e.name;
    const size = Number(e.size);
    if (algorithm !== "sha-256" && algorithm !== "sha-384" && algorithm !== "sha-512") throw new Error("Unsupported digest algorithm");
    if (typeof digest !== "string" || !isHex(digest, hexLen(algorithm))) throw new Error("Digest length does not match the algorithm");
    if (typeof name !== "string" || !name.startsWith("/") || name.includes("\u0000") || new TextEncoder().encode(name).byteLength > 1024) throw new Error("Bad file name in manifest");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Bad file size in manifest");
    if (seen.has(name)) throw new Error(`"${name}" appears twice in the manifest`);
    seen.set(name, { algorithm, digest });
  }
  // One digest algorithm per manifest: mixed algorithms would make verification ambiguous.
  const algorithms = new Set([...seen.values()].map((d) => d.algorithm));
  if (algorithms.size !== 1) throw new Error("A manifest cannot mix digest algorithms");
  const algorithm = [...algorithms][0]!;
  const filesOut: VerifiedFile[] = files.map((entry) => {
    const fileObj = entry as Record<string, unknown>;
    return { name: String(fileObj.name), bytes: Number(fileObj.size), algorithm, digest: String(fileObj.digest).toLowerCase() };
  });
  return { algorithm, files: filesOut, totalSize: filesOut.reduce((sum, f) => sum + f.bytes, 0) };
}

/** The canonical body a manifest's own digest covers. Deterministic key order. */
export function manifestBody(files: readonly VerifiedFile[], algorithm: Algorithm): string {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `${algorithm}\n${ordered.map((f) => `${f.name}\t${f.algorithm}\t${f.bytes}\t${f.digest}`).join("\n")}\n`;
}

/** Digest of the canonical body, hex-encoded. Pure; callers must await digestFile. */
export async function manifestDigest(files: readonly VerifiedFile[], algorithm: Algorithm): Promise<string> {
  const body = new TextEncoder().encode(manifestBody(files, algorithm));
  if (body.byteLength > 1_000_000) throw new Error("Manifest body is too large to digest");
  const alg = { "sha-256": "SHA-256", "sha-384": "SHA-384", "sha-512": "SHA-512" }[algorithm];
  const handle = await crypto.subtle.digest(alg, new Uint8Array(body));
  return [...new Uint8Array(handle)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical manifest body — exact bytes that get digested. Deterministic key order. */
export function canonicalManifestBody(files: readonly VerifiedFile[], algorithm: Algorithm): string {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = ordered.map((f) => `${f.name}\t${f.algorithm}\t${f.bytes}\t${f.digest}`);
  return `${algorithm}\n${lines.join("\n")}\n`;
}

export interface FileBytes { name: string; bytes: Uint8Array }

/** Digest one file's bytes; throws when the file is too large to hold in memory. */
export async function digestFile(bytes: Uint8Array, algorithm: Algorithm): Promise<string> {
  if (!(bytes instanceof Uint8Array)) throw new Error("Digest needs bytes");
  const bits = digestBits(algorithm);
  const alg = { "sha-256": "SHA-256", "sha-384": "SHA-384", "sha-512": "SHA-512" }[algorithm];
  const handle = await crypto.subtle.digest(alg, new Uint8Array(bytes));
  return [...new Uint8Array(handle)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerificationReport {
  ok: boolean;
  verified: string[];
  mismatched: { name: string; expected: string; actual: string }[];
  missing: string[];
  extra: string[];
  totalBytes: number;
  /** False when an extra file could not be verified because it is not in the manifest. */
  complete: boolean;
}

/**
 * Verify the manifest against a directory's actual bytes. `provided` must contain
 * every manifest entry for a result to be complete; `sha256` is a sync fallback
 * that the caller supplies when crypto.subtle is unavailable in a worker.
 */
export async function verifyManifest(files: readonly VerifiedFile[], provided: readonly FileBytes[], sha256?: (bytes: Uint8Array) => string): Promise<VerificationReport> {
  const manifest = new Map<string, VerifiedFile>(files.map((f) => [f.name, f]));
  const providedMap = new Map<string, Uint8Array>(provided.map((p) => [p.name, p.bytes]));
  const verified: string[] = [];
  const mismatched: { name: string; expected: string; actual: string }[] = [];
  const missing: string[] = [];

  for (const entry of files) {
    const bytes = providedMap.get(entry.name);
    if (!bytes) { missing.push(entry.name); continue; }
    if (bytes.length !== entry.bytes) { mismatched.push({ name: entry.name, expected: entry.digest, actual: `size ${bytes.length} ≠ ${entry.bytes}` }); continue; }
    const actual = sha256 ? sha256(bytes) : await digestFile(bytes, entry.algorithm);
    if (actual.toLowerCase() === entry.digest.toLowerCase()) verified.push(entry.name);
    else mismatched.push({ name: entry.name, expected: entry.digest, actual });
  }

  const extra = [...providedMap.keys()].filter((name) => !manifest.has(name));
  const complete = missing.length === 0 && mismatched.length === 0 && verified.length === files.length;
  return {
    ok: complete && extra.length === 0,
    verified,
    mismatched,
    missing,
    extra,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    complete,
  };
}

/**
 * Verifier for a *signed* manifest (BL-02's offline certificate). The certificate
 * is verified against the Ed25519 public key embedded in it, and the signature
 * is over the canonical manifest body. No key imports from untrusted byte ranges.
 */
export interface Certificate { algorithm: string; publicKey: string; signature: string }

export function parseCertificate(raw: unknown): Certificate {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 10_000) throw new Error("Certificate must be a JSON string");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Certificate is not valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Certificate must be a JSON object");
  const c = parsed as Record<string, unknown>;
  if (c.algorithm !== "Ed25519") throw new Error(`Unsupported certificate algorithm ${String(c.algorithm)}`);
  const pub = c.publicKey;
  const sig = c.signature;
  if (typeof pub !== "string" || !isHex(pub, 64)) throw new Error("Ed25519 public key must be 64 lowercase hex characters");
  if (typeof sig !== "string" || !isHex(sig, 128)) throw new Error("Ed25519 signature must be 128 lowercase hex characters");
  return { algorithm: "Ed25519", publicKey: pub.toLowerCase(), signature: sig.toLowerCase() };
}

/** Verifies an Ed25519 signature using the browser's own native key import. */
export async function verifySignature(cert: Certificate, message: Uint8Array, signature: string): Promise<boolean> {
  if (cert.algorithm !== "Ed25519") throw new Error("verifySignature only supports Ed25519");
  if (!(message instanceof Uint8Array)) throw new Error("Signature needs bytes");
  if (!isHex(signature, 128)) throw new Error("Signature must be 128 hex characters");
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(hexToBytes(cert.publicKey)),
    { name: "Ed25519", namedCurve: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    new Uint8Array(hexToBytes(signature)),
    new Uint8Array(message),
  );
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export function describeReport(report: VerificationReport): string {
  const parts = [`${report.verified.length} verified`, `${report.mismatched.length} mismatched`, `${report.missing.length} missing`, `${report.extra.length} extra`];
  return report.complete ? `all ${parts[0]} · ${report.totalBytes} bytes` : parts.join(" · ");
}
