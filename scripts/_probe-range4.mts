import { Workbook } from "../src/lib/formula/engine.ts";
for (const f of ["=SUMIFS(Data!B:B,Data!A:A,\">0\")", "=SUMIF(Data!A:A,\">0\",B:B)", "=COUNTIFS(A:A,\">0\",Data!A:A,\">0\")", "=SUMPRODUCT(A:A,Data!A:A)", "=SUMIFS(B:B,Data!A:A,\">0\")"]) {
  const wb = new Workbook(); const s = wb.sheet(); const d = wb.addSheet("Data");
  for (let r = 0; r < 20; r++) { d.setCell(0, r, String(r + 1)); d.setCell(1, r, "1"); }
  s.setCell(0, 0, "1"); s.setCell(1, 0, "2"); s.setCell(1, 1, "3"); s.setCell(4, 0, f); wb.recalculate();
  console.log(f.padEnd(42), JSON.stringify(wb.sheet().get(4, 0)?.value));
}
