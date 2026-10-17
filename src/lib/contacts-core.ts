/**
 * Contacts engine (TT24, PR-05 / CN-*). Pure and hook-free: shared by the Contacts module and the Node test suites.
 *
 * Storage is a real vCard file (/Contacts/contacts.vcf), so the address book is inspectable in Files and opens in
 * any other contacts app. We READ vCard 2.1, 3.0 (RFC 2426) and 4.0 (RFC 6350) and WRITE 4.0.
 *
 * Covered: line unfolding, groups (item1.EMAIL), parameters incl. quoted values and RFC 6868 caret escapes, TEXT
 * escapes (\n \, \; \\), structured N / ADR / ORG, multi-valued NICKNAME / CATEGORIES, 2.1 bare TYPE params,
 * QUOTED-PRINTABLE with soft line breaks + CHARSET, inline base64 PHOTO (ENCODING=b / BASE64) → data: URI,
 * PREF (4.0 PREF=n and 3.0 TYPE=pref), and folding at 75 octets on write without splitting UTF-8 sequences.
 * Properties we do not model (X-*, IMPP, GEO, KEY, RELATED, …) are kept verbatim and written back, so a round
 * trip does not lose them. Not covered: AGENT nested vCards (skipped with a warning), vCard in XML/JSON (jCard).
 */

/** `params`: other parameters (PID, ALTID, LABEL, …) re-serialised verbatim; `uri`: TEL was a tel: URI (VALUE=uri). */
export interface Typed { value: string; types: string[]; pref?: number; params?: string; uri?: boolean }
export interface Adr { types: string[]; pobox: string; ext: string; street: string; locality: string; region: string; code: string; country: string; pref?: number; params?: string }
export interface Name { family: string; given: string; additional: string; prefix: string; suffix: string }
export interface Contact {
  uid: string;
  fn: string;
  n: Name;
  nickname: string[];
  org: string[];
  title: string;
  emails: Typed[];
  tels: Typed[];
  adrs: Adr[];
  urls: Typed[];
  bday: string;
  note: string;
  categories: string[];
  /** data: or http(s): URI; "" when none */
  photo: string;
  rev: string;
  /** unmodelled properties as unfolded content lines, written back verbatim */
  extra: string[];
}
export interface ParseResult { contacts: Contact[]; warnings: string[]; versions: Record<string, number> }

export const MAX_INPUT = 20 * 1024 * 1024;
export const MAX_CONTACTS = 20_000;
const EMPTY_NAME: Name = { family: "", given: "", additional: "", prefix: "", suffix: "" };

export function emptyContact(uid: string): Contact {
  return { uid, fn: "", n: { ...EMPTY_NAME }, nickname: [], org: [], title: "", emails: [], tels: [], adrs: [], urls: [], bday: "", note: "", categories: [], photo: "", rev: "", extra: [] };
}

/* ───────────────────────── lexical layer ───────────────────────── */

interface Prop { group: string; name: string; params: Record<string, string[]>; value: string; line: number; raw: string }

/** Split on unescaped `sep` (backslash escapes are kept for the later unescape step). */
function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = []; let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === sep) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function unescapeText(s: string): string {
  return s.replace(/\\([nN,;:\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** RFC 6868: ^n → newline, ^' → ", ^^ → ^ inside parameter values. */
const decodeParam = (v: string) => v.replace(/\^(\^|n|')/g, (_, c: string) => (c === "n" ? "\n" : c === "'" ? '"' : "^"));
const encodeParam = (v: string) => {
  const e = v.replace(/\^/g, "^^").replace(/\r\n|\r|\n/g, "^n").replace(/"/g, "^'");
  return /[:;,]/.test(e) || /\s/.test(e) ? `"${e}"` : e;
};

/** Parse one unfolded content line: [group.]name *(;param) : value. */
function parseLine(raw: string, line: number): Prop | null {
  let i = 0, inQ = false;
  for (; i < raw.length; i++) { const c = raw[i]; if (c === '"') inQ = !inQ; else if (c === ":" && !inQ) break; }
  if (i >= raw.length) return null;
  const head = raw.slice(0, i), value = raw.slice(i + 1);
  const parts: string[] = []; let cur = ""; inQ = false;
  for (const c of head) { if (c === '"') { inQ = !inQ; cur += c; } else if (c === ";" && !inQ) { parts.push(cur); cur = ""; } else cur += c; }
  parts.push(cur);
  const nameFull = parts.shift()!.trim();
  const dot = nameFull.lastIndexOf(".");
  const group = dot > 0 ? nameFull.slice(0, dot) : "";
  const name = (dot > 0 ? nameFull.slice(dot + 1) : nameFull).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params: Record<string, string[]> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    // vCard 2.1 bare parameter (TEL;HOME;VOICE) is a TYPE; bare QUOTED-PRINTABLE / BASE64 are ENCODINGs
    const key = eq < 0 ? (/^(QUOTED-PRINTABLE|BASE64|B|8BIT|7BIT)$/i.test(p) ? "ENCODING" : "TYPE") : p.slice(0, eq).trim().toUpperCase();
    const rawVals = eq < 0 ? p : p.slice(eq + 1);
    const vals: string[] = []; let v = ""; let q = false;
    for (const c of rawVals) { if (c === '"') q = !q; else if (c === "," && !q) { vals.push(v); v = ""; } else v += c; }
    vals.push(v);
    (params[key] ??= []).push(...vals.map((x) => decodeParam(x.trim())).filter((x) => x !== ""));
  }
  return { group, name, params, value, line, raw };
}

function decodeQuotedPrintable(s: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else { const code = s.charCodeAt(i); if (code < 0x80) bytes.push(code); else for (const b of new TextEncoder().encode(s[i])) bytes.push(b); }
  }
  try { return new TextDecoder(charset || "utf-8", { fatal: false }).decode(new Uint8Array(bytes)); }
  catch { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); }
}

/** Unfold physical lines into content lines (RFC 6350 §3.2) plus vCard 2.1 quoted-printable soft breaks. */
function unfold(text: string): { line: number; text: string }[] {
  const phys = text.replace(/^\ufeff/, "").split(/\r\n|\r|\n/);
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < phys.length; i++) {
    const l = phys[i];
    if ((l.startsWith(" ") || l.startsWith("\t")) && out.length) { out[out.length - 1].text += l.slice(1); continue; }
    if (l === "") continue;
    out.push({ line: i + 1, text: l });
    // QP soft line break: "…=" at end continues on the next physical line, which has no leading space
    if (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE[;:]/i.test(l.split(":")[0] + ":")) {
      while (out[out.length - 1].text.endsWith("=") && i + 1 < phys.length) out[out.length - 1].text = out[out.length - 1].text.slice(0, -1) + phys[++i].replace(/^[ \t]/, "");
    }
  }
  return out;
}

/* ───────────────────────── semantic layer ───────────────────────── */

const typesOf = (p: Prop) => {
  const t = (p.params.TYPE ?? []).flatMap((x) => x.split(",")).map((x) => x.toLowerCase().trim()).filter(Boolean);
  return [...new Set(t.filter((x) => x !== "pref" && x !== "internet" && x !== "x400"))];
};
const prefOf = (p: Prop): number | undefined => {
  const n = Number(p.params.PREF?.[0]);
  if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
  return (p.params.TYPE ?? []).some((t) => t.toLowerCase() === "pref") ? 1 : undefined;
};

const MODELLED_PARAMS = new Set(["TYPE", "PREF", "ENCODING", "CHARSET", "VALUE"]);
/** Parameters we do not model, re-serialised so a round trip keeps PID / ALTID / LABEL / LANGUAGE / … */
function extraParams(p: Prop): string | undefined {
  const s = Object.entries(p.params).filter(([k]) => !MODELLED_PARAMS.has(k)).map(([k, v]) => `;${k}=${v.map(encodeParam).join(",")}`).join("");
  return s || undefined;
}
const withParams = <T extends object>(o: T, p: Prop): T => { const x = extraParams(p); return x ? { ...o, params: x } : o; };

function textValue(p: Prop): string {
  const enc = (p.params.ENCODING?.[0] ?? "").toUpperCase();
  if (enc === "QUOTED-PRINTABLE") return decodeQuotedPrintable(p.value, p.params.CHARSET?.[0] ?? "utf-8");
  return p.value;
}

export interface ParseOptions { newUid?: () => string }
const defaultUid = () => `urn:uuid:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)}`;

export function parseVcf(input: string, opts: ParseOptions = {}): ParseResult {
  const warnings: string[] = []; const versions: Record<string, number> = {};
  const contacts: Contact[] = [];
  if (input.length > MAX_INPUT) return { contacts, warnings: [`input is ${input.length} characters; the limit is ${MAX_INPUT}`], versions };
  const newUid = opts.newUid ?? defaultUid;
  let cur: { c: Contact; version: string; start: number; hadFn: boolean; depth: number } | null = null;
  for (const { line, text } of unfold(input)) {
    const p = parseLine(text, line);
    if (!p) { if (cur) warnings.push(`line ${line}: not a property, ignored`); continue; }
    if (p.name === "BEGIN" && p.value.trim().toUpperCase() === "VCARD") {
      if (cur) { cur.depth++; warnings.push(`line ${line}: nested vCard (AGENT) skipped`); continue; }
      if (contacts.length >= MAX_CONTACTS) { warnings.push(`stopped after ${MAX_CONTACTS} contacts`); break; }
      cur = { c: emptyContact(""), version: "", start: line, hadFn: false, depth: 0 };
      continue;
    }
    if (!cur) continue;
    if (p.name === "END" && p.value.trim().toUpperCase() === "VCARD") {
      if (cur.depth > 0) { cur.depth--; continue; }
      contacts.push(finish(cur.c, cur.hadFn, newUid, warnings, cur.start));
      versions[cur.version || "unknown"] = (versions[cur.version || "unknown"] ?? 0) + 1;
      cur = null; continue;
    }
    if (cur.depth > 0) continue;
    apply(cur, p, warnings);
  }
  if (cur) {
    warnings.push(`line ${cur.start}: vCard without END:VCARD, kept`);
    contacts.push(finish(cur.c, cur.hadFn, newUid, warnings, cur.start));
    versions[cur.version || "unknown"] = (versions[cur.version || "unknown"] ?? 0) + 1;
  }
  return { contacts, warnings, versions };
}

function apply(cur: { c: Contact; version: string; hadFn: boolean }, p: Prop, warnings: string[]) {
  const c = cur.c;
  const v = textValue(p);
  switch (p.name) {
    case "VERSION": cur.version = v.trim(); return;
    case "FN": if (!c.fn) { c.fn = unescapeText(v).trim(); cur.hadFn = true; } return;
    case "N": {
      const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitEscaped(v, ";").map((x) => splitEscaped(x, ",").map(unescapeText).join(", ").trim());
      c.n = { family, given, additional, prefix, suffix }; return;
    }
    case "NICKNAME": c.nickname.push(...splitEscaped(v, ",").map(unescapeText).map((x) => x.trim()).filter(Boolean)); return;
    case "CATEGORIES": c.categories.push(...splitEscaped(v, ",").map(unescapeText).map((x) => x.trim()).filter(Boolean)); return;
    case "ORG": c.org = splitEscaped(v, ";").map(unescapeText).map((x) => x.trim()).filter(Boolean); return;
    case "TITLE": c.title = unescapeText(v).trim(); return;
    case "EMAIL": { const e = unescapeText(v).trim(); if (e) c.emails.push(withParams({ value: e, types: typesOf(p), pref: prefOf(p) }, p)); return; }
    case "TEL": {
      const isUri = (p.params.VALUE?.[0] ?? "").toLowerCase() === "uri" || /^tel:/i.test(v.trim());
      const t = (isUri ? v : unescapeText(v)).trim().replace(/^tel:/i, "");
      const ty = typesOf(p);
      if (t) c.tels.push(withParams({ value: t, types: ty.filter((x) => x !== "voice" || ty.length === 1), pref: prefOf(p), ...(isUri ? { uri: true } : {}) }, p));
      return;
    }
    case "URL": { const u = unescapeText(v).trim(); if (u) c.urls.push(withParams({ value: u, types: typesOf(p), pref: prefOf(p) }, p)); return; }
    case "ADR": {
      const [pobox = "", ext = "", street = "", locality = "", region = "", code = "", country = ""] = splitEscaped(v, ";").map((x) => splitEscaped(x, ",").map(unescapeText).join(", ").trim());
      if ([pobox, ext, street, locality, region, code, country].some(Boolean)) c.adrs.push(withParams({ types: typesOf(p), pobox, ext, street, locality, region, code, country, pref: prefOf(p) }, p));
      return;
    }
    case "BDAY":
      // a text birthday ("circa 1800") is not a date: keep the line verbatim instead of writing it back as an invalid date
      if ((p.params.VALUE?.[0] ?? "").toLowerCase() === "text") c.extra.push(p.raw); else c.bday = v.trim();
      return;
    case "NOTE": c.note = c.note ? `${c.note}\n${unescapeText(v)}` : unescapeText(v); return;
    case "UID": c.uid = v.trim(); return;
    case "REV": c.rev = v.trim(); return;
    case "PHOTO": {
      const enc = (p.params.ENCODING?.[0] ?? "").toUpperCase();
      if (enc === "B" || enc === "BASE64") {
        const t = (p.params.TYPE?.[0] ?? "jpeg").toLowerCase().replace(/^image\//, "");
        c.photo = `data:image/${t};base64,${p.value.replace(/\s/g, "")}`;
      } else if (/^(data:image\/|https?:)/i.test(p.value.trim())) c.photo = p.value.trim();
      else warnings.push(`line ${p.line}: PHOTO with unsupported encoding kept as-is`), c.extra.push(p.raw);
      return;
    }
    case "PRODID": case "KIND": if (p.name === "KIND" && v.trim().toLowerCase() !== "individual") c.extra.push(p.raw); return;
    default: c.extra.push(p.raw);
  }
}

function finish(c: Contact, hadFn: boolean, newUid: () => string, warnings: string[], start: number): Contact {
  if (!c.uid) c.uid = newUid();
  if (!hadFn || !c.fn) {
    const fromN = [c.n.prefix, c.n.given, c.n.additional, c.n.family, c.n.suffix].filter(Boolean).join(" ");
    c.fn = fromN || c.org[0] || c.emails[0]?.value || c.tels[0]?.value || "Unnamed";
    if (!hadFn) warnings.push(`line ${start}: no FN; display name derived as "${c.fn}"`);
  }
  return c;
}

/* ───────────────────────── writer ───────────────────────── */

/** Fold at 75 octets (RFC 6350 §3.2) without splitting a UTF-8 sequence; continuation lines start with one space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = []; let cur = ""; let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines carry the leading space
    if (bytes + n > limit) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : " " + l)).join("\r\n");
}

const typeParams = (t: { types: string[]; pref?: number; params?: string }) =>
  `${t.types.length ? `;TYPE=${t.types.map(encodeParam).join(",")}` : ""}${t.pref ? `;PREF=${t.pref}` : ""}${t.params ?? ""}`;

/** RFC 6350 §4.3.1: vCard 4.0 dates use the BASIC format — 1985-04-12 → 19850412, --04-12 → --0412. */
export function basicDate(s: string): string {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t); if (m) return `${m[1]}${m[2]}${m[3]}`;
  m = /^--(\d{2})-(\d{2})$/.exec(t); if (m) return `--${m[1]}${m[2]}`;
  return t;
}
/** Every RFC 6350 date / date-time form we accept (plus the extended forms people type, converted on write). */
export const isVcardDate = (s: string) => /^(\d{8}|\d{4}-\d{2}|\d{4}|--\d{4}|--\d{2}|---\d{2}|\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})(T[\d:+\-Z]+)?$/.test(s.trim());

export function serializeContact(c: Contact, now?: string): string {
  const L: string[] = ["BEGIN:VCARD", "VERSION:4.0"];
  L.push(`UID:${c.uid}`);
  L.push(`FN:${escapeText(c.fn || "Unnamed")}`);
  const n = c.n;
  if ([n.family, n.given, n.additional, n.prefix, n.suffix].some(Boolean)) L.push(`N:${[n.family, n.given, n.additional, n.prefix, n.suffix].map(escapeText).join(";")}`);
  if (c.nickname.length) L.push(`NICKNAME:${c.nickname.map(escapeText).join(",")}`);
  if (c.org.length) L.push(`ORG:${c.org.map(escapeText).join(";")}`);
  if (c.title) L.push(`TITLE:${escapeText(c.title)}`);
  for (const e of c.emails) L.push(`EMAIL${typeParams(e)}:${escapeText(e.value)}`);
  for (const t of c.tels) L.push(t.uri ? `TEL${typeParams(t)};VALUE=uri:tel:${t.value.trim().replace(/\s+/g, "-")}` : `TEL${typeParams(t)}:${escapeText(t.value)}`);
  for (const a of c.adrs) L.push(`ADR${typeParams(a)}:${[a.pobox, a.ext, a.street, a.locality, a.region, a.code, a.country].map(escapeText).join(";")}`);
  for (const u of c.urls) L.push(`URL${typeParams(u)}:${u.value}`);
  if (c.bday) L.push(`BDAY:${basicDate(c.bday)}`);
  if (c.note) L.push(`NOTE:${escapeText(c.note)}`);
  if (c.categories.length) L.push(`CATEGORIES:${c.categories.map(escapeText).join(",")}`);
  if (c.photo) L.push(`PHOTO:${c.photo}`);
  for (const x of c.extra) L.push(x);
  const rev = now ?? c.rev;
  if (rev) L.push(`REV:${rev}`);
  L.push("END:VCARD");
  return L.map(foldLine).join("\r\n") + "\r\n";
}

export const serializeVcf = (list: Contact[], now?: string) => list.map((c) => serializeContact(c, now)).join("");

/* ───────────────────────── search, sort, duplicates, merge ───────────────────────── */

export const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
export const phoneDigits = (s: string) => s.replace(/\D/g, "");
/** Phones compare on their last 10 digits when both have ≥ 10, so +1 555 010 0199 = (555) 010-0199. */
const phoneKey = (s: string) => { const d = phoneDigits(s); return d.length >= 10 ? d.slice(-10) : d; };

export function matches(c: Contact, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  const hay = fold([c.fn, c.n.given, c.n.family, c.n.additional, ...c.nickname, ...c.org, c.title, ...c.emails.map((e) => e.value), ...c.categories, c.note,
    ...c.adrs.map((a) => [a.street, a.locality, a.region, a.code, a.country].join(" "))].join(" \u0001 "));
  const digits = c.tels.map((t) => phoneDigits(t.value)).join(" ");
  return q.split(" ").every((tok) => hay.includes(tok) || (/^\+?[\d().\s-]{3,}$/.test(tok) && phoneDigits(tok).length >= 3 && digits.includes(phoneDigits(tok))));
}

export const sortKey = (c: Contact) => fold(c.n.family ? `${c.n.family} ${c.n.given}` : c.fn);
export const sortContacts = (list: Contact[]) => [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.uid.localeCompare(b.uid));
export const letterOf = (c: Contact) => { const ch = sortKey(c).charAt(0).toUpperCase(); return /[A-Z]/.test(ch) ? ch : "#"; };

export interface DupGroup { uids: string[]; reasons: string[] }

/** Union-find over shared normalised e-mail, phone (last 10 digits, ≥ 7 digits) or identical folded display name. */
export function findDuplicates(list: Contact[]): DupGroup[] {
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reasons = new Map<number, Set<string>>();
  const seen = new Map<string, number>();
  const link = (key: string, i: number, why: string) => {
    const j = seen.get(key);
    if (j === undefined) { seen.set(key, i); return; }
    const a = find(i), b = find(j);
    if (a !== b) parent[a] = b;
    const r = find(i); const set = reasons.get(r) ?? new Set<string>(); set.add(why); reasons.set(r, set);
  };
  list.forEach((c, i) => {
    for (const e of c.emails) link(`e:${e.value.trim().toLowerCase()}`, i, `same e-mail ${e.value.trim().toLowerCase()}`);
    for (const t of c.tels) { const k = phoneKey(t.value); if (k.length >= 7) link(`t:${k}`, i, `same phone ${t.value}`); }
    const nm = fold(c.fn); if (nm && nm !== "unnamed") link(`n:${nm}`, i, `same name ${c.fn}`);
  });
  const groups = new Map<number, number[]>();
  list.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const out: DupGroup[] = [];
  for (const [root, idx] of groups) {
    if (idx.length < 2) continue;
    const why = new Set<string>();
    for (const [r, s] of reasons) if (find(r) === root) s.forEach((x) => why.add(x));
    out.push({ uids: idx.map((i) => list[i].uid), reasons: [...why].sort() });
  }
  return out;
}

function unionBy<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const seen = new Set(a.map(key)); const out = [...a];
  for (const x of b) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

/** Merge b into a: a's non-empty scalars win, lists are unioned by normalised value, notes are kept from both. */
export function mergeContacts(a: Contact, b: Contact, now?: string): Contact {
  const pick = (x: string, y: string) => x || y;
  return {
    uid: a.uid,
    fn: pick(a.fn, b.fn),
    n: { family: pick(a.n.family, b.n.family), given: pick(a.n.given, b.n.given), additional: pick(a.n.additional, b.n.additional), prefix: pick(a.n.prefix, b.n.prefix), suffix: pick(a.n.suffix, b.n.suffix) },
    nickname: unionBy(a.nickname, b.nickname, fold),
    org: a.org.length ? a.org : b.org,
    title: pick(a.title, b.title),
    emails: unionBy(a.emails, b.emails, (e) => e.value.trim().toLowerCase()),
    tels: unionBy(a.tels, b.tels, (t) => phoneKey(t.value)),
    adrs: unionBy(a.adrs, b.adrs, (x) => fold([x.street, x.locality, x.code, x.country].join("|"))),
    urls: unionBy(a.urls, b.urls, (u) => u.value.trim().toLowerCase()),
    bday: pick(a.bday, b.bday),
    note: a.note && b.note && fold(a.note) !== fold(b.note) ? `${a.note}\n${b.note}` : pick(a.note, b.note),
    categories: unionBy(a.categories, b.categories, fold),
    photo: pick(a.photo, b.photo),
    rev: now ?? a.rev,
    extra: unionBy(a.extra, b.extra, (x) => x),
  };
}

/* ───────────────────────── birthdays, CSV, picker ───────────────────────── */

/** BDAY → {year?, month, day}: 19850412, 1985-04-12, --0412, --04-12, 1985-04-12T…; null for text values. */
export function parseBday(s: string): { year?: number; month: number; day: number } | null {
  const t = s.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(t);
  if (m) return valid({ year: +m[1], month: +m[2], day: +m[3] });
  m = /^--(\d{2})-?(\d{2})$/.exec(t);
  if (m) return valid({ month: +m[1], day: +m[2] });
  return null;
}
const valid = (d: { year?: number; month: number; day: number }) => {
  if (d.month < 1 || d.month > 12 || d.day < 1) return null;
  const dim = new Date(Date.UTC(d.year ?? 2000, d.month, 0)).getUTCDate(); // 2000 is a leap year, so --0229 is valid without a year
  return d.day <= dim ? d : null;
};

/** Upcoming birthdays within `days` of `today` (YYYY-MM-DD), Feb 29 observed on Feb 28 in non-leap years. */
export function upcomingBirthdays(list: Contact[], today: string, days: number): { uid: string; fn: string; date: string; inDays: number; turns?: number }[] {
  const [ty, tm, td] = today.split("-").map(Number);
  const t0 = Date.UTC(ty, tm - 1, td);
  const out: { uid: string; fn: string; date: string; inDays: number; turns?: number }[] = [];
  for (const c of list) {
    const b = parseBday(c.bday); if (!b) continue;
    for (const y of [ty, ty + 1]) {
      const leap = new Date(Date.UTC(y, 1, 29)).getUTCMonth() === 1;
      const day = b.month === 2 && b.day === 29 && !leap ? 28 : b.day;
      const t = Date.UTC(y, b.month - 1, day);
      const inDays = Math.round((t - t0) / 86_400_000);
      if (inDays >= 0) {
        if (inDays <= days) out.push({ uid: c.uid, fn: c.fn, date: new Date(t).toISOString().slice(0, 10), inDays, turns: b.year ? y - b.year : undefined });
        break;
      }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.fn.localeCompare(b.fn));
}

/** RFC 4180 field with the CSV-injection guard; values made only of digits, spaces and ()+-. are phone-like and exempt. */
export function csvField(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s) && !/^[+\-]?[\d\s().-]+$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const CSV_HEADER = ["Name", "Given Name", "Family Name", "Nickname", "Organization", "Title", "E-mail 1", "E-mail 2", "Phone 1", "Phone 2", "Address", "Birthday", "Categories", "Notes"];
export function toCsv(list: Contact[]): string {
  const rows = [CSV_HEADER, ...list.map((c) => {
    const a = c.adrs[0];
    return [c.fn, c.n.given, c.n.family, c.nickname.join(", "), c.org.join(" / "), c.title, c.emails[0]?.value ?? "", c.emails[1]?.value ?? "", c.tels[0]?.value ?? "", c.tels[1]?.value ?? "",
      a ? [a.street, a.locality, a.region, a.code, a.country].filter(Boolean).join(", ") : "", c.bday, c.categories.join(", "), c.note];
  })];
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Contact Picker API result (navigator.contacts.select) → Contact. Fields the user did not grant are absent. */
export function fromPicker(p: { name?: string[]; email?: string[]; tel?: string[]; address?: { addressLine?: string[]; city?: string; region?: string; postalCode?: string; country?: string }[] }, uid: string): Contact {
  const c = emptyContact(uid);
  c.fn = (p.name?.[0] ?? "").trim();
  c.emails = (p.email ?? []).filter(Boolean).map((value) => ({ value, types: [] }));
  c.tels = (p.tel ?? []).filter(Boolean).map((value) => ({ value, types: [] }));
  c.adrs = (p.address ?? []).map((a) => ({ types: [], pobox: "", ext: "", street: (a.addressLine ?? []).join(", "), locality: a.city ?? "", region: a.region ?? "", code: a.postalCode ?? "", country: a.country ?? "" }));
  if (!c.fn) c.fn = c.emails[0]?.value || c.tels[0]?.value || "Unnamed";
  return c;
}

/** Light validation used by the editor; returns human messages, never throws. */
export function validate(c: Contact): string[] {
  const out: string[] = [];
  if (!c.fn.trim()) out.push("A display name is required.");
  for (const e of c.emails) if (e.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.value)) out.push(`"${e.value}" does not look like an e-mail address.`);
  for (const t of c.tels) if (t.value && phoneDigits(t.value).length < 3) out.push(`"${t.value}" has fewer than 3 digits.`);
  if (c.bday && !isVcardDate(c.bday)) out.push(`Birthday "${c.bday}" is not a date (use YYYY-MM-DD, --MM-DD or YYYY).`);
  return out;
}
