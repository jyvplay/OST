/**
 * TT146 (PR-06) — mail handoff, done to the letter of RFC 6068.
 *
 * This shell has no IMAP client and no SMTP socket: a browser cannot open a
 * raw TCP connection, and a proxy that did it on the user's behalf would read
 * every message. So "Mail" is a handoff, and a handoff is only honest if the
 * URL it builds is *correct*, because the failure mode is silent: the mail
 * client opens with a mangled body, or the subject is cut at the first `&`, or
 * the URL exceeds what the client will accept and nothing happens at all.
 *
 * The rules that matter, all implemented below:
 *   • `mailto:` header values are percent-encoded UTF-8. A raw `&` in a subject
 *     starts a new header; a raw `+` is a plus, not a space (that is
 *     form-encoding, a different thing, and the confusion is everywhere).
 *   • Line breaks in the body are CRLF (`%0D%0A`). A bare `%0A` is accepted by
 *     most clients and rejected by some, and "some" is enough to lose a draft.
 *   • A CR or LF anywhere in an address or the subject is a header-injection
 *     attempt. It is refused, never escaped, because escaping it would send a
 *     header the user did not write.
 *   • Length is bounded before the click, not after. The URL limit that matters
 *     is the strictest client's (~2000 bytes), and a truncated body must say so
 *     in the body — a silently shortened message looks like a complete one.
 *   • `mailto` has no attachments. Not "limited attachments": none. The only
 *     portable path is the Web Share API with files, which is a different
 *     channel and is offered only when the platform says it can carry them.
 */

export const MAX_URL_BYTES = 2000;
export const MAX_BODY_CHARS = 1800;
export const MAX_RECIPIENTS = 20;
export const ADDRESS_MAX = 254;

export interface MailDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface DraftIssue { field: string; message: string }

const CTRL = /[\u0000-\u001f\u007f]/;
const HEADER_BREAK = /[\r\n]/;
/** One dot-atom label: letters, digits, and the printable atoms RFC 5322 allows unquoted. */
const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * A deliberately narrow address check.
 *
 * This is *not* full RFC 5322 and does not pretend to be: quoted local parts,
 * comments, and SMTPUTF8 addresses are refused rather than mis-encoded, because
 * a wrong encoding sends mail to the wrong place. The refusal names the reason.
 */
export function validateAddress(raw: string): string | null {
  if (typeof raw !== "string") return "address must be text";
  const a = raw.trim();
  if (!a) return "address is empty";
  if (a.length > ADDRESS_MAX) return `address is longer than ${ADDRESS_MAX} characters`;
  if (CTRL.test(a)) return "address contains a control character or a line break";
  if (/\s/.test(a)) return "address contains a space (quoted local parts are not supported)";
  if (!a.includes("@")) return "address has no @";
  if (!/^[\x20-\x7e]+$/.test(a)) return "only ASCII addresses are supported (SMTPUTF8 is not encoded here)";
  const at = a.lastIndexOf("@");
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  if (!local || local.length > 64) return "the part before @ must be 1–64 characters";
  if (!ATEXT.test(local)) return "the part before @ is not a dot-atom (quoted local parts are not supported)";
  if (!domain || domain.length > 253) return "the domain must be 1–253 characters";
  const labels = domain.split(".");
  if (labels.length < 2) return "the domain needs at least one dot";
  for (const label of labels) if (!LABEL.test(label)) return `"${label}" is not a valid domain label`;
  const tld = labels[labels.length - 1];
  if (!/^[A-Za-z]{2,63}$/.test(tld)) return "the last domain label is not a top-level domain";
  return null;
}

/** Trim, lower-case for comparison, drop duplicates, keep the first spelling. */
export function normaliseRecipients(list: readonly string[]): { kept: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const kept: string[] = [];
  const duplicates: string[] = [];
  for (const raw of list) {
    const a = raw.trim();
    if (!a) continue;
    const key = a.toLowerCase();
    if (seen.has(key)) { duplicates.push(a); continue; }
    seen.add(key);
    kept.push(a);
  }
  return { kept, duplicates };
}

export interface DraftCheck { errors: DraftIssue[]; warnings: string[]; draft: MailDraft }

/** Validate and normalise. Errors are refusals; warnings are things the user should know. */
export function checkDraft(input: Partial<MailDraft>): DraftCheck {
  const errors: DraftIssue[] = [];
  const warnings: string[] = [];
  const collect = (field: "to" | "cc" | "bcc") => {
    const raw = input[field] ?? [];
    if (!Array.isArray(raw)) { errors.push({ field, message: `${field} must be a list` }); return []; }
    for (const a of raw) {
      const problem = validateAddress(a);
      if (problem) errors.push({ field, message: `${field}: ${problem}` });
    }
    const { kept, duplicates } = normaliseRecipients(raw);
    if (duplicates.length) warnings.push(`${field}: ignored ${duplicates.length} duplicate address${duplicates.length === 1 ? "" : "es"}`);
    if (kept.length > MAX_RECIPIENTS) errors.push({ field, message: `${field} has ${kept.length} addresses; the limit is ${MAX_RECIPIENTS}` });
    return kept;
  };

  const to = collect("to");
  const cc = collect("cc");
  const bcc = collect("bcc");
  if (to.length + cc.length + bcc.length === 0) errors.push({ field: "to", message: "there is no recipient" });

  const subject = typeof input.subject === "string" ? input.subject : "";
  if (HEADER_BREAK.test(subject)) errors.push({ field: "subject", message: "the subject contains a line break, which would inject a header" });
  if (CTRL.test(subject)) errors.push({ field: "subject", message: "the subject contains a control character" });
  if (subject.length > 500) warnings.push("the subject is longer than 500 characters; some clients will cut it");

  const bodyRaw = typeof input.body === "string" ? input.body : "";
  if (bodyRaw.includes("\u0000")) errors.push({ field: "body", message: "the body contains a NUL character" });
  const body = bodyRaw.replace(/\r\n|\r/g, "\n");
  if (body.length > MAX_BODY_CHARS) warnings.push(`the body is ${body.length} characters; only ${MAX_BODY_CHARS} fit in a mailto link and the rest is marked as truncated`);

  return { errors, warnings, draft: { to, cc, bcc, subject, body } };
}

export const TRUNCATION_MARK = "\n\n[truncated by Fusion: the rest stays in this window — use Share or copy]";

/**
 * RFC 6068 percent-encoding.
 *
 * `encodeURIComponent` is almost right and wrong in two places that matter: it
 * leaves `!'()*` unescaped (harmless here, but inconsistent with what clients
 * expect) and, more importantly, it encodes a space as `%20`, which is correct
 * for mailto and wrong for the `application/x-www-form-urlencoded` habit many
 * implementations copy. This function is explicit about both.
 */
export function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/['!()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "%20");
}

export function decodeHeaderValue(value: string): string {
  // `+` is a literal plus in RFC 6068, not a space.
  return decodeURIComponent(value.replace(/\+/g, "%2B"));
}

export interface BuiltMailto {
  url: string;
  truncated: boolean;
  /** Characters removed from the end of the body. */
  droppedChars: number;
  /** Fields that were dropped because the URL would not fit. */
  dropped: string[];
  warnings: string[];
}

const addressList = (list: readonly string[]) => list.join(",");

function assemble(draft: MailDraft, body: string): string {
  const params: string[] = [];
  if (draft.cc.length) params.push(`cc=${addressList(draft.cc)}`);
  if (draft.bcc.length) params.push(`bcc=${addressList(draft.bcc)}`);
  if (draft.subject) params.push(`subject=${encodeHeaderValue(draft.subject)}`);
  if (body) params.push(`body=${encodeHeaderValue(body.replace(/\n/g, "\r\n"))}`);
  const head = `mailto:${addressList(draft.to)}`;
  return params.length ? `${head}?${params.join("&")}` : head;
}

/**
 * Build the URL, shortening in a fixed order until it fits:
 *   1. truncate the body (the only field whose loss is visible and recoverable),
 *   2. drop BCC, then CC (each reported),
 *   3. refuse — never silently produce an over-long URL.
 *
 * The order is deliberate: a message with no body is useless, but a message to
 * the wrong people is worse than a message that says "I dropped the copies".
 */
export function buildMailto(input: Partial<MailDraft>): BuiltMailto {
  const check = checkDraft(input);
  if (check.errors.length) throw new Error(check.errors.map((e) => e.message).join("; "));
  const warnings = [...check.warnings];
  const draft: MailDraft = { ...check.draft };
  const dropped: string[] = [];
  let truncated = false;
  let droppedChars = 0;

  let body = draft.body;
  if (body.length > MAX_BODY_CHARS) {
    droppedChars = body.length - MAX_BODY_CHARS;
    body = body.slice(0, MAX_BODY_CHARS) + TRUNCATION_MARK;
    truncated = true;
    warnings.push(`the body was cut from ${draft.body.length} to ${MAX_BODY_CHARS} characters, with a visible marker`);
  }

  // Shrink to fit. Each character is at least one byte and encoding is
  // monotone in length, so the largest prefix that fits can be found by
  // bisection instead of by guessing one character at a time.
  const fits = (candidate: string) => byteLength(assemble(draft, candidate)) <= MAX_URL_BYTES;
  if (!fits(body)) {
    truncated = true;
    if (!body.endsWith(TRUNCATION_MARK)) {
      let lo = 0, hi = body.length, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(body.slice(0, mid) + TRUNCATION_MARK)) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (best >= 0 && best < body.length) {
        droppedChars = body.length - best;
        body = body.slice(0, best) + TRUNCATION_MARK;
      }
    }
  }
  let url = assemble(draft, body);
  if (byteLength(url) > MAX_URL_BYTES && draft.bcc.length) {
    dropped.push("bcc"); draft.bcc = []; url = assemble(draft, body);
    warnings.push("BCC was dropped because the link would exceed 2000 bytes");
  }
  if (byteLength(url) > MAX_URL_BYTES && draft.cc.length) {
    dropped.push("cc"); draft.cc = []; url = assemble(draft, body);
    warnings.push("CC was dropped because the link would exceed 2000 bytes");
  }
  if (byteLength(url) > MAX_URL_BYTES && body) {
    droppedChars += body.length; body = ""; url = assemble(draft, body);
    warnings.push("the body was dropped entirely: the recipients and subject alone fill the link");
  }
  if (byteLength(url) > MAX_URL_BYTES) {
    throw new Error(`the recipient list alone is ${byteLength(url)} bytes, over the ${MAX_URL_BYTES}-byte mailto limit`);
  }
  return { url, truncated, droppedChars: Math.max(0, droppedChars), dropped, warnings };
}

function byteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Parse a mailto URL back into a draft. Unknown headers are ignored, per RFC 6068. */
export function parseMailto(url: string): MailDraft {
  if (typeof url !== "string" || !/^mailto:/i.test(url)) throw new Error("not a mailto: URL");
  const rest = url.slice("mailto:".length);
  const q = rest.indexOf("?");
  const toPart = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);
  const split = (s: string) => s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const draft: MailDraft = { to: split(decodeURIComponent(toPart)), cc: [], bcc: [], subject: "", body: "" };
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const raw = eq === -1 ? "" : pair.slice(eq + 1);
    if (key === "subject") draft.subject = decodeHeaderValue(raw);
    else if (key === "body") draft.body = decodeHeaderValue(raw).replace(/\r\n|\r/g, "\n");
    else if (key === "cc") draft.cc = split(decodeHeaderValue(raw));
    else if (key === "bcc") draft.bcc = split(decodeHeaderValue(raw));
  }
  return draft;
}

/* ------------------------------------------------------------------ channels */

export interface HandoffCaps {
  /** `navigator.share` exists. */
  shareApi: boolean;
  /** `navigator.canShare({ text })` said yes. */
  canShareText: boolean;
  /** `navigator.canShare({ files })` said yes. */
  canShareFiles: boolean;
  /** The browser can be told to register itself as the mailto handler (`registerProtocolHandler`). */
  canRegisterProtocol: boolean;
}

export interface HandoffPlan {
  primary: "mailto" | "share" | "copy";
  alternates: ("mailto" | "share" | "copy")[];
  /** Why the primary channel was chosen — shown, not logged. */
  reason: string;
  /** Things the chosen channel cannot carry. */
  cannot: string[];
}

/**
 * Decide which channel to use. Files force Share (mailto cannot attach);
 * without Share, mailto is still the best path even though it loses attachments,
 * and the loss is reported rather than dropped.
 */
export function planHandoff(caps: HandoffCaps, draft: Partial<MailDraft>, hasFile: boolean): HandoffPlan {
  const cannot: string[] = [];
  const textShareUsable = caps.shareApi && caps.canShareText;
  if (hasFile) {
    if (caps.shareApi && caps.canShareFiles) {
      return { primary: "share", alternates: ["copy"], reason: "a file was attached, and Share can carry files while mailto cannot", cannot: ["a Share sheet decides the app, so the recipient field is not set for you"] };
    }
    cannot.push("an attachment cannot be sent: mailto has no attachments and this browser cannot share files");
  }
  if (caps.canRegisterProtocol) {
    cannot.push("the browser may hand this to a web handler rather than your desktop mail app");
  }
  if (textShareUsable) {
    return {
      primary: "mailto", alternates: ["share", "copy"],
      reason: "mailto opens the real mail client with the recipient filled in; Share is offered as an alternative",
      cannot: [...cannot, "the mail client, not Fusion, sends the message — no copy is kept in Sent"],
    };
  }
  return {
    primary: "mailto", alternates: ["copy"],
    reason: caps.shareApi ? "Share cannot carry text in this browser" : "this browser has no Web Share; mailto and clipboard remain",
    cannot: [...cannot, "the mail client, not Fusion, sends the message — no copy is kept in Sent"],
  };
}

/** Shape passed to `navigator.share`. Kept here so the UI cannot invent fields. */
export function sharePayload(draft: Partial<MailDraft>): { title: string; text: string } {
  const subject = (draft.subject ?? "").trim();
  const body = (draft.body ?? "").trim();
  return { title: subject || "Fusion message", text: [subject, body].filter(Boolean).join("\n\n") };
}

/** Short, plain-language summary of a built link for the compose pane. */
export function describeBuilt(built: BuiltMailto): string {
  const parts = [`${byteLength(built.url)} / ${MAX_URL_BYTES} bytes`];
  if (built.truncated) parts.push(`${built.droppedChars} characters cut with a visible marker`);
  if (built.dropped.length) parts.push(`${built.dropped.join(" and ")} dropped`);
  return parts.join(" · ");
}
