/**
 * CT-01 — share send / receive, and CA-02's present-a-URL half.
 *
 * Two directions, one policy:
 *
 *   SEND     `navigator.share` opens the OS sheet. It can be cancelled, it can
 *            be absent, and it can throw for reasons the spec lists but no
 *            browser explains. All three must be distinguishable, because
 *            "the user changed their mind" and "this browser cannot share" are
 *            not the same event and must not produce the same toast.
 *
 *   RECEIVE  `share_target` in the manifest makes the PWA an endpoint for the
 *            OS sheet. The incoming form data is attacker-adjacent: it arrives
 *            from another app and can carry files, a title and arbitrary text.
 *            Every field has to be bounded and normalised before it touches the
 *            VFS, or a share from a hostile app becomes an unbounded write.
 *
 * This module is the decision layer. It does no I/O; the caller performs the
 * write once a ShareIntent has been accepted.
 */

/** What the caller wants to share. */
export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
  files?: readonly { name: string; size: number; type: string }[];
}

/** Why a share did not happen — three genuinely different outcomes. */
export type ShareOutcome =
  | { ok: true; shared: true; via: "files" | "url" | "text" }
  | { ok: false; reason: "unsupported"; detail: string }
  | { ok: false; reason: "cancelled"; detail: string }
  | { ok: false; reason: "refused"; detail: string };

/** Limits, chosen to match what a phone share sheet can realistically carry. */
export const SHARE_TEXT_MAX = 8000;
export const SHARE_URL_MAX = 2048;
export const SHARE_TITLE_MAX = 200;
export const SHARE_FILES_MAX = 10;
export const SHARE_BYTES_MAX = 64 * 1024 * 1024;

/** The capabilities the caller could detect. */
export interface ShareCaps {
  canShare?: boolean;
  /** `navigator.canShare({files})` with a representative file. */
  canShareFiles?: boolean;
  hasShare?: boolean;
}

/** Prune a payload to what this browser will actually accept. */
export interface SharePlan {
  /** What will be handed to navigator.share. */
  payload: SharePayload;
  /** What was removed, and why — shown to the user, never silent. */
  dropped: string[];
  /** False when nothing survives, so the caller must not call share at all. */
  worthTrying: boolean;
}

/**
 * Normalise and bound a payload BEFORE it reaches the OS.
 *
 * The failure this prevents: `navigator.share` throwing `TypeError: Invalid
 * share data` because a field was one character over a limit no browser tells
 * you about, leaving the user with a button that does nothing.
 */
import { safeSlice } from "@/lib/a11y/release-gate";

export function planShare(input: SharePayload, caps: ShareCaps): SharePlan {
  const dropped: string[] = [];
  const payload: SharePayload = {};

  if (input.title) {
    if (input.title.length > SHARE_TITLE_MAX) {
      payload.title = input.title.slice(0, SHARE_TITLE_MAX);
      dropped.push(`Title shortened to ${SHARE_TITLE_MAX} characters.`);
    } else {
      payload.title = input.title;
    }
  }

  if (input.text) {
    if (input.text.length > SHARE_TEXT_MAX) {
      payload.text = input.text.slice(0, SHARE_TEXT_MAX);
      dropped.push(`Text shortened to ${SHARE_TEXT_MAX} characters.`);
    } else {
      payload.text = input.text;
    }
  }

  if (input.url) {
    const safe = normaliseShareUrl(input.url);
    if (!safe) {
      dropped.push("The link was not a shareable http(s) address and was left out.");
    } else if (safe.length > SHARE_URL_MAX) {
      dropped.push("The link was too long to share.");
    } else {
      payload.url = safe;
    }
  }

  if (input.files?.length) {
    if (!caps.canShareFiles) {
      dropped.push(`${input.files.length} attachment(s) left out: this browser cannot share files.`);
    } else {
      const files = input.files.slice(0, SHARE_FILES_MAX);
      let bytes = 0;
      const kept: Array<{ name: string; size: number; type: string }> = [];
      for (const f of files) {
        if (!Number.isFinite(f.size) || f.size < 0) continue;
        if (bytes + f.size > SHARE_BYTES_MAX) {
          dropped.push(`Stopped at ${(SHARE_BYTES_MAX / 1048576).toFixed(0)} MB of attachments.`);
          break;
        }
        bytes += f.size;
        kept.push(f);
      }
      if (kept.length < input.files.length && !dropped.some((d) => /Stopped at/.test(d))) {
        dropped.push(`${input.files.length - kept.length} attachment(s) beyond the ${SHARE_FILES_MAX}-file limit were left out.`);
      }
      if (kept.length) payload.files = kept;
    }
  }

  const worthTrying = !!(payload.title || payload.text || payload.url || payload.files?.length);
  return { payload, dropped, worthTrying };
}

/**
 * Only http(s) links leave the app.
 *
 * A share sheet is a trust boundary: handing `javascript:` or a `file:` URL to
 * another app is how a "share this page" button becomes a way to open arbitrary
 * local paths on the receiving side.
 */
export function normaliseShareUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Credentials in a shared URL are a credential leak into whatever app
    // receives it, and some share targets log the URL verbatim.
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Classify what actually happened when the caller invoked navigator.share. */
export function interpretShareError(err: unknown): ShareOutcome {
  const name = (err as { name?: string } | null)?.name ?? "";
  const message = (err as { message?: string } | null)?.message ?? String(err);
  // AbortError is the user closing the sheet. It is not a failure and must not
  // be shown in a red toast.
  if (name === "AbortError") {
    return { ok: false, reason: "cancelled", detail: "The share sheet was closed without sharing." };
  }
  if (name === "NotAllowedError") {
    return { ok: false, reason: "refused", detail: "The browser refused the share — it needs a user gesture, and the page must be visible." };
  }
  if (name === "TypeError") {
    return { ok: false, reason: "refused", detail: `The browser rejected the share data: ${message}` };
  }
  return { ok: false, reason: "refused", detail: message || "The share failed." };
}

/** What to tell the user before they press the button. */
export function describeSharing(caps: ShareCaps): string {
  if (!caps.hasShare) return "This browser has no share sheet; the link can still be copied.";
  if (!caps.canShare) return "The share sheet exists but reports it cannot share this content.";
  if (!caps.canShareFiles) return "Text and links can be shared; files cannot in this browser.";
  return "Shares text, links and files through the system sheet.";
}

// ── Receive side ──────────────────────────────────────────────────────────

/** A share that arrived from another app. */
export interface ShareIntent {
  title: string;
  text: string;
  url: string;
  files: Array<{ name: string; size: number; type: string }>;
  /** Fields that were dropped or trimmed, and why. */
  notes: string[];
}

export interface RawShareForm {
  get(name: string): unknown;
}

/**
 * Normalise a share_target submission.
 *
 * `share_target` delivers a form POST whose field names are declared in the
 * manifest. Everything in it is untrusted: it comes from an arbitrary app on
 * the device. Path components are stripped from file names, control characters
 * are removed from text, and every string is bounded.
 */
export function receiveShare(form: RawShareForm): ShareIntent {
  const notes: string[] = [];
  // This runs during page load, driven by data another app chose. A throw here
  // is a white screen caused by a share, so every access goes through a guard
  // that treats a missing, non-function or throwing `get` as "no such field".
  const read = (name: string): unknown => {
    if (!form || typeof form !== "object" || typeof form.get !== "function") return undefined;
    try {
      return form.get(name);
    } catch {
      return undefined;
    }
  };
  const str = (name: string, max: number): string => {
    const raw = read(name);
    if (typeof raw !== "string") return "";
    // Strip C0 controls except tab/newline, which legitimate text carries.
    const clean = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (clean.length > max) {
      notes.push(`"${name}" was shortened to ${max} characters.`);
      return Array.from(clean).slice(0, max).join("");
    }
    return clean;
  };

  // A shared file's name is a path in some implementation; take the basename so
  // "../../etc/passwd" cannot become a traversal in our VFS.
  const baseName = (n: string): string => {
    const parts = n.split(/[\\/]/);
    const last = parts[parts.length - 1] ?? "";
    const safe = last.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "");
    return safe || "shared-file";
  };

  const files: ShareIntent["files"] = [];
  const rawFiles = read("files");
  const list = Array.isArray(rawFiles) ? rawFiles : rawFiles && typeof rawFiles === "object" && "length" in (rawFiles as object) ? Array.from(rawFiles as ArrayLike<{ name?: string; size?: number; type?: string }>) : [];
  for (const f of list.slice(0, SHARE_FILES_MAX)) {
    const size = Number(f?.size ?? 0);
    if (!Number.isFinite(size) || size < 0) continue;
    if (size > SHARE_BYTES_MAX) {
      notes.push(`"${baseName(String(f?.name ?? ""))}" was larger than ${(SHARE_BYTES_MAX / 1048576).toFixed(0)} MB and was not imported.`);
      continue;
    }
    files.push({ name: baseName(String(f?.name ?? "")), size, type: String(f?.type ?? "") });
  }
  if (list.length > SHARE_FILES_MAX) notes.push(`Only the first ${SHARE_FILES_MAX} files were imported.`);

  const url = normaliseShareUrl(str("url", SHARE_URL_MAX)) ?? "";
  const rawUrl = str("url", SHARE_URL_MAX);
  if (rawUrl && !url) notes.push("The shared link was not an http(s) address and was not kept.");

  return { title: str("title", SHARE_TITLE_MAX), text: str("text", SHARE_TEXT_MAX), url, files, notes };
}

/** Where a received share should land. */
export function shareDestination(intent: ShareIntent): { module: "files" | "notes" | "browser" | "none"; why: string } {
  if (intent.files.length) return { module: "files", why: `${intent.files.length} file(s) land in /Downloads/Shared.` };
  if (intent.url) return { module: "browser", why: "The link opens in the browser." };
  if (intent.text) return { module: "notes", why: "The text becomes a note." };
  return { module: "none", why: "Nothing usable arrived; nothing was written." };
}
