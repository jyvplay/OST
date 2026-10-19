# TT45: post-quantum hybrid SSH key exchange (ML-KEM, FIPS 203) for TD-03

TT44 shipped Fusion's from-scratch SSH-2 client. One of its disclosed gaps was **post-quantum key exchange**. Node 22's
`crypto` has no ML-KEM, so it was out of reach. That gap matters for a privacy product: OpenSSH 10 (April 2025) made
`mlkem768x25519-sha256` its default because of "store now, decrypt later". Someone who records today's SSH traffic
could decrypt it once a large quantum computer exists, and X25519 alone does not prevent that.

TT45 removes the blocker with original code:
- `src/lib/server/ssh/mlkem.ts` is ML-KEM-512/768/1024, written from the FIPS 203 algorithm text (Algorithms 3–18,
  §7 input checks). It uses only Node's SHA3/SHAKE.
- `src/lib/server/ssh/transport.ts` gains the three hybrid methods of draft-ietf-sshm-mlkem-hybrid-kex-10:
  `mlkem768x25519-sha256` (preferred, as in OpenSSH 10), `mlkem768nistp256-sha256` and `mlkem1024nistp384-sha384`.
- The SSH window shows **"Post-quantum"** only when a hybrid was actually negotiated. Otherwise it shows **"Classical
  key exchange"**, with a tooltip that explains the difference.

TT45 also finished the TT44 release (see DESIGN-TT44.md, Results). One adversarial test found a real bug, which is now
fixed: the client reported the server's DISCONNECT during the initial key exchange as "strict KEX violation" and lost
the server's reason. It is now handled first, as OpenSSH's `packet.c` does ("Always process disconnect messages").

## Runtime honesty

**What ran:**
- Node 22 and TypeScript in the Arena sandbox (Linux, 2 vCPUs).
- asyncssh 2.24.1 as the SSH server. Its ML-KEM hybrids call **OpenSSL's** ML-KEM through python `cryptography` 50.0.2
  (asyncssh's `crypto/pq.py` checks `backend.mlkem_supported()`), so the peer is an independent implementation.
- The same `cryptography` module as a primitive oracle (`scripts/oracle/mlkem_oracle.py`).
- NIST's ACVP vectors, fetched from `api.github.com` (usnistgov/ACVP-Server, `gen-val/json-files/ML-KEM-keyGen-FIPS203`
  and `ML-KEM-encapDecap-FIPS203`, `internalProjection.json`).
- Real Chromium (@sparticuz/chromium) against the production build, for the UI badge.

**What did not run:**
- No OpenSSH `sshd` (apt is blocked). The interop peer is asyncssh plus OpenSSL, not OpenSSH's own ML-KEM (libcrux).
- No timing-side-channel measurement (see §C).
- `cryptography` has no ML-KEM-512, so ML-KEM-512 is verified by ACVP only. SSH uses only 768 and 1024.

**Sources read for facts:** FIPS 203; draft-ietf-sshm-mlkem-hybrid-kex-10 (datatracker); OpenSSH `packet.c` (the
DISCONNECT ordering, fetched via the GitHub API). No ML-KEM code was read or copied.

## A. Formal model

**ML-KEM (per parameter set P ∈ {512, 768, 1024}, with k = 2, 3, 4):**

| Function | Contract |
|---|---|
| `keyGenInternal(P, d, z)` | 32-byte d and z → (ek, dk) with \|ek\| = 384k+32 and \|dk\| = 768k+96. Equal to FIPS 203 Algorithm 16, including the K-PKE seed G(d ‖ k). |
| `encapsInternal(P, ek, m)` | Refuses ek unless \|ek\| = 384k+32 **and** every 12-bit coefficient is < q (the §7.2 modulus check). Otherwise (K, c) = Algorithm 17. |
| `decaps(P, dk, c)` | Refuses c of the wrong length, and dk whose embedded H(ek) does not match (§7.3). Otherwise Algorithm 18. A c that does not re-encrypt to itself yields K̄ = J(z ‖ c) (**implicit rejection**: no error and no branch on the comparison). |
| Randomized wrappers | `keyGen` and `encaps` draw d, z and m from `crypto.randomBytes`. Every SSH key exchange makes a fresh key pair (the draft forbids reuse). |

**Hybrid KEX (client side).** For method M with KEM P, classical group C and hash HASH:
1. **Send** `SSH_MSG_KEX_HYBRID_INIT` (30) carrying `string C_INIT`, where C_INIT = ek_P ‖ pk_C. For pk_C: X25519 is
   32 bytes; P-256 and P-384 are uncompressed points (65 and 97 bytes).
2. **Receive** `SSH_MSG_KEX_HYBRID_REPLY` (31): `string K_S, string S_REPLY, string sig`.
3. **Length check.** Refuse with `kex` and DISCONNECT 3 unless |S_REPLY| = |ct_P| + |pk_C|. For NIST groups, a
   compressed point length is also accepted. This happens before any ML-KEM work.
4. **Shared secrets.** K_PQ = decaps(dk, ct). K_CL is the fixed-length classical secret: X25519 (all-zero and low-order
   refused) or ECDH (off-curve points refused).
5. **Key.** K = HASH(K_PQ ‖ K_CL). **K is encoded as `string`**, both in
   H = HASH(V_C, V_S, I_C, I_S, K_S, C_INIT, S_REPLY, K) and in the RFC 4253 §7.2 key derivation.
6. Everything after H is unchanged from TT44: host-key type, signature, known_hosts, NEWKEYS, strict KEX, rekeying.

**UI invariant.** The badge reads "Post-quantum" ⇔ `negotiated.kex` starts with `mlkem`.

## B. Hypotheses

- **H+ (expected to hold):**
  - All ACVP vectors match byte for byte.
  - OpenSSL and our code agree on (seed → ek), and on encapsulation/decapsulation in both directions.
  - asyncssh completes each hybrid, including repeated rekeys.
- **H− (expected to fail closed):**
  - A tampered ciphertext gives an unrelated K_PQ, so the host signature fails (`hostkey-signature`).
  - Wrong S_REPLY lengths, low-order X25519 points and off-curve points are refused as `kex`.
  - A downgrade adversary who strips the hybrids from both KEXINITs fails the signature, because I_C and I_S are hashed.
- **H∂ (holds only partly):** "constant time". JavaScript cannot promise it. The select and the comparison are
  branch-free, but `%` and the JIT are not controlled. Ephemeral keys are the actual mitigation (§C).

## C. Frontier

- **Timing.** In SSH every decapsulation key is used exactly once and then zeroed, so an attacker can never send it a
  second chosen ciphertext. The adaptive "many decapsulations against one key" setting of KyberSlash-type attacks
  therefore does not exist. A long-lived ML-KEM key in JavaScript would need a constant-time audit that was not done.
- **Not implemented:**
  - `sntrup761x25519-sha512`: NTRU Prime, the older OpenSSH hybrid. It is still offered by OpenSSH 9.x servers that
    lack mlkem768x25519. Those servers fall back to classical KEX, and the UI says so.
  - Group exchange, zlib, certificates and forwarding remain TT44 limits.
- **Interop breadth.** The peer is asyncssh plus OpenSSL. OpenSSH's libcrux-based ML-KEM was not tested live, but both
  follow FIPS 203 final, and ACVP pins the primitive.

## D. Negative shapes (≥ 15) and the modal-shortcut test

Each of these looks plausible but violates the contract. Each one is tested to fail (T), or excluded by design and
code review (R):
1. ek with a coefficient ≥ q accepted, i.e. a length-only check (T: D test, ACVP ek checks, mutant MK2).
2. Decapsulation returning an error, or K', on a bad ciphertext instead of J(z ‖ c) (T: ACVP modified-ciphertext
   cases, the OpenSSL cross-check, MK1).
3. K-PKE seeded with G(d) instead of G(d ‖ k), i.e. draft FIPS 203 (T: ACVP keyGen, MK5).
4. Matrix sampled with ρ ‖ i ‖ j, the transposed index order (T: MK6).
5. K encoded as an mpint, the classical habit (T: asyncssh end to end, MK3).
6. K = K_CL only, which silently drops the post-quantum half while the badge still says PQ (T: MK8).
7. A short or long S_REPLY parsed anyway (T: D test, MK4).
8. A ciphertext-only reply with the classical half missing (T).
9. A low-order (all-zero) X25519 half (T).
10. An off-curve P-256 half (T).
11. A one-bit ML-KEM ciphertext tamper accepted (T: hostkey-signature for all three methods).
12. A downgrade by stripping both KEXINITs succeeding silently (T).
13. A one-sided strip reported as our own "strict KEX violation" instead of the server's reason (T: found this turn
    and fixed; MK7).
14. A dk with a broken H(ek) used anyway (T).
15. A wrong-size d or z silently padded (T).
16. ML-KEM key pairs or encapsulation randomness reused across connections (R: `keyGen` is called inside
    `sendKexInit2`, and dk is zeroed after use).
17. "Post-quantum" shown for a classical session (T: e2e-tt45 against a curve25519-only server).
18. The receive limit for S_REPLY left at 1024 bytes, so 1568+97-byte replies are refused (T: mlkem1024nistp384 end to end).

**Modal-shortcut failure test.** The tempting shortcut is to trust the PQ claim because "negotiation picked mlkem".
Shape 6 shows why that fails: negotiation succeeds and the badge says PQ, yet without K_PQ in K there is no
post-quantum protection. Only the end-to-end tests against an independent peer catch it (MK8 was killed by the asyncssh
tests, not by any unit test).

## E. Mechanism-distinct approaches considered

1. **Original FIPS 203 implementation on Node's Keccak** (chosen). Zero dependencies, 222 lines, ≈ 1.4 ms per
   handshake.
2. **An npm ML-KEM package** (e.g. a pure-JS port). Rejected: this tier asks for original code, and it adds a dependency.
3. **WebCrypto ML-KEM.** Node 22's WebCrypto rejects `ML-KEM-768` (TypeError, checked). Browser support was not
   verified, and is irrelevant here because the SSH stack runs server-side.
4. **Spawning `openssl` (ML-KEM needs ≥ 3.5) or liboqs as a subprocess.** Rejected: an external binary would be needed
   on every user machine. The sandbox's system OpenSSL is 3.0.20, which has no ML-KEM (checked).
5. **sntrup761x25519 instead.** Rejected for now: ML-KEM is the standardised KEM (FIPS 203) and OpenSSH 10's default.
   NTRU Prime is the frontier.
6. **A pure-PQ method (mlkem768-sha256 alone).** Rejected: the draft and OpenSSH use hybrids, so security never falls
   below X25519 even if ML-KEM were broken.
7. **Montgomery/Barrett arithmetic in Int16, like reference C.** Not needed: doubles are exact up to 2⁵³ and every
   product here is < 2²⁵. Plain `%` is simpler to audit.

## F. Artifacts

- **Code:** `src/lib/server/ssh/mlkem.ts` (new). `src/lib/server/ssh/transport.ts` (hybrid KEX, string-encoded K,
  the DISCONNECT-first fix, a 4096-byte reply limit). `src/components/modules/Ssh.tsx` (the badge).
- **Tests:** `scripts/tt45-unit.mts` (10). `scripts/e2e-tt45.mts` (2, Chromium). `scripts/oracle/mlkem_oracle.py`
  (test-only). The tt44-unit KEX matrix now also covers the three hybrids, since it iterates `KEX_ALGS`.
- **Register:** `src/db/seed-data/features-tt45.ts` (TD-03 nuance and tests; seed 3.34.0).
- **Environment:** `scripts/sandbox/bootstrap.sh` now installs the TT44/45 SSH oracles (asyncssh, bcrypt, paramiko).
- **Screenshots:** `/tmp/tt45-pq.png`, `/tmp/tt45-classical.png`.

## G. Adversary findings (this turn)

- **Second-order adversary (a man in the middle on the cleartext key exchange):**
  - Ciphertext bit flip → `hostkey-signature`.
  - Classical half replaced by a low-order point → `kex`.
  - S_REPLY length ±1 → `kex`.
  - Hybrids stripped from both KEXINITs → `hostkey-signature`. The downgrade is caught because I_C and I_S are inside H.
  - Hybrids stripped from the server KEXINIT only → asyncssh hangs up with "Invalid PQ client public key". **Finding:**
    our client hid that reason behind a strict-KEX message. Fixed (§I).
- **TT44 release adversaries (the full suite, plus visual inspection) found three real TT44 defects, now fixed:**
  1. The status-bar badge read `neg.cipherC2S`, a field that does not exist (it is `c2s`), so it showed
     "kex · · auth". Found in the e2e-tt45 screenshot. e2e-tt45 now asserts the exact "kex · cipher · auth" text.
  2. The SSH module had no icon in `src/lib/icon-data.ts` (a11y-unit: "modules without an icon: ssh"). It now uses the
     terminal glyph on the lagoon tile, distinct from the slate local Terminal.
  3. `POST /api/ssh/[id]/sftp` looked up the session before validating the body, so an empty body got 404 instead of the
     repo-wide 400 (integration's "every JSON handler" test). The body is now validated first; CSRF and the session
     check still run before any operation.
- **Environment error (mine, disclosed):** after the sandbox reset I started Postgres with an ad-hoc script whose
  initdb defaulted to **SQL_ASCII**. `left(body, 180)` then cut "→" mid-character, and the search tests failed with
  "invalid byte sequence for encoding UTF8". The repo already had `scripts/sandbox/bootstrap.sh` + `pg-start.mjs`
  (`-E UTF8 --locale=C`). The ad-hoc script was deleted and the database recreated with the repo's starter. Lesson:
  after a reset, run the repo's bootstrap first.
- **Mutation adversary:** 8 mutants (MK1–MK8), **8/8 killed**. Each was killed by the test aimed at it (table in Results).

## H. External verification

| Oracle | What it checks | Result |
|---|---|---|
| NIST ACVP keyGen | 75 (d, z) → (ek, dk), all three parameter sets | 75/75 identical |
| NIST ACVP encapsulation | 75 (ek, m) → (c, K) | 75/75 |
| NIST ACVP decapsulation | 30, including 15 modified ciphertexts (implicit rejection) | 30/30 |
| NIST ACVP key checks | 30 ek modulus + 30 dk hash, both valid and invalid | 60/60 |
| OpenSSL ML-KEM (python `cryptography`) | seed → ek; their encaps → our decaps; our encaps → their decaps; same K̄ on a tampered c | 768 and 1024, 40 each way |
| asyncssh (OpenSSL ML-KEM inside) | all three hybrids end to end, 1 MiB echo, exact C_INIT/S_REPLY sizes, 12 rekeys in 3 MiB | pass |
| OpenSSH `packet.c` | DISCONNECT is processed before the strict-KEX gate | fixed to match |

## I. Repair, then a new attack on the repair

- **Repair.** `dispatch()` now handles `MSG.DISCONNECT` before the strict-KEX gate, and throws `disconnect` with the
  server's text.
- **New attack on the repair.** Could an attacker use a DISCONNECT to bypass strict KEX (Terrapin-style)? No:
  DISCONNECT terminates the session, and no state is kept or advanced. The TT44 Terrapin tests (IGNORE before and after
  KEXINIT) still go through the unchanged gate, and they rerun in tt44-unit.
- **Mutant MK7 (repair reverted).** Killed by the one-sided downgrade assertion.

## J. Stopping

TD-03 now has post-quantum hybrid KEX, verified against NIST vectors, an independent ML-KEM, an independent SSH server
and a hostile man in the middle. The UI never claims PQ for a classical session.

**Not reached:** sntrup761x25519-sha512; a live OpenSSH 10 peer (apt blocked); a constant-time audit; group exchange;
zlib; certificates; forwarding; Firefox and Safari.

## Results (this turn)

Filled in from the full run below.
