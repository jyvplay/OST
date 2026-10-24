"""TT39 differential oracle for PAC evaluation (spawned by scripts/tt39-pac.mts).

An independent PAC implementation: PyPAC (Apache-2.0) running each script in the Duktape engine (dukpy, MIT).
Reads {"now": "<ISO UTC>", "cases": [{"pac": src, "url": u, "host": h}, ...]} on stdin, prints a JSON list of
results ("!error: ..." for failures). The clock is pinned by replacing PyPAC's _now() so date/time helpers are
compared at the same instant.
"""
import datetime as dt
import json
import sys

import pypac.parser_functions as pf
from pypac.parser import PACFile

req = json.load(sys.stdin)
fixed = dt.datetime.fromisoformat(req["now"].replace("Z", "+00:00"))


def _now(utc=False):
    return fixed if utc else fixed.replace(tzinfo=None)


pf._now = _now
out = []
cache = {}
for c in req["cases"]:
    try:
        p = cache.get(c["pac"])
        if p is None:
            p = cache[c["pac"]] = PACFile(c["pac"])
        out.append(str(p.find_proxy_for_url(c["url"], c["host"])))
    except Exception as e:  # noqa: BLE001 — report every failure as data
        out.append("!error: %s" % type(e).__name__)
print(json.dumps(out))
