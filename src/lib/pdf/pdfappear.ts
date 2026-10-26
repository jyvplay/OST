/**
 * TT52 — default appearances for annotations that carry no /AP (ISO 32000-2 §12.5.5 says a viewer may synthesise
 * one; Acrobat and PDFium do for the markup types below). Content is produced in default user space (page
 * coordinates) so the interpreter can run it directly. Original code from the specification.
 */
import { N, PDict, PStr, isArr, isName, textString, type PObj } from "./pdfobj";
import type { PdfDoc } from "./pdfdoc";
import { helvWidth, wrap, pdfLiteralWinAnsi } from "./pdftextfit";

const f = (n: number) => (Number.isFinite(n) ? (Math.round(n * 1000) / 1000).toString() : "0");
function colorOps(c: number[], stroke: boolean): string {
  if (c.length === 1) return `${f(c[0])} ${stroke ? "G" : "g"}`;
  if (c.length === 3) return `${c.map(f).join(" ")} ${stroke ? "RG" : "rg"}`;
  if (c.length === 4) return `${c.map(f).join(" ")} ${stroke ? "K" : "k"}`;
  return "";
}
export interface SynthAppearance { content: string; resources: PDict }

/** a content stream (user space) for an annotation without an appearance, or null when the type has none */
export function synthAppearance(doc: PdfDoc, a: PDict): SynthAppearance | null {
  const st = doc.resolve(a.get("Subtype")); if (!isName(st)) return null; const type = st.n;
  const nums = (o: PObj | undefined) => doc.arr(o).map((v) => doc.num(v));
  const rect = nums(a.get("Rect")); if (rect.length !== 4) return null;
  const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const C = nums(a.get("C")); const IC = nums(a.get("IC"));
  const bs = doc.dict(a.get("BS")); const border = nums(a.get("Border"));
  let w = bs && bs.has("W") ? doc.num(bs.get("W"), 1) : border.length >= 3 ? border[2] : 1;
  const dash = bs && isName(doc.resolve(bs.get("S")), "D") ? nums(bs.get("D")) : [];
  const ca = a.has("CA") ? doc.num(a.get("CA"), 1) : 1;
  const res = new PDict(); let pre = "";
  if (ca < 1 || type === "Highlight") {
    const g = new PDict().set("CA", ca).set("ca", ca); if (type === "Highlight") g.set("BM", N("Multiply"));
    res.set("ExtGState", new PDict().set("GS0", g)); pre += "/GS0 gs ";
  }
  const strokeC = C.length ? colorOps(C, true) : "";
  const lineSetup = () => `${f(w)} w ${dash.length ? `[${dash.map(f).join(" ")}] 0 d ` : ""}`;
  const quads = () => { const q = nums(a.get("QuadPoints")); const out: number[][] = []; for (let i = 0; i + 7 < q.length; i += 8) out.push(q.slice(i, i + 8)); return out.length ? out : [[x0, y1, x1, y1, x0, y0, x1, y0]]; };
  switch (type) {
    case "Square": case "Circle": {
      if (!C.length && !IC.length) return null; if (!C.length) w = 0;
      const x = x0 + w / 2, y = y0 + w / 2, W = x1 - x0 - w, H = y1 - y0 - w; if (W <= 0 || H <= 0) return null;
      let path: string;
      if (type === "Square") path = `${f(x)} ${f(y)} ${f(W)} ${f(H)} re`;
      else { const k = 0.5523, cx = x + W / 2, cy = y + H / 2, rx = W / 2, ry = H / 2; path = `${f(cx + rx)} ${f(cy)} m ${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c ${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c h`; }
      const op = IC.length && C.length && w > 0 ? "B" : IC.length ? "f" : "S";
      return { content: `${pre}${IC.length ? colorOps(IC, false) + " " : ""}${strokeC} ${lineSetup()}${path} ${op}`, resources: res };
    }
    case "Line": {
      const L = nums(a.get("L")); if (L.length !== 4 || !C.length) return null;
      return { content: `${pre}${strokeC} ${lineSetup()}${f(L[0])} ${f(L[1])} m ${f(L[2])} ${f(L[3])} l S`, resources: res };
    }
    case "Polygon": case "PolyLine": {
      const v = nums(a.get("Vertices")); if (v.length < 4 || (!C.length && !IC.length)) return null;
      let p = `${f(v[0])} ${f(v[1])} m`; for (let i = 2; i + 1 < v.length; i += 2) p += ` ${f(v[i])} ${f(v[i + 1])} l`;
      const close = type === "Polygon"; const op = close ? (IC.length && C.length ? "b" : IC.length ? "f" : "s") : "S";
      return { content: `${pre}${close && IC.length ? colorOps(IC, false) + " " : ""}${strokeC} ${lineSetup()}${p} ${op}`, resources: res };
    }
    case "Ink": {
      const ink = doc.arr(a.get("InkList")); if (!ink.length || !C.length) return null;
      let p = ""; for (const s of ink) { const v = nums(s); if (v.length < 2) continue; p += `${f(v[0])} ${f(v[1])} m`; if (v.length === 2) p += ` ${f(v[0])} ${f(v[1])} l`; for (let i = 2; i + 1 < v.length; i += 2) p += ` ${f(v[i])} ${f(v[i + 1])} l`; p += " "; }
      return { content: `${pre}${strokeC} ${lineSetup()}1 J 1 j ${p}S`, resources: res };
    }
    case "Highlight": {
      const col = C.length ? C : [1, 1, 0];
      return { content: `${pre}${colorOps(col, false)} ` + quads().map((q) => `${f(q[0])} ${f(q[1])} m ${f(q[2])} ${f(q[3])} l ${f(q[6])} ${f(q[7])} l ${f(q[4])} ${f(q[5])} l h`).join(" ") + " f", resources: res };
    }
    case "Underline": case "StrikeOut": case "Squiggly": {
      if (!C.length) return null; let out = `${pre}${strokeC} `;
      for (const q of quads()) {
        // baseline from the lower edge (points 3→4), height from the upper edge
        const bx0 = q[4], by0 = q[5], bx1 = q[6], by1 = q[7]; const h = Math.hypot(q[0] - q[4], q[1] - q[5]) || 10;
        const lw = Math.max(0.5, h / 14); const ux = (q[0] - q[4]) / h, uy = (q[1] - q[5]) / h;
        const off = type === "StrikeOut" ? h * 0.4 : h * 0.08;
        const sx = bx0 + ux * off, sy = by0 + uy * off, ex = bx1 + ux * off, ey = by1 + uy * off;
        if (type === "Squiggly") { const len = Math.hypot(ex - sx, ey - sy); const n = Math.max(2, Math.round(len / (h / 4))); let p = `${f(sx)} ${f(sy)} m`; for (let i = 1; i <= n; i++) { const t = i / n; const amp = i % 2 ? h / 10 : 0; p += ` ${f(sx + (ex - sx) * t + ux * amp)} ${f(sy + (ey - sy) * t + uy * amp)} l`; } out += `${f(lw)} w ${p} S `; }
        else out += `${f(lw)} w ${f(sx)} ${f(sy)} m ${f(ex)} ${f(ey)} l S `;
      }
      return { content: out.trim(), resources: res };
    }
    case "Text": {
      const col = C.length ? C : [1, 0.92, 0.23]; const x = x0, y = y1 - 20;
      return { content: `${pre}${colorOps(col, false)} 0 G 0.6 w ${f(x + 1)} ${f(y + 4)} 18 15 re b 0 g ${f(x + 4)} ${f(y + 14)} 12 1.2 re f ${f(x + 4)} ${f(y + 11)} 12 1.2 re f ${f(x + 4)} ${f(y + 8)} 8 1.2 re f ${colorOps(col, false)} ${f(x + 5)} ${f(y + 4)} m ${f(x + 6)} ${f(y)} l ${f(x + 10)} ${f(y + 4)} l b`, resources: res };
    }
    case "FreeText": {
      const contents = a.get("Contents"); const text = contents instanceof PStr ? textString(contents) : ""; if (!text) return null;
      const daO = doc.resolve(a.get("DA")); const da = daO instanceof PStr ? textString(daO) : "/Helv 12 Tf 0 g";
      const m = /([\d.]+)\s+Tf/.exec(da); const size = m && Number(m[1]) > 0 ? Number(m[1]) : 12;
      const colorPart = da.replace(/\/[^\s/]+\s+[\d.]+\s+Tf/, "").trim() || "0 g";
      res.set("Font", new PDict().set("Helv", new PDict().set("Type", N("Font")).set("Subtype", N("Type1")).set("BaseFont", N("Helvetica")).set("Encoding", N("WinAnsiEncoding"))));
      const lines = wrap(text, Math.max(10, x1 - x0 - 4), size);
      const body = lines.map((l, i) => `1 0 0 1 ${f(x0 + 2)} ${f(y1 - 2 - size * (i + 1) * 1.15 + size * 0.25)} Tm (${pdfLiteralWinAnsi(l)}) Tj`).join(" ");
      const frame = C.length ? `${colorOps(C, true)} ${f(Math.max(w, 0.5))} w ${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)} re S ` : "";
      return { content: `${pre}${frame}q ${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)} re W n BT /Helv ${f(size)} Tf ${colorPart} ${body} ET Q`, resources: res };
    }
    default: return null;
  }
}
export { isArr, helvWidth };
