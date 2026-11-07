/**
 * TT145 (RC-15) — sensitive-content exclusions for Recall, as a rule set that a
 * person can read, that cannot be defeated by a URL's shape.
 *
 * Recall records what a person chose to save. The exclusion rules answer the
 * narrower and harder question: *what must not be saved even if they ask*, and
 * *what must not appear in a receipt even when it is saved*. Those are two
 * different sets and conflating them is how a "private" feature ends up with a
 * password in its own audit log:
 *
 *   · **capture exclusions** — a host, a path pattern, a window title pattern.
 *     They decide whether the Save button is offered at all.
 *   · **redaction rules** — query parameter names, path segments, header-ish
 *     labels. They run over every string that would land in a receipt, including
 *     the ones a person typed.
 *
 * Two properties are enforced structurally rather than by care:
 *
 *   · **redaction is closed under concatenation.** A label built from two strings
 *     is redacted as a whole, not per part, so "token=" split across a label and a
 *     suffix cannot be reassembled. The engine exposes `redactAll` which is the
 *     only path the receipt writer is allowed to use.
 *   · **a rule that fails to parse is reported, never dropped.** A silent drop is
 *     the difference between "my bank is excluded" and "my bank was excluded until
 *     someone typed a trailing space".
 */

export const MAX_RULES = 500;
export const MAX_TITLE = 200;

export interface Rules {
  /** Hosts (bare, `*.suffix`, `**.suffix`) whose pages are never captured. */
  hosts: string[];
  /** Path substrings/globs, matched against path+query. */
  paths: string[];
  /** Case-insensitive title substrings. */
  titles: string[];
  /** Query parameter names whose values are replaced. */
  queryParams: string[];
  /** Substrings replaced anywhere in a receipt string. */
  literals: string[];
}

export interface Parsed { rules: Rules; rejected: { line: number; why: string }[] }

export const EMPTY: Rules = { hosts: [], paths: [], titles: [], queryParams: ["token", "access_token", "id_token", "session", "sessionid", "password", "passcode", "key", "apikey", "api_key", "sig", "signature", "code", "otp", "auth", "jwt", "sso", "ticket"], literals: [] };

const HOST = /^(\*{0,2}\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Format, one rule per line:
 *   host bank.example.com
 *   path /account/*
 *   title "Online Banking"
 *   param sessionid
 *   literal 4111 1111 1111 1111
 */
export function parse(text: string, base: Rules = EMPTY): Parsed {
  const rules: Rules = { hosts: [...base.hosts], paths: [...base.paths], titles: [...base.titles], queryParams: [...base.queryParams], literals: [...base.literals] };
  const rejected: { line: number; why: string }[] = [];
  if (text.length > 100_000) return { rules, rejected: [{ line: 0, why: "rule text exceeds 100000 characters" }] };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const m = /^([a-z]+)\s+(.+)$/i.exec(line);
    if (!m) { rejected.push({ line: i + 1, why: "expected: <host|path|title|param|literal> <value>" }); return; }
    const kind = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, "$1").trim();
    if (!value) { rejected.push({ line: i + 1, why: `“${kind}” needs a value` }); return; }
    if (kind === "host") {
      const v = value.toLowerCase();
      if (!HOST.test(v)) { rejected.push({ line: i + 1, why: `“${value}” is not a host, *.suffix or **.suffix` }); return; }
      rules.hosts.push(v);
    } else if (kind === "path") {
      if (!/^[a-z0-9/._~%?=&*-]+$/i.test(value)) { rejected.push({ line: i + 1, why: `“${value}” contains characters a path never has` }); return; }
      rules.paths.push(value);
    } else if (kind === "title") {
      if (value.length > MAX_TITLE) { rejected.push({ line: i + 1, why: `title is ${value.length} characters; the limit is ${MAX_TITLE}` }); return; }
      rules.titles.push(value.toLowerCase());
    } else if (kind === "param") {
      if (!/^[a-z0-9_.-]{1,60}$/i.test(value)) { rejected.push({ line: i + 1, why: `“${value}” is not a query parameter name` }); return; }
      rules.queryParams.push(value.toLowerCase());
    } else if (kind === "literal") {
      if (value.length < 4) { rejected.push({ line: i + 1, why: "a literal shorter than 4 characters would redact ordinary words" }); return; }
      rules.literals.push(value);
    } else rejected.push({ line: i + 1, why: `unknown rule kind “${kind}”` });
  });
  if (rules.hosts.length + rules.paths.length + rules.titles.length + rules.queryParams.length + rules.literals.length > MAX_RULES) rejected.push({ line: 0, why: `more than ${MAX_RULES} rules; the extra ones were not applied` });
  return { rules, rejected };
}

function hostMatch(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("**.")) { const s = pattern.slice(3); return host === s || host.endsWith(`.${s}`); }
  if (pattern.startsWith("*.")) { const s = pattern.slice(2); return host.endsWith(`.${s}`) && host.slice(0, -s.length - 1).indexOf(".") === -1; }
  return false;
}

export interface CaptureDecision { allowed: boolean; why: string }

/**
 * May this page be captured? Host first (a bank is a bank on every path), then
 * path, then title. Each refusal names the rule that produced it, because "not
 * allowed" with no reason is what makes people turn exclusions off.
 */
export function mayCapture(rules: Rules, input: { url: string; title?: string }): CaptureDecision {
  let host = "", path = "";
  try { const u = new URL(input.url); host = u.hostname.toLowerCase().replace(/\.$/, ""); path = u.pathname + u.search; } catch { return { allowed: false, why: "the address is not a URL, so nothing can be attributed to it" }; }
  const h = rules.hosts.find((p) => hostMatch(p, host));
  if (h) return { allowed: false, why: `host rule “${h}” excludes ${host}` };
  const p = rules.paths.find((pat) => (pat.includes("*") ? new RegExp(`^${pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(path) : path.toLowerCase().includes(pat.toLowerCase())));
  if (p) return { allowed: false, why: `path rule “${p}” excludes ${path}` };
  const title = (input.title ?? "").toLowerCase();
  const t = title ? rules.titles.find((pat) => title.includes(pat)) : undefined;
  if (t) return { allowed: false, why: `title rule “${t}” excludes this page` };
  return { allowed: true, why: `no rule excludes ${host}; ${rules.hosts.length} host, ${rules.paths.length} path and ${rules.titles.length} title rules were checked` };
}

export const REDACTED = "*redacted*";

/** Replaces every query parameter whose name is excluded, preserving order and the rest of the URL. */
export function redactUrl(rules: Rules, url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return REDACTED; }
  const out = new URL(u.href);
  for (const name of [...out.searchParams.keys()]) if (rules.queryParams.includes(name.toLowerCase())) out.searchParams.set(name, REDACTED);
  // Fragments routinely carry tokens in SPA routes; the fragment is dropped entirely.
  out.hash = "";
  let s = out.href;
  for (const lit of rules.literals) s = s.split(lit).join(REDACTED);
  return s;
}

/**
 * Redaction of free text (a label a person typed, a page title). The literal list
 * applies, and so does a structural rule: anything shaped like a bearer token or
 * a long hex/base64 run is replaced, because a token pasted into a title is
 * exactly the leak a receipt would preserve.
 */
const TOKEN_SHAPES: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // github tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // common API key shape
  /\b[A-Za-z0-9_-]{40,}\b/g, // any long opaque run
];

export function redactText(rules: Rules, text: string): string {
  let s = text;
  for (const lit of rules.literals) if (lit) s = s.split(lit).join(REDACTED);
  for (const re of TOKEN_SHAPES) s = s.replace(re, REDACTED);
  return s;
}

/**
 * The only function a receipt writer may call. Redaction is closed under
 * concatenation: parts are joined FIRST and redacted as one string, so a token
 * split across a label and a suffix is still caught.
 */
export function redactAll(rules: Rules, parts: readonly string[]): string[] {
  const joined = parts.join("\u0000");
  const redacted = redactText(rules, joined);
  return redacted.split("\u0000");
}

export const LIMITS = [
  "there is no automatic detection of passwords, card numbers or health data; the rules are declared by a person",
  "a token that matches no shape and no literal is not redacted: this is a filter, not a classifier",
  "exclusions decide whether Save is offered; they do not encrypt what was already saved",
  "the rule list itself is stored with the profile and is readable on this device",
] as const;
