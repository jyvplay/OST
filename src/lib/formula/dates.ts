/**
 * The "1900 date system" serial epoch — empirically VERIFIED against real
 * LibreOffice 7.4.7.2, not assumed from memory (see docs/test-fixtures/
 * formula-oracle.json, anchors below). Epoch: serial 0 = 1899-12-30 (UTC).
 *
 * Verified anchors (oracle, this build):
 *   DATE(1900,1,1)  = 2       DATE(1900,2,28) = 60
 *   DATE(1900,2,29) = 61      DATE(1900,3,1)  = 61
 *   DATE(2024,1,1)  = 45292
 *
 * Finding: the textbook claim "Excel reserves serial 60 for a fictitious
 * Feb 29, 1900" does NOT hold for the forward DATE()→serial direction in this
 * oracle: DATE(1900,2,29) normalises (plain calendar overflow, exactly like
 * DATE(1900,2,30) would) to March 1, 1900 = serial 61, the SAME serial as
 * DATE(1900,3,1). A plain proleptic-Gregorian day count from the 1899-12-30
 * epoch, with no special-case at all, reproduces every anchor exactly. The
 * one place real parity is knowingly NOT claimed: typing the bare integer 60
 * into a cell and number-formatting it as a date is documented Excel/Calc
 * behaviour to display "02/29/1900" for Lotus-1-2-3 compatibility — a
 * serial→display-string labelling quirk, not an arithmetic one. This engine
 * does not implement that reverse label for the narrow 1900-01 / 1900-02
 * range (negative space, documented, out of scope: see docs/OFFICE-ENGINE.md).
 */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
/** TT46: workbooks saved with <workbookPr date1904="1"> count serial 0 = 1904-01-01. Set for the duration of a recalc. */
let EPOCH_UTC = EPOCH_1900;
export function setDate1904(on: boolean): boolean { const prev = EPOCH_UTC !== EPOCH_1900; EPOCH_UTC = on ? Date.UTC(1904, 0, 1) : EPOCH_1900; return prev; }
export const isDate1904 = () => EPOCH_UTC !== EPOCH_1900;
const DAY_MS = 86_400_000;

/**
 * TT46: the 1900 date system reproduces Excel's (Lotus-compatible) leap-year quirk exactly: serial 1 = 1900-01-01,
 * serial 60 = the non-existent 1900-02-29, serial 61 = 1900-03-01, serial 0 = "1900-01-00". Day overflow is applied
 * AFTER locating the first of the month, so DATE(1900,1,60) = 60 like Excel. The 1904 system has no quirk.
 */
export function dateToSerial(y: number, m: number, d: number): number {
  if (isDate1904()) return Math.round((Date.UTC(y, m - 1, d) - EPOCH_UTC) / DAY_MS);
  const first = new Date(Date.UTC(y, m - 1, 1)); // normalises month overflow into the year
  const fy = first.getUTCFullYear(), fm = first.getUTCMonth();
  let s = Math.round((first.getTime() - EPOCH_UTC) / DAY_MS);
  if (fy < 1900 || (fy === 1900 && fm < 2)) s -= 1; // Jan/Feb 1900 (and earlier) sit one below the JS day count
  return s + d - 1;
}
export function serialToDate(serial: number): { y: number; m: number; d: number; weekday0: number } {
  if (isDate1904()) { const dt = new Date(EPOCH_UTC + serial * DAY_MS); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday0: dt.getUTCDay() }; }
  const day = Math.floor(serial);
  const weekday0 = (((day + 6) % 7) + 7) % 7; // Excel: serial 1 is a Sunday, counting straight through the fake leap day
  if (day === 0) return { y: 1900, m: 1, d: 0, weekday0 };
  if (day === 60) return { y: 1900, m: 2, d: 29, weekday0 };
  const dt = new Date(EPOCH_UTC + (day < 60 ? day + 1 : day) * DAY_MS + (serial - day) * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday0 };
}
export function nowSerial(): number {
  return (Date.now() - EPOCH_UTC) / DAY_MS;
}
export function todaySerial(): number {
  const n = new Date();
  return dateToSerial(n.getFullYear(), n.getMonth() + 1, n.getDate());
}
