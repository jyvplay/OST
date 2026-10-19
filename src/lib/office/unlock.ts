/**
 * TT47 — client-side flow for password-protected Office files.
 *  - unlockOffice: asks for the password in the app's own modal (masked, Escape cancels; never window.prompt) and
 *    decrypts ON THIS DEVICE; a wrong password keeps the dialog open with an inline alert. The password is never sent.
 *  - TT48: saves of an unlocked document are re-encrypted with the same password (MS-OFFCRYPTO Agile, SHA-512 /
 *    AES-256 / HMAC, encryptOffice). The password lives only in the window's memory (Protection), never on the server.
 *    askPassword sets, changes or removes it; removal is explicit and is the only way plaintext replaces the original.
 *  - confirmUnencryptedCopy (TT47): explicit, differently named unencrypted copy (kept for callers that need it).
 */
import { askForm, askText } from "@/lib/ask";
import { OfficePasswordError, decryptOffice, deriveAgileKey, encryptOffice, isEncryptedOffice, type AgileKey } from "./offcrypto";

/** Per-window protection state for a document. password=null + removed=false on an encrypted original = still locked. */
export interface Protection { path: string; password: string | null; key: AgileKey | null; wasEncrypted: boolean; removed: boolean }
export const lockedProtection = (path: string): Protection => ({ path, password: null, key: null, wasEncrypted: true, removed: false });
/** true when a save to dest must be refused: the encrypted original was never unlocked (or unlocking was cancelled). */
export const saveBlocked = (p: Protection | null, dest: string) => !!p && p.wasEncrypted && !p.password && !p.removed && dest === p.path;
/** Encrypt the package when the document has a password (the key derivation is cached per password per window). */
export function sealPackage(plain: Uint8Array, p: Protection | null): { bytes: Uint8Array; encrypted: boolean } {
  if (!p?.password) return { bytes: plain, encrypted: false };
  p.key ??= deriveAgileKey(p.password);
  return { bytes: encryptOffice(plain, p.password, { key: p.key }), encrypted: true };
}
/** Set / change / remove the password. Resolves the updated Protection, or null when cancelled. */
export async function askPassword(name: string, p: Protection | null, path: string): Promise<Protection | null> {
  const has = !!p?.password;
  const v = await askForm({
    title: has ? `Change or remove the password of "${name}"` : `Protect "${name}" with a password`,
    detail: (has ? "Leave both fields empty to REMOVE the password: the next save then writes the file without encryption. " : "")
      + "The file is encrypted on this device when it is saved (AES-256, the same format Word and Excel use). The password is never sent or stored — if you forget it, the file cannot be opened.",
    fields: [{ name: "pw", label: "New password", secret: true }, { name: "again", label: "Confirm password", secret: true }],
    okLabel: has ? "Apply" : "Set password",
    validate: (x) => x.pw !== x.again ? "The passwords do not match." : !has && !x.pw ? "Enter a password." : x.pw.length > 255 ? "Use at most 255 characters." : null,
  });
  if (v === null) return null;
  const base: Protection = p ?? { path, password: null, key: null, wasEncrypted: false, removed: false };
  return v.pw ? { ...base, password: v.pw, key: null, removed: false } : { ...base, password: null, key: null, removed: true };
}

export { isEncryptedOffice };
export const MAX_ENCRYPTED_BYTES = 64 << 20;

/** Resolves to the decrypted package bytes, or null when the user cancels. */
export async function unlockOffice(bytes: Uint8Array, name: string): Promise<{ bytes: Uint8Array; method: string; integrity: string; password: string } | null> {
  if (bytes.length > MAX_ENCRYPTED_BYTES) throw new Error(`${name} is larger than the ${MAX_ENCRYPTED_BYTES >> 20} MB limit for encrypted files`);
  let result: { bytes: Uint8Array; method: string; integrity: string; password: string } | null = null;
  const pw = await askText("Password", "", {
    secret: true, title: `"${name}" is password-protected`, okLabel: "Open",
    detail: "Enter the password to open it. It is checked and the file decrypted on this device only — the password is never sent or stored.",
    validate: (v) => {
      if (!v) return "Enter the password.";
      try { result = { ...decryptOffice(bytes, v), password: v }; return null; }
      catch (e) { return e instanceof OfficePasswordError ? "The password is not correct. Passwords are case-sensitive." : `This file cannot be opened: ${(e as Error).message}`; }
    },
  });
  return pw === null ? null : result;
}

/** Ask where to put an unencrypted copy; null = cancelled (nothing is written). */
export async function confirmUnencryptedCopy(originalPath: string, suggested: string, ext: string): Promise<string | null> {
  const base = suggested && suggested !== originalPath ? suggested : (originalPath || `/Documents/Untitled${ext}`).replace(new RegExp(`\\${ext}$`, "i"), "") + ` (unencrypted)${ext}`;
  const v = await askText("Save as", base, {
    title: "Save an unencrypted copy?", okLabel: "Save unencrypted copy",
    detail: `This file was opened from a password-protected original. This saves a copy WITHOUT a password. The protected original is left unchanged.`,
    validate: (p) => !p.trim() ? "Enter a file path." : p.trim() === originalPath ? "Choose a different name — the protected original is kept as it is." : !p.trim().toLowerCase().endsWith(ext) ? `The name must end in ${ext}.` : null,
  });
  return v === null ? null : v.trim();
}
