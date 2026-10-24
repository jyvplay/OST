import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, ilike, like, not, or } from "drizzle-orm";
import { db } from "@/db";
import { vfsNodes } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import {
  folderSize, getNode, listDir, mkdir, normalize, purgeNode, dropVersions, restoreNode,
  transferNode, trashNode, versionsOf, writeFile, baseName, parentOf, MAX_BYTES, escapeLike,
} from "@/lib/server/vfs";
import { readCentralDirectory, readEntryVerified, writeZip } from "@/lib/server/zip";
import { readJsonObject } from "@/lib/http-json";
import { refuseEncryptedOverwrite } from "@/lib/mime";
import { sidecarPath, isSidecar } from "@/lib/photos/recipe";

/**
 * TT54 (MD-03): a photo's non-destructive edit lives in the hidden sidecar ".<name>.edit.json" beside it. Whatever
 * client moves / copies / renames / trashes / restores / purges the photo (Files, desktop, terminal, API), the sidecar
 * follows, so an edit is never orphaned or attached to the wrong picture. Best effort AFTER the primary op succeeded:
 * a sidecar failure is reported in the response, never undoes the user's operation.
 */
async function followSidecar<T extends object>(res: T, src: string, op: "move" | "copy" | "trash" | "restore" | "purge", dst?: string): Promise<T & { sidecar?: string }> {
  const from = normalize(src);
  if (isSidecar(from)) return res;
  const sc = sidecarPath(from);
  try {
    const node = await getNode(sc);
    if (!node) return res;
    if (op === "move" || op === "copy") { const to = sidecarPath(normalize(dst!)); if (await getNode(to)) await purgeNode(to); await transferNode(sc, to, op); }
    else if (op === "trash") await trashNode(sc);
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
        const rows = await db.select().from(vfsNodes).where(eq(vfsNodes.trashed, true)).orderBy(desc(vfsNodes.updatedAt));
        return NextResponse.json({ ok: true, nodes: rows.map(strip) });
      }
      case "media": {
        // TT54 (MD-03): the Photos library in ONE query — every image / video outside /System and the trash, plus the
        // edit sidecars (".<name>.edit.json") so the library knows which photos carry a recipe. Content is not loaded.
        const rows = await db.select({ path: vfsNodes.path, name: vfsNodes.name, mime: vfsNodes.mime, size: vfsNodes.size, sha256: vfsNodes.sha256, createdAt: vfsNodes.createdAt, updatedAt: vfsNodes.updatedAt })
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
      case "write":
        if (body.encoding === "base64") refuseEncryptedOverwrite(await getNode(normalize(String(body.path))), String(body.content ?? ""), body.replaceEncrypted);
        return NextResponse.json(await writeFile({
          path: String(body.path), content: String(body.content ?? ""),
          encoding: (body.encoding as "utf8" | "base64") ?? "utf8",
          mime: body.mime ? String(body.mime) : undefined,
          reason: body.reason ? String(body.reason) : "write",
          // TT69 (FF-15): a recovery draft is rewritten every few seconds while someone types; snapshotting each one
          // would grow the version table without bound. Only drafts in the recovery folders skip it (a /Private
          // draft's path is encrypted, so the whole private store qualifies).
          ...(isDraftWrite(body) ? { snapshot: false } : {}),
        }));
      case "mkdir":
        return NextResponse.json(await mkdir(String(body.path)));
      case "move":
        return NextResponse.json(await followSidecar(await transferNode(String(body.src), String(body.dst), "move"), String(body.src), "move", String(body.dst)));
      case "copy":
        return NextResponse.json(await followSidecar(await transferNode(String(body.src), String(body.dst), "copy"), String(body.src), "copy", String(body.dst)));
      case "rename": {
        const src = normalize(String(body.path));
        const dst = `${parentOf(src) === "/" ? "" : parentOf(src)}/${String(body.name)}`;
        return NextResponse.json(await followSidecar(await transferNode(src, dst, "move"), src, "move", dst));
      }
      case "trash":
        return NextResponse.json(await followSidecar(await trashNode(String(body.path)), String(body.path), "trash"));
      case "restore":
        return NextResponse.json(await followSidecar(await restoreNode(String(body.path)), String(body.path), "restore"));
      case "purge":
        return NextResponse.json(await followSidecar(await purgeNode(String(body.path)), String(body.path), "purge"));
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
            await followSidecar(await transferNode(n.path, to, "move"), n.path, "move", to);
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
        const zipBuf = writeZip(all.map((n) => ({
          name: n.path.slice(base === "/" ? 1 : base.length + 1),
          data: Buffer.from(n.content, n.encoding === "base64" ? "base64" : "utf8"),
          mtime: n.updatedAt,
        })));
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
        const entries = readCentralDirectory(buf).filter((e) => !e.name.endsWith("/"));
        const dest = normalize(String(body.dst ?? src.replace(/\.zip$/i, "")));
        const staged = entries.map((e) => ({ path: normalize(`${dest}/${e.name}`), data: readEntryVerified(buf, e) }));
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
      case "tag": {
        const path = normalize(String(body.path));
        await db.update(vfsNodes).set({ tags: String(body.tags ?? "") }).where(eq(vfsNodes.path, path));
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown op ${op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 400 });
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
