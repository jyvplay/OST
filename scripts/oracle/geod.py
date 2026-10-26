"""Test oracle for scripts/tt34-unit.mts: GeographicLib (C. Karney, MIT licence, PyPI 'geographiclib'), an
independent implementation of WGS84 geodesics accurate to ~15 nm. Reads JSON cases on stdin, prints results.
Never shipped; only the tests call it."""
import json, sys
from geographiclib.geodesic import Geodesic

g = Geodesic.WGS84
req = json.load(sys.stdin)
out = {"inverse": [], "direct": [], "polygon": []}
for lat1, lon1, lat2, lon2 in req.get("inverse", []):
    r = g.Inverse(lat1, lon1, lat2, lon2)
    out["inverse"].append([r["s12"], r["azi1"], r["azi2"]])
for lat, lon, az, s in req.get("direct", []):
    r = g.Direct(lat, lon, az, s)
    out["direct"].append([r["lat2"], r["lon2"], r["azi2"]])
for ring in req.get("polygon", []):
    p = g.Polygon()
    for lat, lon in ring:
        p.AddPoint(lat, lon)
    n, perim, area = p.Compute(False, True)  # signed=True would give orientation; we compare magnitudes
    out["polygon"].append([perim, abs(area)])
json.dump(out, sys.stdout)
