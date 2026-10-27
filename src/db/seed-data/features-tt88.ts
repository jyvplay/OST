import type { SpecRow } from "./row";

/** TT88: general-backup recovery is a separate, explicitly selected export format. */
export function patchTT88(row: SpecRow): SpecRow {
  if (row.code !== "BK-06") return row;
  return {
    ...row, tier: "A", phase: "P2", status: "built",
    route: "Backup → Generate recovery key → confirm → Download with recovery key; restore with either local secret",
    nuance: "New recovery-key downloads use a random per-archive AES-GCM data key wrapped separately by a PBKDF2-SHA256 passphrase and a 256-bit user-held key. The complete header and ciphertext are authenticated. Keys are generated, displayed and used in this browser; there is no cloud escrow. Either secret can decrypt the backup; losing both loses access. Decrypted snapshot contents still go to the Fusion server during restore. Passphrase-only downloads and older archives do not gain a recovery slot retroactively. WebCrypto requires a secure context; no hardware-keystore backing, secure erasure, external audit or protection against malicious scripts is claimed.",
    test: "tt88-recovery.mts checks both directions against independent Python cryptography, malformed headers, KDF limits, tampering, slot swapping, canonical encoding and key generation; e2e-tt88-recovery.mts tests real Chromium downloads, confirmation, both unlock paths, failed local authentication, restore, accessibility and observed request/storage boundaries; tt88-mutants.py injects targeted defects",
  };
}
