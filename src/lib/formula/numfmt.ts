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
    if (c === "\\") { toks.push({ k: "lit", v: s[i + 1] ?? "" }); i += 2; continue; }
    if (c === "_") { toks.push({ k: "lit", v: " " }); i += 2; continue; }
    if (c === "*") { i += 2; continue; }
    if (c === "[") {
      const j = s.indexOf("]", i); const inner = s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j + 1;
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
/** Fraction formats: "# ?/?", "# ??/??", "?/8", "0 0/100" (numerator/denominator placeholders around a literal '/'). */
function formatFraction(value: number, toks: Tok[], slash: number): string {
  let ns = slash; while (ns > 0 && toks[ns - 1].k === "ph") ns--;
  const numPh = toks.slice(ns, slash) as { k: "ph"; v: string }[];
  let de = slash + 1; let fixedDen = "";
  while (de < toks.length && toks[de].k === "lit" && /^\d$/.test((toks[de] as { v: string }).v)) { fixedDen += (toks[de] as { v: string }).v; de++; }
  const denStart = slash + 1; let denEnd = denStart;
  if (!fixedDen) while (denEnd < toks.length && toks[denEnd].k === "ph") denEnd++;
  const denPh = toks.slice(denStart, denEnd) as { k: "ph"; v: string }[];
  const intIdx = toks.slice(0, ns).map((t, i) => (t.k === "ph" ? i : -1)).filter((i) => i >= 0);
  const mixed = intIdx.length > 0;
  const x = Math.abs(value);
  let ip = mixed ? Math.floor(x) : 0; const frac = x - ip;
  let [num, den] = fixedDen ? [Math.round(frac * Number(fixedDen)), Number(fixedDen)] : bestFraction(frac, 10 ** Math.max(1, denPh.length) - 1);
  if (!mixed && !fixedDen && frac >= 1) [num, den] = bestFraction(frac % 1, 10 ** Math.max(1, denPh.length) - 1), num += Math.floor(frac) * den;
  if (num === den && mixed) { ip++; num = 0; }
  const padL = (str: string, ph: { v: string }[]) => { const z = ph.filter((p) => p.v === "0").length; const q = ph.filter((p) => p.v === "?").length; return str.padStart(z, "0").padStart(z + q, " "); };
  const blankFrac = num === 0 && mixed;
  let ipStr = ip === 0 ? "" : String(ip);
  if (mixed) { const ph = intIdx.map((i) => toks[i] as { v: string }); ipStr = padL(ipStr, ph); if (ip === 0 && (num === 0 || !ph.length) && !ipStr.trim()) ipStr = num === 0 ? "0" : ipStr; }
  const numStr = blankFrac ? " ".repeat(Math.max(numPh.length, String(num).length)) : padL(String(num), numPh);
  const denStr = fixedDen ? (blankFrac ? " ".repeat(fixedDen.length) : fixedDen) : blankFrac ? " ".repeat(Math.max(denPh.length, 1)) : String(den).padEnd(denPh.length, " ");
  let out = "", done = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (mixed && i === intIdx[0]) { out += ipStr; continue; }
    if (mixed && intIdx.includes(i)) continue;
    if (i === ns && !done) { out += numStr + (blankFrac ? " " : "/") + denStr; done = true; i = fixedDen ? de - 1 : denEnd - 1; continue; }
    if (t.k === "lit") out += mixed && blankFrac && i > intIdx[intIdx.length - 1] && i < ns ? " ".repeat(t.v.length) : t.v;
    else if (t.k === "pct") out += "%";
  }
  if (!mixed && num === 0 && !fixedDen) return out.replace(numStr + "/" + denStr, "0".padStart(numStr.length, " ") + " ".repeat(1 + denStr.length));
  return out;
}

/** Round half away from zero at `d` decimals (Excel display rounding). */
function roundAway(x: number, d: number): string {
  if (d > 15) d = 15;
  const sgn = x < 0 ? -1 : 1; const a = Math.abs(x);
  const r = Math.round(Number(`${a}e${d}`)) / 10 ** d; // decimal-string shift avoids 1.005*100 errors
  const v = Number.isFinite(r) ? r : a;
  return (sgn < 0 && v !== 0 ? "-" : "") + v.toFixed(d);
}
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function formatNumberToks(value: number, toks: Tok[]): string {
  const hasDate = toks.some((t) => t.k === "date" || t.k === "ampm" || t.k === "elapsed");
  if (hasDate) return formatDate(value, toks);
  const firstPh = toks.findIndex((t) => t.k === "ph");
  if (firstPh < 0) return toks.map((t) => (t.k === "lit" ? t.v : t.k === "pct" ? "%" : "")).join("");
  const expIdx = toks.findIndex((t) => t.k === "exp");
  const slash = toks.findIndex((t, i) => t.k === "lit" && t.v === "/" && toks[i - 1]?.k === "ph" && (toks[i + 1]?.k === "ph" || (toks[i + 1]?.k === "lit" && /^\d$/.test((toks[i + 1] as { v: string }).v))));
  if (slash > 0 && expIdx < 0) return formatFraction(value, toks, slash);
  const dotIdx = toks.findIndex((t, i) => t.k === "dot" && (expIdx < 0 || i < expIdx));
  let lastPh = -1; toks.forEach((t, i) => { if (t.k === "ph" && (expIdx < 0 || i < expIdx)) lastPh = i; });
  const intEnd = dotIdx >= 0 ? dotIdx : lastPh + 1;
  const intPh = toks.slice(0, intEnd).filter((t) => t.k === "ph") as { k: "ph"; v: string }[];
  const decPh = dotIdx >= 0 ? (toks.slice(dotIdx + 1, expIdx >= 0 ? expIdx : undefined).filter((t) => t.k === "ph") as { k: "ph"; v: string }[]) : [];
  const thousands = toks.slice(firstPh, intEnd).some((t) => t.k === "comma");
  let scale = 0; for (let i = lastPh + 1; i < toks.length && toks[i].k === "comma"; i++) scale++;
  const pct = toks.filter((t) => t.k === "pct").length;
  let x = Math.abs(value) * 100 ** pct / 1000 ** scale;
  let expStr = "";
  if (expIdx >= 0) {
    const expPh = toks.slice(expIdx + 1).filter((t) => t.k === "ph").length;
    const intDigits = Math.max(1, intPh.length);
    // TT46: a '#' in the integer placeholders makes it ENGINEERING notation (exponent a multiple of their count).
    const eng = intPh.length > 1 && intPh.some((p) => p.v === "#");
    let e: number, m: number;
    if (eng) { e = x === 0 ? 0 : Math.floor(Math.floor(Math.log10(x)) / intDigits) * intDigits; m = x / 10 ** e; if (Number(roundAway(m, decPh.length)) >= 10 ** intDigits) { e += intDigits; m = x / 10 ** e; } }
    else { e = x === 0 ? 0 : Math.floor(Math.log10(x)) - (intDigits - 1); m = x / 10 ** e; if (Number(roundAway(m, decPh.length)) >= 10 ** intDigits) { e++; m = x / 10 ** e; } }
    x = m;
    const et = toks[expIdx] as { sign: string; upper: boolean };
    const sign = e < 0 ? "-" : et.sign === "+" ? "+" : "";
    expStr = `${et.upper ? "E" : "e"}${sign}${String(Math.abs(e)).padStart(expPh, "0")}`;
  }
  let fixed = roundAway(x, decPh.length).replace("-", "");
  let [ip, dp = ""] = fixed.split(".");
  const minInt = intPh.filter((p) => p.v === "0").length;
  if (ip === "0" && minInt === 0) ip = "";
  ip = ip.padStart(minInt, "0");
  const qInt = intPh.filter((p) => p.v === "?").length;
  if (qInt) ip = ip.padStart(minInt + qInt, " ");
  if (thousands) ip = group(ip);
  // trailing '#' decimals drop zeros, '?' become spaces
  let dchars = dp.split("");
  for (let i = decPh.length - 1; i >= 0; i--) { if (dchars[i] !== "0") break; if (decPh[i].v === "#") dchars.pop(); else if (decPh[i].v === "?") dchars[i] = " "; else break; }
  dp = dchars.join("");
  fixed = "";
  // assemble: literals keep their position relative to the number block
  let out = ""; let intDone = false, decDone = false, expDone = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === "lit") out += t.v;
    else if (t.k === "pct") out += "%";
    else if (t.k === "ph") {
      if (expIdx >= 0 && i > expIdx) { if (!expDone) { out += expStr; expDone = true; } continue; }
      if (dotIdx >= 0 && i > dotIdx) { if (!decDone) { out += dp; decDone = true; } continue; }
      if (!intDone) { out += ip; intDone = true; }
    } else if (t.k === "dot") { if (i === dotIdx) { if (!intDone) { out += ip; intDone = true; } out += "."; } else out += "."; }
    else if (t.k === "exp") { if (!expDone && toks.slice(i + 1).every((u) => u.k !== "ph")) { out += expStr; expDone = true; } }
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
    for (let j = i - 1; j >= 0; j--) { const t = toks[j]; if (t.k === "date") return t.v.startsWith("h"); if (t.k === "elapsed") return t.v.startsWith("h"); }
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
    else if (t.k === "date") {
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

/** General format: up to 11 significant characters like Excel's default column, no float noise. */
export function formatGeneral(v: number): string {
  if (!Number.isFinite(v)) return "#NUM!";
  if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e11 || a < 1e-9)) {
    const [m, e] = v.toExponential(5).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const n = Number(e);
    return `${mant}E${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  return String(Number(v.toPrecision(10)));
}

export function formatValue(v: Scalar | undefined, fmt?: string): Formatted {
  if (v === undefined || v === "") return { text: "" };
  if (isError(v)) return { text: v.error };
  if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE" };
  const code = (fmt ?? "General").trim();
  const sections = splitSections(code);
  if (typeof v === "string") {
    const sec = sections.length >= 4 ? sections[3] : sections.find((s) => s.includes("@"));
    if (!sec) return { text: v };
    const { toks, color } = lex(sec);
    return { text: toks.map((t) => (t.k === "at" ? v : t.k === "lit" ? t.v : "")).join(""), color };
  }
  if (/^general$/i.test(code) || code === "") return { text: formatGeneral(v) };
  let sec = sections[0]; let value = v; let autoMinus = v < 0;
  const conds = sections.map((x) => lex(x).cond);
  if (conds.some(Boolean)) { // TT46: [<0] / [>=100] conditional sections; the first matching wins, else the next unconditioned one
    const i = sections.findIndex((_, k) => conds[k] && condOk(conds[k]!, v));
    const j = i >= 0 ? i : sections.findIndex((_, k) => !conds[k] && k < 3);
    sec = sections[j >= 0 ? j : 0];
    autoMinus = v < 0 && !(conds[j]?.op.startsWith("<") ?? false) && j === 0;
    value = v;
  } else if (v < 0 && sections.length >= 2 && sections[1] !== "") { sec = sections[1]; value = -v; autoMinus = false; }
  else if (v === 0 && sections.length >= 3 && sections[2] !== "") { sec = sections[2]; autoMinus = false; }
  if (/^general$/i.test(sec.trim())) return { text: formatGeneral(v) };
  const { toks, color } = lex(sec);
  const isDate = toks.some((t) => t.k === "date" || t.k === "ampm" || t.k === "elapsed");
  let text = formatNumberToks(isDate ? v : Math.abs(value), toks);
  if (autoMinus && !isDate && /[1-9]/.test(text)) text = "-" + text;
  return { text, color };
}
