"""TT79 second-order adversary for the PDF signature work: plausible wrong implementations of PKCS#12 (KDF, MAC,
passwords, limits), the legacy ciphers, chain trust and the visible appearance. Each mutant is applied to the source,
the named tt79-pdf tests run (HARNESS_ONLY prefixes) and the mutant must be KILLED. Oracles stay external (OpenSSL,
pyHanko, PDFium, published vectors). Run: /home/user/tools/venv/bin/python scripts/tt79-pdf-mutants.py (restores files)."""
import os, re, subprocess, sys
R = "/home/user/OST/"
P, L, S = ("src/lib/pdf/" + f for f in ("pkcs12.ts", "legacyciphers.ts", "pdfsig.ts"))
M = [
  ("KDF diversifier ignored (always key id)", P, "const D = new Uint8Array(v).fill(id);", "const D = new Uint8Array(v).fill(1);", "P2"),
  ("KDF I_j + B + 1 without the +1", P, "let carry = 1; for (let k = v - 1;", "let carry = 0; for (let k = v - 1;", "P2"),
  ("password without the BMPString terminator", P, "out.push(0, 0); return Uint8Array.from(out); }", "return Uint8Array.from(out); }", "P2"),
  ("MAC mismatch tolerated", P, "if (!tryPw(bmpPassword(password)) && !(password === \"\" && tryPw(new Uint8Array(0)))) throw", "if (false) throw", "P3"),
  ("iteration cap removed", P, "if (v < 1 || v > MAX_ITER) throw", "if (v < 1) throw", "N"),
  ("bag count cap removed", P, "if (++bags > 256) throw", "if (++bags > 1e9) throw", "N"),
  ("size cap removed", P, "if (file.length > 1 << 20) throw", "if (file.length > 1 << 30) throw", "N"),
  ("RC2 effective-bits mask skipped", L, "L[128 - T8] = RC2_PI[L[128 - T8] & TM];", "L[128 - T8] = RC2_PI[L[128 - T8]];", "P1"),
  ("PKCS#7 padding bytes not checked", L, "for (let i = b.length - n; i < b.length; i++) if (b[i] !== n) throw", "for (let i = b.length - n; i < b.length; i++) if (false) throw", "P1"),
  ("issuer need not be a CA", S, "const caOk = (c: Cert) => { const k = keyUsage(c); return isCA(c) && (!k || k(5)); };", "const caOk = (_c: Cert) => true;", "P7"),
  ("validity period ignored", S, "const inTime = (c: Cert) => !!c.notBefore && !!c.notAfter && at >= c.notBefore && at <= c.notAfter;", "const inTime = (_c: Cert) => true;", "P7"),
  ("signer key usage ignored", S, "const ku = keyUsage(leaf); if (ku && !ku(0) && !ku(1)) return", "const ku = keyUsage(leaf); if (false && ku) return", "P7"),
  ("issuer accepted by name alone (signature not checked)", S, "return (await verifyWith(c, cur.sigAlg, null, cur.sig, cur.tbs)) === true;", "return true;", "P5,P7"),
  ("anchors ignored: anything with a chain is trusted", S, "if (anchors.length) { const t = await trustPath(", "if (anchors.length && false) { const t = await trustPath(", "P5"),
  ("visible box in the wrong corner", S, "const u0 = corner.endsWith(\"right\") ? dw - m - bw : m,", "const u0 = corner.endsWith(\"right\") ? m : dw - m - bw,", "P6,P8"),
  ("rotated pages: no /Matrix", S, "if (matrix) fd.set(\"Matrix\", matrix);", "", "P8"),
  ("widget without the Print flag / appearance", S, ".set(\"F\", 4).set(\"AP\", new PDict().set(\"N\", ed.add(form)));", ".set(\"F\", 4);", "P5,P6"),
]
killed = 0; ran = 0; survivors = []
SKIP = int(os.environ.get("SKIP", "0"))
NAMES = [x for x in os.environ.get("ONLY_NAMES", "").split("|") if x]
for name, f, a, b, only in M[SKIP:]:
    if NAMES and not any(x in name for x in NAMES): continue
    ran += 1
    src = open(R + f).read()
    if a not in src: print(f"!! anchor missing: {name}"); sys.exit(2)
    open(R + f, "w").write(src.replace(a, b, 1))
    hung = False
    try:
        out = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt79-pdf.mts"], cwd=R, env={**os.environ, "HARNESS_ONLY": only}, capture_output=True, text=True, timeout=240).stdout
    except subprocess.TimeoutExpired:
        out, hung = "", True  # a hang is the denial of service the guard exists to stop: the N tests' time bound is violated
    finally:
        open(R + f, "w").write(src)
    if hung:
        killed += 1; print(f"KILLED   {name} [{only}] (suite hung > 240 s — the guard's purpose)", flush=True); continue
    if not re.search(r"\d+ passed, \d+ failed", out):
        print(f"INVALID  {name} (suite crashed — fix the mutant)"); continue
    dead = "✗" in out or "FAILED" in out
    killed += dead
    if not dead: survivors.append(name)
    print(("KILLED  " if dead else "SURVIVED") + f" {name} [{only}]", flush=True)
print(f"{killed}/{ran} mutants killed" + (f" (first {SKIP} skipped)" if SKIP else "") + (f"; survivors: {survivors}" if survivors else ""))
