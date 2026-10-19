/**
 * TT47 — client-side flow for password-protected Office files.
 *  - unlockOffice: asks for the password in the app's own modal (masked, Escape cancels; never window.prompt) and
 *    decrypts ON THIS DEVICE; a wrong password keeps the dialog open with an inline alert. The password is never sent.
 *  - confirmUnencryptedCopy: Fusion cannot write encrypted files yet, so a save from a decrypted document must be an
 *    explicit, differently named unencrypted copy — the protected original is never silently replaced with plaintext.
 */
import { askText } from "@/lib/ask";
import { OfficePasswordError, decryptOffice, isEncryptedOffice } from "./offcrypto";

export { isEncryptedOffice };
export const MAX_ENCRYPTED_BYTES = 64 << 20;

/** Resolves to the decrypted package bytes, or null when the user cancels. */
export async function unlockOffice(bytes: Uint8Array, name: string): Promise<{ bytes: Uint8Array; method: string; integrity: string } | null> {
  if (bytes.length > MAX_ENCRYPTED_BYTES) throw new Error(`${name} is larger than the ${MAX_ENCRYPTED_BYTES >> 20} MB limit for encrypted files`);
  let result: { bytes: Uint8Array; method: string; integrity: string } | null = null;
  const pw = await askText("Password", "", {
    secret: true, title: `"${name}" is password-protected`, okLabel: "Open",
    detail: "Enter the password to open it. It is checked and the file decrypted on this device only — the password is never sent or stored.",
    validate: (v) => {
      if (!v) return "Enter the password.";
      try { result = decryptOffice(bytes, v); return null; }
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
    detail: `This file was opened from a password-protected original. Fusion cannot write encrypted ${ext} files yet, so saving creates a copy WITHOUT a password. The protected original is left unchanged.`,
    validate: (p) => !p.trim() ? "Enter a file path." : p.trim() === originalPath ? "Choose a different name — the protected original is kept as it is." : !p.trim().toLowerCase().endsWith(ext) ? `The name must end in ${ext}.` : null,
  });
  return v === null ? null : v.trim();
}
