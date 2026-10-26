"""Independent SVG geometry oracle (svgelements, Python) for scripts/oracle-svg.mts.
stdin: {"paths": [d...], "transforms": [str...]}  stdout: {"paths": [{bbox, length, end}], "transforms": [[a,b,c,d,e,f]]}
svgelements computes arc bounds analytically and arc length numerically on the true ellipse (no cubic approximation)."""
import json, sys
from svgelements import Path, Matrix, Move

req = json.load(sys.stdin)
out = {"paths": [], "transforms": []}
for d in req["paths"]:
    try:
        p = Path(d)
        bb = p.bbox()
        segs = [s for s in p if not isinstance(s, Move)]
        out["paths"].append({
            "bbox": None if bb is None else list(bb),
            "length": float(p.length(error=1e-9, min_depth=8)),
            "end": None if not segs else [float(segs[-1].end.x), float(segs[-1].end.y)],
        })
    except Exception as e:  # noqa
        out["paths"].append({"error": str(e)})
for t in req["transforms"]:
    m = Matrix(t)
    out["transforms"].append([m.a, m.b, m.c, m.d, m.e, m.f])
print(json.dumps(out))
