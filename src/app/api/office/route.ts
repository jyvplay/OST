import { NextResponse, type NextRequest } from "next/server";
import { getNode } from "@/lib/server/vfs";
import { readDocx, writeDocx, type DocModel } from "@/lib/office/docx";
import { readPptx, writePptx, type DeckModel } from "@/lib/office/pptx";

export const dynamic = "force-dynamic";
const LIMIT = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const b = (await req.json()) as { op?: string; path?: string; base64?: string; document?: DocModel; deck?: DeckModel };
  try {
    if (b.op === "importDocx" || b.op === "importPptx") {
      let bytes: Buffer;
      if (b.base64) bytes = Buffer.from(b.base64, "base64");
      else if (b.path) {
        const n = await getNode(b.path);
        if (!n) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
        bytes = Buffer.from(n.content, n.encoding === "base64" ? "base64" : "utf8");
      } else throw new Error("path or base64 required");
      if (bytes.length > LIMIT) throw new Error("Office file exceeds the 8 MB parsing guard");
      if (b.op === "importDocx") {
        const document = readDocx(bytes);
        return NextResponse.json({ ok: true, document, grade: "C", engine: "first-party OOXML paragraph/table parser", losses: ["pagination/layout", "images/drawings", "headers/footers", "footnotes/endnotes", "numbering definitions", "comments/tracked changes", "fields/macros", "theme inheritance"] });
      }
      const deck = readPptx(bytes);
      return NextResponse.json({ ok: true, deck, grade: "C", engine: "first-party PresentationML text-shape parser", losses: ["positioning", "fonts/styles", "images/charts", "notes", "animation/transitions", "audio/video", "master/layout inheritance"] });
    }
    if (b.op === "exportDocx") {
      if (!b.document) throw new Error("document required");
      const out = writeDocx(b.document);
      return NextResponse.json({ ok: true, base64: out.toString("base64"), bytes: out.length, grade: "C" });
    }
    if (b.op === "exportPptx") {
      if (!b.deck) throw new Error("deck required");
      const out = writePptx(b.deck);
      return NextResponse.json({ ok: true, base64: out.toString("base64"), bytes: out.length, grade: "C" });
    }
    return NextResponse.json({ ok: false, error: "unknown operation" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 400 });
  }
}
