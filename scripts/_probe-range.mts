import { Workbook } from "../src/lib/formula/engine.ts";
for (const f of ["=SUM(A:A)", "=SUM(A:B)", "=SUM(A:C)", "=SUMIF(A:A,\">0\",B:B)", "=COUNTA(A:C)", "=SUMPRODUCT(A1:A1048576,B1:B1048576)"]) {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "1"); s.setCell(0, 1048575, "2"); s.setCell(1, 1048575, "10"); s.setCell(2, 1048575, "100");
  s.setCell(4, 0, f);
  const t = performance.now(); wb.recalculate(); const ms = performance.now() - t;
  console.log(f.padEnd(40), JSON.stringify(wb.sheet().get(4, 0)?.value), ms.toFixed(0) + " ms", (process.memoryUsage().heapUsed / 1e6).toFixed(0) + " MB");
}
