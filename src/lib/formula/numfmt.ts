/**
 * Excel number-format codes (TT15) — a first-party formatter for the subset of
 * the format-code language documented in Microsoft's "Review guidelines for
 * customizing a number format": up to 4 sections (positive;negative;zero;text),
 * [Color] tags, quoted/escaped literals, 0 # ? placeholders, thousands
 * separator and trailing-comma scaling, %, scientific E+/E-, @ text, _x
 * spacing, *x fill (ignored), date/time tokens (yyyy yy mmmm mmm mm m dddd ddd
 * dd d hh h mm ss AM/PM A/P, elapsed [h] [m] [s]) and fractional seconds.
 *
 * Declared gaps: [<cond>] conditional sections, fractions (# ?/?), locale
 * tokens ([$-409]), DBNum, accounting alignment. Locale is en-US.
 */
import { serialToDate } from "./dates";
import { isError, type Scalar } from "./types";

export interface Formatted { text: string; color?: string }
const COLORS: Record<string, string> = { black: "#000000", blue: "#3b82f6", cyan: "#06b6d4", green: "#22c55e", magenta: "#d946ef", red: "#ef4444", white: "#ffffff", yellow: "#eab308" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const BUILTIN_FORMATS: { label: string; code: string }[] = [
  { label: "General", code: "General" }, { label: "Number", code: "0.00" }, { label: "Number (1,000)", code: "#,##0.00" },
  { label: "Integer", code: "#,##0" }, { label: "Currency", code: "$#,##0.00" }, { label: "Accounting (neg in parens)", code: "$#,##0.00;($#,##0.00)" },
  { label: "Negative red", code: "#,##0.00;[Red]-#,##0.00" }, { label: "Percent", code: "0%" }, { label: "Percent 0.00", code: "0.00%" },
  { label: "Scientific", code: "0.00E+00" }, { label: "Short date", code: "m/d/yyyy" }, { label: "ISO date", code: "yyyy-mm-dd" },
  { label: "Long date", code: "dddd, mmmm d, yyyy" }, { label: "Time", code: "h:mm:ss AM/PM" }, { label: "24h time", code: "hh:mm" },
  { label: "Date + time", code: "yyyy-mm-dd hh:mm" }, { label: "Elapsed hours", code: "[h]:mm:ss" }, { label: "Text", code: "@" },
];

function splitSections(fmt: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '"') q = !q;
    if (c === "\\" && !q) { cur += c + (fmt[i + 1] ?? ""); i++; continue; }
    if (c === ";" && !q) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

type Tok = { k: "lit"; v: string } | { k: "ph"; v: string } | { k: "dot" } | { k: "comma" } | { k: "pct" } | { k: "exp"; sign: "+" | "-"; upper: boolean } | { k: "at" } | { k: "date"; v: string } | { k: "ampm"; v: string } | { k: "elapsed"; v: string };
interface Cond { op: string; v: number }
function lex(sec: string): { toks: Tok[]; color?: string; cond?: Cond } {
  const toks: Tok[] = []; let color: string | undefined; let cond: Cond | undefined; let i = 0;
  const s = sec;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { const j = s.indexOf('"', i + 1); toks.push({ k: "lit", v: s.slice(i + 1, j < 0 ? s.length : j) }); i = j < 0 ? s.length : j + 1; continue; }
    if (c === "\\" || c === "!") { toks.push({ k: "lit", v: s[i + 1] ?? "" }); i += 2; continue; } // TT73: '!' escapes like '\\'
    if (c === "_") { toks.push({ k: "lit", v: " " }); i += 2; continue; }
    if (c === "*") { i += 2; continue; }
    if (c === "[") {
      const j = s.indexOf("]", i); const inner = s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j + 1;
      // TT73: [$USD] / [$€-407] / [$$-1009] show the currency text before the '-'; a bare [$-409] locale shows nothing
      if (inner.startsWith("$")) { const cur = inner.slice(1).split("-")[0]; if (cur) toks.push({ k: "lit", v: cur }); continue; }
      if (COLORS[inner.toLowerCase()]) color = COLORS[inner.toLowerCase()];
      else if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ k: "elapsed", v: inner.toLowerCase() });
      else { const cm = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(inner.trim()); if (cm) cond = { op: cm[1], v: Number(cm[2]) }; }
      continue; // [$-409], [<0] etc. ignored (declared)
    }
    if (/^(AM\/PM|A\/P)/i.test(s.slice(i))) { const m = /^(AM\/PM|A\/P)/i.exec(s.slice(i))![0]; toks.push({ k: "ampm", v: m }); i += m.length; continue; }
    if (/[yYmMdDhHsS]/.test(c) && !(c === "E" || c === "e")) { let j = i; while (j < s.length && s[j].toLowerCase() === c.toLowerCase()) j++; toks.push({ k: "date", v: s.slice(i, j).toLowerCase() }); i = j; continue; }
    if (c === "0" || c === "#" || c === "?") { toks.push({ k: "ph", v: c }); i++; continue; }
    if (c === ".") { toks.push({ k: "dot" }); i++; continue; }
    if (c === ",") { toks.push({ k: "comma" }); i++; continue; }
    if (c === "%") { toks.push({ k: "pct" }); i++; continue; }
    if ((c === "E" || c === "e") && (s[i + 1] === "+" || s[i + 1] === "-")) { toks.push({ k: "exp", sign: s[i + 1] as "+" | "-", upper: c === "E" }); i += 2; continue; }
    if (c === "@") { toks.push({ k: "at" }); i++; continue; }
    toks.push({ k: "lit", v: c }); i++;
  }
  return { toks, color, cond };
}
const condOk = (c: Cond, x: number) => (c.op === "<" ? x < c.v : c.op === "<=" ? x <= c.v : c.op === ">" ? x > c.v : c.op === ">=" ? x >= c.v : c.op === "=" ? x === c.v : x !== c.v);

/** TT46: best rational approximation p/q of x ∈ [0,1) with q ≤ maxQ (Stern–Brocot / continued fractions). */
function bestFraction(x: number, maxQ: number): [number, number] {
  if (x <= 0) return [0, 1];
  let [p0, q0, p1, q1] = [0, 1, 1, 0]; let v = x;
  for (let k = 0; k < 64; k++) {
    const a = Math.floor(v); const p2 = a * p1 + p0, q2 = a * q1 + q0;
    if (q2 > maxQ) { const t = Math.floor((maxQ - q0) / q1); const pa = t * p1 + p0, qa = t * q1 + q0; return Math.abs(pa / qa - x) < Math.abs(p1 / q1 - x) ? [pa, qa] : [p1, q1]; }
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    if (Math.abs(v - a) < 1e-12) break; v = 1 / (v - a);
  }
  return [p1, q1];
}
type Ph = { k: "ph"; v: string };
/** TT73: right-aligned digit distribution across placeholders with interleaved literals ("#-#-#" on 23 → "-2-3").
 * Surplus digits go to the first placeholder; unused '0' → "0", '?' → " ", '#' → "". */
function distribute(digits: string, seg: Tok[]): string {
  const nph = seg.filter((t) => t.k === "ph").length; let k = nph; const out: string[] = [];
  let di = digits.length;
  for (let i = seg.length - 1; i >= 0; i--) {
    const t = seg[i];
    if (t.k !== "ph") { out.push(t.k === "lit" ? t.v : t.k === "pct" ? "%" : ""); continue; }
    k--;
    let s = "";
    if (k === 0) { s = digits.slice(0, Math.max(0, di)); di = 0; } else if (di > 0) { s = digits[di - 1]; di--; }
    out.push(s || (t.v === "0" ? "0" : t.v === "?" ? " " : ""));
  }
  return out.reverse().join("");
}
const width = (seg: Tok[]) => seg.reduce((n, t) => n + (t.k === "ph" ? 1 : t.k === "lit" ? t.v.length : t.k === "pct" ? 1 : 0), 0);
/** TT73 fraction formats, per Excel's observed output (POI NumberFormatTests, Excel-cached values):
 *  numerator = the placeholder run nearest the '/' (literals may sit between it and the '/': "#=/=#"); integer part =
 *  every placeholder before it, digits distributed across interior literals; the literals between integer and
 *  numerator are the separator. No integer placeholders → an improper fraction ("#_#/#" on 3.75 → "15 /4").
 *  Integer 0 with a fraction: '#' drops the integer and separator, '?' (integer or numerator) blanks them, '0' shows "0".
 *  Zero fraction: a '0' in the numerator shows "0/1"; otherwise the fraction (separator included) is replaced by
 *  spaces when any '?' placeholder is present, else dropped. Denominator '0' pads left with zeros, '?' right with spaces. */
function formatFraction(value: number, toks: Tok[], slash: number): string {
  let ne = slash - 1; while (ne >= 0 && toks[ne].k === "lit") ne--;
  let ns = ne; while (ns > 0 && toks[ns - 1].k === "ph") ns--;
  let ds = slash + 1; while (ds < toks.length && toks[ds].k === "lit" && !/^\d+$/.test((toks[ds] as { v: string }).v)) ds++;
  let fixedDen = ""; let de = ds;
  if (toks[ds]?.k === "lit") { while (de < toks.length && toks[de].k === "lit" && /^\d$/.test((toks[de] as { v: string }).v)) { fixedDen += (toks[de] as { v: string }).v; de++; } }
  else while (de < toks.length && toks[de].k === "ph") de++;
  const numSeg = toks.slice(ns, ne + 1), numLits = toks.slice(ne + 1, slash), denLits = toks.slice(slash + 1, ds), denSeg = toks.slice(ds, de);
  const numPh = numSeg as Ph[], denPh = fixedDen ? [] : (denSeg as Ph[]);
  const before = toks.slice(0, ns);
  const fi = before.findIndex((t) => t.k === "ph");
  let li = -1; before.forEach((t, i) => { if (t.k === "ph") li = i; });
  const mixed = fi >= 0;
  const prefix = (mixed ? before.slice(0, fi) : before), intSeg = mixed ? before.slice(fi, li + 1) : [], sep = mixed ? before.slice(li + 1) : [];
  const suffix = toks.slice(de);
  const lits = (seg: Tok[]) => seg.map((t) => (t.k === "lit" ? t.v : t.k === "pct" ? "%" : t.k === "comma" ? "," : "")).join("");
  const intPh = intSeg.filter((t) => t.k === "ph") as Ph[];
  const x = Math.abs(value);
  const maxQ = 10 ** Math.max(1, denPh.length) - 1;
  let ip = mixed ? Math.floor(x) : 0; const frac = x - ip;
  let num: number, den: number;
  if (fixedDen) { den = Number(fixedDen); num = Math.round(frac * den); }
  else if (mixed) [num, den] = bestFraction(frac, maxQ);
  else { const w = Math.floor(frac); [num, den] = bestFraction(frac - w, maxQ); num += w * den; }
  if (mixed && num === den && num > 0) { ip++; num = 0; den = fixedDen ? Number(fixedDen) : 1; }
  if (num === 0 && !fixedDen) den = 1;
  const denStr = (d: number) => { if (fixedDen) return fixedDen; const z = denPh.filter((p) => p.v === "0").length, q = denPh.filter((p) => p.v === "?").length; return String(d).padStart(z, "0").padEnd(z + q, " "); };
  const fracStr = (n: number) => distribute(String(n), numSeg) + lits(numLits) + "/" + lits(denLits) + denStr(den);
  const anyQ = [...intPh, ...numPh, ...denPh].some((p) => p.v === "?");
  if (!mixed) return lits(prefix) + fracStr(num) + lits(suffix);
  if (num === 0) {
    if (numPh.some((p) => p.v === "0")) {
      const lastIsHash = intPh[intPh.length - 1]?.v === "#";
      const intTxt = ip > 0 ? distribute(String(ip), intSeg) + lits(sep) : lastIsHash && !intPh.some((p) => p.v === "0") ? "" : distribute("0", intSeg) + lits(sep);
      return lits(prefix) + intTxt + fracStr(0) + lits(suffix);
    }
    const intTxt = distribute(String(ip), intSeg);
    const rest = width(sep) + width(numSeg) + width(numLits) + 1 + width(denLits) + Math.max(denPh.length, fixedDen.length);
    return lits(prefix) + intTxt + (anyQ ? " ".repeat(rest) : "") + lits(suffix);
  }
  let intTxt: string;
  if (ip > 0) intTxt = distribute(String(ip), intSeg) + lits(sep);
  else { const body = distribute("", intSeg); intTxt = body + (intPh.some((p) => p.v === "0") ? lits(sep) : intPh.some((p) => p.v === "?") || numPh.some((p) => p.v === "?") ? " ".repeat(width(sep)) : ""); }
  return lits(prefix) + intTxt + fracStr(num) + lits(suffix);
}

/** Round half away from zero at `d` decimals (Excel display rounding). */
function roundAway(x: number, d: number): string {
  if (d > 15) d = 15;
  const sgn = x < 0 ? -1 : 1; const a = Math.abs(x);
  // decimal-exponent shift on the 15-significant-digit value avoids 1.005*100 errors (and works for 1e-7 forms)
  const [mant, ex] = Number(a.toPrecision(15)).toExponential(14).split("e");
  const r = Math.round(Number(`${mant}e${Number(ex) + d}`)) / 10 ** d;
  const v = Number.isFinite(r) ? r : a;
  return (sgn < 0 && v !== 0 ? "-" : "") + v.toFixed(d);
}
const PAD = "\u0001";
/** TT73: thousands grouping that also groups '?' padding — Excel blanks the padded digit positions AND the separators
 * between them ("?,?????????" on 1234567 → "    1,234,567"; "0,000000" on 123456 → "0,123,456"). */
function padInt(ip: string, ph: { v: string }[], thousands: boolean): string {
  const z = ph.filter((p) => p.v === "0").length, q = ph.filter((p) => p.v === "?").length;
  let s = ip.padStart(z, "0").padStart(z + q, PAD);
  if (thousands) { let o = ""; for (let i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0) o += ","; o += s[i]; } s = o; }
  const lead = /^[\u0001,]*/.exec(s)![0];
  return " ".repeat(lead.length) + s.slice(lead.length);
}
/** TT73 scientific notation, per Excel's observed output (POI NumberFormatApproxTests, Excel-cached):
 *  - the exponent is a multiple of the integer-placeholder count n ("0000.0000E+0" on 123456.789 → "0012.3457E+4");
 *  - the E/e prints where it stands; the exponent sign prints just before the exponent digits, so literals between
 *    them stay put ("#.#|e+|#" → "1.2|e|+5"); "E-" shows only a minus;
 *  - exponent '0' pads with zeros, '?' with spaces, '#' with nothing (at least one digit);
 *  - '%' and ',' do not scale the mantissa; a zero value fills EVERY integer placeholder ('#', '?' too) with 0. */
function formatScientific(value: number, toks: Tok[], expIdx: number): string {
  const dotIdx = toks.findIndex((t, i) => t.k === "dot" && i < expIdx);
  const mant = toks.slice(0, expIdx);
  const intPh = (dotIdx >= 0 ? mant.slice(0, dotIdx) : mant).filter((t) => t.k === "ph") as { k: "ph"; v: string }[];
  const decPh = dotIdx >= 0 ? (mant.slice(dotIdx + 1).filter((t) => t.k === "ph") as { k: "ph"; v: string }[]) : [];
  const expPh = toks.slice(expIdx + 1).filter((t) => t.k === "ph") as { k: "ph"; v: string }[];
  const firstPh = toks.findIndex((t) => t.k === "ph");
  let lastInt = -1; mant.forEach((t, i) => { if (t.k === "ph" && (dotIdx < 0 || i < dotIdx)) lastInt = i; });
  const thousands = firstPh >= 0 && mant.slice(firstPh, lastInt).some((t) => t.k === "comma");
  const n = Math.max(1, intPh.length);
  const x = Number(Math.abs(value).toPrecision(15));
  let e = 0, m = 0;
  if (x !== 0) {
    e = Math.floor(Math.floor(Math.log10(x)) / n) * n; m = x / 10 ** e;
    if (m < 1) { e -= n; m = x / 10 ** e; }
    if (Number(roundAway(m, decPh.length)) >= 10 ** n) { e += n; m = x / 10 ** e; }
  }
  let [ip, dp = ""] = roundAway(m, decPh.length).replace("-", "").split(".");
  if (ip === "0" && x !== 0 && !intPh.some((p) => p.v === "0")) ip = "";
  ip = x === 0 ? padInt("0".repeat(Math.max(1, intPh.length)), [], thousands) : padInt(ip, intPh, thousands);
  const dch = dp.split("");
  for (let i = decPh.length - 1; i >= 0; i--) { if (dch[i] !== "0") break; if (decPh[i].v === "#") dch.pop(); else if (decPh[i].v === "?") dch[i] = " "; else break; }
  dp = dch.join("");
  const et = toks[expIdx] as { sign: string; upper: boolean };
  const ez = expPh.filter((p) => p.v === "0").length, eq = expPh.filter((p) => p.v === "?").length;
  const ed = String(Math.abs(e)).padStart(Math.max(1, ez), "0").padStart(ez + eq, " ");
  const esign = e < 0 ? "-" : et.sign === "+" ? "+" : "";
  let out = "", intDone = false, decDone = false, expDone = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === "lit") out += t.v;
    else if (t.k === "pct") out += "%";
    else if (t.k === "comma") { if (i < firstPh) out += ","; }
    else if (t.k === "exp") { out += et.upper ? "E" : "e"; if (!expPh.length) { out += esign + ed; expDone = true; } }
    else if (t.k === "dot") { if (i === dotIdx) { if (!intDone) { out += ip; intDone = true; } out += "."; } else if (i > expIdx) out += "."; }
    else if (t.k === "ph") {
      if (i > expIdx) { if (!expDone) { out += esign + ed; expDone = true; } }
      else if (dotIdx >= 0 && i > dotIdx) { if (!decDone) { out += dp; decDone = true; } }
      else if (!intDone) { out += ip; intDone = true; }
    }
  }
  return out;
}

function formatNumberToks(value: number, toks: Tok[]): string {
  const hasDate = toks.some((t) => t.k === "date" || t.k === "ampm" || t.k === "elapsed");
  if (hasDate) return formatDate(value, toks);
  const firstPh = toks.findIndex((t) => t.k === "ph");
  if (firstPh < 0) return toks.map((t) => (t.k === "lit" ? t.v : t.k === "pct" ? "%" : "")).join("");
  const expIdx = toks.findIndex((t) => t.k === "exp");
  const slash = toks.findIndex((t, i) => {
    if (t.k !== "lit" || t.v !== "/") return false;
    let l = i - 1; while (l >= 0 && toks[l].k === "lit" && (toks[l] as { v: string }).v !== "/") l--;
    let r = i + 1; while (r < toks.length && toks[r].k === "lit" && !/^\d$/.test((toks[r] as { v: string }).v) && (toks[r] as { v: string }).v !== "/") r++;
    return toks[l]?.k === "ph" && (toks[r]?.k === "ph" || (toks[r]?.k === "lit" && /^\d$/.test((toks[r] as { v: string }).v)));
  });
  if (slash > 0 && expIdx < 0 && !toks.some((t) => t.k === "dot")) return formatFraction(value, toks, slash);
  const dotIdx = toks.findIndex((t, i) => t.k === "dot" && (expIdx < 0 || i < expIdx));
  let lastPh = -1; toks.forEach((t, i) => { if (t.k === "ph" && (expIdx < 0 || i < expIdx)) lastPh = i; });
  const intEnd = dotIdx >= 0 ? dotIdx : lastPh + 1;
  const intPh = toks.slice(0, intEnd).filter((t) => t.k === "ph") as { k: "ph"; v: string }[];
  const decPh = dotIdx >= 0 ? (toks.slice(dotIdx + 1, expIdx >= 0 ? expIdx : undefined).filter((t) => t.k === "ph") as { k: "ph"; v: string }[]) : [];
  // TT73: a comma is a thousands separator only between integer placeholders; commas straight after the last integer
  // placeholder (before the '.') or after the last placeholder each scale by 1,000 ("#,.#," on 1234567 → "1.2")
  const lastIntPh = (() => { let k = -1; for (let i = 0; i < intEnd; i++) if (toks[i].k === "ph") k = i; return k; })();
  const thousands = toks.slice(firstPh, lastIntPh).some((t) => t.k === "comma");
  let scale = 0; for (let i = lastPh + 1; i < toks.length && toks[i].k === "comma"; i++) scale++;
  if (dotIdx >= 0 && lastIntPh < dotIdx && lastIntPh !== lastPh) for (let i = lastIntPh + 1; i < dotIdx && toks[i].k === "comma"; i++) scale++;
  const pct = toks.filter((t) => t.k === "pct").length;
  // TT47: Excel works to 15 significant digits — 0.00035*100 is 0.034999…96 in binary but 0.035 to Excel
  let x = Number((Math.abs(value) * 100 ** pct / 1000 ** scale).toPrecision(15));
  if (expIdx >= 0) return formatScientific(value, toks, expIdx);
  let fixed = roundAway(x, decPh.length).replace("-", "");
  let [ip, dp = ""] = fixed.split(".");
  const minInt = intPh.filter((p) => p.v === "0").length;
  if (ip === "0" && minInt === 0) ip = "";
  // TT73: literals between integer placeholders take digits on both sides — Excel distributes the digits right-aligned
  // across the placeholders ("(###) ###-####" → "(555) 123-4567", "0\\.0," on 9234 → "0.9", "# ##0" → "1 234")
  const intSeg = toks.slice(firstPh, lastIntPh + 1);
  // …and a '0' left of a '#' shows only in its own position ("0##" on 5 → "05", checked with Excel's TEXT per POI bug 61638)
  const interior = intSeg.some((t) => t.k === "lit") || (!thousands && /0[^0]*#/.test(intPh.map((p) => p.v).join("")));
  ip = interior ? distribute(ip, intSeg.filter((t) => t.k !== "comma")) : padInt(ip, intPh, thousands);
  // trailing '#' decimals drop zeros, '?' become spaces
  let dchars = dp.split("");
  for (let i = decPh.length - 1; i >= 0; i--) { if (dchars[i] !== "0") break; if (decPh[i].v === "#") dchars.pop(); else if (decPh[i].v === "?") dchars[i] = " "; else break; }
  dp = dchars.join("");
  fixed = "";
  // assemble: literals keep their position relative to the number block
  let out = ""; let intDone = false, decDone = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (interior && i > firstPh && i <= lastIntPh) continue; // emitted with the distributed integer digits
    if (t.k === "lit") out += t.v;
    else if (t.k === "pct") out += "%";
    else if (t.k === "comma" && i < firstPh) out += ","; // TT47: a comma before any digit placeholder is literal
    else if (t.k === "ph") {
      if (dotIdx >= 0 && i > dotIdx) { if (!decDone) { out += dp; decDone = true; } continue; }
      if (!intDone) { out += ip; intDone = true; }
    } else if (t.k === "dot") { if (i === dotIdx) { if (!intDone) { out += ip; intDone = true; } out += "."; } else out += "."; }
  }
  return out;
}

function formatDate(value: number, toks: Tok[]): string {
  const elapsed = toks.some((t) => t.k === "elapsed");
  if (value < 0 && elapsed) return "-" + formatDate(-value, toks); // [h]:mm etc. show negative durations
  if (value < 0) return "#".repeat(8);
  const day = Math.floor(value); const frac = value - day;
  const d = serialToDate(day);
  let secs = Math.round(frac * 86400 * 1000) / 1000;
  const hasAmPm = toks.some((t) => t.k === "ampm");
  const subsec = toks.some((t, i) => t.k === "date" && t.v.startsWith("s") && toks[i + 1]?.k === "dot" && toks[i + 2]?.k === "ph");
  if (!subsec) secs = Math.round(secs);
  const H = Math.floor(secs / 3600) % 24, M = Math.floor(secs / 60) % 60, S = Math.floor(secs % 60);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  // minutes vs months: 'm' after an hour token or before a seconds token is minutes
  const isMinute = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      const t = toks[j];
      // TT73: 'm' straight after seconds with only ':' between is minutes ("s:m" → "53:23")
      if (t.k === "date") return t.v.startsWith("h") || (t.v.startsWith("s") && toks.slice(j + 1, i).every((u) => u.k === "lit" && u.v === ":"));
      if (t.k === "elapsed") return t.v.startsWith("h");
    }
    for (let j = i + 1; j < toks.length; j++) { const t = toks[j]; if (t.k === "date") return t.v.startsWith("s"); }
    return false;
  };
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === "lit") out += t.v;
    else if (t.k === "elapsed") { const total = Math.round(value * 86400 * (subsec ? 1000 : 1)) / (subsec ? 1000 : 1); const n = t.v.startsWith("h") ? Math.floor(total / 3600) : t.v.startsWith("m") ? Math.floor(total / 60) : Math.floor(total); out += String(n).padStart(t.v.length, "0"); }
    else if (t.k === "ampm") out += t.v.length > 3 ? (H < 12 ? "AM" : "PM") : t.v[0] === "a" ? (H < 12 ? "a" : "p") : (H < 12 ? "A" : "P");
    else if (t.k === "dot") { out += "."; if (toks[i + 1]?.k === "ph") { let n = 0; while (toks[i + 1 + n]?.k === "ph") n++; out += (frac * 86400 % 1).toFixed(n).slice(2); i += n; } }
    else if (t.k === "date" && /^(h+|s+|m{1,2})$/.test(t.v) && toks.slice(0, i).some((u) => u.k === "elapsed" && u.v[0] === t.v[0]) && (t.v[0] !== "m" || isMinute(i))) {
      // TT73: after an elapsed [h]/[m]/[s], a plain token of the same unit is elapsed too ("[h] … h" → 75 both times)
      const total = Math.round(value * 86400 * (subsec ? 1000 : 1)) / (subsec ? 1000 : 1);
      const n = t.v[0] === "h" ? Math.floor(total / 3600) : t.v[0] === "m" ? Math.floor(total / 60) : Math.floor(total);
      out += String(n).padStart(t.v.length, "0");
    } else if (t.k === "date") {
      const v = t.v;
      if (v[0] === "y") out += v.length <= 2 ? pad(d.y % 100) : String(d.y);
      else if (v[0] === "d") out += v.length === 1 ? d.d : v.length === 2 ? pad(d.d) : v.length === 3 ? DAYS[d.weekday0].slice(0, 3) : DAYS[d.weekday0];
      else if (v[0] === "h") { const h = hasAmPm ? (H % 12 || 12) : H; out += v.length >= 2 ? pad(h) : h; }
      else if (v[0] === "s") out += v.length >= 2 ? pad(S) : S;
      else if (v[0] === "m") {
        if (v.length <= 2 && isMinute(i)) out += v.length === 2 ? pad(M) : M;
        else out += v.length === 1 ? d.m : v.length === 2 ? pad(d.m) : v.length === 3 ? MONTHS[d.m - 1].slice(0, 3) : v.length === 5 ? MONTHS[d.m - 1][0] : MONTHS[d.m - 1];
      }
    } else if (t.k === "ph") out += t.v === "0" ? "0" : "";
    else if (t.k === "pct") out += "%";
    else if (t.k === "comma") out += ",";
  }
  return out;
}

/** General format, per Excel-cached evidence (POI GeneralFormatTests): at most 11 characters (sign excluded), plain
 * decimals from 1E-09 up to 99999999999, otherwise scientific with up to 6 significant digits ("1.12346E+11").
 * TT73: never JavaScript exponent notation ("1e-9" → "0.000000001"); decimals are rounded to fit 11 characters. */
function sciGeneral(v: number): string {
  const [m, e] = v.toExponential(5).split("e");
  const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
  const n = Number(e);
  return `${mant}E${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
}
/** Plain decimal of |a| (no exponent) rounded to `d` decimals, trailing zeros removed. */
function plainDecimal(a: number, d: number): string {
  const [mant, ex] = Number(a.toPrecision(15)).toExponential(14).split("e");
  const digits = mant.replace(".", ""); const e = Number(ex);
  const big = BigInt(digits); const shift = d - 14 + e; let q: bigint;
  const TEN = BigInt(10), TWO = BigInt(2), ONE = BigInt(1);
  if (shift >= 0) q = big * TEN ** BigInt(shift); else { const div = TEN ** BigInt(-shift); q = big / div; if ((big % div) * TWO >= div) q += ONE; }
  let str = q.toString().padStart(d + 1, "0");
  if (d > 0) { str = str.slice(0, -d) + "." + str.slice(-d); str = str.replace(/0+$/, "").replace(/\.$/, ""); }
  return str;
}
export function formatGeneral(v: number): string {
  if (!Number.isFinite(v)) return "#NUM!";
  const a = Math.abs(v); const sg = v < 0 ? "-" : "";
  if (a === 0) return "0";
  if (Number.isInteger(v) && a < 1e11) return String(v);
  if (a >= 1e11 || a < 1e-9) return sciGeneral(v);
  const intDigits = a < 1 ? 1 : Math.floor(Math.log10(a)) + 1;
  let s = plainDecimal(a, Math.max(0, 10 - intDigits));
  if (s.replace(".", "").length > 11 || (s.indexOf(".") < 0 && s.length > 11)) return sciGeneral(v);
  if (/^0\.0+$/.test(s) || s === "0") return sciGeneral(v);
  // a tiny value whose 11-char decimal keeps fewer significant digits than scientific would show → scientific
  if (a < 1e-4) { const sig = s.replace(/^0\.0*/, "").length; const sci = sciGeneral(a); const sciSig = sci.split("E")[0].replace(".", "").length; if (sig < sciSig) return sciGeneral(v); }
  return sg + s;
}

export function formatValue(v: Scalar | undefined, fmt?: string): Formatted {
  if (v === undefined || v === "") return { text: "" };
  if (isError(v)) return { text: v.error };
  const code = (fmt ?? "General").trim();
  const sections = splitSections(code);
  if (typeof v === "boolean") {
    // TT73 (Excel-cached, POI TextFormatTests): a logical goes through the TEXT section, '@' standing for TRUE/FALSE
    const t = v ? "TRUE" : "FALSE";
    if (sections.length < 4) return { text: t };
    const { toks, color } = lex(sections[3]);
    return { text: toks.map((k) => (k.k === "at" ? t : k.k === "lit" ? k.v : "")).join(""), color };
  }
  if (typeof v === "string") {
    const sec = sections.length >= 4 ? sections[3] : sections.find((s) => s.includes("@"));
    if (!sec) return { text: v };
    const { toks, color } = lex(sec);
    return { text: toks.map((t) => (t.k === "at" ? v : t.k === "lit" ? t.v : "")).join(""), color };
  }
  const bare = (x: string) => x.replace(/^(\[\$-[0-9A-Fa-f]+\])+/, "").trim(); // TT73: "[$-1010409]General"
  if (/^general$/i.test(bare(code)) || code === "") return { text: formatGeneral(v) };
  let sec = sections[0]; let value = v; let autoMinus = v < 0;
  const conds = sections.map((x) => lex(x).cond);
  if (conds.some(Boolean)) { // TT46: [<0] / [>=100] conditional sections; the first matching wins, else the next unconditioned one
    const i = sections.findIndex((_, k) => conds[k] && condOk(conds[k]!, v));
    const j = i >= 0 ? i : sections.findIndex((_, k) => !conds[k] && k < 3);
    if (j < 0) return { text: formatGeneral(v) }; // TT47: no section applies → Excel shows the value in General
    sec = sections[j];
    // TT73 (Excel-cached evidence): a conditional section keeps the minus sign ("[<>-10]#" on -11 → "-11"); only a
    // negative-section condition ("[<0]", "[<=-1]": an upper bound at or below zero) formats the magnitude.
    const c = conds[j];
    autoMinus = v < 0 && j === 0 && !(c && (c.op === "<" || c.op === "<=") && c.v <= 0);
    value = v;
  } else if (v < 0 && sections.length >= 2 && sections[1] !== "") { sec = sections[1]; value = -v; autoMinus = false; }
  else if (v === 0 && sections.length >= 3 && sections[2] !== "") { sec = sections[2]; autoMinus = false; }
  if (/^general$/i.test(bare(sec))) return { text: formatGeneral(v) };
  const { toks, color } = lex(sec);
  // TT73: a text section ('@' and no digit or date token) applied to a number shows the number in General
  if (toks.some((t) => t.k === "at") && !toks.some((t) => t.k === "ph" || t.k === "date" || t.k === "elapsed" || t.k === "ampm")) return { text: toks.map((t) => (t.k === "at" ? formatGeneral(v) : t.k === "lit" ? t.v : "")).join(""), color };
  const isDate = toks.some((t) => t.k === "date" || t.k === "ampm" || t.k === "elapsed");
  let text = formatNumberToks(isDate ? v : Math.abs(value), toks);
  if (autoMinus && !isDate && /[1-9]/.test(text)) text = "-" + text;
  return { text, color };
}
