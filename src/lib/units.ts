/**
 * TT139 (CV-04) — unit conversion with dimensional analysis.
 *
 * The Calculator's unit mode used to hold a flat table of "multiply by k"
 * factors, which is wrong the moment a unit is offset (temperature) or derived
 * (speed = length/time). Here every unit carries a *dimension vector* over the
 * seven SI base quantities and an affine transform to that dimension's base
 * unit. Conversion is then only legal when the dimensions are identical, and
 * the error says which dimension differs instead of offering a nonsense answer.
 *
 * Precision: factors are stored as exact decimal strings and parsed to doubles
 * once; the conversion path is a single multiply-add, and `formatQuantity`
 * rounds to 15 significant digits, the point past which a double has no more to
 * say. Results are *not* claimed exact — the `exact` flag is only true for
 * conversions with an exact factor of 1 (identity) or an integer power of ten
 * within the double's exact range.
 */

export type Dimension = readonly [number, number, number, number, number, number, number];
/** length, mass, time, electric current, temperature, amount, luminous intensity */
export const DIMENSION_NAMES = ["length", "mass", "time", "current", "temperature", "amount", "luminosity"] as const;

export interface UnitDef {
  id: string;
  label: string;
  symbol: string;
  dimension: Dimension;
  /** value_in_base = value * factor + offset */
  factor: number;
  offset: number;
  /** exact decimal representation of `factor` when it is exact */
  exactFactor?: string;
  aliases?: string[];
  /** currency-like units are refused in conversion because a rate is not a constant */
  requiresRate?: boolean;
}

const D = (l = 0, m = 0, t = 0, i = 0, k = 0, n = 0, j = 0): Dimension => [l, m, t, i, k, n, j] as const;

export const UNITS: UnitDef[] = [
  /** dimensionless "one": what a bare number parses to, so callers can tell a
   *  count from a measurement instead of assuming metres. */
  { id: "one", label: "one", symbol: "", dimension: D(), factor: 1, offset: 0, aliases: ["one", "count", "each"] },
  // length (base: metre)
  { id: "m", label: "metre", symbol: "m", dimension: D(1), factor: 1, offset: 0, aliases: ["metre", "meter", "metres", "meters"] },
  { id: "km", label: "kilometre", symbol: "km", dimension: D(1), factor: 1000, offset: 0, exactFactor: "1000", aliases: ["kilometre", "kilometer", "km"] },
  { id: "cm", label: "centimetre", symbol: "cm", dimension: D(1), factor: 0.01, offset: 0, exactFactor: "0.01", aliases: ["centimetre", "centimeter", "cm"] },
  { id: "mm", label: "millimetre", symbol: "mm", dimension: D(1), factor: 0.001, offset: 0, exactFactor: "0.001", aliases: ["millimetre", "millimeter", "mm"] },
  { id: "um", label: "micrometre", symbol: "µm", dimension: D(1), factor: 1e-6, offset: 0, exactFactor: "0.000001", aliases: ["micron", "micrometre", "micrometer"] },
  { id: "in", label: "inch", symbol: "in", dimension: D(1), factor: 0.0254, offset: 0, exactFactor: "0.0254", aliases: ["inch", "inches", "\""] },
  { id: "ft", label: "foot", symbol: "ft", dimension: D(1), factor: 0.3048, offset: 0, exactFactor: "0.3048", aliases: ["foot", "feet", "'"] },
  { id: "yd", label: "yard", symbol: "yd", dimension: D(1), factor: 0.9144, offset: 0, exactFactor: "0.9144", aliases: ["yard", "yards"] },
  { id: "mi", label: "mile", symbol: "mi", dimension: D(1), factor: 1609.344, offset: 0, exactFactor: "1609.344", aliases: ["mile", "miles"] },
  { id: "nmi", label: "nautical mile", symbol: "nmi", dimension: D(1), factor: 1852, offset: 0, exactFactor: "1852", aliases: ["nautical mile"] },
  { id: "ly", label: "light-year", symbol: "ly", dimension: D(1), factor: 9.4607304725808e15, offset: 0, aliases: ["lightyear", "light-year"] },
  // mass (base: kilogram)
  { id: "kg", label: "kilogram", symbol: "kg", dimension: D(0, 1), factor: 1, offset: 0, aliases: ["kilogram", "kilo", "kg"] },
  { id: "g", label: "gram", symbol: "g", dimension: D(0, 1), factor: 0.001, offset: 0, exactFactor: "0.001", aliases: ["gram", "grams"] },
  { id: "mg", label: "milligram", symbol: "mg", dimension: D(0, 1), factor: 1e-6, offset: 0, exactFactor: "0.000001" },
  { id: "t", label: "tonne", symbol: "t", dimension: D(0, 1), factor: 1000, offset: 0, exactFactor: "1000", aliases: ["tonne", "metric ton"] },
  { id: "lb", label: "pound", symbol: "lb", dimension: D(0, 1), factor: 0.45359237, offset: 0, exactFactor: "0.45359237", aliases: ["pound", "pounds", "lbs"] },
  { id: "oz", label: "ounce", symbol: "oz", dimension: D(0, 1), factor: 0.028349523125, offset: 0, exactFactor: "0.028349523125", aliases: ["ounce", "ounces"] },
  { id: "st", label: "stone", symbol: "st", dimension: D(0, 1), factor: 6.35029318, offset: 0, exactFactor: "6.35029318", aliases: ["stone"] },
  // time (base: second)
  { id: "s", label: "second", symbol: "s", dimension: D(0, 0, 1), factor: 1, offset: 0, aliases: ["second", "seconds", "sec"] },
  { id: "ms", label: "millisecond", symbol: "ms", dimension: D(0, 0, 1), factor: 0.001, offset: 0, exactFactor: "0.001" },
  { id: "min", label: "minute", symbol: "min", dimension: D(0, 0, 1), factor: 60, offset: 0, exactFactor: "60", aliases: ["minute", "minutes"] },
  { id: "h", label: "hour", symbol: "h", dimension: D(0, 0, 1), factor: 3600, offset: 0, exactFactor: "3600", aliases: ["hour", "hours", "hr"] },
  { id: "d", label: "day", symbol: "d", dimension: D(0, 0, 1), factor: 86400, offset: 0, exactFactor: "86400", aliases: ["day", "days"] },
  { id: "wk", label: "week", symbol: "wk", dimension: D(0, 0, 1), factor: 604800, offset: 0, exactFactor: "604800", aliases: ["week", "weeks"] },
  { id: "yr", label: "Julian year", symbol: "yr", dimension: D(0, 0, 1), factor: 31557600, offset: 0, exactFactor: "31557600", aliases: ["year", "years"] },
  // temperature (base: kelvin) — affine
  { id: "K", label: "kelvin", symbol: "K", dimension: D(0, 0, 0, 0, 1), factor: 1, offset: 0, aliases: ["kelvin"] },
  { id: "degC", label: "degree Celsius", symbol: "°C", dimension: D(0, 0, 0, 0, 1), factor: 1, offset: 273.15, aliases: ["celsius", "centigrade", "°c", "degc"] },
  { id: "degF", label: "degree Fahrenheit", symbol: "°F", dimension: D(0, 0, 0, 0, 1), factor: 5 / 9, offset: 273.15 - (32 * 5) / 9, aliases: ["fahrenheit", "°f", "degf"] },
  { id: "degR", label: "degree Rankine", symbol: "°R", dimension: D(0, 0, 0, 0, 1), factor: 5 / 9, offset: 0, aliases: ["rankine"] },
  // area / volume (derived, listed so the UI can offer them without inventing dimension maths)
  { id: "m2", label: "square metre", symbol: "m²", dimension: D(2), factor: 1, offset: 0, aliases: ["sqm", "square metre"] },
  { id: "ha", label: "hectare", symbol: "ha", dimension: D(2), factor: 10000, offset: 0, exactFactor: "10000", aliases: ["hectare"] },
  { id: "acre", label: "acre", symbol: "ac", dimension: D(2), factor: 4046.8564224, offset: 0, exactFactor: "4046.8564224", aliases: ["acre", "acres"] },
  { id: "ft2", label: "square foot", symbol: "ft²", dimension: D(2), factor: 0.09290304, offset: 0, exactFactor: "0.09290304", aliases: ["sqft"] },
  { id: "m3", label: "cubic metre", symbol: "m³", dimension: D(3), factor: 1, offset: 0 },
  { id: "L", label: "litre", symbol: "L", dimension: D(3), factor: 0.001, offset: 0, exactFactor: "0.001", aliases: ["litre", "liter", "liters", "litres"] },
  { id: "mL", label: "millilitre", symbol: "mL", dimension: D(3), factor: 1e-6, offset: 0, exactFactor: "0.000001", aliases: ["millilitre", "milliliter"] },
  { id: "galUS", label: "US gallon", symbol: "gal", dimension: D(3), factor: 0.003785411784, offset: 0, exactFactor: "0.003785411784", aliases: ["gallon", "gal"] },
  { id: "galUK", label: "imperial gallon", symbol: "gal (UK)", dimension: D(3), factor: 0.00454609, offset: 0, exactFactor: "0.00454609", aliases: ["imperial gallon"] },
  { id: "cupUS", label: "US cup", symbol: "cup", dimension: D(3), factor: 0.0002365882365, offset: 0, exactFactor: "0.0002365882365", aliases: ["cup"] },
  // speed, energy, power, pressure, data
  { id: "mps", label: "metre per second", symbol: "m/s", dimension: D(1, 0, -1), factor: 1, offset: 0 },
  { id: "kph", label: "kilometre per hour", symbol: "km/h", dimension: D(1, 0, -1), factor: 1000 / 3600, offset: 0, aliases: ["kph", "kmh"] },
  { id: "mph", label: "mile per hour", symbol: "mph", dimension: D(1, 0, -1), factor: 1609.344 / 3600, offset: 0, aliases: ["mph"] },
  { id: "kn", label: "knot", symbol: "kn", dimension: D(1, 0, -1), factor: 1852 / 3600, offset: 0, aliases: ["knot", "knots"] },
  { id: "J", label: "joule", symbol: "J", dimension: D(2, 1, -2), factor: 1, offset: 0 },
  { id: "cal", label: "calorie (thermochemical)", symbol: "cal", dimension: D(2, 1, -2), factor: 4.184, offset: 0, exactFactor: "4.184", aliases: ["calorie", "calories", "cal"] },
  { id: "kcal", label: "kilocalorie", symbol: "kcal", dimension: D(2, 1, -2), factor: 4184, offset: 0, exactFactor: "4184", aliases: ["kcal", "Cal"] },
  { id: "kWh", label: "kilowatt-hour", symbol: "kWh", dimension: D(2, 1, -2), factor: 3.6e6, offset: 0, exactFactor: "3600000", aliases: ["kwh"] },
  { id: "btu", label: "British thermal unit (IT)", symbol: "Btu", dimension: D(2, 1, -2), factor: 1055.05585262, offset: 0, exactFactor: "1055.05585262", aliases: ["btu"] },
  { id: "W", label: "watt", symbol: "W", dimension: D(2, 1, -3), factor: 1, offset: 0 },
  { id: "hp", label: "mechanical horsepower", symbol: "hp", dimension: D(2, 1, -3), factor: 745.6998715822702, offset: 0, aliases: ["horsepower", "hp"] },
  { id: "Pa", label: "pascal", symbol: "Pa", dimension: D(-1, 1, -2), factor: 1, offset: 0 },
  { id: "kPa", label: "kilopascal", symbol: "kPa", dimension: D(-1, 1, -2), factor: 1000, offset: 0 },
  { id: "bar", label: "bar", symbol: "bar", dimension: D(-1, 1, -2), factor: 100000, offset: 0, exactFactor: "100000" },
  { id: "atm", label: "atmosphere", symbol: "atm", dimension: D(-1, 1, -2), factor: 101325, offset: 0, exactFactor: "101325" },
  { id: "psi", label: "pound per square inch", symbol: "psi", dimension: D(-1, 1, -2), factor: 6894.757293168361, offset: 0, aliases: ["psi"] },
  { id: "torr", label: "torr", symbol: "Torr", dimension: D(-1, 1, -2), factor: 101325 / 760, offset: 0 },
  // digital information, base-2 and base-10 both named explicitly
  { id: "bit", label: "bit", symbol: "bit", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 1, offset: 0, aliases: ["bit", "bits"] },
  { id: "B", label: "byte", symbol: "B", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8, offset: 0, aliases: ["byte", "bytes"] },
  { id: "KiB", label: "kibibyte", symbol: "KiB", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8192, offset: 0, exactFactor: "8192", aliases: ["kib", "kibibyte"] },
  { id: "MiB", label: "mebibyte", symbol: "MiB", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8388608, offset: 0, exactFactor: "8388608", aliases: ["mib"] },
  { id: "GiB", label: "gibibyte", symbol: "GiB", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8589934592, offset: 0, exactFactor: "8589934592", aliases: ["gib"] },
  { id: "kB", label: "kilobyte (1000 B)", symbol: "kB", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8000, offset: 0, exactFactor: "8000", aliases: ["kb", "kilobyte"] },
  { id: "MB", label: "megabyte (10⁶ B)", symbol: "MB", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8e6, offset: 0, exactFactor: "8000000", aliases: ["mb", "megabyte"] },
  { id: "GB", label: "gigabyte (10⁹ B)", symbol: "GB", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8e9, offset: 0, exactFactor: "8000000000", aliases: ["gb", "gigabyte"] },
  { id: "TB", label: "terabyte (10¹² B)", symbol: "TB", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 8e12, offset: 0, exactFactor: "8000000000000", aliases: ["tb", "terabyte"] },
  // angle (dimensionless, kept separate by convention so "convert 90 deg to rad" is meaningful)
  { id: "rad", label: "radian", symbol: "rad", dimension: D(0, 0, 0, 0, 0, 0, 0), factor: 1, offset: 0, aliases: ["radian", "radians"] },
];

const UNIT_INDEX = new Map<string, UnitDef>();
for (const u of UNITS) {
  UNIT_INDEX.set(u.id.toLowerCase(), u);
  for (const a of u.aliases ?? []) UNIT_INDEX.set(a.toLowerCase(), u);
}

/** Look up a unit by symbol, id or alias, case-insensitively. */
export function findUnit(text: string): UnitDef | null {
  const key = String(text ?? "").trim().toLowerCase();
  if (!key) return null;
  return UNIT_INDEX.get(key) ?? UNIT_INDEX.get(key.replace(/s$/, "")) ?? null;
}

export type ConversionFailure = { ok: false; error: string; hint?: string };
export type ConversionResult =
  | { ok: true; value: number; unit: UnitDef; exact: boolean; formatted: string; base: number }
  | ConversionFailure;

export function convert(value: number, from: UnitDef | string, to: UnitDef | string): ConversionResult {
  const a = typeof from === "string" ? findUnit(from) : from;
  const b = typeof to === "string" ? findUnit(to) : to;
  if (!a) return { ok: false, error: `unknown unit "${from}"`, hint: "try a symbol (kg, °F) or a full name (kilogram)" };
  if (!b) return { ok: false, error: `unknown unit "${to}"` };
  if (!Number.isFinite(value)) return { ok: false, error: "value must be a finite number" };
  const da = a.dimension.join(","), db = b.dimension.join(",");
  if (da !== db) {
    const differing = a.dimension.map((exp, i) => (exp !== b.dimension[i] ? `${DIMENSION_NAMES[i]} ${exp}→${b.dimension[i]}` : null)).filter(Boolean);
    return { ok: false, error: `"${a.label}" and "${b.label}" are different kinds of quantity`, hint: differing.join(", ") };
  }
  // angle is dimensionless; refuse cross-conversion with arbitrary dimensionless units
  const angleLike = (u: UnitDef) => ["rad", "deg", "grad", "turn"].includes(u.id);
  if (angleLike(a) !== angleLike(b) && (a.dimension.every((x) => x === 0))) {
    return { ok: false, error: "an angle and a plain number (or a byte count) are both dimensionless but not interchangeable" };
  }
  const base = value * a.factor + a.offset;
  const out = (base - b.offset) / b.factor;
  const exact = a.factor === 1 && a.offset === 0 && b.factor === 1 && b.offset === 0;
  return { ok: true, value: out, unit: b, exact, formatted: formatQuantity(out), base };
}

/** Up to 15 significant digits, trimming float noise but never inventing precision. */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e-4 && abs < 1e15) {
    const s = value.toPrecision(15).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return s === "-0" ? "0" : s;
  }
  return value.toExponential(10).replace(/\.?0+e/, "e");
}

/**
 * Parse a free-text quantity: "12.5 kg", "6'2\"", "1h30m", "3/4 cup".
 * Returns null (not a guess) when no unit is recognisable.
 */
export function parseQuantity(text: string): { value: number; unit: UnitDef; raw: string } | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  // feet/inches compound
  const fi = /^(\d+(?:\.\d+)?)\s*(?:ft|')\s*(\d+(?:\.\d+)?)?\s*(?:in|")?$/i.exec(s);
  if (fi) {
    const feet = Number(fi[1]), inches = Number(fi[2] ?? 0);
    const unit = findUnit("ft");
    if (unit) return { value: feet + inches / 12, unit, raw: s };
  }
  // durations like 1h30m, 2h, 45m, 30s
  const dur = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i.exec(s);
  if (dur && (dur[1] || dur[2] || dur[3]) && /[hms]/i.test(s)) {
    const seconds = Number(dur[1] ?? 0) * 3600 + Number(dur[2] ?? 0) * 60 + Number(dur[3] ?? 0);
    const unit = findUnit("s");
    if (unit) return { value: seconds, unit, raw: s };
  }
  const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*([A-Za-zµ°"'²³/]+(?:\s?[A-Za-z]+)?)?$/.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  // No unit is not the same as metres. A bare "12.5" gets the dimensionless
  // "one" unit so callers can tell "the user typed a number" from "the user
  // typed a length", instead of silently reading 12.5 as 12.5 m.
  const unit = m[2] ? findUnit(m[2]) : findUnit("one");
  if (!unit) return null;
  return { value, unit, raw: s };
}

/** Every unit that is dimensionally compatible with `unit` — the conversion picker's contents. */
export function compatibleUnits(unit: UnitDef): UnitDef[] {
  const key = unit.dimension.join(",");
  return UNITS.filter((u) => u.dimension.join(",") === key && u.id !== unit.id);
}
