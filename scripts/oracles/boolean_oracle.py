"""Shapely (GEOS) oracle for TT19 vector boolean ops.

stdin JSON: {"cases": [{"op": "unite|minusFront|intersect|exclude", "operands": [prim...], "ours": [[ [[x,y],...] exterior, hole... ] ...]}]}
prim: {"kind":"rect","x","y","w","h","rot"?: deg about centre} | {"kind":"ellipse","cx","cy","rx","ry"}
      | {"kind":"ring_hole","outer":[x,y,w,h],"inner":[x,y,w,h]}  (outer minus inner)
The operands are rebuilt here from their primitive parameters (NOT from our flattened polygons), the op is computed
by GEOS, and compared with OUR result region: area, symmetric-difference area and IoU.
"""
import json, sys

from shapely import affinity
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union


def prim(p):
    k = p["kind"]
    if k == "rect":
        g = box(p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"])
        return affinity.rotate(g, p.get("rot", 0), origin="center") if p.get("rot") else g
    if k == "ellipse":
        return affinity.scale(Point(p["cx"], p["cy"]).buffer(1, quad_segs=512), p["rx"], p["ry"])
    if k == "ring_hole":
        ox, oy, ow, oh = p["outer"]; ix, iy, iw, ih = p["inner"]
        return box(ox, oy, ox + ow, oy + oh).difference(box(ix, iy, ix + iw, iy + ih))
    if k == "union":
        return unary_union([prim(c) for c in p["children"]])
    raise ValueError(k)


def run(case):
    gs = [prim(p) for p in case["operands"]]
    op = case["op"]
    if op == "unite":
        r = unary_union(gs)
    elif op == "intersect":
        r = gs[0]
        for g in gs[1:]:
            r = r.intersection(g)
    elif op == "exclude":
        r = gs[0]
        for g in gs[1:]:
            r = r.symmetric_difference(g)
    else:
        r = gs[0]
        for g in gs[1:]:
            r = r.difference(g)
    ours = MultiPolygon([Polygon(p[0], p[1:]) for p in case["ours"]]).buffer(0)
    inter = r.intersection(ours).area
    union = r.union(ours).area
    return {"area": r.area, "ours_area": ours.area, "symdiff": r.symmetric_difference(ours).area,
            "iou": inter / union if union else 1.0, "parts": len(getattr(r, "geoms", [r]))}


if __name__ == "__main__":
    data = json.load(sys.stdin)
    print(json.dumps([run(c) for c in data["cases"]]))
