/**
 * TT70 FF-15: recovery drafts of PASSWORD-PROTECTED documents. TT69 wrote no draft at all for them (a draft would have
 * been plaintext beside an encrypted file). Now the draft is sealed with the document's own password in the same
 * container the file uses — MS-OFFCRYPTO Agile (SHA-512 key derivation, AES-256-CBC, HMAC-SHA512 integrity), via
 * encryptOffice — so a draft is exactly as protected as the document:
 *   - Writer: the sealed bytes are an encrypted .docx (Word / msoffcrypto-tool open it with the password);
 *   - Spreadsheet: the container holds a one-entry ZIP, fusion-draft.json (the Agile container only carries OOXML/ZIP
 *     packages — encryptOffice refuses anything else), so any MS-OFFCRYPTO tool can open it too.
 * The password never leaves the window (it is not part of the draft record). Opening a sealed draft tries the
 * password the window already holds; only if that fails (the password was changed since) does the caller ask.
 * Pure: no UI, no network.
 */
import { openZip, writeZip } from "./zipkit";
import { OfficePasswordError, decryptOffice, deriveAgileKey, encryptOffice, isEncryptedOffice, type AgileKey } from "./offcrypto";

export interface SealKey { password: string; key: AgileKey | null }

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function toB64(b: Uint8Array): string { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(s: string): Uint8Array { const t = atob(s); const o = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) o[i] = t.charCodeAt(i); return o; }

/** Seal draft bytes with the document password. `k.key` caches the expensive key derivation (filled on first use). */
export function sealDraft(plain: Uint8Array, k: SealKey): string {
  if (!k.password) throw new Error("a sealed draft needs the document password");
  k.key ??= deriveAgileKey(k.password);
  return toB64(encryptOffice(plain, k.password, { key: k.key }));
}

export type OpenResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: "password" | "corrupt"; message: string };

/** Open a sealed draft with a candidate password. Never throws: a wrong password and a damaged draft are told apart. */
export function openSealedDraft(payload: string, password: string): OpenResult {
  if (typeof payload !== "string" || !B64.test(payload)) return { ok: false, reason: "corrupt", message: "the draft is not base64" };
  let buf: Uint8Array;
  try { buf = fromB64(payload); } catch { return { ok: false, reason: "corrupt", message: "the draft is not base64" }; }
  if (!isEncryptedOffice(buf)) return { ok: false, reason: "corrupt", message: "the draft is not an encrypted container" };
  try { return { ok: true, bytes: decryptOffice(buf, password).bytes }; }
  catch (e) {
    if (e instanceof OfficePasswordError) return { ok: false, reason: "password", message: "the password does not open this draft" };
    return { ok: false, reason: "corrupt", message: (e as Error).message };
  }
}

/** Shape-compatible with unlock.ts Protection (kept structural so this module stays free of UI imports). */
export interface ProtLike { path: string; password: string | null; key: AgileKey | null; wasEncrypted: boolean; removed: boolean }

/**
 * Protection after restoring a draft: never weaker than before. The window's current password (the file as it is
 * now) wins; an unprotected file adopts the password the draft was sealed with; a plain draft changes nothing.
 */
export function restoredProtection<P extends ProtLike>(prev: P | null, draftPassword: string | null, path: string): P | ProtLike | null {
  if (prev?.password) return prev;
  if (draftPassword) return { ...(prev ?? { path, wasEncrypted: false }), password: draftPassword, key: null, removed: false };
  return prev;
}

export const DRAFT_ENTRY = "fusion-draft.json";
/** Wrap draft text in a one-entry (deflated) ZIP so it can travel in the Agile container. */
export const packDraftText = (text: string): Promise<Uint8Array> => writeZip([{ name: DRAFT_ENTRY, data: text }]);
/** Inverse of packDraftText; throws on anything that is not such a ZIP. */
export async function unpackDraftText(bytes: Uint8Array): Promise<string> {
  const t = await openZip(bytes).readText(DRAFT_ENTRY);
  if (t === null) throw new Error(`the draft has no ${DRAFT_ENTRY}`);
  return t;
}
