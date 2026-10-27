/** TT52 test helper: build small, valid PDFs by hand (classic xref, Helvetica text, optional AcroForm fields). */
export interface MkPage { text: string[]; w?: number; h?: number; crop?: [number, number, number, number]; rotate?: number; userUnit?: number; indirectUserUnit?: boolean; extra?: string }
export interface MkField { name: string; type: "Tx" | "Btn" | "Ch"; rect: number[]; value?: string; flags?: number; options?: string[]; page?: number }
const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
export function mkpdf(pages: MkPage[], opts: { fields?: MkField[]; info?: Record<string, string>; corruptXref?: boolean; pagesUserUnit?: number } = {}): Uint8Array {
  const objs: string[] = []; // index = obj number - 1
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add(""); const pagesObj = add(""); const font = add("<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>");
  const pageNums: number[] = []; const annotsByPage = new Map<number, number[]>();
  const fieldNums: number[] = [];
  for (const f of opts.fields ?? []) {
    const pi = f.page ?? 0; const r = f.rect.join(" ");
    let d = `<</Type /Annot /Subtype /Widget /FT /${f.type} /T (${esc(f.name)}) /Rect [${r}] /F 4 /P ${0}__PAGE${pi}__`;
    if (f.flags) d += ` /Ff ${f.flags}`;
    if (f.type === "Tx") d += ` /DA (/Helv 0 Tf 0 g)${f.value ? ` /V (${esc(f.value)})` : ""}`;
    if (f.type === "Ch") d += ` /DA (/Helv 0 Tf 0 g) /Opt [${(f.options ?? []).map((o) => `(${esc(o)})`).join(" ")}]`;
    if (f.type === "Btn") {
      const on = add(`<</Type /XObject /Subtype /Form /BBox [0 0 ${f.rect[2] - f.rect[0]} ${f.rect[3] - f.rect[1]}] /Length 25>>\nstream\n0 g 2 2 10 10 re f\nendstream`);
      const off = add(`<</Type /XObject /Subtype /Form /BBox [0 0 ${f.rect[2] - f.rect[0]} ${f.rect[3] - f.rect[1]}] /Length 0>>\nstream\n\nendstream`);
      d += ` /V /Off /AS /Off /AP <</N <</Yes ${on} 0 R /Off ${off} 0 R>>>>`;
    }
    d += ">>"; const n = add(d); fieldNums.push(n); const l = annotsByPage.get(pi) ?? []; l.push(n); annotsByPage.set(pi, l);
  }
  pages.forEach((p, i) => {
    const content = `BT /F1 14 Tf 72 ${(p.h ?? 792) - 72} Td 18 TL ${p.text.map((t) => `(${esc(t)}) '`).join(" ")} ET${p.extra ? "\n" + p.extra : ""}`;
    const c = add(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    const annots = annotsByPage.get(i);
    const uu = p.userUnit === undefined ? "" : p.indirectUserUnit ? ` /UserUnit ${add(String(p.userUnit))} 0 R` : ` /UserUnit ${p.userUnit}`;
    const cb = p.crop ? ` /CropBox [${p.crop.join(" ")}]` : "";
    const n = add(`<</Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${p.w ?? 612} ${p.h ?? 792}]${cb}${uu} /Resources <</Font <</F1 ${font} 0 R>>>> /Contents ${c} 0 R${p.rotate ? ` /Rotate ${p.rotate}` : ""}${annots ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : ""}>>`);
    pageNums.push(n);
  });
  for (let k = 0; k < objs.length; k++) objs[k] = objs[k].replace(/0__PAGE(\d+)__/g, (_, pi) => `${pageNums[Number(pi)]} 0 R`);
  objs[pagesObj - 1] = `<</Type /Pages${opts.pagesUserUnit === undefined ? "" : ` /UserUnit ${opts.pagesUserUnit}`} /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length}>>`;
  objs[catalog - 1] = `<</Type /Catalog /Pages ${pagesObj} 0 R${fieldNums.length ? ` /AcroForm <</Fields [${fieldNums.map((n) => `${n} 0 R`).join(" ")}] /DA (/Helv 0 Tf 0 g) /DR <</Font <</Helv ${font} 0 R>>>>>>` : ""}>>`;
  let info = 0; if (opts.info) info = add(`<<${Object.entries(opts.info).map(([k, v]) => `/${k} (${esc(v)})`).join(" ")}>>`);
  let out = "%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n` + offs.map((o, i) => `${String(o + (opts.corruptXref && i === 1 ? 3 : 0)).padStart(10, "0")} 00000 n\r\n`).join("");
  out += `trailer\n<</Size ${objs.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""}>>\nstartxref\n${x}\n%%EOF\n`;
  const b = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) b[i] = out.charCodeAt(i) & 255; return b;
}
