import { Workbook } from "../src/lib/formula/engine.ts";
const wb = new Workbook(); const s = wb.sheet();
s.setCell(0, 0, "1"); s.setCell(0, 1048575, "2"); s.setCell(4, 0, "=SUM(A:A)");
for (let i = 0; i < 3; i++) { const t = performance.now(); wb.recalculate(); console.log((performance.now() - t).toFixed(0)); }
