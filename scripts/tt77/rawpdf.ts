// TT77 test-only: build a PDF from raw object bodies (1-based; object 1 must be the Catalog). Streams: { dict, data }.
export type RawObj = string | { dict: string; data: string | Uint8Array };
export function rawpdf(objs: RawObj[]): Uint8Array {
  const enc = new TextEncoder(); const parts: Uint8Array[] = []; let len = 0; const offs: number[] = [];
  const push = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; parts.push(u); len += u.length; };
  push("%PDF-1.7\n%\xe2\xe3\n");
  objs.forEach((o, i) => {
    offs.push(len); push(`${i + 1} 0 obj\n`);
    if (typeof o === "string") push(o);
    else { const d = typeof o.data === "string" ? enc.encode(o.data) : o.data; push(`<< ${o.dict} /Length ${d.length} >>\nstream\n`); push(d); push("\nendstream"); }
    push("\nendobj\n");
  });
  const x = len; push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (const o of offs) push(`${String(o).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);
  const out = new Uint8Array(len); let k = 0; for (const p of parts) { out.set(p, k); k += p.length; } return out;
}
/** a one-page document: page content + resources (object refs inside `res` count from 4) + extra objects */
export function onePage(content: string, res: string, extra: RawObj[] = [], w = 100, h = 100, pageExtra = ""): Uint8Array {
  return rawpdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources ${res} /Contents ${4 + extra.length} 0 R ${pageExtra} >>`, ...extra, { dict: "", data: content }]);
}
