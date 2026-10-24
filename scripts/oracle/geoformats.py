"""Test oracle for scripts/tt34-unit.mts (never shipped).
  read:  parse OUR GPX with gpxpy (Apache-2.0) and OUR KML with Python's xml.etree → JSON
  write: build GPX with gpxpy from JSON → XML text for OUR parser
stdin: {"mode": "read", "gpx": "...", "kml": "..."} | {"mode": "write", "doc": {...}}"""
import json, sys
import xml.etree.ElementTree as ET
import gpxpy, gpxpy.gpx

req = json.load(sys.stdin)
if req["mode"] == "read":
    g = gpxpy.parse(req["gpx"])
    wpts = [[w.latitude, w.longitude, w.name or "", w.description or "", w.elevation] for w in g.waypoints]
    trks = [[t.name or "", [[p.latitude, p.longitude, p.elevation] for s in t.segments for p in s.points]] for t in g.tracks]
    rtes = [[r.name or "", [[p.latitude, p.longitude, p.elevation] for p in r.points]] for r in g.routes]
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    root = ET.fromstring(req["kml"].encode("utf-8"))
    pms = []
    for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        name = pm.findtext("k:name", default="", namespaces=ns)
        desc = pm.findtext("k:description", default="", namespaces=ns)
        pt = pm.find("k:Point/k:coordinates", ns)
        ls = pm.find("k:LineString/k:coordinates", ns)
        pg = pm.find("k:Polygon/k:outerBoundaryIs/k:LinearRing/k:coordinates", ns)
        el = pt if pt is not None else ls if ls is not None else pg
        kind = "point" if pt is not None else "line" if ls is not None else "polygon"
        coords = [[float(v) for v in t.split(",")] for t in (el.text or "").split()]
        pms.append([kind, name, desc, coords])
    json.dump({"wpts": wpts, "trks": trks, "rtes": rtes, "kml": pms}, sys.stdout)
else:
    d = req["doc"]
    g = gpxpy.gpx.GPX()
    for p in d["points"]:
        g.waypoints.append(gpxpy.gpx.GPXWaypoint(p["lat"], p["lng"], elevation=p.get("ele"), name=p["name"], description=p.get("note") or None))
    for path in d["paths"]:
        if path["kind"] == "route":
            r = gpxpy.gpx.GPXRoute(name=path["name"])
            for p in path["points"]:
                r.points.append(gpxpy.gpx.GPXRoutePoint(p["lat"], p["lng"], elevation=p.get("ele")))
            g.routes.append(r)
        else:
            t = gpxpy.gpx.GPXTrack(name=path["name"])
            s = gpxpy.gpx.GPXTrackSegment()
            for p in path["points"]:
                s.points.append(gpxpy.gpx.GPXTrackPoint(p["lat"], p["lng"], elevation=p.get("ele")))
            t.segments.append(s)
            g.tracks.append(t)
    sys.stdout.write(json.dumps({"gpx10": g.to_xml(version="1.0"), "gpx11": g.to_xml(version="1.1")}))
