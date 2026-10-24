import { Workbook } from "../src/lib/formula/engine.ts";
for (const f of ["=COUNTBLANK(A:A)", "=COUNTIF(A:A,\"\")", "=COUNTIFS(A:A,\"\")", "=COUNTIF(A:A,\"<>5\")", "=ROWS(A:A)", "=INDEX(A:A,1000)", "=SUMPRODUCT(--(A:A=\"\"))", "=MATCH(\"\",A:A,0)", "=COUNTBLANK(A1:A300000)", "=AVERAGEIF(A:A,\"<>5\",B:B)", "=SUM(--(A:A=0))", "=ROWS(FILTER(A:A,A:A=\"\"))"]) {
  const wb = new Workbook(); const s = wb.sheet(); s.setCell(0, 0, "5"); s.setCell(0, 9, "7"); s.setCell(4, 0, f); wb.recalculate();
  console.log(f.padEnd(32), JSON.stringify(wb.sheet().get(4, 0)?.value));
}
