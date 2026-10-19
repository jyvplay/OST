import { NextResponse, type NextRequest } from "next/server";
import { refuseEncrypted, refuseEncryptedOverwrite } from "@/lib/mime";
import { getNode, writeFile } from "@/lib/server/vfs";
import {
  Workbook, Sheet, writeXlsxWorkbook, readXlsxWorkbook, workbookFromJson, workbookToJson,
  isError, type WorkbookJson,
} from "@/lib/formula";
import { readJsonObject } from "@/lib/http-json";
import { patchXlsx } from "@/lib/formula/xlsx-patch";

export const dynamic = "force-dynamic";

function workbookFromBody(body: { workbook?: WorkbookJson; sheet?: { name: string; cells: { ref: string; input: string }[] } }): Workbook {
  if (body.workbook) return workbookFromJson(body.workbook);
  if (body.sheet) {
    const w = new Workbook(); w.sheets.clear();
    const s = new Sheet(body.sheet.name);
    for (const c of body.sheet.cells) {
      const m = /^([A-Z]+)(\d+)$/i.exec(c.ref);
      if (!m) continue;
      let col = 0; for (const x of m[1].toUpperCase()) col = col * 26 + x.charCodeAt(0) - 64;
      s.setCell(col - 1, Number(m[2]) - 1, c.input);
    }
    w.sheets.set(s.name, s); w.recalculate(); return w;
  }
  throw new Error("workbook required");
}
function cellsOut(wb: Workbook) {
  return Object.fromEntries([...wb.sheets.entries()].map(([name, sheet]) => [name,
    [...sheet.grid.entries()].map(([k, cell]) => {
      const [col, row] = k.split(",").map(Number);
      return { col, row, input: cell.input, value: cell.value, error: isError(cell.value) ? cell.value.error : null };
    }),
  ]));
}

export async function POST(req: NextRequest) {
  const body = (await readJsonObject(req)) as ({
    op?: "recalculate" | "exportXlsx" | "importXlsx" | "saveXlsxToVfs" | "patchXlsxToVfs";
    source?: string; renames?: Record<string, string>;
    workbook?: WorkbookJson; sheet?: { name: string; cells: { ref: string; input: string }[] };
    path?: string; dest?: string; base64?: string; sourceBase64?: string; replaceEncrypted?: boolean;
  }) | Response;
  if (body instanceof Response) return body;
  try {
    switch (body.op) {
      case "recalculate": {
        const wb = workbookFromBody(body);
        wb.recalculate();
        return NextResponse.json({ ok: true, workbook: workbookToJson(wb), values: cellsOut(wb) });
      }
      case "exportXlsx": {
        const wb = workbookFromBody(body);
        const buf = writeXlsxWorkbook(wb, [...wb.sheets.keys()][0] ?? "Workbook");
        return NextResponse.json({ ok: true, base64: buf.toString("base64"), bytes: buf.length, sheets: wb.sheets.size });
      }
      case "saveXlsxToVfs": {
        if (!body.dest) throw new Error("dest required");
        const wb = workbookFromBody(body);
        const buf = writeXlsxWorkbook(wb, [...wb.sheets.keys()][0] ?? "Workbook");
        const r = await writeFile({ path: body.dest, content: buf.toString("base64"), encoding: "base64", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", reason: "sheet-export" });
        return NextResponse.json({ ...r, bytes: buf.length, sheets: wb.sheets.size });
      }
      case "patchXlsxToVfs": {
        // TT46 lossless save: keep the original package and rewrite only what changed (xlsx-patch.ts).
        if (!body.dest || !body.source || !body.workbook) throw new Error("source, dest and workbook required");
        let orig: Buffer;
        if (typeof body.sourceBase64 === "string") {
          // TT47: the original was password-protected and decrypted in the browser; it sends the decrypted package
          if (body.sourceBase64.length > 12 * 1024 * 1024) throw new Error("xlsx exceeds the 8 MB guard");
          orig = Buffer.from(body.sourceBase64, "base64");
        } else {
          const node = await getNode(body.source);
          if (!node) throw new Error("source not found");
          refuseEncrypted(node);
          orig = Buffer.from(node.content, node.encoding === "base64" ? "base64" : "utf8");
        }
        if (orig.length > 8 * 1024 * 1024) throw new Error("xlsx exceeds the 8 MB guard");
        const renames = body.renames && typeof body.renames === "object" ? Object.fromEntries(Object.entries(body.renames).filter(([k, v]) => typeof k === "string" && typeof v === "string").slice(0, 255)) : {};
        const { bytes, report } = await patchXlsx(new Uint8Array(orig), workbookFromBody(body), renames as Record<string, string>);
        refuseEncryptedOverwrite(await getNode(body.dest), Buffer.from(bytes.subarray(0, 16)).toString("base64"), body.replaceEncrypted);
        const r = await writeFile({ path: body.dest, content: Buffer.from(bytes).toString("base64"), encoding: "base64", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", reason: "sheet-save-lossless" });
        return NextResponse.json({ ...r, bytes: bytes.length, report });
      }
      case "importXlsx": {
        let buf: Buffer;
        if (body.base64) buf = Buffer.from(body.base64, "base64");
        else if (body.path) {
          const node = await getNode(body.path);
          if (!node) throw new Error("not found");
          refuseEncrypted(node);
          buf = Buffer.from(node.content, node.encoding === "base64" ? "base64" : "utf8");
        } else throw new Error("path or base64 required");
        if (buf.length > 8 * 1024 * 1024) throw new Error("xlsx exceeds the 8 MB import guard");
        // TT47: password-protected workbooks are decrypted in the browser (the password never reaches the server)
        if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) throw new Error("this is an OLE/CFB container — a password-protected (encrypted) or legacy binary workbook");
        const wb = readXlsxWorkbook(buf);
        return NextResponse.json({ ok: true, workbook: workbookToJson(wb), values: cellsOut(wb), sheets: wb.sheets.size });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown op ${body.op}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 400 });
  }
}
