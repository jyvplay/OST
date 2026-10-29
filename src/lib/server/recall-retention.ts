/**
 * RC-13 — the retention half of "memory deletion and retention policy".
 *
 * Deletion existed: a human can trash a memory and its receipt as a guarded pair.
 * Retention did not. An archive that only grows is a privacy problem dressed as a
 * feature, and "delete the old ones" is exactly the operation that goes wrong
 * silently — it is a bulk mutation driven by a rule rather than by a person looking
 * at each item.
 *
 * The design follows from that risk:
 *
 *  - Every run is planned before anything moves, and the plan is returned. `dryRun`
 *    is the default in the UI, and the plan a dry run returns is the same object an
 *    applied run reports, so what you reviewed is what happened.
 *  - A memory is a PAIR. Retention trashes media and receipt together inside one
 *    transaction, or it leaves both alone. A half-pair is never created.
 *  - Anything the policy cannot prove is a complete, intact pair is SKIPPED and
 *    reported, never swept. Unpaired files are RC-28's business, not retention's.
 *  - Soft trash only. Nothing here purges, and nothing here claims secure erasure.
 *  - The scope is one canonical Recall grouping folder, matched exactly. A policy
 *    cannot reach outside /Downloads/Recall/<group>.
 *  - Both rules are "keep" rules and they compose by intersection: a memory survives
 *    only if it is inside the age window AND inside the newest-N window. That order
 *    is stated because the opposite reading (survive if either rule keeps it) is the
 *    one that quietly retains everything.
 */
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, indexDocs, vfsNodes } from "@/db/schema";
import { safeTransaction } from "@/lib/server/transaction";
import { lockVfsPurge } from "@/lib/server/vfs-mutation-lock";
import { escapeLike, sha256 } from "@/lib/server/vfs";

const FOLDER_RE = /^\/Downloads\/Recall\/[^/]+$/;
const RECEIPT_SUFFIX = ".recall.json";
/** Upper bound on one run, so a policy cannot become an unbounded mutation. */
export const RETENTION_MAX_PER_RUN = 200;

export interface RetentionRequest {
  folder: string;
  maxAgeDays?: number | null;
  maxItems?: number | null;
  dryRun?: boolean;
}

export interface RetentionCandidate {
  path: string;
  bytes: number;
  savedAt: string;
  /** Which keep-rule this memory failed. Both can apply. */
  reasons: ("older than the age window" | "outside the newest-N window")[];
}

export interface RetentionReport {
  ok: true;
  folder: string;
  dryRun: boolean;
  /** Active memories considered, before any rule was applied. */
  considered: number;
  kept: number;
  /** Exactly what a run would trash, or did. */
  candidates: RetentionCandidate[];
  /** Pairs the policy refused to touch, with the reason it refused. */
  skipped: { path: string; reason: string }[];
  trashed: string[];
  /** True when the run stopped at RETENTION_MAX_PER_RUN. */
  truncated: boolean;
  policy: { maxAgeDays: number | null; maxItems: number | null };
}

function parse(req: RetentionRequest) {
  const folder = String(req.folder ?? "");
  if (!FOLDER_RE.test(folder) || folder.length > 256 || /[\u0000-\u001f\u007f]/.test(folder)) {
    throw new Error("Select one canonical Recall grouping folder");
  }
  const num = (v: unknown, name: string, max: number): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > max) throw new Error(`${name} must be a whole number between 0 and ${max}`);
    return n;
  };
  const maxAgeDays = num(req.maxAgeDays, "maxAgeDays", 36_500);
  const maxItems = num(req.maxItems, "maxItems", 100_000);
  if (maxAgeDays === null && maxItems === null) throw new Error("A retention policy needs an age limit, a count limit, or both");
  return { folder, maxAgeDays, maxItems, dryRun: req.dryRun !== false };
}

/**
 * Plan, then (optionally) apply. The plan is computed from one ordered read so that
 * the newest-N window and the age window see the same list.
 */
export async function recallRetention(req: RetentionRequest): Promise<RetentionReport> {
  const { folder, maxAgeDays, maxItems, dryRun } = parse(req);

  const rows = await db.select({
    id: vfsNodes.id, path: vfsNodes.path, size: vfsNodes.size, createdAt: vfsNodes.createdAt,
  }).from(vfsNodes)
    .where(and(eq(vfsNodes.parent, folder), eq(vfsNodes.kind, "file"), eq(vfsNodes.trashed, false),
      like(vfsNodes.mime, "%/%")))
    .orderBy(desc(vfsNodes.id));

  // Receipts are not memories; they are the other half of one.
  const media = rows.filter((r) => !r.path.endsWith(RECEIPT_SUFFIX));
  const cutoff = maxAgeDays === null ? null : new Date(Date.now() - maxAgeDays * 86_400_000);

  const candidates: RetentionCandidate[] = [];
  let kept = 0;
  media.forEach((m, index) => {
    const reasons: RetentionCandidate["reasons"] = [];
    if (cutoff && m.createdAt < cutoff) reasons.push("older than the age window");
    if (maxItems !== null && index >= maxItems) reasons.push("outside the newest-N window");
    if (reasons.length) candidates.push({ path: m.path, bytes: m.size, savedAt: m.createdAt.toISOString(), reasons });
    else kept += 1;
  });

  const truncated = candidates.length > RETENTION_MAX_PER_RUN;
  const batch = candidates.slice(0, RETENTION_MAX_PER_RUN);
  const skipped: { path: string; reason: string }[] = [];
  const trashed: string[] = [];

  if (!dryRun) {
    for (const c of batch) {
      try {
        await safeTransaction(async (tx) => {
          await lockVfsPurge(tx);
          const paths = [c.path, c.path + RECEIPT_SUFFIX];
          const nodes = await tx.select().from(vfsNodes).where(inArray(vfsNodes.path, paths)).for("update");
          const mediaNode = nodes.find((n) => n.path === c.path);
          const receiptNode = nodes.find((n) => n.path === paths[1]);
          // Everything the policy cannot prove, it refuses.
          if (!mediaNode || !receiptNode) throw new Error("no complete media/receipt pair");
          if (mediaNode.kind !== "file" || receiptNode.kind !== "file") throw new Error("pair is not a pair of files");
          if (mediaNode.trashed || receiptNode.trashed) throw new Error("pair is already trashed or half-trashed");
          if (sha256(mediaNode.content) !== mediaNode.sha256 || sha256(receiptNode.content) !== receiptNode.sha256) {
            throw new Error("stored bytes no longer match their recorded digest");
          }
          await tx.update(vfsNodes).set({ trashed: true, trashedFrom: c.path, updatedAt: new Date() }).where(inArray(vfsNodes.path, paths));
          await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), inArray(indexDocs.ref, paths)));
          await tx.insert(auditLog).values({
            actor: "policy", action: "recall.retention.trash",
            detail: `${c.path} (${c.reasons.join("; ")})`,
          });
        });
        trashed.push(c.path);
      } catch (e) {
        skipped.push({ path: c.path, reason: String((e as Error).message ?? e) });
      }
    }
    await db.insert(auditLog).values({
      actor: "policy", action: "recall.retention.run",
      detail: `${folder}: considered ${media.length}, trashed ${trashed.length}, skipped ${skipped.length}, policy age=${maxAgeDays ?? "-"} items=${maxItems ?? "-"}`,
    });
  }

  return {
    ok: true, folder, dryRun, considered: media.length, kept,
    candidates: batch, skipped, trashed, truncated,
    policy: { maxAgeDays, maxItems },
  };
}

/** How much a folder currently holds — what a retention UI has to show before it asks. */
export async function recallFolderUsage(folder: string) {
  if (!FOLDER_RE.test(folder)) throw new Error("Select one canonical Recall grouping folder");
  const rows = await db.select({ path: vfsNodes.path, size: vfsNodes.size, createdAt: vfsNodes.createdAt })
    .from(vfsNodes)
    .where(and(eq(vfsNodes.parent, folder), eq(vfsNodes.kind, "file"), eq(vfsNodes.trashed, false),
      like(vfsNodes.path, `${escapeLike(folder)}/%`)));
  const media = rows.filter((r) => !r.path.endsWith(RECEIPT_SUFFIX));
  const oldest = media.reduce<Date | null>((a, r) => (a === null || r.createdAt < a ? r.createdAt : a), null);
  return {
    ok: true as const, folder, memories: media.length,
    bytes: rows.reduce((a, r) => a + r.size, 0),
    oldestSavedAt: oldest ? oldest.toISOString() : null,
  };
}
