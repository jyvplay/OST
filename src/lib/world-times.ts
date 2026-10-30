/** CK-08: the world clock as pasteable text, in the order the rows are
 *  displayed (saved order, or offset order when CK-07's sort is on).
 *  Every row carries its current UTC label so the paste is unambiguous. */
export interface WorldRow { zone: string; time: string; offset: string }
export function worldTimesText(rows: WorldRow[]): string {
  if (!rows.length) return "(no zones)";
  return rows.map((r) => `${r.zone.replace(/_/g, " ")} — ${r.time} (${r.offset})`).join("\n");
}
