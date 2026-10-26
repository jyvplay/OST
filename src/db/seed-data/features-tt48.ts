import type { SpecRow, Status } from "./row";
import { UPDATES_TT47 } from "./features-tt47";

/**
 * TT48 register changes — password-protected Office files are now RE-ENCRYPTED on save (Writer + Spreadsheet).
 * Evidence: scripts/tt48-office.mts (original MS-CFB writer + MS-OFFCRYPTO Agile encryption, verified by olefile 0.47
 * strict mode and msoffcrypto-tool 6.0.0 with HMAC integrity verification, 7/7 mutants killed) and scripts/e2e-tt48.mts
 * (real UI, Chromium 143). Statuses are unchanged; the nuance replaces the TT47 "re-encryption NOT implemented" caveat.
 */
type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };

const OLD_ENC_TAIL = "Saving never writes plaintext over the protected original: an explicit, differently named unencrypted copy is required and the server refuses plaintext over an encrypted file. Re-encrypting on save is NOT implemented.";
const NEW_ENC_TAIL = "TT48: saves of an unlocked file are re-encrypted on the device with the same password (Agile: SHA-512, 100,000-round key derivation, AES-256-CBC, HMAC-SHA512 integrity, fresh package key and salts per save) inside a from-scratch MS-CFB writer; msoffcrypto-tool decrypts every saved file with HMAC verification and olefile parses it in strict mode (22 corpus files 1.9 KB–3 MB, 40 random CFB trees, a 7.5 MB DIFAT file). The Password… control sets, changes or removes the password; plaintext replaces an encrypted original only after explicit removal (the server still refuses it otherwise). The password stays in the window's memory only. A Standard-encrypted original is re-saved as Agile; RC4/CryptoAPI/IRM files are not supported; for .xlsx the decrypted package passes through the local server for the lossless patch (never the password).";
const withEnc = (s?: string) => (s ?? "").replace(OLD_ENC_TAIL, NEW_ENC_TAIL).replace(/\(decrypt only\)/g, "(decrypt and re-encrypt)").replace(/, and encrypted files cannot be re-encrypted on save/g, "");
const plusEnc = (s?: string) => { const t = withEnc(s); return t.includes(NEW_ENC_TAIL) ? t : `${t} ${NEW_ENC_TAIL}`; };
const addTest = (t: string | undefined, extra: string) => (t ? `${t}; ${extra}` : extra);

export const UPDATES_TT48: Record<string, Patch> = {
  "FF-20": { ...UPDATES_TT47["FF-20"], nuance: plusEnc(UPDATES_TT47["FF-20"].nuance), test: addTest(UPDATES_TT47["FF-20"].test, "tt48-office.mts; e2e-tt48.mts") },
  "FF-21": { ...UPDATES_TT47["FF-21"], nuance: withEnc(UPDATES_TT47["FF-21"].nuance), test: addTest(UPDATES_TT47["FF-21"].test, "tt48-office.mts") },
  "FF-22": { ...UPDATES_TT47["FF-22"], nuance: plusEnc(UPDATES_TT47["FF-22"].nuance), test: addTest(UPDATES_TT47["FF-22"].test, "tt48-office.mts; e2e-tt48.mts") },
  "FF-11": { status: "built",
    route: UPDATES_TT47["FF-11"].route,
    nuance: "TT46-48: every save states what was kept and what was rewritten, and whether the file was encrypted with the document's password or had its password removed; a lossy fallback (.fworkbook or a NEW .xlsx) is announced in a warning before it is used. A protected document stays protected on save; writing it without a password requires removing the password explicitly in the Password… dialog.",
    test: "e2e-tt46.mts; e2e-tt47.mts; e2e-tt48.mts" },
  "PR-11": { ...UPDATES_TT47["PR-11"], nuance: withEnc(UPDATES_TT47["PR-11"].nuance), test: addTest(UPDATES_TT47["PR-11"].test, "tt48-office.mts; e2e-tt48.mts") },
};
