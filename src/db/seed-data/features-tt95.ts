import type { SpecRow } from "./row";

/** TT95 reports bounded recipe concurrency and corrects an unsupported calculator claim. */
export function patchTT95(row: SpecRow): SpecRow {
  if (row.code === "MD-03") return {
    ...row,
    nuance: `${row.nuance} Cooperating public Photos clients additionally compare the recipe's observed absence or id/version/digest in the same write/clear transaction. Changed recipes are refused; successful writes return a new token. Private/RAM, unguarded clients, absent-create-delete ABA, and external stores do not have this guarantee.`,
    test: `${row.test}; tt95-photo-concurrency.mts, tt95-photo-race.mts and e2e-tt95-photo-concurrency.mts check stale saves, clears, forced database races, queue replay and failed/corrupt reads.`,
  };
  if (row.code === "PR-09") return {
    ...row, status: "partial",
    route: "Calculator and palette share the local expression evaluator; Calculator keeps up to 40 history entries in the current component",
    nuance: "Basic arithmetic, selected scientific functions, unit conversions and standalone hexadecimal/binary literals work. History is in memory only and is lost on remount; it is not persisted as notes or indexed for search. Programmer support is limited to radix literals/display; bitwise operations and a full programmer mode are not implemented. No new Class A completion is claimed.",
    test: "Existing evaluator tests cover arithmetic, rounding and selected conversions; tt95-calculator-audit.mts checks the in-window history, its loss on remount and the absent bitwise operation. These do not establish a full programmer calculator.",
  };
  return row;
}
