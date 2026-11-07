/**
 * TT139 (PR-06) — mail handoff that survives real mail clients.
 *
 * A `mailto:` link is the only transport a browser has for "send this by email"
 * without an account or a proxy (raw IMAP/SMTP is unavailable and would be a
 * privacy defect anyway). The failure modes are all encoding and length:
 *   - RFC 6068 requires percent-encoding of the *body*, including its newlines
 *     as %0D%0A, and leaves `@`, `:` and `/` safe;
 *   - clients silently cut a mailto at ~2000 characters (older Outlook) or
 *     ~8000 (modern), and the cut is inside the body — so the body must be
 *     truncated *by us*, visibly, with the full text offered as a copy;
 *   - an empty subject must not produce a stray `?`.
 *
 * All three are handled here, plus the Web Share payload for platforms where a
 * share sheet is the better handoff. Limits: attachments are impossible in
 * mailto (stated, not attempted), and `To:` is not validated beyond RFC 5322's
 * dot-atom shape — the mail client is the authority on deliverability.
 */

export interface MailDraft {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  /** limit of the *whole* URL; 2000 is the safe floor across clients */
  budget?: number;
}

export interface BuiltMailto {
  url: string;
  length: number;
  truncatedBody: boolean;
  droppedRecipients: string[];
  invalidRecipients: string[];
  bodyChars: number;
}

const SAFE = /[A-Za-z0-9\-_.~@:/]/;
/** RFC 6068 §2: encode everything except unreserved and the three reserved. */
export function encodeComponent(text: string): string {
  let out = "";
  for (const ch of text) {
    if (SAFE.test(ch)) { out += ch; continue; }
    const bytes = new TextEncoder().encode(ch === "\n" ? "\r\n" : ch);
    for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isEmailShape(addr: string): boolean {
  const a = addr.trim();
  return a.length <= 254 && DOT_ATOM.test(a);
}

export function buildMailto(draft: MailDraft): BuiltMailto {
  const budget = Math.max(256, Math.min(draft.budget ?? 2000, 60_000));
  const valid = (list?: string[]) => (list ?? []).map((s) => s.trim()).filter(Boolean);
  const all = { to: valid(draft.to), cc: valid(draft.cc), bcc: valid(draft.bcc) };
  const invalid: string[] = [];
  const clean = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  for (const key of ["to", "cc", "bcc"] as const) {
    for (const addr of all[key]) (isEmailShape(addr) ? clean[key] : invalid).push(addr);
  }

  const params: string[] = [];
  const subject = draft.subject ?? "";
  const body = draft.body ?? "";
  // Reserve room for the address list, which must not be truncated.
  // encodeURIComponent escapes "@", which RFC 6068 leaves as a safe character in
  // the address list; using it produced mailto:a%40b.co and mail clients showed a
  // literal "%40" in the To: field.
  const header = `mailto:${clean.to.map(encodeComponent).join(",")}`;
  const base = header.length + (subject ? `?subject=${encodeComponent(subject)}`.length : 0);
  const remaining = Math.max(0, budget - base - 8);

  const encodedBodyFull = encodeComponent(body);
  let encodedBody = encodedBodyFull;
  let truncatedBody = false;
  if (encodedBody.length > remaining) {
    truncatedBody = true;
    // Truncate on a character boundary: re-encode a prefix rather than slicing
    // percent-escapes, which would produce "%E2%82" and a mojibake tail.
    let chars = body.length;
    while (chars > 0 && encodeComponent(body.slice(0, chars)).length > remaining - 24) chars -= Math.max(1, Math.floor(chars / 12));
    const suffix = "\n[…truncated: open the item to copy the full text]";
    encodedBody = encodeComponent(body.slice(0, chars) + suffix);
  }
  if (subject) params.push(`subject=${encodeComponent(subject)}`);
  if (clean.cc.length) params.push(`cc=${clean.cc.map(encodeComponent).join(",")}`);
  if (clean.bcc.length) params.push(`bcc=${clean.bcc.map(encodeComponent).join(",")}`);
  if (encodedBody) params.push(`body=${encodedBody}`);
  const url = params.length ? `${header}?${params.join("&")}` : header;
  return { url, length: url.length, truncatedBody, droppedRecipients: [], invalidRecipients: invalid, bodyChars: body.length };
}

/** Web Share Level 2 payload, or null when the platform has no share sheet. */
export function sharePayload(draft: MailDraft): { title: string; text: string } | null {
  const body = (draft.body ?? "").trim();
  if (!body) return null;
  return { title: (draft.subject ?? "Shared from Fusion").slice(0, 80), text: body };
}

/**
 * What to do when neither mailto nor share is available. This is a *result*, not
 * a console warning: the UI shows the copy panel with these lines.
 */
export function handoffFallback(draft: MailDraft): { lines: string[]; copyable: boolean } {
  const subject = (draft.subject ?? "").trim();
  const body = (draft.body ?? "").trim();
  return {
    lines: [
      subject ? `Subject: ${subject}` : "Subject: (none)",
      "",
      body || "(empty)",
    ],
    copyable: Boolean(subject || body),
  };
}
