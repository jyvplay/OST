import type { SpecRow } from "./row";

/**
 * TT45 register change: TD-03 gains the post-quantum hybrid key exchanges of draft-ietf-sshm-mlkem-hybrid-kex-10
 * (mlkem768x25519-sha256 — OpenSSH 10's default — mlkem768nistp256-sha256, mlkem1024nistp384-sha384) on an original
 * ML-KEM (FIPS 203) implementation (src/lib/server/ssh/mlkem.ts); Node 22's crypto has no ML-KEM.
 */
export function patchTT45(f: SpecRow): SpecRow {
  if (f.code !== "TD-03") return f;
  const nuance = f.nuance.replace(
    "KEX with strict-kex",
    "KEX, plus the post-quantum hybrids mlkem768x25519-sha256 (preferred, as in OpenSSH 10) / mlkem768nistp256-sha256 / mlkem1024nistp384-sha384 on an original "
      + "FIPS 203 ML-KEM (all 240 NIST ACVP ML-KEM-512/768/1024 vectors identical; interoperates with OpenSSL's ML-KEM both ways; a downgrade that strips the "
      + "hybrids from both KEXINITs fails the host signature), with strict-kex",
  ).replace("post-quantum KEX (mlkem768x25519 / sntrup761x25519)", "sntrup761x25519-sha512 (the NTRU Prime hybrid; ML-KEM hybrids are supported)")
    + " The status bar says 'Post-quantum' only when an ML-KEM hybrid was negotiated, otherwise 'Classical key exchange'. JavaScript gives no constant-time "
    + "guarantee; ML-KEM keys are ephemeral (one decapsulation per key), which removes the repeated-query setting timing attacks on decapsulation need.";
  return { ...f, nuance, test: `${f.test}; tt45-unit.mts; e2e-tt45.mts` };
}
