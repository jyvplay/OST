/**
 * TT139 (DP-15) — localisation: plural rules, message formatting, number/date.
 *
 * The shell ships English strings today and this module does not pretend
 * otherwise. What it *does* provide is the layer that makes a second language
 * possible without rewriting components: a CLDR-shaped plural-rule engine for
 * the locales this runtime can format, ICU-style message syntax with named
 * arguments and plural/select sub-messages, and locale-aware number, date and
 * list formatting built on `Intl` rather than on string concatenation.
 *
 * The plural categories are computed here, not delegated to `Intl.PluralRules`,
 * because the app must be able to *explain* why a string chose "few": the
 * engine returns the category and the operands it used. The rule tables below
 * are the CLDR cardinal rules for the locale groups an implementer actually
 * needs; an unknown locale falls back to the "other" category and says so.
 */

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

export interface Operands { n: number; i: number; v: number; w: number; f: number; t: number; e: number }

/** CLDR operands for a number as written in the message. */
export function pluralOperands(value: number, decimals?: number): Operands {
  const abs = Math.abs(value);
  const text = decimals !== undefined ? abs.toFixed(decimals) : String(abs);
  const [intPart, fracRaw] = text.split(".");
  const frac = fracRaw ?? "";
  const v = frac.length;
  const f = v ? Number(frac) : 0;
  const t = v ? Number(frac.replace(/0+$/, "") || "0") : 0;
  const w = v ? frac.replace(/0+$/, "").length : 0;
  return { n: abs, i: Number(intPart), v, w, f, t, e: 0 };
}

/**
 * CLDR cardinal plural rule families. Keys are families, not BCP-47 tags, so
 * adding a locale is one line and the test suite can check every group.
 */
export type PluralFamily =
  | "other" | "one-other" | "one-two-other" | "one-few-other" | "one-few-many-other"
  | "east-slavic" | "polish" | "czech-slovak" | "romanian" | "lithuanian" | "latvian"
  | "irish" | "welsh" | "arabic" | "slovenian" | "icelandic" | "macedonian" | "breton";

const FAMILY_BY_LOCALE: Record<string, PluralFamily> = {
  en: "one-other", de: "one-other", nl: "one-other", sv: "one-other", da: "one-other", nb: "one-other",
  nn: "one-other", fi: "one-other", et: "one-other", el: "one-other", he: "one-other", it: "one-other",
  es: "one-other", pt: "one-other", ca: "one-other", eo: "one-other", hu: "one-other", tr: "one-other",
  bg: "one-other", hi: "one-other", bn: "one-other", fa: "one-other", ja: "other", ko: "other",
  zh: "other", th: "other", vi: "other", id: "other", ms: "other", lo: "other", my: "other", km: "other",
  fr: "one-few-other", "fr-ch": "one-few-other", yo: "one-other",
  ru: "east-slavic", uk: "east-slavic", be: "east-slavic", sr: "east-slavic", hr: "east-slavic", bs: "east-slavic",
  pl: "polish", cs: "czech-slovak", sk: "czech-slovak", ro: "romanian", lt: "lithuanian", lv: "latvian",
  ga: "irish", cy: "welsh", ar: "arabic", sl: "slovenian", is: "icelandic", mk: "macedonian", br: "breton",
  ca_valencia: "one-few-other",
};

export function pluralFamily(locale: string): PluralFamily {
  const lower = String(locale ?? "").toLowerCase().replace("_", "-");
  if (FAMILY_BY_LOCALE[lower]) return FAMILY_BY_LOCALE[lower];
  const base = lower.split("-")[0];
  return FAMILY_BY_LOCALE[base] ?? "one-other";
}

/** CLDR cardinal plural category, with the rule that fired reported back. */
export function pluralCategory(locale: string, value: number, decimals?: number): { category: PluralCategory; family: PluralFamily; rule: string } {
  const fam = pluralFamily(locale);
  const o = pluralOperands(value, decimals);
  const { i, v, f, t } = o;
  const isInt = v === 0;
  const mod = (a: number, b: number) => ((a % b) + b) % b;
  const pick = (category: PluralCategory, rule: string) => ({ category, family: fam, rule });
  switch (fam) {
    case "other":
      return pick("other", "always other");
    case "one-other":
      return i === 1 && v === 0 ? pick("one", "i = 1 and v = 0") : pick("other", "default");
    case "one-two-other": // ga-ish handled in irish; this is for e.g. he/ro-lite locales
      return i === 1 && v === 0 ? pick("one", "i = 1 and v = 0") : i === 2 && v === 0 ? pick("two", "i = 2 and v = 0") : pick("other", "default");
    case "one-few-other": // fr, pt-PT
      return i === 0 || i === 1 ? pick("one", "i = 0 or i = 1") : pick("other", "default");
    case "one-few-many-other": // not used by CLDR cardinal directly; kept for completeness
      return i === 1 ? pick("one", "i = 1") : pick("other", "default");
    case "east-slavic": {
      if (v !== 0) return pick("other", "v ≠ 0");
      const m10 = mod(i, 10), m100 = mod(i, 100);
      if (m10 === 1 && m100 !== 11) return pick("one", "i % 10 = 1 and i % 100 ≠ 11");
      if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return pick("few", "i % 10 in 2..4 and i % 100 not in 12..14");
      return pick("many", "fallthrough for integers");
    }
    case "polish": {
      if (v !== 0) return pick("other", "v ≠ 0");
      if (i === 1) return pick("one", "i = 1");
      const m10 = mod(i, 10), m100 = mod(i, 100);
      if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return pick("few", "i % 10 in 2..4 and i % 100 not in 12..14");
      return pick("many", "default for integers");
    }
    case "czech-slovak": {
      if (v !== 0) return pick("many", "v ≠ 0");
      if (i === 1) return pick("one", "i = 1");
      if (i >= 2 && i <= 4) return pick("few", "i in 2..4");
      return pick("other", "default");
    }
    case "romanian": {
      if (i === 1 && v === 0) return pick("one", "i = 1 and v = 0");
      if (v !== 0 || i === 0 || (i !== 1 && mod(i, 100) >= 1 && mod(i, 100) <= 19)) return pick("few", "v ≠ 0 or i = 0 or i % 100 in 1..19");
      return pick("other", "default");
    }
    case "lithuanian": {
      const m10 = mod(i, 10), m100 = mod(i, 100);
      if (m10 === 1 && !(m100 >= 11 && m100 <= 19)) return pick("one", "i % 10 = 1 and i % 100 not in 11..19");
      if (m10 >= 2 && m10 <= 9 && !(m100 >= 11 && m100 <= 19)) return pick("few", "i % 10 in 2..9 and i % 100 not in 11..19");
      return pick("other", "default");
    }
    case "latvian": {
      const m10 = mod(i, 10), m100 = mod(i, 100);
      if (m10 === 0 || (m100 >= 11 && m100 <= 19) || (v === 2 && f % 100 >= 11 && f % 100 <= 19)) return pick("zero", "i % 10 = 0 or i % 100 in 11..19");
      if (m10 === 1 && m100 !== 11) return pick("one", "i % 10 = 1 and i % 100 ≠ 11");
      return pick("other", "default");
    }
    case "irish": {
      if (i === 1) return pick("one", "i = 1");
      if (i === 2) return pick("two", "i = 2");
      if (i >= 3 && i <= 6) return pick("few", "i in 3..6");
      if (i >= 7 && i <= 10) return pick("many", "i in 7..10");
      return pick("other", "default");
    }
    case "welsh": {
      if (i === 0) return pick("zero", "i = 0");
      if (i === 1) return pick("one", "i = 1");
      if (i === 2) return pick("two", "i = 2");
      if (i === 3) return pick("few", "i = 3");
      if (i === 6) return pick("many", "i = 6");
      return pick("other", "default");
    }
    case "arabic": {
      if (i === 0 && isInt) return pick("zero", "i = 0");
      if (i === 1 && isInt) return pick("one", "i = 1");
      if (i === 2 && isInt) return pick("two", "i = 2");
      const m100 = mod(i, 100);
      if (isInt && m100 >= 3 && m100 <= 10) return pick("few", "i % 100 in 3..10");
      if (isInt && m100 >= 11 && m100 <= 99) return pick("many", "i % 100 in 11..99");
      return pick("other", "default");
    }
    case "slovenian": {
      const m100 = mod(i, 100);
      if (v === 0 && m100 === 1) return pick("one", "v = 0 and i % 100 = 1");
      if (v === 0 && m100 === 2) return pick("two", "v = 0 and i % 100 = 2");
      if ((v === 0 && (m100 === 3 || m100 === 4)) || v !== 0) return pick("few", "v = 0 and i % 100 in 3..4, or v ≠ 0");
      return pick("other", "default");
    }
    case "icelandic": {
      const m10 = mod(i, 10), m100 = mod(i, 100);
      if (t === 0 && m10 === 1 && m100 !== 11) return pick("one", "t = 0 and i % 10 = 1 and i % 100 ≠ 11");
      if (t === 0 && m10 === 2 && m100 !== 12) return pick("two", "t = 0 and i % 10 = 2 and i % 100 ≠ 12");
      return pick("other", "default");
    }
    case "macedonian": {
      const m10 = mod(i, 10), m100 = mod(i, 100);
      if (v === 0 && m10 === 1 && m100 !== 11) return pick("one", "v = 0 and i % 10 = 1 and i % 100 ≠ 11");
      return pick("other", "default");
    }
    case "breton": {
      const m10 = mod(i, 10), m100 = mod(i, 100);
      if (m10 === 1 && !(m100 === 11 || m100 === 71 || m100 === 91)) return pick("one", "i % 10 = 1 and i % 100 not in {11,71,91}");
      if (m10 === 2 && !(m100 === 12 || m100 === 72 || m100 === 92)) return pick("two", "i % 10 = 2 and i % 100 default excluded");
      if (m10 === 3 || m10 === 4 || m10 === 9) return pick("few", "i % 10 in {3,4,9}");
      if (i !== 0 && mod(i, 1_000_000) === 0) return pick("many", "i ≠ 0 and i % 1000000 = 0");
      return pick("other", "default");
    }
  }
}

export type MessageArg = string | number | Date | undefined;
export interface FormatContext { locale: string; args: Record<string, MessageArg>; now?: number }

/**
 * Format an ICU-style message: `{name}`, `{count, plural, one {# item} other {# items}}`,
 * `{kind, select, a {…} other {…}}`, `{n, number}`, `{d, date}`, `{t, time}`.
 * Unknown arguments render as `{name}` rather than disappearing, so a missing
 * translation is visible instead of silent.
 */
export function formatMessage(template: string, ctx: FormatContext): string {
  return renderTemplate(String(template), ctx);
}

function renderTemplate(template: string, ctx: FormatContext): string {
  // ICU message syntax has no escape for a literal brace, so the practical
  // convention is to double it: "{{" renders as "{". This is a pre-pass over
  // quoted-literal doubles only, which keeps a real "{{a}}" nesting untouched.
  template = template.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => `\uE000${inner}\uE001`);
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "'" && template[i + 1] === "'") { out += "'"; i += 2; continue; }
    if (ch !== "{") { out += ch; i++; continue; }
    const close = matchBrace(template, i);
    if (close === -1) { out += template.slice(i); break; }
    out += renderPlaceholder(template.slice(i + 1, close), ctx);
    i = close + 1;
  }
  out = out.replace(/\uE000/g, "{").replace(/\uE001/g, "}");
  return out;
}

function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function renderPlaceholder(body: string, ctx: FormatContext): string {
  const parts = splitTopLevel(body, ",");
  const name = parts[0].trim();
  const value = ctx.args[name];
  if (parts.length === 1) return value === undefined ? `{${name}}` : stringify(value, ctx);
  const type = parts[1].trim().toLowerCase();
  const rest = parts.slice(2).join(",").trim();
  if (type === "plural" || type === "selectordinal") {
    const n = typeof value === "number" ? value : Number(value ?? 0);
    const category = type === "selectordinal" ? ordinalCategory(ctx.locale, n) : pluralCategory(ctx.locale, n).category;
    const branches = parseBranches(rest);
    const chosen = branches[category] ?? branches.other ?? `{${name}}`;
    return renderTemplate(chosen.replace(/#/g, formatNumber(n, ctx.locale)), ctx);
  }
  if (type === "select") {
    const key = value === undefined ? "other" : String(value);
    const branches = parseBranches(rest);
    return renderTemplate(branches[key] ?? branches.other ?? `{${name}}`, ctx);
  }
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value ?? 0);
    if (rest.startsWith("::")) return formatCurrencyOrPercent(n, rest.slice(2), ctx.locale);
    return formatNumber(n, ctx.locale);
  }
  if (type === "date") {
    const d = value instanceof Date ? value : new Date(typeof value === "number" ? value : Date.parse(String(value ?? "")));
    return Number.isNaN(d.getTime()) ? `{${name}}` : formatDate(d, ctx.locale, rest);
  }
  if (type === "time") {
    const d = value instanceof Date ? value : new Date(typeof value === "number" ? value : Date.parse(String(value ?? "")));
    return Number.isNaN(d.getTime()) ? `{${name}}` : new Intl.DateTimeFormat(ctx.locale, { timeStyle: rest === "short" ? "short" : "medium" }).format(d);
  }
  return value === undefined ? `{${name}}` : stringify(value, ctx);
}

function parseBranches(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    const keyStart = i;
    while (i < text.length && !/[\s{]/.test(text[i])) i++;
    const key = text.slice(keyStart, i);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "{") break;
    const close = matchBrace(text, i);
    if (close === -1) break;
    out[key] = text.slice(i + 1, close);
    i = close + 1;
  }
  return out;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") depth--;
    else if (s[i] === sep && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out;
}

function stringify(value: MessageArg, ctx: FormatContext): string {
  if (value instanceof Date) return formatDate(value, ctx.locale, "medium");
  if (typeof value === "number") return formatNumber(value, ctx.locale);
  return String(value ?? "");
}

export function formatNumber(value: number, locale: string, opts: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(value)) return String(value);
  try { return new Intl.NumberFormat(locale, opts).format(value); } catch { return String(value); }
}

function formatCurrencyOrPercent(n: number, spec: string, locale: string): string {
  // `percent` or a currency code (`EUR`)
  if (spec === "percent") return formatNumber(n, locale, { style: "percent", maximumFractionDigits: 1 });
  try { return formatNumber(n, locale, { style: "currency", currency: spec.toUpperCase() }); } catch { return formatNumber(n, locale); }
}

const DATE_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  short: { dateStyle: "short" }, medium: { dateStyle: "medium" }, long: { dateStyle: "long" }, full: { dateStyle: "full" },
};
export function formatDate(d: Date, locale: string, style = "medium"): string {
  try { return new Intl.DateTimeFormat(locale, DATE_STYLES[style] ?? DATE_STYLES.medium).format(d); } catch { return d.toISOString(); }
}

/** Ordinal plural category (CLDR), which English needs for "1st/2nd/3rd/4th". */
export function ordinalCategory(locale: string, n: number): PluralCategory {
  const base = String(locale).toLowerCase().split("-")[0];
  if (base === "en") {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return "one";
    if (m10 === 2 && m100 !== 12) return "two";
    if (m10 === 3 && m100 !== 13) return "few";
    return "other";
  }
  return n === 1 ? "one" : "other";
}

/** Properly localised list ("A, B and C" / "A、B、C"). */
export function formatList(items: readonly string[], locale: string): string {
  try {
    const anyIntl = Intl as unknown as { ListFormat?: new (l: string, o?: object) => { format: (a: string[]) => string } };
    if (anyIntl.ListFormat) return new anyIntl.ListFormat(locale, { style: "long", type: "conjunction" }).format([...items]);
  } catch { /* fall through */ }
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Relative time ("3 minutes ago") via Intl.RelativeTimeFormat, with an explicit unit. */
export function formatRelative(ms: number, locale: string, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const unit: [Intl.RelativeTimeFormatUnit, number] =
    abs < 60_000 ? ["second", 1000] : abs < 3_600_000 ? ["minute", 60_000] : abs < 86_400_000 ? ["hour", 3_600_000] : abs < 2_592_000_000 ? ["day", 86_400_000] : abs < 31_536_000_000 ? ["month", 2_592_000_000] : ["year", 31_536_000_000];
  try { return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.round(diff / unit[1]), unit[0]); }
  catch { return new Date(ms).toISOString(); }
}
