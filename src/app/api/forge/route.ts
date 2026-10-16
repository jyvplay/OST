import { NextResponse, type NextRequest } from "next/server";
import { refuseEncrypted } from "@/lib/mime";
import { getNode } from "@/lib/server/vfs";
import { extractEpub, extractOoxml, readCentralDirectory, readPsdHeader } from "@/lib/server/zip";
import { readPsd } from "@/lib/image/psd";

export const dynamic = "force-dynamic";

/**
 * Forge server engine. Runs the risky parsing off the UI thread *and* off the
 * client entirely, with hard guards. Grades are returned with the payload so no
 * surface can display converted content without its fidelity grade.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { op?: string; path?: string; base64?: string };
  const op = body.op ?? "extract";
  try {
    let buf: Buffer | null = null;
    let name = body.path ?? "upload";
    if (body.base64) {
      buf = Buffer.from(body.base64, "base64");
    } else if (body.path) {
      const node = await getNode(body.path);
      if (!node) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
      try { refuseEncrypted(node); } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 422 }); }
      name = node.name;
      buf = Buffer.from(node.content, node.encoding === "base64" ? "base64" : "utf8");
    }
    if (!buf) return NextResponse.json({ ok: false, error: "path or base64 required" }, { status: 400 });
    if (buf.length > 16 * 1024 * 1024) return NextResponse.json({ ok: false, error: "over 16 MB parse guard" }, { status: 413 });

    if (op === "psd" || name.toLowerCase().endsWith(".psd") || name.toLowerCase().endsWith(".psb")) {
      const header: ReturnType<typeof readPsdHeader> & { decodeError?: string } = readPsdHeader(buf);
      // TT16: full first-party decode (layers, blend, masks) when the file is complete and supported.
      try {
        const { doc, warnings, info } = await readPsd(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        const layers = doc.layers.map((l) => ({ name: l.name, x: l.x, y: l.y, w: l.w, h: l.h, opacity: Math.round(l.opacity * 100), blend: l.blend, visible: l.visible, mask: !!l.mask }));
        return NextResponse.json({
          ok: true, name, kind: "psd", grade: "B", engine: "first-party PSD codec (src/lib/image/psd.ts)",
          boundary: "Pixel layers, offsets, opacity, visibility, 12 separable blend modes, masks and Unicode names are decoded and editable in the Image Editor. Effects, adjustment/type/smart layers render from stored pixels only.",
          dropped: warnings,
          text: [`${doc.width}×${doc.height}, mode ${info.mode}, ${layers.length} layer(s), compression ${info.compression.join("/")}`, ...layers.map((l) => `• ${l.name} — ${l.blend} ${l.opacity}%${l.visible ? "" : " (hidden)"}${l.mask ? " +mask" : ""} @${l.x},${l.y} ${l.w}×${l.h}`)].join("\n"),
          parts: [], header, layers, editable: "imageedit",
        });
      } catch (e) {
        header.decodeError = (e as Error).message;
      }
      return NextResponse.json({
        ok: true, name, kind: "psd", grade: "E", engine: "first-party PSD header reader",
        boundary: "Header and section metadata only. Pixels and layers are not decoded or editable.",
        dropped: ["pixel data", "layer contents", "effects", "smart objects"],
        text: Object.entries(header).map(([k, v]) => `${k}: ${v}`).join("\n"), parts: [], header,
      });
    }
    if (op === "epub" || name.toLowerCase().endsWith(".epub")) {
      const book = extractEpub(buf);
      return NextResponse.json({
        ok: true, name, kind: "epub", grade: "C", engine: "zip + OPF spine reader",
        boundary: "Reading order and text are preserved; styling, images and footnote links are not.",
        dropped: ["CSS styling", "images", "internal links"],
        text: `# ${book.title}${book.author ? `\n_${book.author}_` : ""}\n\n` +
          book.chapters.map((c) => `## Chapter ${c.index}\n\n${c.text}`).join("\n\n").slice(0, 400_000),
        parts: book.chapters.map((c) => c.href),
      });
    }
    if (op === "listZip") {
      const entries = readCentralDirectory(buf);
      return NextResponse.json({ ok: true, name, entries, grade: "B", engine: "node:zlib + central-directory parser" });
    }
    const result = extractOoxml(buf);
    return NextResponse.json({
      ok: true,
      name,
      kind: result.kind,
      grade: result.kind === "zip" ? "B" : "D",
      engine: "node:zlib inflateRaw + XML text extraction",
      boundary: "Extraction and conversion only. This engine cannot round-trip Office documents; saving back is disabled.",
      dropped: result.dropped,
      text: result.text.slice(0, 400_000),
      parts: result.parts.slice(0, 200),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 400 });
  }
}
