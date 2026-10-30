/** TT118 CV-01 — unit converter with affine temperature handling.
 * Every unit is (factor to base, offset) with value_in_base = value*factor + offset,
 * which handles °C/°F/K exactly and keeps every other category linear. Factors are
 * exact definitions where the SI defines them (inch = 0.0254 m, pound = 0.45359237 kg,
 * US gallon = 3.785411784 L); data uses binary (IEC) units and says so. Converting
 * across categories is refused, never approximated. */
export interface UnitDef { symbol: string; name: string; factor: number; offset?: number }
export const CONVERTER: Record<string, { base: string; units: UnitDef[] }> = {
  length: { base: "m", units: [
    { symbol: "mm", name: "millimetres", factor: 0.001 }, { symbol: "cm", name: "centimetres", factor: 0.01 },
    { symbol: "m", name: "metres", factor: 1 }, { symbol: "km", name: "kilometres", factor: 1000 },
    { symbol: "in", name: "inches", factor: 0.0254 }, { symbol: "ft", name: "feet", factor: 0.3048 },
    { symbol: "yd", name: "yards", factor: 0.9144 }, { symbol: "mi", name: "miles", factor: 1609.344 },
    { symbol: "nmi", name: "nautical miles", factor: 1852 }] },
  mass: { base: "kg", units: [
    { symbol: "g", name: "grams", factor: 0.001 }, { symbol: "kg", name: "kilograms", factor: 1 },
    { symbol: "t", name: "tonnes", factor: 1000 }, { symbol: "oz", name: "ounces", factor: 0.028349523125 },
    { symbol: "lb", name: "pounds", factor: 0.45359237 }] },
  temperature: { base: "°C", units: [
    { symbol: "°C", name: "Celsius", factor: 1 }, { symbol: "°F", name: "Fahrenheit", factor: 5 / 9, offset: -32 * 5 / 9 },
    { symbol: "K", name: "kelvin", factor: 1, offset: -273.15 }] },
  data: { base: "B", units: [
    { symbol: "B", name: "bytes", factor: 1 }, { symbol: "KiB", name: "kibibytes", factor: 1024 },
    { symbol: "MiB", name: "mebibytes", factor: 1024 ** 2 }, { symbol: "GiB", name: "gibibytes", factor: 1024 ** 3 },
    { symbol: "TiB", name: "tebibytes", factor: 1024 ** 4 }, { symbol: "kB", name: "kilobytes (1000)", factor: 1000 },
    { symbol: "MB", name: "megabytes (1000)", factor: 1e6 }, { symbol: "GB", name: "gigabytes (1000)", factor: 1e9 }] },
  speed: { base: "m/s", units: [
    { symbol: "m/s", name: "metres per second", factor: 1 }, { symbol: "km/h", name: "kilometres per hour", factor: 1 / 3.6 },
    { symbol: "mph", name: "miles per hour", factor: 0.44704 }, { symbol: "kn", name: "knots", factor: 0.514444 }] },
  time: { base: "s", units: [
    { symbol: "ms", name: "milliseconds", factor: 0.001 }, { symbol: "s", name: "seconds", factor: 1 },
    { symbol: "min", name: "minutes", factor: 60 }, { symbol: "h", name: "hours", factor: 3600 },
    { symbol: "d", name: "days", factor: 86400 }, { symbol: "wk", name: "weeks", factor: 604800 }] },
  energy: { base: "J", units: [
    { symbol: "J", name: "joules", factor: 1 }, { symbol: "kJ", name: "kilojoules", factor: 1000 },
    { symbol: "cal", name: "calories", factor: 4.184 }, { symbol: "kcal", name: "kilocalories", factor: 4184 },
    { symbol: "Wh", name: "watt-hours", factor: 3600 }, { symbol: "kWh", name: "kilowatt-hours", factor: 3.6e6 },
    { symbol: "BTU", name: "British thermal units", factor: 1055.05585 }] },
  volume: { base: "L", units: [
    { symbol: "mL", name: "millilitres", factor: 0.001 }, { symbol: "L", name: "litres", factor: 1 },
    { symbol: "m³", name: "cubic metres", factor: 1000 }, { symbol: "gal", name: "US gallons", factor: 3.785411784 },
    { symbol: "cup", name: "US cups", factor: 0.2365882365 }, { symbol: "fl oz", name: "US fluid ounces", factor: 0.0295735295625 }] },
};
export function convert(value: number, fromSymbol: string, toSymbol: string): { value: number; category: string } {
  if (!Number.isFinite(value)) throw new Error("value must be a finite number");
  for (const [category, def] of Object.entries(CONVERTER)) {
    const from = def.units.find((u) => u.symbol === fromSymbol);
    const to = def.units.find((u) => u.symbol === toSymbol);
    if (from && to) {
      const base = value * from.factor + (from.offset ?? 0);
      const raw = (base - (to.offset ?? 0)) / to.factor;
      // 12 significant digits: enough for every defined factor here, and it keeps
      // affine round-trips (100 °C -> 212 °F) exact instead of 211.99999999999997.
      return { value: Number(raw.toPrecision(12)), category };
    }
    if (from || to) throw new Error(`cannot convert ${fromSymbol} to ${toSymbol}: different categories`);
  }
  throw new Error(`unknown unit: ${fromSymbol} or ${toSymbol}`);
}
export function formatConverted(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e15 || abs < 1e-9) return v.toExponential(6);
  return String(Number(v.toPrecision(12)));
}
