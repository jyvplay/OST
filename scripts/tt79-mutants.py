"""TT79 second-order adversary: plausible wrong implementations of the ZIP engine (decoders, crypto, container, writer,
editor, guards). Each mutant is applied to the source, the named tt79-archive tests run (HARNESS_ONLY prefixes), and
the mutant must be KILLED (a test fails). Run: /home/user/tools/venv/bin/python scripts/tt79-mutants.py
(restores every file afterwards). Oracles stay external (Python zipfile / pyzipper / Info-ZIP / OpenSSL vectors)."""
import os, re, subprocess, sys
R = "/home/user/OST/"
Z, I, B, L, C, T = ("src/lib/archive/" + f for f in ("zip.ts", "inflate.ts", "bunzip.ts", "unlzma.ts", "zipcrypt.ts", "tree.ts"))
M = [
  ("Deflate64 length code 285 treated as 258", I, "if (d64) { lbase[28] = 3; lext[28] = 16; }", "if (false) { lbase[28] = 3; lext[28] = 16; }", "C3"),
  ("Deflate64 distance codes 30/31 refused", I, "const ndist = d64 ? 32 : 30;", "const ndist = 30;", "C3"),
  ("stored block NLEN not checked", I, "if (len !== (~nlen & 0xffff)) throw", "if (false) throw", "N1"),
  ("inflate output limit ignored", I, "if (need > this.limit) throw", "if (false) throw", "N1"),
  ("bzip2 RLE1 run one too long", B, "for (let k = 0; k < v; k++) emit(last);", "for (let k = 0; k <= v; k++) emit(last);", "C1"),
  ("bzip2 selectors not MTF-decoded", B, "const v = mtfG[j]; mtfG.splice(j, 1); mtfG.unshift(v); sel[i] = v;", "sel[i] = j;", "C1"),
  ("bzip2 block CRC unchecked", B, "if ((~crc >>> 0) !== blockCrc) throw", "if (false) throw", "N1"),
  ("LZMA matched literals decoded as plain", L, "if (state >= 7) {", "if (false) {", "C1"),
  ("LZMA short-rep state transition wrong", L, "state = state < 7 ? 9 : 11;", "state = state < 7 ? 8 : 11;", "C1"),
  ("LZMA align bits not reversed", L, "dist = (dist + rtree(align, 0, 4)) >>> 0;", "dist = (dist + tree(align, 0, 4)) >>> 0;", "C1"),
  ("WinZip CTR counted big-endian (WebCrypto style)", C, "for (let i = 0; i < 16; i++) { ctr[i] = (ctr[i] + 1) & 0xff; if (ctr[i]) break; }", "for (let i = 15; i >= 0; i--) { ctr[i] = (ctr[i] + 1) & 0xff; if (ctr[i]) break; }", "E1,E2"),
  ("PBKDF2 with 1 iteration", C, "pbkdf2Sha1(password, salt, 1000,", "pbkdf2Sha1(password, salt, 1,", "E1"),
  ("AES MAC not verified", C, "if (diff) throw new Error(\"AES: authentication", "if (false) throw new Error(\"AES: authentication", "N1"),
  ("ZipCrypto check byte from CRC even with a data descriptor", Z, "e.flags & 8 ? (e.dosTime >>> 8) & 0xff : e.crc >>> 24, e.crc >>> 24", "e.crc >>> 24, e.crc >>> 24", "E3"),
  ("ZIP64 extra read csize before usize", Z, "if (usize === 0xffffffff) { usize = u64(d, q); q += 8; }\n        if (csize === 0xffffffff) { csize = u64(d, q); q += 8; }", "if (csize === 0xffffffff) { csize = u64(d, q); q += 8; }\n        if (usize === 0xffffffff) { usize = u64(d, q); q += 8; }", "C4,W2"),
  ("writer omits the ZIP64 EOCD on entry-count overflow", Z, "items.length >= 0xffff ||", "", "W2"),
  ("unmarked names decoded as UTF-8 regardless of host", Z, "return { s: decodeCp437(raw), enc: \"cp437\" };", "return { s: td.decode(raw), enc: \"cp437\" };", "C5"),
  ("Unicode Path used without its CRC check", Z, "if (u32(d, 1) === crc32(rawName))", "if (true)", "C5,N1"),
  ("overlap guard removed", Z, "if (spans[k][0] < spans[k - 1][1]) throw", "if (false) throw", "N1"),
  ("local / central name mismatch accepted", Z, "if (lnl !== nl || lname.some((v, k) => v !== rawName[k])) throw", "if (false) throw", "N1"),
  ("zip-slip lets '..' through", Z, "if (p === \"..\") return null;", "if (p === \"...\") return null;", "N1,T1"),
  ("symlinks not recognised", Z, "const symlink = mode !== null && (mode & 0o170000) === 0o120000;", "const symlink = false;", "C4,N1"),
  ("ratio guard removed", Z, "usize / Math.max(csize, 1) > limits.maxRatio) throw", "usize / Math.max(csize, 1) > Infinity) throw", "N1"),
  ("editor drops the data descriptor of copied entries", Z, "descriptor: !!(flags & 8),", "descriptor: false,", "X1"),
  ("writer never sets the UTF-8 flag", Z, "const name = te.encode(nm), utf8 = !isAscii(nm);", "const name = te.encode(nm), utf8 = false;", "W1"),
  ("writer DOS month 0-based", Z, "((d.getMonth() + 1) << 5)", "(d.getMonth() << 5)", "W1"),
  ("editor re-keeps a stale Unicode Path on rename", Z, "renamed ? [0x0001, 0x7075] : [0x0001]);\n    // the local", "[0x0001]);\n    // the local", "X1,T1"),
  ("tree turns unsafe names into folders", T, "if (!e.safePath) { if (!pre)", "if (false) { if (!pre)", "T1"),
]
killed = 0; survivors = []
for name, f, a, b, only in M:
    src = open(R + f).read()
    if a not in src: print(f"!! anchor missing: {name}"); sys.exit(2)
    open(R + f, "w").write(src.replace(a, b, 1))
    try:
        out = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt79-archive.mts"], cwd=R, env={**os.environ, "HARNESS_ONLY": only}, capture_output=True, text=True, timeout=600).stdout
    finally:
        open(R + f, "w").write(src)
    if not re.search(r"\d+ passed, \d+ failed", out):
        print(f"INVALID  {name} (suite crashed — fix the mutant)"); continue
    dead = "✗" in out or "FAILED" in out
    killed += dead
    if not dead: survivors.append(name)
    print(("KILLED  " if dead else "SURVIVED") + f" {name} [{only}]", flush=True)
print(f"{killed}/{len(M)} mutants killed" + (f"; survivors: {survivors}" if survivors else ""))
