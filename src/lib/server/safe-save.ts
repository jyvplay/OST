/**
 * FM-18 — the safe-save contract.
 *
 * The contract every desktop and mobile platform converged on, for the same reason:
 * an in-place overwrite that fails halfway destroys the only copy. The canonical
 * shape is write-elsewhere → reopen and validate → atomically replace → clean up,
 * and never destroy the original on any failing path.
 *
 * This implementation is written against PostgreSQL because that is this system's
 * storage. The parts that make the contract real are kept real:
 *
 *  - The temporary output is a genuinely separate committed object, not a variable.
 *    It is written in its own transaction and is visible to other readers while it
 *    exists, which is what makes a crash between stages observable and reclaimable.
 *  - The validation stage REOPENS that object in a NEW transaction and recomputes
 *    the digest from what storage actually returned. It does not re-hash the buffer
 *    the caller passed, because that only proves the caller can hash. The whole
 *    point is to catch storage that did not keep what it was given.
 *  - The replacement stage publishes the bytes it read back from the temporary
 *    object inside the replacing transaction — the validated bytes, not the
 *    caller's buffer a second time.
 *  - Every failure after the temporary object exists removes it and leaves the
 *    original untouched; the original's version number is only ever advanced by a
 *    replacement that passed validation.
 *
 * Honest limits, stated here and mirrored into the specs row:
 *  - "Atomic" means PostgreSQL's commit, not fsync of a block device.
 *  - This is not the Android SAF provider contract; there is no native document
 *    provider here. It is the same five-stage shape against the storage that exists.
 *  - Validation checks what can be checked without interpreting a format the system
 *    does not own: declared digest, byte length, encoding round-trip, and JSON
 *    well-formedness when the caller asks for it.
 */
import { and, asc, eq, like, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, fileOps, indexDocs, safeSaveClaims, vfsNodes, vfsVersions } from "@/db/schema";
import { guessMime, isPrivateVfsPath, isTextual } from "@/lib/mime";
import { safeTransaction } from "@/lib/server/transaction";
import { lockVfsWriter } from "@/lib/server/vfs-mutation-lock";
import { baseName, escapeLike, MAX_BYTES, normalize, parentOf, sha256, writableDirectories, type Encoding } from "@/lib/server/vfs";

/** Refused because the bytes that came back from storage are not the bytes promised. */
export class SafeSaveValidationError extends Error {}
/** Refused because the target is not the one the caller validated against. */
export class SafeSaveReplaceConflict extends Error {}

/** Where temporary outputs live. Visible on purpose: an orphan here is evidence. */
export const SAFE_SAVE_DIR = "/.safe-save";
/** Same alphabet as the RC-39 commit token: opaque, caller-minted, never parsed. */
export const SAFE_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type SafeSaveValidator = "none" | "utf8" | "json";
export type SafeSaveConflict = "refuse" | "copy";

export interface SafeSaveExpected {
  id: number;
  version: number;
  sha256: string;
}

export interface SafeSaveArgs {
  path: string;
  content: string;
  encoding?: Encoding;
  mime?: string;
  /** What the caller believes it is sending. Compared against storage, not against itself. */
  declaredSha256?: string;
  /** What the caller believes is already there. null asserts "nothing is there". */
  expected?: SafeSaveExpected | null;
  /** What to do when `expected` does not match: refuse, or publish a copy beside it. */
  onConflict?: SafeSaveConflict;
  /** Makes the whole save idempotent across a lost acknowledgement. */
  token?: string;
  validate?: SafeSaveValidator;
  reason?: string;
}

export interface SafeSaveResult {
  ok: true;
  path: string;
  /** True when the target itself was replaced. */
  replaced: boolean;
  /** Set instead of `replaced` when the target was busy and a copy was published. */
  savedCopyTo?: string;
  id: number;
  version: number;
  size: number;
  sha256: string;
  opId: number;
  /** The stages this save actually went through, in order. */
  stages: string[];
  /** True when this answer was replayed from an earlier identical attempt. */
  replayed: boolean;
}

const STAGES = ["PREPARED", "TEMP_WRITTEN", "REOPENED", "VALIDATED", "REPLACED", "TEMP_RECLAIMED", "COMPLETE"] as const;

/** A name that cannot collide with a real file and carries its own age. */
const tempPathFor = (token: string) => `${SAFE_SAVE_DIR}/${token}.part`;

/** `notes.md` → `notes (copy).md` → `notes (copy 2).md`. Never overwrites. */
export function copyNameFor(path: string, taken: (p: string) => boolean): string {
  const dir = parentOf(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const at = (n: number) => `${dir === "/" ? "" : dir}/${stem} (copy${n > 1 ? ` ${n}` : ""})${ext}`;
  for (let n = 1; n < 1000; n++) if (!taken(at(n))) return at(n);
  throw new SafeSaveReplaceConflict("A thousand copies of this name already exist");
}

/**
 * Validation that does not pretend to understand formats this system does not own.
 * Returns the number of bytes the content really decodes to, or throws.
 */
function validateContent(content: string, encoding: Encoding, validator: SafeSaveValidator): number {
  if (encoding === "base64") {
    // A base64 payload that does not round-trip is corrupt, whatever it claims to be.
    const buf = Buffer.from(content, "base64");
    if (buf.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "").replace(/\s/g, "")) {
      throw new SafeSaveValidationError("The temporary output is not valid base64 after reopening");
    }
    if (validator === "json") throw new SafeSaveValidationError("JSON validation requires utf8 encoding");
    return buf.byteLength;
  }
  // UTF-8: a lone surrogate survives a JavaScript string but not a byte round-trip.
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content) {
    throw new SafeSaveValidationError("The temporary output does not round-trip as UTF-8 (lone surrogate or invalid sequence)");
  }
  if (validator === "json") {
    try {
      JSON.parse(content);
    } catch (e) {
      throw new SafeSaveValidationError(`The temporary output is not well-formed JSON: ${String((e as Error).message)}`);
    }
  }
  return bytes.byteLength;
}

/**
 * The five-stage save. Each stage is a real boundary: the temporary output is
 * committed before it is reopened, and the reopen reads storage rather than memory.
 */
export async function safeSave(args: SafeSaveArgs): Promise<SafeSaveResult> {
  const path = normalize(args.path);
  if (path === "/") throw new Error("Refusing to write the VFS root");
  if (path.startsWith(`${SAFE_SAVE_DIR}/`) || path === SAFE_SAVE_DIR) throw new Error("Refusing to safe-save into the temporary output folder");
  const encoding: Encoding = args.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64") throw new Error("invalid encoding");
  const validator: SafeSaveValidator = args.validate ?? "none";
  if (validator !== "none" && validator !== "utf8" && validator !== "json") throw new Error("invalid validator");
  const onConflict: SafeSaveConflict = args.onConflict ?? "refuse";
  if (onConflict !== "refuse" && onConflict !== "copy") throw new Error("invalid onConflict");
  if (args.token !== undefined && !SAFE_TOKEN_RE.test(args.token)) throw new Error("invalid token");
  if (args.declaredSha256 !== undefined && !/^[0-9a-f]{64}$/.test(args.declaredSha256)) throw new Error("invalid declaredSha256");

  const size = Buffer.byteLength(args.content, encoding === "base64" ? "base64" : "utf8");
  if (size > MAX_BYTES) throw new Error(`File exceeds the ${MAX_BYTES} byte store limit (${size})`);
  const mime = args.mime ?? guessMime(baseName(path));
  const stages: string[] = [];
  const stage = (s: (typeof STAGES)[number]) => { stages.push(s); };


  // ── Idempotency. Claimed before anything is written, so a retry of a save whose
  //    answer was lost is answered by the first attempt rather than performed again.
  if (args.token) {
    const claimed = await db.insert(safeSaveClaims)
      .values({ token: args.token, path, sha256: sha256(args.content), result: null })
      .onConflictDoNothing({ target: safeSaveClaims.token })
      .returning({ token: safeSaveClaims.token });
    if (!claimed.length) {
      const [prior] = await db.select().from(safeSaveClaims).where(eq(safeSaveClaims.token, args.token)).limit(1);
      if (prior && prior.sha256 !== sha256(args.content)) {
        throw new SafeSaveReplaceConflict("This save token was already used for different bytes");
      }
      if (prior?.result) return { ...(prior.result as unknown as SafeSaveResult), replayed: true };
      // Claimed but unfinished: the first attempt died before it recorded an answer.
      throw new SafeSaveReplaceConflict("An earlier save with this token is still in flight or failed; mint a new token to retry");
    }
  }

  const [op] = await db.insert(fileOps).values({ op: "safeSave", src: path, dst: args.token ? tempPathFor(args.token) : "", state: "REQUESTED", bytes: size })
    .returning({ id: fileOps.id });
  const journal = async (state: string, extra: Partial<typeof fileOps.$inferInsert> = {}) => {
    await db.update(fileOps)
      .set({ state, steps: stages.map((s) => ({ state: s, at: new Date().toISOString() })), updatedAt: new Date(), ...extra })
      .where(and(eq(fileOps.id, op.id), ne(fileOps.state, "COMPLETE")))
      .catch(() => undefined);
  };

  // A token is optional; the temporary output is not. Without a token the temp name
  // is derived from the op id, which is unique for the same reason.
  const temp = tempPathFor(args.token ?? `op${op.id}auto`);
  stage("PREPARED");
  await journal("PREPARED");

  try {
    // Representability is a property of the INPUT, not of storage, and it has to be
    // settled before anything is written. PostgreSQL's text type is UTF-8 and the
    // driver encodes a JavaScript string on the way in, so a lone surrogate is
    // silently replaced by U+FFFD *before* storage ever sees it. Reopening cannot
    // detect that: the digest going in and the digest coming back agree, because
    // both were computed after the same substitution. Here is the only honest place
    // to refuse it. (Found by a test that asserted the opposite and was right.)
    // It runs inside the try so that a refusal is journalled like any other failure.
    const declaredBytes = validateContent(args.content, encoding, validator);
    // ── Stage 1: write the temporary output and COMMIT it. ───────────────────────
    await safeTransaction(async (tx) => {
      await lockVfsWriter(tx);
      await writableDirectories(tx, SAFE_SAVE_DIR, true);
      await tx.insert(vfsNodes)
        .values({ path: temp, parent: SAFE_SAVE_DIR, name: baseName(temp), kind: "file", mime, encoding, content: args.content, size, sha256: sha256(args.content) })
        .onConflictDoUpdate({ target: vfsNodes.path, set: { content: args.content, encoding, mime, size, sha256: sha256(args.content), trashed: false, updatedAt: new Date() } });
    });
    stage("TEMP_WRITTEN");
    await journal("TEMP_WRITTEN");

    // ── Stage 2: REOPEN it. A separate transaction, reading what storage kept. ───
    const [reopened] = await db.select({ content: vfsNodes.content, encoding: vfsNodes.encoding, size: vfsNodes.size, sha256: vfsNodes.sha256 })
      .from(vfsNodes).where(and(eq(vfsNodes.path, temp), eq(vfsNodes.trashed, false))).limit(1);
    if (!reopened) throw new SafeSaveValidationError("The temporary output disappeared before it could be validated");
    stage("REOPENED");

    // ── Stage 3: validate what came back, not what was sent. ────────────────────
    const storedDigest = sha256(reopened.content);
    if (storedDigest !== reopened.sha256) throw new SafeSaveValidationError("Storage returned bytes whose digest does not match the digest recorded with them");
    if (args.declaredSha256 && storedDigest !== args.declaredSha256) {
      throw new SafeSaveValidationError(`The saved bytes do not match the digest the caller declared (declared ${args.declaredSha256.slice(0, 12)}…, stored ${storedDigest.slice(0, 12)}…)`);
    }
    // Re-run the same validation on what storage returned. The input check above
    // cannot speak for the round trip; this one cannot speak for the input.
    const decodedBytes = validateContent(reopened.content, reopened.encoding as Encoding, validator);
    if (decodedBytes !== declaredBytes) throw new SafeSaveValidationError(`The reopened output decodes to ${decodedBytes} bytes, not the ${declaredBytes} that were offered`);
    if (reopened.size !== size) throw new SafeSaveValidationError(`The temporary output is ${reopened.size} bytes, not the ${size} that were sent`);
    stage("VALIDATED");
    await journal("VALIDATED", { sha256: storedDigest });

    // ── Stage 4: replace the target atomically, from the validated bytes. ───────
    const published = await safeTransaction(async (tx) => {
      await lockVfsWriter(tx);
      await writableDirectories(tx, parentOf(path), true);
      // Read the validated temp INSIDE this transaction: what gets published is what
      // was validated, even if the caller's buffer has since been garbage.
      const [src] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, temp)).limit(1).for("update");
      if (!src) throw new SafeSaveValidationError("The temporary output vanished during replacement");
      const [prev] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, path)).limit(1).for("update");

      const mismatch =
        args.expected === undefined ? null
          : args.expected === null
            ? (prev && !prev.trashed ? "a file already exists at this path" : null)
            : !prev || prev.trashed ? "the file this save was validated against is gone"
              : prev.id !== args.expected.id ? "a different file now occupies this path"
                : prev.version !== args.expected.version ? `this file moved to version ${prev.version} while the save was being prepared`
                  : prev.sha256 !== args.expected.sha256 ? "this file's bytes changed while the save was being prepared"
                    : null;

      if (mismatch && onConflict === "refuse") throw new SafeSaveReplaceConflict(`Not replaced: ${mismatch}`);

      if (mismatch) {
        // Save a Copy: the original is not touched at all.
        const siblings = await tx.select({ path: vfsNodes.path }).from(vfsNodes)
          .where(and(eq(vfsNodes.parent, parentOf(path)), eq(vfsNodes.trashed, false)));
        const takenSet = new Set(siblings.map((s) => s.path));
        const copyPath = copyNameFor(path, (p) => takenSet.has(p));
        const [made] = await tx.insert(vfsNodes)
          .values({ path: copyPath, parent: parentOf(copyPath), name: baseName(copyPath), kind: "file", mime: src.mime, encoding: src.encoding, content: src.content, size: src.size, sha256: src.sha256 })
          .returning({ id: vfsNodes.id, version: vfsNodes.version });
        await indexOrForget(tx, copyPath, src.mime, src.encoding, src.content);
        await tx.delete(vfsNodes).where(eq(vfsNodes.path, temp));
        await tx.insert(auditLog).values({ actor: "user", action: "fs.safeSave.copy", detail: `${path} → ${copyPath}: ${mismatch}` });
        return { replaced: false as const, savedCopyTo: copyPath, id: made.id, version: made.version };
      }

      if (prev && !prev.trashed) {
        if (prev.kind !== "file") throw new Error(`This path is a folder: ${path}`);
        await tx.insert(vfsVersions).values({ path, version: prev.version, encoding: prev.encoding, content: prev.content, size: prev.size, sha256: prev.sha256, reason: args.reason ?? "safeSave" });
        const [done] = await tx.update(vfsNodes)
          .set({ content: src.content, encoding: src.encoding, mime: src.mime, size: src.size, sha256: src.sha256, version: prev.version + 1, updatedAt: new Date(), trashed: false })
          .where(eq(vfsNodes.path, path)).returning({ id: vfsNodes.id, version: vfsNodes.version });
        await indexOrForget(tx, path, src.mime, src.encoding, src.content);
        await tx.delete(vfsNodes).where(eq(vfsNodes.path, temp));
        await tx.insert(auditLog).values({ actor: "user", action: "fs.safeSave", detail: path });
        return { replaced: true as const, id: done.id, version: done.version };
      }

      if (prev?.trashed) throw new Error(`This path is in Trash: ${path}. Restore or permanently delete it before writing here.`);
      const [made] = await tx.insert(vfsNodes)
        .values({ path, parent: parentOf(path), name: baseName(path), kind: "file", mime: src.mime, encoding: src.encoding, content: src.content, size: src.size, sha256: src.sha256 })
        .returning({ id: vfsNodes.id, version: vfsNodes.version });
      await indexOrForget(tx, path, src.mime, src.encoding, src.content);
      await tx.delete(vfsNodes).where(eq(vfsNodes.path, temp));
      await tx.insert(auditLog).values({ actor: "user", action: "fs.safeSave.create", detail: path });
      return { replaced: true as const, id: made.id, version: made.version };
    });
    stage("REPLACED");
    stage("TEMP_RECLAIMED");
    stage("COMPLETE");
    await journal("COMPLETE", { sha256: storedDigest, bytes: decodedBytes });

    const result: SafeSaveResult = {
      ok: true, path, replaced: published.replaced, ...(published.savedCopyTo ? { savedCopyTo: published.savedCopyTo } : {}),
      id: published.id, version: published.version, size, sha256: storedDigest, opId: op.id, stages, replayed: false,
    };
    if (args.token) {
      await db.update(safeSaveClaims).set({ result: result as unknown as Record<string, unknown> }).where(eq(safeSaveClaims.token, args.token)).catch(() => undefined);
    }
    return result;
  } catch (err) {
    // Every failing path removes the temporary output and leaves the original alone.
    await db.delete(vfsNodes).where(eq(vfsNodes.path, temp)).catch(() => undefined);
    await journal("FAILED", { error: String((err as Error).message ?? err) });
    // A failed attempt must not poison the token: the caller may fix the bytes and retry.
    if (args.token) await db.delete(safeSaveClaims).where(and(eq(safeSaveClaims.token, args.token), sql`${safeSaveClaims.result} is null`)).catch(() => undefined);
    throw err;
  }
}

/** Index maintenance shared by every publishing path above. */
async function indexOrForget(tx: Parameters<Parameters<typeof safeTransaction>[0]>[0], path: string, mime: string, encoding: string, content: string) {
  if (isPrivateVfsPath(path)) {
    await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), eq(indexDocs.ref, path)));
    return;
  }
  const body = isTextual(mime) && encoding === "utf8" ? content.slice(0, 50_000) : "";
  await tx.insert(indexDocs).values({ source: "file", ref: path, title: baseName(path), body, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: baseName(path), body, updatedAt: new Date() } });
}

/**
 * Reclaim temporary outputs abandoned by a process that died between stages.
 * Age-bounded so it can never delete a save that is still in flight.
 */
export async function safeSaveSweep(olderThanMs = 60_000): Promise<{ ok: true; reclaimed: string[]; kept: number }> {
  const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
  const stale = await db.select({ path: vfsNodes.path }).from(vfsNodes)
    .where(and(like(vfsNodes.path, `${escapeLike(SAFE_SAVE_DIR)}/%`), eq(vfsNodes.kind, "file"), lt(vfsNodes.updatedAt, cutoff)))
    .orderBy(asc(vfsNodes.path));
  const all = await db.select({ path: vfsNodes.path }).from(vfsNodes)
    .where(and(like(vfsNodes.path, `${escapeLike(SAFE_SAVE_DIR)}/%`), eq(vfsNodes.kind, "file")));
  for (const s of stale) await db.delete(vfsNodes).where(eq(vfsNodes.path, s.path));
  if (stale.length) await db.insert(auditLog).values({ actor: "system", action: "fs.safeSave.sweep", detail: `${stale.length} abandoned temporary outputs reclaimed` });
  return { ok: true, reclaimed: stale.map((s) => s.path), kept: all.length - stale.length };
}
