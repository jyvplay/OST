import { recallLifecycle } from '@/lib/server/recall-lifecycle';
import { recallAudit, recallSearch } from '@/lib/server/recall-search';
import { recallOrphanTrash } from '@/lib/server/recall-orphan';
import { atomicRecallCommit } from '@/lib/server/recall-commit';
import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, getTableColumns, ilike, like, lt, not, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { vfsNodes } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import {
  folderSize, getNode, listDir, mkdir, normalize, purgeNode, dropVersions, restoreNode,
  transferNode, trashNode, versionsOf, writeFile, setTags, baseName, parentOf, MAX_BYTES, escapeLike,
  parseExpectedPhoto, PhotoRecipeConflict,
} from "@/lib/server/vfs";
import { deflateRawSync } from "node:zlib";
import { readArchive, readEntry, writeArchive, extractable, PasswordError, type NameMode } from "@/lib/archive/zip";
import { readJsonObject } from "@/lib/http-json";
import { refuseEncryptedOverwrite } from "@/lib/mime";
import { ConditionalWriteConflict, conditionalWriteFile, type ExpectedFile } from "@/lib/server/conditional-write";
import { sidecarPath, isSidecar } from "@/lib/photos/recipe";

/**
 * Public photo move/copy and its known recipe are handled atomically by
 * transferNode. Trash/restore/purge still attempt the companion separately
 * after the primary operation; failure is returned and cannot undo the primary.
 * Encrypted Private names cannot be paired by this server without the keys.
 */
async function followSidecar<T extends object>(res: T, src: string, op: "trash" | "restore" | "purge"): Promise<T & { sidecar?: string }> {
  const from = normalize(src);
  if (isSidecar(from)) return res;
  const sc = sidecarPath(from);
  try {
    const node = await getNode(sc);
    if (!node) return res;
    if (op === "trash") await trashNode(sc);
    else if (op === "restore") await restoreNode(sc);
    else await purgeNode(sc);
    return { ...res, sidecar: "followed" };
  } catch (e) { return { ...res, sidecar: `not followed: ${(e as Error).message}` }; }
}

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await bootstrap();
  const p = req.nextUrl.searchParams;
  const op = p.get("op") ?? "list";
  const path = p.get("path") ?? "/";
  try {
    switch (op) {
      // TT104: keyset pagination projects metadata only; never loads media bodies.
      case "recallPage": {
        if (!/^\/Downloads\/Recall\/[^/]+$/.test(path) || path !== normalize(path) || path.length > 256 || /[\u0000-\u001f\u007f]/.test(path))
          return NextResponse.json({ error: "Select one canonical Recall grouping folder" }, { status: 400 });
        const cursor = p.get("before");
        if (cursor !== null && (!/^[1-9][0-9]{0,9}$/.test(cursor) || Number(cursor) > 2147483647))
          return NextResponse.json({ error: "Invalid Recall cursor" }, { status: 400 });
        const [folder] = await db.select({kind:vfsNodes.kind,trashed:vfsNodes.trashed}).from(vfsNodes).where(eq(vfsNodes.path,path)).limit(1);
        if (folder && (folder.kind !== 'dir' || folder.trashed)) return NextResponse.json({error:'Recall folder is unavailable'}, {status:409});
        const rows = await db.select({id:vfsNodes.id,path:vfsNodes.path,name:vfsNodes.name,mime:vfsNodes.mime,size:vfsNodes.size,createdAt:vfsNodes.createdAt})
          .from(vfsNodes).where(and(eq(vfsNodes.parent,path),eq(vfsNodes.kind,'file'),eq(vfsNodes.trashed,false),
            or(like(vfsNodes.mime,'image/%'),like(vfsNodes.mime,'video/%'),like(vfsNodes.mime,'audio/%')),
            sql`octet_length(${vfsNodes.path}) <= 1024 AND octet_length(${vfsNodes.name}) <= 512 AND octet_length(${vfsNodes.mime}) <= 256`,
            cursor === null ? undefined : lt(vfsNodes.id,Number(cursor))))
          .orderBy(desc(vfsNodes.id)).limit(101);
        const nodes=rows.slice(0,100);
        return NextResponse.json({ok:true,nodes,next:rows.length>100 ? String(nodes[nodes.length-1].id) : null,order:'insertion-id-desc',metadataLimits:{pathBytes:1024,nameBytes:512,mimeBytes:256}});
      }
      case "recallSearch":
        return NextResponse.json(await recallSearch({ method: p.get("method"), host: p.get("host"), from: p.get("from"), to: p.get("to"), limit: p.get("limit") }));
      case "recallAudit":
        return NextResponse.json(await recallAudit(p.get("folder")));
      case "list": {
        const nodes = await listDir(path);
        return NextResponse.json({ ok: true, path: normalize(path), nodes: nodes.map(strip) });
      }
      case "read": {
        const node = await getNode(path);
        if (!node) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
        return NextResponse.json({ ok: true, node });
      }
      case "stat": {
        const node = await getNode(path);
        const size = node?.kind === "dir" ? await folderSize(path) : null;
        return NextResponse.json({ ok: true, node: node ? strip(node) : null, folder: size });
      }
      case "versions":
        return NextResponse.json({ ok: true, versions: await versionsOf(path) });
      case "trash": {
        // Do not transfer every trashed file body into the server merely to
        // discard it before responding. This is still an unpaginated listing.
        const { content, ...columns } = getTableColumns(vfsNodes);
        const rows = await db.select({ ...columns, hasContent: sql<boolean>`${content} <> ''` }).from(vfsNodes)
          .where(eq(vfsNodes.trashed, true)).orderBy(desc(vfsNodes.updatedAt));
        return NextResponse.json({ ok: true, nodes: rows.map((n) => ({ ...n, base: baseName(n.path) })) });
      }
      case "media": {
        // TT54 (MD-03): the Photos library in ONE query — every image / video outside /System and the trash, plus the
        // edit sidecars (".<name>.edit.json") so the library knows which photos carry a recipe. Content is not loaded.
        const rows = await db.select({ id: vfsNodes.id, version: vfsNodes.version, path: vfsNodes.path, name: vfsNodes.name, mime: vfsNodes.mime, size: vfsNodes.size, sha256: vfsNodes.sha256, createdAt: vfsNodes.createdAt, updatedAt: vfsNodes.updatedAt })
          .from(vfsNodes)
          .where(and(eq(vfsNodes.kind, "file"), eq(vfsNodes.trashed, false), not(like(vfsNodes.path, "/System/%")),
            or(like(vfsNodes.mime, "image/%"), like(vfsNodes.mime, "video/%"), like(vfsNodes.name, ".%.edit.json"))))
          .orderBy(desc(vfsNodes.updatedAt)).limit(20000);
        return NextResponse.json({ ok: true, items: rows });
      }
      case "find": {
        // TT55 (FM-16): deep name search under `path` — the quick filter's "search subfolders". The query is LIKE-escaped
        // (a typed % or _ is literal), trash is excluded, dotfiles only with hidden=1, /System only when searching inside it.
        const q = (p.get("q") ?? "").trim().slice(0, 200);
        if (!q) return NextResponse.json({ ok: true, nodes: [], truncated: false });
        const hidden = p.get("hidden") === "1";
        const root = normalize(path); const base = root === "/" ? "" : root;
        const rows = await db.select().from(vfsNodes).where(and(
          like(vfsNodes.path, `${escapeLike(base)}/%`), ilike(vfsNodes.name, `%${escapeLike(q)}%`), eq(vfsNodes.trashed, false),
          ...(hidden ? [] : [not(like(vfsNodes.name, ".%"))]),
          ...(root.startsWith("/System") ? [] : [not(like(vfsNodes.path, "/System/%"))]),
        )).orderBy(vfsNodes.path).limit(201);
        return NextResponse.json({ ok: true, nodes: rows.slice(0, 200).map(strip), truncated: rows.length > 200 });
      }
      case "tree": {
        const rows = await db.select().from(vfsNodes)
          .where(and(eq(vfsNodes.kind, "dir"), eq(vfsNodes.trashed, false)));
        return NextResponse.json({ ok: true, dirs: rows.map((r) => r.path).sort() });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown op ${op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  await bootstrap();
  const body = (await readJsonObject(req)) as (Record<string, string | boolean | undefined>) | Response;
  if (body instanceof Response) return body;
  const op = String(body.op ?? "");
  try {
    switch (op) {
      case "recallPair": return NextResponse.json(await recallLifecycle(body));
      case "recallOrphan": return NextResponse.json(await recallOrphanTrash(body));
      case "recallCommit": return NextResponse.json(await atomicRecallCommit(body));
      case "writeIfUnchanged": { // folder sync: either create only if absent or replace exactly the previewed version
        const b = body as unknown as Record<string, unknown>;
        if (typeof b.path !== "string" || typeof b.content !== "string" || !Object.hasOwn(b, "expected")) {
          return NextResponse.json({ ok: false, error: "path, content and expected are required" }, { status: 400 });
        }
        const x = b.expected;
        if (x !== null && (!x || typeof x !== "object" || Array.isArray(x)
          || !Number.isSafeInteger((x as ExpectedFile).id) || (x as ExpectedFile).id <= 0
          || !Number.isSafeInteger((x as ExpectedFile).version) || (x as ExpectedFile).version <= 0
          || typeof (x as ExpectedFile).sha256 !== "string" || !/^[0-9a-f]{64}$/.test((x as ExpectedFile).sha256))) {
          return NextResponse.json({ ok: false, error: "expected must be null or a file id, version and SHA-256" }, { status: 400 });
        }
        if (b.encoding !== undefined && b.encoding !== "utf8" && b.encoding !== "base64") return NextResponse.json({ ok: false, error: "invalid encoding" }, { status: 400 });
        if (b.mime !== undefined && typeof b.mime !== "string") return NextResponse.json({ ok: false, error: "invalid MIME type" }, { status: 400 });
        return NextResponse.json(await conditionalWriteFile(b.path, b.content, x as ExpectedFile | null, b.encoding ?? "utf8", b.mime as string | undefined));
      }
      case "write":
        if (body.encoding === "base64") refuseEncryptedOverwrite(await getNode(normalize(String(body.path))), String(body.content ?? ""), body.replaceEncrypted);
        return NextResponse.json(await writeFile({
          path: String(body.path), content: String(body.content ?? ""),
          encoding: (body.encoding as "utf8" | "base64") ?? "utf8",
          mime: body.mime ? String(body.mime) : undefined,
          reason: body.reason ? String(body.reason) : "write",
          expectedPhoto: parseExpectedPhoto((body as Record<string, unknown>).expectedPhoto, String(body.path)),
          expectedRecipe: (body as Record<string, unknown>).expectedRecipe,
          // TT69 (FF-15): a recovery draft is rewritten every few seconds while someone types; snapshotting each one
          // would grow the version table without bound. Only drafts in the recovery folders skip it (a /Private
          // draft's path is encrypted, so the whole private store qualifies).
          ...(isDraftWrite(body) ? { snapshot: false } : {}),
        }));
      case "mkdir":
        return NextResponse.json(await mkdir(String(body.path)));
      case "move":
        return NextResponse.json(await transferNode(String(body.src), String(body.dst), "move"));
      case "copy":
        return NextResponse.json(await transferNode(String(body.src), String(body.dst), "copy"));
      case "rename": {
        const src = normalize(String(body.path));
        const dst = `${parentOf(src) === "/" ? "" : parentOf(src)}/${String(body.name)}`;
        return NextResponse.json(await transferNode(src, dst, "move"));
      }
      case "trash":
        return NextResponse.json(await followSidecar(await trashNode(String(body.path)), String(body.path), "trash"));
      case "restore":
        return NextResponse.json(await followSidecar(await restoreNode(String(body.path)), String(body.path), "restore"));
      case "purge":
        return NextResponse.json(await followSidecar(await purgeNode(String(body.path), parseExpectedPhoto((body as Record<string, unknown>).expectedPhoto, String(body.path)), (body as Record<string, unknown>).expectedRecipe), String(body.path), "purge"));
      case "dropVersions":
        return NextResponse.json(await dropVersions(String(body.path)));
      case "batchRename": {
        // pattern tokens: {n} index, {name} original stem, {ext} extension
        const dir = normalize(String(body.path));
        const pattern = String(body.pattern ?? "{name}");
        const start = Number(body.start ?? 1);
        // TT55 (FM-15): `paths` restricts the rename to the selected files of this folder (in the given order)
        const only = Array.isArray(body.paths) ? (body.paths as unknown[]).map((x) => normalize(String(x))) : null;
        const listed = (await listDir(dir)).filter((n) => n.kind === "file" && !isSidecar(n.path));
        const nodes = only ? only.map((q) => listed.find((n) => n.path === q)).filter((n): n is (typeof listed)[number] => !!n) : listed;
        const results: { from: string; to: string; ok: boolean; error?: string }[] = [];
        let i = start;
        for (const n of nodes) {
          const dot = n.name.lastIndexOf(".");
          const stem = dot > 0 ? n.name.slice(0, dot) : n.name;
          const ext = dot > 0 ? n.name.slice(dot + 1) : "";
          const next = pattern
            .replace(/\{n\}/g, String(i).padStart(2, "0"))
            .replace(/\{name\}/g, stem)
            .replace(/\{ext\}/g, ext);
          const to = `${dir === "/" ? "" : dir}/${next}`;
          i += 1;
          if (to === n.path) { results.push({ from: n.path, to, ok: true }); continue; }
          try {
            await transferNode(n.path, to, "move");
            results.push({ from: n.path, to, ok: true });
          } catch (e) {
            results.push({ from: n.path, to, ok: false, error: String((e as Error).message) });
          }
        }
        return NextResponse.json({ ok: true, results });
      }
      case "upload": {
        // base64 payload from the browser; size guard lives in writeFile
        const path = normalize(String(body.path));
        refuseEncryptedOverwrite(await getNode(path), String(body.content ?? ""), body.replaceEncrypted);
        return NextResponse.json(await writeFile({
          path, content: String(body.content ?? ""), encoding: "base64",
          mime: body.mime ? String(body.mime) : undefined, reason: "upload",
        }));
      }
      case "compress": {
        // FM-05: folder or file → .zip node (journaled write like any other)
        // TT55 (FM-15): `paths` (siblings) → one archive of the whole selection, names relative to their parent.
        // Descendants are fetched by an escaped prefix match (the old code loaded every VFS row to filter in JS).
        const srcs = Array.isArray(body.paths) && body.paths.length ? (body.paths as unknown[]).map((x) => normalize(String(x))) : [normalize(String(body.path))];
        const parents = new Set(srcs.map(parentOf));
        if (srcs.length > 1 && parents.size > 1) throw new Error("the selected items must be in the same folder");
        const single = srcs.length === 1 ? await getNode(srcs[0]) : null;
        if (srcs.length === 1 && !single) throw new Error(`not found: ${srcs[0]}`);
        const dst = normalize(String(body.dst ?? (srcs.length === 1 ? `${srcs[0]}.zip` : `${[...parents][0] === "/" ? "" : [...parents][0]}/Archive.zip`)));
        const all: (typeof vfsNodes.$inferSelect)[] = [];
        for (const src of srcs) {
          const root = await getNode(src);
          if (!root || root.trashed) throw new Error(`not found: ${src}`);
          if (root.kind === "dir") all.push(...await db.select().from(vfsNodes).where(and(like(vfsNodes.path, `${escapeLike(src === "/" ? "" : src)}/%`), eq(vfsNodes.trashed, false), eq(vfsNodes.kind, "file"))));
          else all.push(root);
          if (all.length > 2000) throw new Error("more than 2 000 files — refusing to build an archive that large in one request");
        }
        // a single folder keeps its historic layout (entries relative to the folder); anything else is relative to the parent
        const base = single?.kind === "dir" ? srcs[0] : [...parents][0];
        // TT79 (FF-69/FF-70): the isomorphic engine — UTF-8 names, ZIP64 when needed, optional WinZip AES-256 / ZipCrypto
        const password = body.password ? String(body.password) : undefined;
        const zipBuf = Buffer.from(await writeArchive(all.map((n) => ({
          name: n.path.slice(base === "/" ? 1 : base.length + 1),
          data: new Uint8Array(Buffer.from(n.content, n.encoding === "base64" ? "base64" : "utf8")),
          mtime: n.updatedAt,
        })), { password, encryption: body.encryption === "zipcrypto" ? "zipcrypto" : "aes256", deflate: (d) => deflateRawSync(d) }));
        const r = await writeFile({ path: dst, content: zipBuf.toString("base64"), encoding: "base64", mime: "application/zip", reason: "compress" });
        return NextResponse.json({ ...r, entries: all.length });
      }
      case "extract": {
        // FM-05: zip → folder. Guards run on the central directory BEFORE any
        // write; every entry's CRC is verified; nothing is written if any check fails.
        const src = normalize(String(body.path));
        const node = await getNode(src);
        if (!node) throw new Error(`not found: ${src}`);
        const buf = Buffer.from(node.content, node.encoding === "base64" ? "base64" : "utf8");
        // TT79: every method the engine reads (stored/deflate/Deflate64/bzip2/LZMA), ZIP64, CP437/UTF-8 names,
        // ZipCrypto + WinZip AES with `password`; `entries` limits the extraction to a selection. Guards (zip-slip,
        // symlinks, duplicates, overlap, ratio, sizes) run on the directory BEFORE any write; CRC / AES MAC verified.
        const arc = readArchive(new Uint8Array(buf), undefined, (["auto", "cp437", "utf8"].includes(String(body.nameMode)) ? body.nameMode : "auto") as NameMode);
        const pick = Array.isArray(body.entries) ? new Set((body.entries as unknown[]).map(String)) : null;
        const entries = arc.entries.filter((e) => !e.dir && (!pick || pick.has(e.name)));
        const blocked = entries.filter((e) => !extractable(e));
        if (blocked.length) throw new Error(`refused: ${blocked.length} entr${blocked.length === 1 ? "y is" : "ies are"} unsafe (${blocked.slice(0, 3).map((e) => `${e.name}${e.symlink ? " → symlink" : e.duplicate ? " → duplicate" : " → escapes the folder"}`).join(", ")}) — nothing was extracted`);
        const dest = normalize(String(body.dst ?? src.replace(/\.zip$/i, "")));
        const staged: { path: string; data: Buffer }[] = [];
        try {
          for (const e of entries) staged.push({ path: normalize(`${dest}/${e.safePath}`), data: Buffer.from(await readEntry(new Uint8Array(buf), e, { password: body.password !== undefined ? String(body.password) : undefined })) });
        } catch (err) {
          if (err instanceof PasswordError) return NextResponse.json({ ok: false, error: err.message, needPassword: true }, { status: 401 });
          throw err;
        }
        for (const s of staged) {
          if (!s.path.startsWith(`${dest}/`)) throw new Error(`entry escapes destination: ${s.path}`);
          if (s.data.length > MAX_BYTES) throw new Error(`${s.path} exceeds the ${MAX_BYTES}-byte store limit`);
        }
        let written = 0;
        for (const s of staged) {
          const text = s.data.toString("utf8");
          const isText = !text.includes("\u0000") && Buffer.from(text, "utf8").equals(s.data);
          await writeFile({ path: s.path, content: isText ? text : s.data.toString("base64"), encoding: isText ? "utf8" : "base64", reason: "extract" });
          written += 1;
        }
        return NextResponse.json({ ok: true, dest, written });
      }
      case "tag":
        return NextResponse.json(await setTags(String(body.path), String(body.tags ?? "")));
      default:
        return NextResponse.json({ ok: false, error: `unknown op ${op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message ?? err) }, { status: err instanceof ConditionalWriteConflict || err instanceof PhotoRecipeConflict ? 409 : 400 });
  }
}

/** Directory listings never carry file bodies — a 10k-row folder must stay cheap. */
function strip(n: typeof vfsNodes.$inferSelect) {
  const { content, ...rest } = n;
  return { ...rest, hasContent: content.length > 0, base: baseName(n.path) };
}

/** TT69: draft writes that skip the version snapshot — reason AND location must both say "recovery draft" */
function isDraftWrite(body: Record<string, unknown>): boolean {
  const p = normalize(String(body.path ?? ""));
  return body.reason === "recovery-draft" && (p.startsWith("/System/Recovery/") || p.startsWith("/Private/"));
}
