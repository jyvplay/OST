#!/usr/bin/env python3
"""TT50 oracle: chart trendline fits computed with numpy (BSD) — polyfit / lstsq on the textbook models.
stdin: JSON list of {type, xs, ys, order?, period?, intercept?}; stdout: JSON list of {coef, r2} or {points} or {error}."""
import json, sys
import numpy as np

def r2(y, yhat, centred=True):
    y = np.asarray(y, float); yhat = np.asarray(yhat, float)
    sst = np.sum((y - y.mean()) ** 2) if centred else np.sum(y ** 2)
    return float(1 - np.sum((y - yhat) ** 2) / sst) if sst > 0 else 1.0

def fit(c):
    xs = np.asarray(c["xs"], float); ys = np.asarray(c["ys"], float); t = c["type"]
    if t == "movingAvg":
        p = c.get("period", 2)
        return {"points": [[float(xs[i]), float(np.mean(ys[i - p + 1:i + 1]))] for i in range(p - 1, len(ys))]}
    if t == "linear":
        if c.get("intercept") is not None:
            b0 = c["intercept"]; m = float(np.linalg.lstsq(xs[:, None], ys - b0, rcond=None)[0][0])
            return {"coef": [b0, m], "r2": r2(ys, m * xs + b0, centred=False)}
        m, b = np.polyfit(xs, ys, 1); return {"coef": [float(b), float(m)], "r2": r2(ys, m * xs + b)}
    if t == "exp":
        ly = np.log(ys); m, b = np.polyfit(xs, ly, 1); return {"coef": [float(np.exp(b)), float(m)], "r2": r2(ly, m * xs + b)}
    if t == "log":
        lx = np.log(xs); a, b = np.polyfit(lx, ys, 1); return {"coef": [float(b), float(a)], "r2": r2(ys, a * lx + b)}
    if t == "power":
        lx, ly = np.log(xs), np.log(ys); m, b = np.polyfit(lx, ly, 1); return {"coef": [float(np.exp(b)), float(m)], "r2": r2(ly, m * lx + b)}
    if t == "poly":
        k = c.get("order", 2); p = np.polyfit(xs, ys, k); return {"coef": [float(v) for v in p[::-1]], "r2": r2(ys, np.polyval(p, xs))}
    return {"error": "unknown"}

out = []
for c in json.load(sys.stdin):
    try: out.append(fit(c))
    except Exception as e: out.append({"error": str(e)})
print(json.dumps(out))
