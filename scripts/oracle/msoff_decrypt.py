"""TT48 test-only oracle (msoffcrypto-tool, MIT): decrypt with HMAC integrity verification.
stdin lines: in_path<TAB>password<TAB>out_path → JSON per line {in, ok, error}."""
import sys, json, msoffcrypto
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line: continue
    src, pw, dst = line.split("\t")
    try:
        with open(src, "rb") as f:
            of = msoffcrypto.OfficeFile(f); of.load_key(password=pw)
            with open(dst, "wb") as o: of.decrypt(o, verify_integrity=True)
        print(json.dumps({"in": src, "ok": True}))
    except Exception as ex:
        print(json.dumps({"in": src, "ok": False, "error": f"{type(ex).__name__}: {ex}"}))
