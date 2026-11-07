/**
 * MD-05 — camera and QR / barcode scanning, without a decoder dependency.
 *
 * `BarcodeDetector` exists in Chromium and nowhere else. Shipping a JS QR
 * decoder as a fallback is a 30–60 KB dependency that would also need its own
 * test corpus, so this module does NOT decode pixels. What it does is the part
 * that is actually hard to get right and that every naive implementation gets
 * wrong: taking the raw string a detector returns and deciding what it MEANS,
 * safely.
 *
 * A QR code is attacker-supplied input that arrives by camera. The classic
 * mistake is to treat the result as a URL and navigate to it, which turns any
 * printed sticker into a link that can open `javascript:` or an `intent:` URL.
 * This module classifies the payload and never returns something the caller can
 * hand straight to `location.assign` without knowing what it is.
 */

/** What the scanned text turned out to be. */
export type ScanKind =
  | "url"
  | "wifi"
  | "vcard"
  | "email"
  | "phone"
  | "geo"
  | "otp"
  | "text";

export interface ScanResult {
  kind: ScanKind;
  /** The value to show the user. Always safe to display as text. */
  text: string;
  /** Present only when it is safe to navigate to. Never `javascript:` etc. */
  url?: string;
  /** Structured fields for the formats we parse. */
  fields?: Record<string, string>;
  /** Set when something was refused or stripped, and why. */
  warned?: string;
}

/** Schemes that are never navigable, whatever the QR code says. */
const DANGEROUS = /^(javascript|data|vbscript|file|blob|about|chrome|intent|market|itms-apps):/i;
/** Schemes a printed code may legitimately open. */
const NAVIGABLE = /^(https?|mailto|tel|sms|geo):/i;

const MAX_PAYLOAD = 4096;

/**
 * Classify a scanned string.
 *
 * Never throws: a detector can return garbage, and a scan that crashes the
 * camera pipeline is worse than a scan that says "unrecognised".
 */
export function classifyScan(raw: string): ScanResult {
  if (typeof raw !== "string") return { kind: "text", text: "", warned: "The detector returned a non-string." };
  // Strip the NUL and control padding some encoders emit, but keep interior
  // newlines: vCards and Wi-Fi payloads are line-structured.
  const trimmed = raw.replace(/\0/g, "").slice(0, MAX_PAYLOAD).trim();
  if (!trimmed) return { kind: "text", text: "", warned: "Empty payload." };
  if (raw.length > MAX_PAYLOAD) {
    return { kind: "text", text: trimmed, warned: `Payload longer than ${MAX_PAYLOAD} characters; truncated.` };
  }

  // Wi-Fi: WIFI:T:WPA;S:name;P:password;H:true;;
  if (/^WIFI:/i.test(trimmed)) {
    const fields = parseSemicolon(trimmed.slice(5));
    const ssid = fields.S ?? "";
    // The password is deliberately NOT echoed into the display text: this
    // result gets shown on screen and often screenshotted.
    return {
      kind: "wifi",
      text: ssid ? `Wi-Fi network "${ssid}"${fields.T ? ` (${fields.T})` : ""}` : "Wi-Fi network (no name)",
      fields: { ssid, type: fields.T ?? "", hidden: fields.H ?? "" },
    };
  }

  // vCard: BEGIN:VCARD ... FN:name
  if (/^BEGIN:VCARD/i.test(trimmed)) {
    const fn = /\r?\nFN:(.*)/i.exec(trimmed)?.[1]?.trim() ?? "";
    const tel = /\r?\nTEL[^:]*:(.*)/i.exec(trimmed)?.[1]?.trim() ?? "";
    return { kind: "vcard", text: fn ? `Contact card: ${fn}` : "Contact card (unnamed)", fields: { name: fn, tel } };
  }

  // OTP: otpauth://totp/Issuer:user?secret=...
  if (/^otpauth:\/\//i.test(trimmed)) {
    const secret = /[?&]secret=([A-Z2-7]+)/i.exec(trimmed)?.[1] ?? "";
    const issuer = /[?&]issuer=([^&]+)/i.exec(trimmed)?.[1] ?? "";
    return {
      kind: "otp",
      text: issuer ? `Authenticator setup for ${decodeURIComponent(issuer)}` : "Authenticator setup code",
      fields: { issuer: decodeURIComponent(issuer), hasSecret: secret ? "yes" : "no" },
      warned: secret ? "The secret is not displayed; it would be copied straight into an authenticator." : "",
    };
  }

  // Dangerous schemes are refused BEFORE the navigable check, because a
  // handset that installs a handler for `intent:` would otherwise open it.
  if (DANGEROUS.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(":"));
    return {
      kind: "text",
      text: trimmed,
      warned: `A "${scheme}:" link is not opened. Scanned codes can carry any scheme, so only http(s), mailto, tel, sms and geo are followed.`,
    };
  }

  if (NAVIGABLE.test(trimmed)) {
    const kind: ScanKind =
      /^mailto:/i.test(trimmed) ? "email" : /^tel:/i.test(trimmed) ? "phone" : /^geo:/i.test(trimmed) ? "geo" : "url";
    // A bare "http://" with no host is not a URL to navigate to.
    if (/^https?:\/\/$/i.test(trimmed) || /^https?:\/\/\//i.test(trimmed)) {
      return { kind: "text", text: trimmed, warned: "A web link with no host." };
    }
    return { kind, text: trimmed, url: trimmed };
  }

  // A hostname-looking string with no scheme. Common on printed material;
  // promoted to https rather than left inert, but ONLY if it really looks like one.
  if (/^[\w-]+(\.[\w-]+)+(\/[^\s]*)?$/.test(trimmed) && !/^[^.]+$/.test(trimmed)) {
    return { kind: "url", text: trimmed, url: `https://${trimmed}` };
  }

  return { kind: "text", text: trimmed };
}

/** Split the Wi-Fi style `K:V;K:V;;` payload, honouring backslash escapes. */
function parseSemicolon(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  let value = "";
  let inValue = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      value += body[++i];
      continue;
    }
    if (ch === ":" && !inValue) {
      inValue = true;
      continue;
    }
    if (ch === ";") {
      if (key) out[key.toUpperCase()] = value;
      key = "";
      value = "";
      inValue = false;
      continue;
    }
    if (inValue) value += ch;
    else key += ch;
  }
  if (key) out[key.toUpperCase()] = value;
  return out;
}

/**
 * Whether this browser can decode at all, and what to do if it cannot.
 *
 * The honest answer matters: a camera pointed at a QR code that silently does
 * nothing reads as a broken app, not as a missing platform feature.
 */
export function describeScanner(hasBarcodeDetector: boolean, hasCamera: boolean): string {
  if (!hasCamera) return "No camera available. A code can still be typed in by hand.";
  if (!hasBarcodeDetector) {
    return "This browser has no BarcodeDetector, so codes are not decoded automatically. Use manual entry, or type the address.";
  }
  return "Point the camera at a code. Only http(s), mailto, tel, sms and geo links are followed.";
}
