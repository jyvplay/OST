/** Calculator history is opt-in, browser-local and unencrypted; it is not a VFS or Notes record. */
export const CALC_HISTORY_PREFIX = "fusion.calculator.history.v1.";
export const CALC_HISTORY_KEEP = "fusion.calculator.keep.v1";
export const CALC_HISTORY_LIMIT = 40;

export interface CalculatorEntry {
  id: string;
  expr: string;
  text: string;
  mode: "scientific" | "programmer";
  width: number;
  signed: boolean;
  at: number;
}

function validEntry(value: unknown): value is CalculatorEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const x = value as Record<string, unknown>;
  return typeof x.id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(x.id)
    && typeof x.expr === "string" && x.expr.length > 0 && x.expr.length <= 512
    && typeof x.text === "string" && x.text.length <= 1024
    && (x.mode === "scientific" || x.mode === "programmer")
    && typeof x.width === "number" && [8, 16, 32, 64].includes(x.width)
    && typeof x.signed === "boolean" && typeof x.at === "number" && Number.isSafeInteger(x.at) && x.at >= 0;
}

function keys(storage: Storage, limited = true): string[] {
  const result: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(CALC_HISTORY_PREFIX)) {
      result.push(key);
      if (limited && result.length > 1000) throw new Error("Too many saved calculator records");
    }
  }
  return result;
}

/** Refuse malformed records instead of silently deleting or overwriting them. */
export function readCalculatorHistory(storage: Storage): CalculatorEntry[] {
  const entries = keys(storage).map((key) => {
    const raw = storage.getItem(key);
    let value: unknown;
    try { value = JSON.parse(raw ?? ""); } catch { throw new Error("A saved calculator record is unreadable"); }
    if (!validEntry(value) || key !== CALC_HISTORY_PREFIX + value.id) throw new Error("A saved calculator record is invalid");
    return value;
  });
  return entries.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

/** Distinct keys avoid a read/modify/write overwrite on concurrent appends. */
export function appendCalculatorHistory(storage: Storage, entry: CalculatorEntry): void {
  if (!validEntry(entry)) throw new Error("Calculation is too long to save to browser history");
  readCalculatorHistory(storage); // fail closed on corruption before mutating anything
  const key = CALC_HISTORY_PREFIX + entry.id;
  if (storage.getItem(key) !== null) throw new Error("Calculator history id collision");
  storage.setItem(key, JSON.stringify(entry));
  // Optional Web Locks in the caller serialize pruning and deletion across
  // participating tabs. Without locks, entries still have distinct keys but a
  // concurrent clear/prune is best effort, not a cross-tab transaction.
  for (const old of readCalculatorHistory(storage).slice(CALC_HISTORY_LIMIT)) storage.removeItem(CALC_HISTORY_PREFIX + old.id);
}

/** This is intentionally called only after an explicit user confirmation. */
export function deleteCalculatorHistory(storage: Storage): void {
  for (const key of keys(storage, false)) storage.removeItem(key);
}
