"""TT48 test-only oracle: strict olefile (BSD) parse of a compound file. stdin: path per line → JSON per line
{path, ok, error, streams: {"a/b": size}, sha: {"a/b": sha256}}. Raises on any olefile defect >= DEFECT_INCORRECT."""
import sys, json, hashlib, olefile
for line in sys.stdin:
    p = line.strip()
    if not p: continue
    try:
        o = olefile.OleFileIO(p, raise_defects=olefile.DEFECT_INCORRECT)
        st, sh = {}, {}
        for e in o.listdir(streams=True, storages=False):
            k = "/".join(e); d = o.openstream(e).read(); st[k] = len(d); sh[k] = hashlib.sha256(d).hexdigest()
        print(json.dumps({"path": p, "ok": True, "streams": st, "sha": sh}))
    except Exception as ex:
        print(json.dumps({"path": p, "ok": False, "error": f"{type(ex).__name__}: {ex}"}))
