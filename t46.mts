import { Workbook } from "./src/lib/formula/engine.ts";
import { readXlsxWorkbook } from "./src/lib/formula/xlsx.ts";
import { readFileSync } from "node:fs";
const wb = new Workbook(); const s = wb.sheet();
s.setCell(1, 1, "10"); s.setCell(1, 2, "=$A3*B$2"); s.setCell(2, 2, "=A9"); s.setCell(3,2,"=A9+0"); wb.recalculate();
console.log(wb.valueAt("Sheet1", 1, 2), JSON.stringify(wb.valueAt("Sheet1", 2, 2)), wb.valueAt("Sheet1",3,2));
const w2 = readXlsxWorkbook(readFileSync("/home/user/tools/corpus/xlsx/51710.xlsx"));
const sh = w2.sheet(); console.log(sh.get(1, 502)?.input, w2.valueAt(sh.name, 1, 502), sh.get(0,502), sh.get(1,1)?.input);
