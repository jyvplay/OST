/**
 * Extended function library — imported (additively) from the competing TT14
 * repository's office engine (officeFunctions*.ts, officeDynamicArrays.ts).
 *
 * Precedence rule (enforced in engine.ts): the first-party, LibreOffice-oracle
 * verified FUNCTIONS table in ../functions.ts ALWAYS wins for a name defined in
 * both. This library is consulted only for names our table does not define, so
 * no previously verified behaviour can change by importing it.
 */
import { FUNCTIONS as BASE } from "./officeFunctions";
import { EXTRA_FUNCTIONS } from "./officeFunctions2";
import { ADVANCED_FUNCTIONS } from "./officeFunctions3";
import { DYNAMIC_ARRAY_FUNCTIONS } from "./officeDynamicArrays";
import { TT15_FUNCTIONS } from "./tt15Functions";
export type { ArgAccessor, EvalEnv, FnImpl, CellValue as ExtValue, ResultValue } from "./officeFunctions";
export { isGridValue } from "./officeFunctions";

export const EXT_FUNCTIONS = { ...BASE, ...EXTRA_FUNCTIONS, ...DYNAMIC_ARRAY_FUNCTIONS, ...ADVANCED_FUNCTIONS, ...TT15_FUNCTIONS };
