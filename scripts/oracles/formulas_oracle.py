"""Independent formula oracle: the PyPI `formulas` package (an Excel formula
interpreter written in Python, no shared code with this repo). Reads a JSON list
of formula strings on stdin, prints [{formula, ok, value|error}] on stdout.
Run: python3 scripts/oracles/formulas_oracle.py < vectors.json"""
import json, sys, math
import formulas
import numpy as np

def norm(v):
    if isinstance(v, np.ndarray):
        if v.size == 1:
            return norm(v.item())
        return [[norm(x) for x in row] for row in v.tolist()] if v.ndim == 2 else [norm(x) for x in v.tolist()]
    if isinstance(v, formulas.functions.XlError) or type(v).__name__ in ("XlError",):
        return {"error": str(v)}
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, float, np.integer, np.floating)):
        f = float(v)
        return f if math.isfinite(f) else {"error": "#NUM!"}
    if isinstance(v, list):
        return [norm(x) for x in v]
    s = str(v)
    if s.startswith("#"):
        return {"error": s}
    return s

out = []
for f in json.load(sys.stdin):
    try:
        fn = formulas.Parser().ast(f)[1].compile()
        out.append({"formula": f, "ok": True, "value": norm(fn())})
    except Exception as e:  # unsupported function or parse error in the oracle
        out.append({"formula": f, "ok": False, "reason": type(e).__name__ + ": " + str(e)[:120]})
print(json.dumps(out))
