/**
 * TT79 — Excel's text → number coercion for arithmetic and numeric parameters (="$1.00"+1 is 2, DOLLAR("$1.00") is
 * "$1.00", POI EverythingTests L420). Accepted (en-US): surrounding spaces; a sign; "$" before or after the sign;
 * digits with optional thousands groups of three ("1,234,567"; misplaced separators such as "12,34" are rejected —
 * a conservative choice, not oracle-verified against Excel); a decimal part; an exponent;
 * one trailing "%" (÷100); a negative in parentheses "(1,000)". Plain JS numerals stay accepted (hex/binary/
 * Infinity are not: Excel rejects "0x10"). Dates and times in text ("1/2/2020", "12:30") are NOT coerced here.
 * Returns null when the text is not a number.
 */
const RE = /^([+-])?(\$)?([+-])?(\d{1,3}(?:,\d{3})+|\d*)(\.\d*)?(?:[eE]([+-]?\d+))?(%)?$/;
export function numericText(raw: string): number | null {
  let t = raw.trim(); if (!t) return null;
  let neg = false;
  if (t.startsWith("(") && t.endsWith(")")) { t = t.slice(1, -1).trim(); neg = true; if (/^[+-]/.test(t) || /^\$[+-]/.test(t)) return null; }
  const m = RE.exec(t); if (!m) return null;
  const [, s1, cur, s2, int, frac, exp, pct] = m;
  if (s1 && s2) return null; if (!int && (!frac || frac === ".")) return null;
  if (exp !== undefined && (cur || pct)) return null; // "$1e3" / "1e3%" are not numbers to Excel's coercion
  let n = Number(`${int.replace(/,/g, "") || "0"}${frac ?? ""}${exp !== undefined ? `e${exp}` : ""}`);
  if (!Number.isFinite(n)) return null;
  if (pct) n /= 100; if (s1 === "-" || s2 === "-") n = -n; if (neg) n = -n;
  return n;
}
