import { Workbook, Sheet, a1 } from "./engine";
import { lettersToCol } from "./types";

export interface WorkbookJson { sheets: { name: string; cells: { ref: string; input: string }[] }[] }
export function workbookToJson(wb: Workbook): WorkbookJson {
  return { sheets: [...wb.sheets.values()].map((s) => ({
    name: s.name,
    cells: [...s.grid.entries()].map(([k, c]) => {
      const [col, row] = k.split(",").map(Number);
      return { ref: a1(col, row), input: c.input };
    }),
  })) };
}
export function workbookFromJson(data: WorkbookJson): Workbook {
  const wb = new Workbook(); wb.sheets.clear();
  for (const s of data.sheets) {
    const sheet = new Sheet(s.name);
    for (const { ref, input } of s.cells) {
      const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
      if (m) sheet.setCell(lettersToCol(m[1].toUpperCase()), Number(m[2]) - 1, input);
    }
    wb.sheets.set(s.name, sheet);
  }
  if (!wb.sheets.size) wb.addSheet("Sheet1");
  wb.recalculate();
  return wb;
}
