import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { vfsNodes } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import {
  folderSize, getNode, listDir, mkdir, normalize, purgeNode, dropVersions, restoreNode,
  transferNode, trashNode, versionsOf, writeFile, baseName, parentOf, MAX_BYTES,
} from "@/lib/server/vfs";
import { readCentralDirectory, readEntryVerified, writeZip } from "@/lib/server/zip";
import { readJsonObject } from "@/lib/http-json";
import { refuseEncryptedOverwrite } from "@/lib/mime";

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
        return NextResponse.json(await trashNode(String(body.path)));
      case "restore":
        return NextResponse.json(await restoreNode(String(body.path)));
      case "purge":
        return NextResponse.json(await purgeNode(String(body.path)));
      case "dropVersions":
        return NextResponse.json(await dropVersions(String(body.path)));
      case "batchRename": {
        // pattern tokens: {n} index, {name} original stem, {ext} extension
        const dir = normalize(String(body.path));
        const pattern = String(body.pattern ?? "{name}");
        const start = Number(body.start ?? 1);
        const nodes = (await listDir(dir)).filter((n) => n.kind === "file");
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
        const src = normalize(String(body.path));
        const dst = normalize(String(body.dst ?? `${src}.zip`));
        const root = await getNode(src);
        if (!root) throw new Error(`not found: ${src}`);
        const all = root.kind === "dir"
          ? (await db.select().from(vfsNodes).where(eq(vfsNodes.trashed, false)))
              .filter((n) => n.kind === "file" && n.path.startsWith(`${src}/`))
          : [root];
        if (all.length > 2000) throw new Error("more than 2 000 files — refusing to build an archive that large in one request");
        const base = root.kind === "dir" ? src : parentOf(src);
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
