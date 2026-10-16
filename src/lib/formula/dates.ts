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
const EPOCH_UTC = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function dateToSerial(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_UTC) / DAY_MS);
}
export function serialToDate(serial: number): { y: number; m: number; d: number; weekday0: number } {
  const t = EPOCH_UTC + serial * DAY_MS;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday0: dt.getUTCDay() };
}
export function nowSerial(): number {
  return (Date.now() - EPOCH_UTC) / DAY_MS;
}
export function todaySerial(): number {
  const n = new Date();
  return dateToSerial(n.getFullYear(), n.getMonth() + 1, n.getDate());
}
