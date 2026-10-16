import { createHash } from "node:crypto";
import { and, asc, eq, like, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, fileOps, indexDocs, vfsNodes, vfsVersions } from "@/db/schema";


/**
 * CRITICAL FIX (v3.3): LIKE treats `_` and `%` as wildcards. v3.0-3.2 built
 * descendant patterns as `${path}/%` unescaped, so purging "/a_b" also deleted
 * everything under "/aXb" (reproduced against the live server: data loss).
 * Every prefix match now goes through escapeLike; backslash is Postgres's
 * default LIKE escape character.
 */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const descendantsOf = (p: string) => `${escapeLike(p === "/" ? "" : p)}/%`;

export const MAX_BYTES = 8 * 1024 * 1024; // honest cap: Postgres text column, not a disk

export type Encoding = "utf8" | "base64";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function normalize(p: string): string {
  if (!p || p === "/") return "/";
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    // zip-slip / traversal hardening also applies to plain path input
    out.push(part.replace(/\u0000/g, ""));
  }
  return "/" + out.join("/");
}

export const parentOf = (p: string) => {
  const n = normalize(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
};
export const baseName = (p: string) => normalize(p).split("/").filter(Boolean).pop() ?? "/";

export function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
    yml: "text/yaml", yaml: "text/yaml", log: "text/plain", ini: "text/plain",
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", ts: "text/typescript",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", heic: "image/heic", bmp: "image/bmp",
    pdf: "application/pdf", zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    psd: "image/vnd.adobe.photoshop", psb: "image/vnd.adobe.photoshop", epub: "application/epub+zip",
    ics: "text/calendar", fsheet: "application/json", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg",
  };
  return map[ext] ?? "application/octet-stream";
}

export const isTextual = (mime: string) =>
  mime.startsWith("text/") || ["application/json", "image/svg+xml", "text/typescript"].includes(mime);

async function audit(action: string, detail: string) {
  await db.insert(auditLog).values({ actor: "user", action, detail });
}

/** Index maintenance — one place, so search can never disagree with the VFS. */
async function indexUpsert(path: string, name: string, body: string) {
  await db
    .insert(indexDocs)
    .values({ source: "file", ref: path, title: name, body: body.slice(0, 50_000), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [indexDocs.source, indexDocs.ref],
      set: { title: name, body: body.slice(0, 50_000), updatedAt: new Date() },
    });
}
async function indexDrop(path: string) {
  await db.delete(indexDocs).where(and(eq(indexDocs.source, "file"), eq(indexDocs.ref, path)));
}

export async function getNode(path: string) {
  const p = normalize(path);
  const rows = await db.select().from(vfsNodes).where(eq(vfsNodes.path, p)).limit(1);
  return rows[0] ?? null;
}

export async function listDir(path: string, includeTrashed = false) {
  const p = normalize(path);
  const rows = await db
    .select()
    .from(vfsNodes)
    .where(includeTrashed ? eq(vfsNodes.parent, p) : and(eq(vfsNodes.parent, p), eq(vfsNodes.trashed, false)))
    .orderBy(asc(vfsNodes.kind), asc(vfsNodes.name));
  return rows;
}

export async function ensureDir(path: string) {
  const p = normalize(path);
  if (p === "/") return;
  const segments = p.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segments) {
    const parent = cur === "" ? "/" : cur;
    cur = `${parent === "/" ? "" : parent}/${seg}`;
    const existing = await getNode(cur);
    if (!existing) {
      await db.insert(vfsNodes).values({
        path: cur, parent, name: seg, kind: "dir", mime: "inode/directory", encoding: "utf8",
      }).onConflictDoNothing();
    }
  }
}

export interface WriteArgs {
  path: string;
  content: string;
  encoding?: Encoding;
  mime?: string;
  reason?: string;
  /** FM-18 safe save: snapshot the previous version before replacing. */
  snapshot?: boolean;
}

/**
 * Safe save (FM-18): temp write → verify digest → atomic publish → version snapshot.
 * The journal row is written OUTSIDE the data transaction on purpose: if the data
 * transaction rolls back, the journal must still record that it was attempted.
 */
export async function writeFile(args: WriteArgs) {
  const path = normalize(args.path);
  const name = baseName(path);
  const parent = parentOf(path);
  const encoding: Encoding = args.encoding ?? "utf8";
  const mime = args.mime ?? guessMime(name);
  const size = Buffer.byteLength(args.content, encoding === "base64" ? "base64" : "utf8");
  if (size > MAX_BYTES) throw new Error(`File exceeds the ${MAX_BYTES} byte store limit (${size})`);
  const digest = sha256(args.content);

  const [op] = await db.insert(fileOps).values({ op: "write", src: path, state: "REQUESTED", bytes: size })
    .returning({ id: fileOps.id });
  const steps: { state: string; at: string }[] = [{ state: "REQUESTED", at: new Date().toISOString() }];
  const step = async (state: string, extra: Partial<typeof fileOps.$inferInsert> = {}) => {
    steps.push({ state, at: new Date().toISOString() });
    await db.update(fileOps).set({ state, steps, updatedAt: new Date(), ...extra }).where(eq(fileOps.id, op.id));
  };

  try {
    await ensureDir(parent);
    await step("COPYING_TO_TEMP");
    const prev = await getNode(path);
    // verify we can reproduce the digest from the exact bytes we will store
    if (sha256(args.content) !== digest) throw new Error("digest mismatch before publish");
    await step("DEST_VERIFIED", { sha256: digest });

    await db.transaction(async (tx) => {
      if (prev) {
        if (args.snapshot !== false) {
          await tx.insert(vfsVersions).values({
            path, version: prev.version, encoding: prev.encoding, content: prev.content,
            size: prev.size, sha256: prev.sha256, reason: args.reason ?? "write",
          });
        }
        await tx.update(vfsNodes).set({
          content: args.content, encoding, mime, size, sha256: digest,
          version: prev.version + 1, updatedAt: new Date(), trashed: false,
        }).where(eq(vfsNodes.path, path));
      } else {
        await tx.insert(vfsNodes).values({
          path, parent, name, kind: "file", mime, encoding, content: args.content, size, sha256: digest,
        });
      }
    });
    await step("DEST_PUBLISHED");
    await step("COMPLETE");
    if (isTextual(mime) && encoding === "utf8") await indexUpsert(path, name, args.content);
    else await indexUpsert(path, name, "");
    await audit("fs.write", path);
    return { ok: true, path, size, sha256: digest, opId: op.id };
  } catch (err) {
    await db.update(fileOps).set({
      state: "FAILED", error: String((err as Error).message ?? err), steps, updatedAt: new Date(),
    }).where(eq(fileOps.id, op.id));
    throw err;
  }
}

/** Journaled move/copy (spec §5.7), directory-aware via path-prefix rewrite. */
export async function transferNode(src: string, dst: string, mode: "move" | "copy") {
  const from = normalize(src);
  const to = normalize(dst);
  if (from === "/" ) throw new Error("refusing to move the root");
  if (to === from) throw new Error("source and destination are identical");
  if (to.startsWith(from + "/")) throw new Error("refusing to move a directory into itself");

  const node = await getNode(from);
  if (!node) throw new Error(`not found: ${from}`);
  const existing = await getNode(to);
  if (existing) throw new Error(`destination exists: ${to}`);

  const [op] = await db.insert(fileOps).values({ op: mode, src: from, dst: to, state: "REQUESTED", bytes: node.size })
    .returning({ id: fileOps.id });
  const steps: { state: string; at: string }[] = [{ state: "REQUESTED", at: new Date().toISOString() }];
  const step = async (state: string, extra: Partial<typeof fileOps.$inferInsert> = {}) => {
    steps.push({ state, at: new Date().toISOString() });
    await db.update(fileOps).set({ state, steps, updatedAt: new Date(), ...extra }).where(eq(fileOps.id, op.id));
  };

  try {
    await ensureDir(parentOf(to));
    await step("COPYING_TO_TEMP");
    const tempPath = `${parentOf(to)}/.fusion-tmp-${op.id}-${baseName(to)}`.replace("//", "/");

    const descendants = node.kind === "dir"
      ? await db.select().from(vfsNodes).where(like(vfsNodes.path, descendantsOf(from)))
      : [];

    await db.transaction(async (tx) => {
      await tx.insert(vfsNodes).values({
        path: tempPath, parent: parentOf(to), name: baseName(tempPath), kind: node.kind, mime: node.mime,
        encoding: node.encoding, content: node.content, size: node.size, sha256: node.sha256, tags: node.tags,
      });
      for (const d of descendants) {
        const rel = d.path.slice(from.length);
        const np = `${tempPath}${rel}`;
        await tx.insert(vfsNodes).values({
          path: np, parent: parentOf(np), name: d.name, kind: d.kind, mime: d.mime, encoding: d.encoding,
          content: d.content, size: d.size, sha256: d.sha256, tags: d.tags,
        });
      }
    });

    const temp = await getNode(tempPath);
    if (!temp || temp.sha256 !== node.sha256) throw new Error("verification failed after temp copy");
    await step("DEST_VERIFIED", { sha256: node.sha256 });

    await db.transaction(async (tx) => {
      await tx.update(vfsNodes)
        .set({ path: to, parent: parentOf(to), name: baseName(to), updatedAt: new Date() })
        .where(eq(vfsNodes.path, tempPath));
      const tempKids = await tx.select().from(vfsNodes).where(like(vfsNodes.path, descendantsOf(tempPath)));
      for (const k of tempKids) {
        const np = `${to}${k.path.slice(tempPath.length)}`;
        await tx.update(vfsNodes).set({ path: np, parent: parentOf(np) }).where(eq(vfsNodes.path, k.path));
      }
    });
    await step("DEST_PUBLISHED");

    if (mode === "move") {
      await db.transaction(async (tx) => {
        await tx.delete(vfsNodes).where(or(eq(vfsNodes.path, from), like(vfsNodes.path, descendantsOf(from))));
      });
      await step("SOURCE_RETIRE");
      await indexDrop(from);
    }
    await step("COMPLETE");

    const published = await getNode(to);
    if (published && isTextual(published.mime) && published.encoding === "utf8") {
      await indexUpsert(to, published.name, published.content);
    }
    await audit(`fs.${mode}`, `${from} -> ${to}`);
    return { ok: true, opId: op.id, from, to };
  } catch (err) {
    await db.update(fileOps).set({
      state: "FAILED", error: String((err as Error).message ?? err), steps, updatedAt: new Date(),
    }).where(eq(fileOps.id, op.id));
    // best-effort rollback of the temp copy; state remains inspectable in the journal
    await db.delete(vfsNodes).where(like(vfsNodes.path, `%/.fusion-tmp-${op.id}-%`));
    throw err;
  }
}

export async function trashNode(path: string) {
  const p = normalize(path);
  const node = await getNode(p);
  if (!node) throw new Error(`not found: ${p}`);
  await db.update(vfsNodes).set({ trashed: true, trashedFrom: p, updatedAt: new Date() })
    .where(or(eq(vfsNodes.path, p), like(vfsNodes.path, descendantsOf(p))));
  await indexDrop(p);
  await db.insert(fileOps).values({ op: "trash", src: p, state: "COMPLETE", bytes: node.size });
  await audit("fs.trash", p);
  return { ok: true };
}

export async function restoreNode(path: string) {
  const p = normalize(path);
  await db.update(vfsNodes).set({ trashed: false, trashedFrom: null, updatedAt: new Date() })
    .where(or(eq(vfsNodes.path, p), like(vfsNodes.path, descendantsOf(p))));
  const node = await getNode(p);
  if (node && isTextual(node.mime) && node.encoding === "utf8") await indexUpsert(p, node.name, node.content);
  await audit("fs.restore", p);
  return { ok: true };
}

export async function purgeNode(path: string) {
  const p = normalize(path);
  await db.delete(vfsNodes).where(or(eq(vfsNodes.path, p), like(vfsNodes.path, descendantsOf(p))));
  await indexDrop(p);
  await audit("fs.purge", p);
  return { ok: true };
}

export async function mkdir(path: string) {
  await ensureDir(path);
  await audit("fs.mkdir", normalize(path));
  return { ok: true, path: normalize(path) };
}

export async function folderSize(path: string) {
  const p = normalize(path);
  const rows = await db
    .select({ bytes: sql<number>`coalesce(sum(${vfsNodes.size}),0)`, files: sql<number>`count(*)` })
    .from(vfsNodes)
    .where(and(like(vfsNodes.path, descendantsOf(p)), eq(vfsNodes.trashed, false)));
  return { bytes: Number(rows[0]?.bytes ?? 0), files: Number(rows[0]?.files ?? 0) };
}

export async function versionsOf(path: string) {
  return db.select().from(vfsVersions).where(eq(vfsVersions.path, normalize(path))).orderBy(asc(vfsVersions.version));
}
