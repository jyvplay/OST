/**
 * Suite "tt34-unit" (TT34): Maps geodesy, Plus Codes and GPX/KML, and the Streams transport, without a browser.
 *   - WGS84 geodesics (src/lib/geodesy.ts) against GeographicLib (C. Karney; the independent `geographiclib` Python
 *     package, scripts/oracle/geod.py): 20 000 random inverse pairs, 2 000 near-antipodal pairs, 10 000 direct
 *     problems, 400 random polygons (area + perimeter); poles, equator, antimeridian, a ring around a pole
 *   - Plus Codes (src/lib/pluscode.ts) against the Open Location Code project's official test vectors
 *     (scripts/fixtures/olc/*.csv, Apache-2.0): encoding (incl. integer conversion), decoding, validity, short codes
 *   - GPX / KML (src/lib/geo-formats.ts) both ways against gpxpy and Python's xml.etree (scripts/oracle/geoformats.py);
 *     hostile XML (entity declarations, mismatched tags, two roots, bad coordinates) refused or skipped with a warning
 *   - transport protocol (embed-control-core.ts): exact command messages per provider, capability matrix, player
 *     reports of volume / mute / speed / playlist; keyboard map; library previous / shuffle (no repeats per round)
 * Gates were fixed before measuring: distances ≤ 1 mm, direct positions ≤ 1 mm, areas ≤ 1e-6 relative.
 * Not covered here: real provider players (unreachable from the sandbox) — see e2e-tt34 for the browser side.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt34-unit.mts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import * as G from "../src/lib/geodesy.ts";
import * as PC from "../src/lib/pluscode.ts";
import * as X from "../src/lib/geo-formats.ts";
import * as E from "../src/lib/embed-control-core.ts";
import * as S from "../src/lib/stream-core.ts";

const { test, finish } = makeHarness("tt34-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const py = (script: string, input: unknown) => JSON.parse(execFileSync(PY, [`scripts/oracle/${script}`], { input: JSON.stringify(input), maxBuffer: 1 << 28 }).toString());
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const rows = (f: string) => readFileSync(`scripts/fixtures/olc/${f}`, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(","));

/* ===================================================================== MP-06 geodesy */

await test("geodesy (MP-06): inverse on WGS84 vs GeographicLib — 20 000 random pairs and 2 000 near-antipodal pairs (Vincenty's failure region, solved by shooting), all ≤ 1 mm", { "MP-06": "full" }, () => {
  ok(existsSync(PY), `python oracle missing at ${PY}`);
  const inv: number[][] = [], near: number[][] = [];
  for (let i = 0; i < 20000; i++) inv.push([rnd() * 180 - 90, rnd() * 360 - 180, rnd() * 180 - 90, rnd() * 360 - 180]);
  for (let i = 0; i < 2000; i++) { const la = rnd() * 180 - 90, lo = rnd() * 360 - 180; near.push([la, lo, Math.max(-90, Math.min(90, -la + (rnd() - 0.5))), lo + 180 + (rnd() - 0.5)]); }
  const o = py("geod.py", { inverse: [...inv, ...near] });
  let m1 = 0, m2 = 0, shoot = 0, az = 0;
  inv.forEach((c, i) => { const r = G.inverse([c[0], c[1]], [c[2], c[3]]); m1 = Math.max(m1, Math.abs(r.s - o.inverse[i][0])); if (r.s > 1000 && Math.abs(c[0]) < 89 && Math.abs(c[2]) < 89) az = Math.max(az, Math.abs(((r.az1 - o.inverse[i][1] + 540) % 360) - 180)); });
  near.forEach((c, i) => { const r = G.inverse([c[0], c[1]], [c[2], c[3]]); m2 = Math.max(m2, Math.abs(r.s - o.inverse[inv.length + i][0])); if (r.method === "shooting") shoot++; });
  console.log(`    inverse max |Δs| ${(m1 * 1000).toFixed(4)} mm (random), ${(m2 * 1000).toFixed(4)} mm (near-antipodal, ${shoot}/2000 by shooting); max |Δaz1| ${az.toExponential(2)}°`);
  ok(m1 <= 1e-3, `random pairs max error ${m1} m > 1 mm`);
  ok(m2 <= 1e-3, `near-antipodal max error ${m2} m > 1 mm`);
  ok(shoot > 1000, `the shooting fallback should carry most near-antipodal pairs (got ${shoot})`);
  ok(az < 1e-6, `azimuth error ${az}° too large`);
});

await test("geodesy (MP-06): direct problem (10 000 cases, up to 19 000 km) lands ≤ 1 mm from GeographicLib; poles, equator, antimeridian, coincident points; the sphere was up to ~0.5 % off", { "MP-06": "full" }, () => {
  const dir: number[][] = [];
  for (let i = 0; i < 10000; i++) dir.push([rnd() * 180 - 90, rnd() * 360 - 180, rnd() * 360 - 180, rnd() * 19e6]);
  const special = [[90, 0, -90, 0], [0, 0, 0, 90], [0, 0, 0, 179.5], [0, 179.9, 0, -179.9], [45, 10, 45, 10], [-89.999, 0, 89.999, 180], [0, 0, 0.5, 179.7], [60, 0, 60, 180]];
  const o = py("geod.py", { direct: dir, inverse: special });
  let m = 0;
  dir.forEach((c, i) => { const r = G.direct([c[0], c[1]], c[2], c[3]); m = Math.max(m, G.distance([r.lat, r.lng], [o.direct[i][0], o.direct[i][1]])); });
  console.log(`    direct max position error ${(m * 1000).toFixed(4)} mm`);
  ok(m <= 1e-3, `direct max error ${m} m`);
  special.forEach((c, i) => { const r = G.inverse([c[0], c[1]], [c[2], c[3]]); ok(Math.abs(r.s - o.inverse[i][0]) <= 1e-3, `special ${c}: ${r.s} vs ${o.inverse[i][0]}`); });
  // the sphere's error that motivated this: London → New York
  const lhr: G.LatLng = [51.47, -0.4543], jfk: G.LatLng = [40.6413, -73.7781];
  const ell = G.distance(lhr, jfk), sph = 2 * 6371008.8 * Math.asin(Math.sqrt(Math.sin((jfk[0] - lhr[0]) * Math.PI / 360) ** 2 + Math.cos(lhr[0] * Math.PI / 180) * Math.cos(jfk[0] * Math.PI / 180) * Math.sin((jfk[1] - lhr[1]) * Math.PI / 360) ** 2));
  ok(Math.abs(ell - sph) > 5000, `ellipsoid vs sphere should differ by kilometres on LHR–JFK (got ${ell - sph} m)`);
  eq(G.pathLength([]), 0); eq(G.distance([10, 10], [10, 370]), 0, "same point across a 360° wrap");
});

await test("geodesy (MP-06): polygon area on the ellipsoid vs GeographicLib — 400 random polygons from 1 m² to continents ≤ 1e-6 relative; perimeter ≤ 1 mm; a polar cap and an antimeridian square; formatting", { "MP-06": "full" }, () => {
  const polys: number[][][] = [];
  for (let i = 0; i < 400; i++) {
    const n = 3 + Math.floor(rnd() * 6), la = rnd() * 160 - 80, lo = rnd() * 360 - 180, r = Math.pow(10, rnd() * 5.3 - 4);
    const ring: number[][] = [];
    for (let k = 0; k < n; k++) { const t = (k / n) * 2 * Math.PI + rnd() * 0.5; ring.push([Math.max(-89.9, Math.min(89.9, la + r * Math.sin(t))), lo + (r * Math.cos(t)) / Math.max(0.2, Math.cos((la * Math.PI) / 180))]); }
    polys.push(ring);
  }
  const cap = [[80, 0], [80, 90], [80, 180], [80, -90]], am = [[-1, 179], [-1, -179], [1, -179], [1, 179]];
  const o = py("geod.py", { polygon: [...polys, cap, am] });
  let rel = 0, per = 0;
  polys.forEach((ring, i) => { const r = G.polygonArea(ring as G.LatLng[]); rel = Math.max(rel, Math.abs(r.area - o.polygon[i][1]) / o.polygon[i][1]); per = Math.max(per, Math.abs(r.perimeter - o.polygon[i][0])); });
  console.log(`    area max relative error ${rel.toExponential(2)}, perimeter max ${(per * 1000).toFixed(4)} mm`);
  ok(rel <= 1e-6, `area relative error ${rel}`);
  ok(per <= 1e-3, `perimeter error ${per}`);
  const c = G.polygonArea(cap as G.LatLng[]), a = G.polygonArea(am as G.LatLng[]);
  ok(Math.abs(c.area - o.polygon[400][1]) / o.polygon[400][1] < 1e-6, `polar cap ${c.area} vs ${o.polygon[400][1]}`);
  ok(Math.abs(a.area - o.polygon[401][1]) / o.polygon[401][1] < 1e-6, `antimeridian square ${a.area} vs ${o.polygon[401][1]}`);
  eq(G.polygonArea([[0, 0], [0, 1]]).area, 0, "two points have no area");
  eq(G.formatArea(1234), "1,234 m²"); eq(G.formatArea(56000), "5.60 ha"); eq(G.formatArea(2.5e6), "2.50 km²"); eq(G.formatArea(4046.8564224 * 3, "imperial"), "3.00 acres");
  // the drawn line is continuous across the antimeridian (no ±360 jump)
  const line = G.geodesicLine([[0, 170], [0, -170]]);
  ok(line.every((p, i) => !i || Math.abs(p[1] - line[i - 1][1]) < 5), "geodesicLine jumps across the antimeridian");
  ok(Math.abs(line[line.length - 1][1] - 190) < 1e-9, `the line should end at 190 (unwrapped), got ${line[line.length - 1][1]}`);
});

/* ===================================================================== MP-07 Plus Codes */

await test("Plus Codes (MP-07): every official Open Location Code vector — encoding (302, incl. degrees → integers), decoding (420), validity (25), shorten / recover (19)", { "MP-07": "full" }, () => {
  let n = 0;
  for (const [lat, lng, li, gi, len, code] of rows("encoding.csv")) {
    eq(PC.locationToIntegers(+lat, +lng), [+li, +gi], `integers for ${lat},${lng}`);
    eq(PC.encode(+lat, +lng, +len), code, `encode ${lat},${lng},${len}`); n++;
  }
  for (const [code, len, a, b, c, d] of rows("decoding.csv")) {
    const r = PC.decode(code);
    ok(r.length === +len && [r.latLo - +a, r.lngLo - +b, r.latHi - +c, r.lngHi - +d].every((x) => Math.abs(x) < 1e-10), `decode ${code}: ${JSON.stringify(r)}`); n++;
  }
  for (const [code, v, s, f] of rows("validityTests.csv")) { eq([PC.isValid(code), PC.isShort(code), PC.isFull(code)], [v === "true", s === "true", f === "true"], `validity ${code}`); n++; }
  for (const [full, lat, lng, short, type] of rows("shortCodeTests.csv")) {
    if (type === "B" || type === "S") eq(PC.shorten(full, +lat, +lng), short, `shorten ${full} @ ${lat},${lng}`);
    if (type === "B" || type === "R") eq(PC.recoverNearest(short, +lat, +lng), full, `recover ${short} @ ${lat},${lng}`);
    n++;
  }
  ok(n === 302 + 420 + 25 + 19, `vector count ${n}`);
});

await test("Plus Codes (MP-07): refusals and search parsing — bad lengths, padded shortening, invalid codes; codes found in free text with a locality; recovery across the antimeridian", { "MP-07": "full" }, () => {
  const throws = (f: () => unknown, m: string) => { try { f(); } catch { return; } throw new Error(`should throw: ${m}`); };
  throws(() => PC.encode(10, 10, 1), "length 1"); throws(() => PC.encode(10, 10, 7), "odd length < 10"); throws(() => PC.encode(NaN, 0), "NaN");
  throws(() => PC.decode("9G8F+6W"), "decode a short code"); throws(() => PC.shorten("8FWC0000+", 47, 8), "shorten a padded code"); throws(() => PC.recoverNearest("nonsense", 0, 0), "recover junk");
  eq(PC.encode(47.365562, 8.524813), "8FVC9G8F+6W"); eq(PC.encode(47.365562, 8.524813, 8), "8FVC9G8F+");
  eq(PC.findCode("9G8F+6W Zürich"), { code: "9G8F+6W", rest: "Zürich" });
  eq(PC.findCode("  8fvc9g8f+6w "), { code: "8FVC9G8F+6W", rest: "" });
  eq(PC.findCode("Raleigh, NC"), null); eq(PC.findCode("a+b"), null); eq(PC.findCode("WC2300+G6g"), null);
  // the spec's worked example: what 8FVC9G8F+6W shortens to near four reference points
  eq(PC.shorten("8FVC9G8F+6W", 47.373313, 8.537562), "8F+6W"); eq(PC.shorten("8FVC9G8F+6W", 47.339563, 8.556687), "9G8F+6W");
  eq(PC.shorten("8FVC9G8F+6W", 47.985187, 8.440688), "VC9G8F+6W"); eq(PC.shorten("8FVC9G8F+6W", 38.800562, -9.064937), "8FVC9G8F+6W");
  // a short code near Fiji (179.9°E) recovered from a reference just across the antimeridian
  const full = PC.encode(-17.5, 179.95), short = full.slice(4);
  eq(PC.recoverNearest(short, -17.4, -179.9), full, "antimeridian recovery");
});

/* ===================================================================== MP-08 GPX / KML */

const NASTY = ["Café & Bar", "<script>alert(1)</script>", "Ünïcödé 東京 🚲", 'He said "hi" & \'bye\'', "a]]>b", "tab\tand\nnewline", "  spaced  ", "x"];
function sampleDoc(): X.GeoDoc {
  const d: X.GeoDoc = { points: [], paths: [], warnings: [] };
  for (let i = 0; i < 60; i++) d.points.push({ lat: rnd() * 180 - 90, lng: rnd() * 360 - 180, name: NASTY[i % NASTY.length] + i, note: i % 3 ? NASTY[(i + 3) % NASTY.length] : "", ...(i % 4 === 0 ? { ele: Math.round(rnd() * 400000) / 100 } : {}) });
  d.paths.push({ name: "Measured path & co", kind: "track", points: Array.from({ length: 50 }, () => ({ lat: rnd() * 10 + 40, lng: rnd() * 10 - 80 })) });
  d.paths.push({ name: "Route <1>", kind: "route", points: Array.from({ length: 7 }, () => ({ lat: rnd() * 2, lng: rnd() * 2, ele: 12.5 })) });
  return d;
}
const near8 = (a: number, b: number) => Math.abs(a - b) < 6e-9;

await test("GPX / KML export (MP-08): gpxpy and xml.etree read Fusion's files back exactly — 60 waypoints with hostile names (& < \" ' ]]> emoji, tabs, spaces), a 50-point track, a route with elevations, a KML polygon", { "MP-08": "full" }, () => {
  const doc = sampleDoc();
  const gpx = X.toGPX(doc, { name: "Fusion", time: "2026-10-17T12:00:00Z" });
  const kml = X.toKML({ points: doc.points, paths: [doc.paths[0], { ...doc.paths[1], kind: "polygon" }] });
  const r = py("geoformats.py", { mode: "read", gpx, kml });
  eq([r.wpts.length, r.trks.length, r.rtes.length, r.trks[0][1].length, r.rtes[0][1].length], [60, 1, 1, 50, 7], "counts");
  r.wpts.forEach((w: [number, number, string, string, number | null], i: number) => {
    const p = doc.points[i];
    ok(near8(w[0], p.lat) && near8(w[1], p.lng), `wpt ${i} position`);
    eq([w[2], w[3]], [p.name, p.note], `wpt ${i} text`);
    if (p.ele !== undefined) ok(w[4] !== null && near8(w[4], p.ele), `wpt ${i} elevation`);
  });
  r.trks[0][1].forEach((q: number[], i: number) => ok(near8(q[0], doc.paths[0].points[i].lat) && near8(q[1], doc.paths[0].points[i].lng), `trkpt ${i}`));
  eq([r.trks[0][0], r.rtes[0][0]], ["Measured path & co", "Route <1>"]);
  ok(r.rtes[0][1].every((q: number[]) => q[2] === 12.5), "route elevations");
  const pts = r.kml.filter((k: unknown[]) => k[0] === "point");
  eq(pts.length, 60, "KML placemarks");
  pts.forEach((k: [string, string, string, number[][]], i: number) => { const p = doc.points[i]; eq([k[1], k[2]], [p.name, p.note], `KML ${i} text`); ok(near8(k[3][0][0], p.lng) && near8(k[3][0][1], p.lat), `KML ${i} lng,lat order`); });
  const poly = r.kml.find((k: unknown[]) => k[0] === "polygon");
  ok(poly && poly[3].length === 8 && near8(poly[3][0][0], poly[3][7][0]), "KML polygon ring is closed (7 + repeat)");
});

await test("GPX / KML import (MP-08): Fusion reads GPX 1.0 and 1.1 written by gpxpy, its own GPX/KML, namespaced and real-world shapes (multi-segment tracks, MultiGeometry, Folder nesting, CDATA, gx: extensions)", { "MP-08": "full" }, () => {
  const doc = sampleDoc();
  const w = py("geoformats.py", { mode: "write", doc });
  for (const v of ["gpx10", "gpx11"]) {
    const d = X.parseGPX(w[v]);
    eq([d.points.length, d.paths.length, d.paths[0].points.length, d.paths[1].kind], [60, 2, 50, "route"], `${v} counts`);
    d.points.forEach((p, i) => { const o = doc.points[i]; ok(near8(p.lat, o.lat) && near8(p.lng, o.lng), `${v} wpt ${i}`); eq([p.name, p.note], [o.name, o.note], `${v} wpt ${i} text`); });
  }
  const own = X.parseGPX(X.toGPX(doc));
  eq(own.points.map((p) => [p.name, p.note, p.ele ?? null]), doc.points.map((p) => [p.name, p.note, p.ele ?? null]), "own GPX round trip");
  const kml = `<?xml version="1.0"?>\n<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><kml:Document><kml:Folder><kml:name>Trip</kml:name>
    <kml:Placemark><kml:name><![CDATA[Café <b>Nord</b>]]></kml:name><kml:Point><kml:coordinates> 8.5417,47.3769,408 </kml:coordinates></kml:Point></kml:Placemark>
    <kml:Placemark><kml:name>Both</kml:name><kml:MultiGeometry><kml:Point><kml:coordinates>1,2</kml:coordinates></kml:Point><kml:LineString><kml:coordinates>1,2 3,4
      5,6</kml:coordinates></kml:LineString></kml:MultiGeometry></kml:Placemark>
    <kml:Placemark><kml:name>Lake</kml:name><kml:Polygon><kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>0,0 1,0 1,1 0,0</kml:coordinates></kml:LinearRing></kml:outerBoundaryIs><kml:innerBoundaryIs><kml:LinearRing><kml:coordinates>0.2,0.2 0.3,0.2 0.3,0.3 0.2,0.2</kml:coordinates></kml:LinearRing></kml:innerBoundaryIs></kml:Polygon></kml:Placemark>
    <kml:Placemark><kml:name>Track</kml:name><gx:Track><gx:coord>1 2 3</gx:coord></gx:Track></kml:Placemark>
  </kml:Folder></kml:Document></kml:kml>`;
  const k = X.parseKML(kml);
  eq(k.points.map((p) => [p.name, p.lat, p.lng, p.ele ?? null]), [["Café <b>Nord</b>", 47.3769, 8.5417, 408], ["Both", 2, 1, null]]);
  eq(k.paths.map((p) => [p.name, p.kind, p.points.length]), [["Both", "line", 3], ["Lake", "polygon", 3]]);
  ok(k.warnings.some((x) => /holes/.test(x)) && k.warnings.some((x) => /Track/.test(x)), `warnings: ${k.warnings.join(" | ")}`);
  const gpx2 = `<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><name>Two</name><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"><ele>5</ele><time>2026-01-01T00:00:00Z</time></trkpt></trkseg><trkseg><trkpt lat="3" lon="4"/></trkseg></trk><extensions><x:y xmlns:x="urn:x">ignored</x:y></extensions></gpx>`;
  const g2 = X.parseGPX(gpx2);
  eq(g2.paths.map((p) => [p.name, p.points.length]), [["Two (1)", 2], ["Two (2)", 1]]);
  eq(g2.paths[0].points[1], { lat: 1.1, lng: 2.1, ele: 5, time: "2026-01-01T00:00:00Z" });
  eq(X.parseGeoFile(gpx2).format, "gpx"); eq(X.parseGeoFile(kml).format, "kml");
});

await test("GPX / KML hostile input (MP-08): entity declarations refused (billion laughs / external entity), mismatched or unclosed tags, two roots, wrong root, out-of-range coordinates skipped with a warning, > 20 MB refused", { "MP-08": "full" }, () => {
  const refuse = (src: string, re: RegExp, m: string) => { try { X.parseGeoFile(src); } catch (e) { ok(re.test((e as Error).message), `${m}: "${(e as Error).message}" !~ ${re}`); return; } throw new Error(`should refuse: ${m}`); };
  refuse(`<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><gpx><wpt lat="1" lon="1"><name>&b;</name></wpt></gpx>`, /entity declarations/, "billion laughs");
  refuse(`<!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml><Placemark><name>&xxe;</name></Placemark></kml>`, /entity declarations/, "external entity");
  refuse(`<!DOCTYPE gpx [<!ENTITY unused "x">]><gpx></gpx>`, /entity declarations/, "a declared but unused entity is refused too (no expansion machinery at all)");
  eq(X.parseXml(`<!DOCTYPE gpx><gpx/>`).name, "gpx", "a plain DOCTYPE is fine");
  refuse(`<gpx><wpt lat="1" lon="1"><name>x</wpt></gpx>`, /does not match/, "mismatched tag");
  refuse(`<gpx><wpt lat="1" lon="1">`, /not closed/, "unclosed");
  refuse(`<gpx></gpx><gpx></gpx>`, /more than one root/, "two roots");
  refuse(`<gpx><wpt lat="1" lon="1"><name>&nbsp;</name></wpt></gpx>`, /undeclared entity/, "undeclared entity");
  refuse(`<svg xmlns="http://www.w3.org/2000/svg"/>`, /not a GPX or KML/, "an SVG");
  refuse(`<gpx>${"x".repeat(X.XML_MAX)}</gpx>`, /20 MB/, "oversize");
  const d = X.parseGPX(`<gpx><wpt lat="91" lon="0"/><wpt lat="1" lon="200"/><wpt lat="abc" lon="1"/><wpt lat="45" lon="7"><name>ok</name></wpt><rte><rtept lat="1" lon="1"/></rte></gpx>`);
  eq(d.points.map((p) => p.name), ["ok"]); eq(d.warnings.length, 3, "three skipped waypoints");
  const k = X.parseKML(`<kml><Placemark><name>bad</name><Point><coordinates>200,10</coordinates></Point></Placemark><Placemark><name>none</name></Placemark></kml>`);
  eq(k.points.length, 0); eq(k.warnings.length, 2);
  eq(X.parseXml(`<a>&#x1F6B2;&#169;&amp;&lt;</a>`).text, "🚲©&<", "numeric + predefined entities");
  ok(!/[\u0001\u0008]/.test(X.xmlEscape("a\u0001b\u0008c")), "control characters XML 1.0 cannot carry are dropped on export");
});

/* ===================================================================== SM-09..11 transport */

const ready = (ctl: E.Ctl): E.CtlState => ({ ...E.initialState(ctl), connected: true, status: "playing" });
await test("transport protocol (SM-09): exact volume / mute / speed / playlist / seek messages per provider; SoundCloud volume, Spotify and TIDAL extras never sent; capability matrix", { "SM-09": "full" }, () => {
  const yt = (c: E.Command) => E.command("youtube", c, "fusion-3");
  eq(yt({ op: "volume", value: 37.4 }), JSON.stringify({ event: "command", func: "setVolume", args: [37], id: "fusion-3", channel: "widget" }));
  eq(yt({ op: "volume", value: 140 }), JSON.stringify({ event: "command", func: "setVolume", args: [100], id: "fusion-3", channel: "widget" }), "clamped");
  eq(JSON.parse(yt({ op: "mute", on: true }) as string).func, "mute"); eq(JSON.parse(yt({ op: "mute", on: false }) as string).func, "unMute");
  eq(JSON.parse(yt({ op: "rate", value: 1.5 }) as string).args, [1.5]); eq(yt({ op: "rate", value: 0 }), null);
  eq(JSON.parse(yt({ op: "next" }) as string).func, "nextVideo"); eq(JSON.parse(yt({ op: "prev" }) as string).func, "previousVideo");
  eq(E.command("vimeo", { op: "volume", value: 50 }), JSON.stringify({ method: "setVolume", value: 0.5 }), "Vimeo 0–1");
  eq(E.command("vimeo", { op: "mute", on: true }), JSON.stringify({ method: "setMuted", value: true }));
  eq(E.command("vimeo", { op: "rate", value: 2 }), JSON.stringify({ method: "setPlaybackRate", value: 2 })); eq(E.command("vimeo", { op: "rate", value: 3 }), null, "Vimeo rate > 2");
  eq(E.command("vimeo", { op: "next" }), null);
  eq(E.command("soundcloud", { op: "next" }), JSON.stringify({ method: "next" })); eq(E.command("soundcloud", { op: "prev" }), JSON.stringify({ method: "prev" }));
  eq(E.command("soundcloud", { op: "seek", seconds: 61.5 }), JSON.stringify({ method: "seekTo", value: 61500 }));
  for (const c of [{ op: "volume", value: 50 }, { op: "mute", on: true }, { op: "rate", value: 1.5 }] as E.Command[]) eq(E.command("soundcloud", c), null, `SoundCloud ${c.op} must not be sent`);
  for (const ctl of ["spotify", "tidal"] as E.Ctl[]) for (const c of [{ op: "volume", value: 50 }, { op: "mute", on: true }, { op: "rate", value: 1.5 }, { op: "next" }, { op: "seek", seconds: 5 }] as E.Command[]) eq(E.command(ctl, c, "f", ready(ctl)), null, `${ctl} ${c.op}`);
  const caps = (ctl: E.Ctl, extra: Partial<E.CtlState> = {}) => { const c = E.capabilities({ ...ready(ctl), ...extra }); return (Object.keys(c) as (keyof E.Caps)[]).filter((k) => c[k]).join(" "); };
  eq(caps("youtube"), "seek volume mute rate"); eq(caps("youtube", { playlistSize: 5 }), "seek volume mute rate playlist");
  eq(caps("vimeo"), "seek volume mute rate"); eq(caps("soundcloud"), "seek"); eq(caps("soundcloud", { playlistSize: 3 }), "seek playlist");
  eq(caps("spotify"), ""); eq(caps("tidal"), ""); eq(caps("youtube", { connected: false }), "", "nothing before the handshake");
  eq(E.capabilities(null).seek, false);
});

await test("transport reports (SM-09): volume / mute / speed / rates / playlist come only from the player — YouTube infoDelivery, Vimeo volumechange + playbackratechange (subscribed), SoundCloud getSounds; junk ignored", { "SM-09": "full" }, () => {
  let st = ready("youtube");
  let r = E.receive(st, JSON.stringify({ event: "initialDelivery", info: { playerState: 1, currentTime: 3, duration: 200, volume: 80, muted: false, playbackRate: 1, availablePlaybackRates: [0.25, 0.5, 1, 1.5, 2], playlist: ["a", "b", "c"], playlistIndex: 1 } }));
  st = r.state;
  eq([st.volume, st.muted, st.rate, st.rates, st.playlistSize, st.playlistIndex], [80, false, 1, [0.25, 0.5, 1, 1.5, 2], 3, 1]);
  ok(r.events.some((e) => e.type === "settings"), "settings event");
  r = E.receive(st, JSON.stringify({ event: "infoDelivery", info: { volume: 30, muted: true } })); st = r.state; eq([st.volume, st.muted, st.rate], [30, true, 1], "delta keeps the rest");
  r = E.receive(st, JSON.stringify({ event: "infoDelivery", info: { volume: 900, playbackRate: -1, availablePlaybackRates: ["x"] } })); eq([r.state.volume, r.state.rate], [30, 1], "out-of-range values ignored");
  let v = { ...E.initialState("vimeo") };
  r = E.receive(v, JSON.stringify({ event: "ready" }));
  ok(r.send.includes(JSON.stringify({ method: "addEventListener", value: "volumechange" })) && r.send.includes(JSON.stringify({ method: "addEventListener", value: "playbackratechange" })), "Vimeo subscriptions");
  v = r.state;
  v = E.receive(v, JSON.stringify({ event: "volumechange", data: { volume: 0.25, muted: false } })).state; eq([v.volume, v.muted], [25, false]);
  v = E.receive(v, JSON.stringify({ event: "playbackratechange", data: { playbackRate: 1.5 } })).state; eq(v.rate, 1.5);
  eq(E.receive(v, JSON.stringify({ event: "volumechange", data: { volume: 7 } })).state.volume, 25, "Vimeo volume outside 0–1 ignored");
  let sc = E.initialState("soundcloud");
  r = E.receive(sc, JSON.stringify({ method: "ready" })); ok(r.send.includes(JSON.stringify({ method: "getSounds" })), "SoundCloud asks for its sounds");
  sc = E.receive(r.state, JSON.stringify({ method: "getSounds", value: [{ id: 1 }, { id: 2 }, { id: 3 }] })).state; eq(sc.playlistSize, 3);
  eq(E.receive(sc, "not json").state, sc, "junk → same state");
});

await test("keyboard (SM-10): Space/K, J/L, arrows, M, Shift+N/P, < >, digits; nothing while typing or with modifiers; sliders keep their arrows; Space on a button stays the button's; speed stepping", { "SM-10": "full" }, () => {
  const k = (key: string, o: Partial<E.KeyInput> = {}) => E.keyAction({ key, tag: "SECTION", ...o });
  eq(k(" "), { op: "toggle" }); eq(k("k"), { op: "toggle" }); eq(k("j"), { op: "skip", seconds: -10 }); eq(k("L"), { op: "skip", seconds: 10 });
  eq(k("ArrowLeft"), { op: "skip", seconds: -5 }); eq(k("ArrowRight"), { op: "skip", seconds: 5 }); eq(k("ArrowUp"), { op: "volume", delta: 5 }); eq(k("ArrowDown"), { op: "volume", delta: -5 });
  eq(k("m"), { op: "mute" }); eq(k("N", { shiftKey: true }), { op: "libNext" }); eq(k("P", { shiftKey: true }), { op: "libPrev" }); eq(k("n"), null);
  eq(k(">", { shiftKey: true }), { op: "rate", dir: 1 }); eq(k("<", { shiftKey: true }), { op: "rate", dir: -1 }); eq(k("5"), { op: "seekFraction", f: 0.5 });
  for (const o of [{ tag: "INPUT", type: "text" }, { tag: "INPUT", type: "url" }, { tag: "TEXTAREA" }, { tag: "SELECT" }, { tag: "DIV", editable: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }] as Partial<E.KeyInput>[]) {
    eq(k("k", o), null, `typing/modifier ${JSON.stringify(o)}`); eq(k(" ", o), null);
  }
  eq(k("ArrowLeft", { tag: "INPUT", type: "range" }), null, "slider keeps arrows"); eq(k("5", { tag: "INPUT", type: "range" }), null);
  eq(k("k", { tag: "INPUT", type: "range" }), { op: "toggle" }, "letters still work on a slider");
  eq(k(" ", { tag: "BUTTON" }), null, "Space presses the focused button"); eq(k("k", { tag: "BUTTON" }), { op: "toggle" });
  eq(E.stepRate([0.5, 1, 1.5, 2], 1, 1), 1.5); eq(E.stepRate([0.5, 1, 1.5, 2], 2, 1), 2); eq(E.stepRate([0.5, 1, 1.5, 2], 1.1, -1), 0.5); eq(E.stepRate([], 1, 1), 1);
});

await test("library order (SM-11): Previous wraps only with Loop; Shuffle never repeats within a round, never plays the same item twice in a row across rounds, is uniform (χ², 6 items × 6 000 draws)", { "SM-11": "full" }, () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, url: `https://youtu.be/aaaaaaaaaa${i}`, title: `T${i}`, kind: "video", provider: "youtube", added: "" }) as unknown as S.LibraryItem);
  eq(S.prevIn(items, "i3", false)?.id, "i2"); eq(S.prevIn(items, "i0", false), null); eq(S.prevIn(items, "i0", true)?.id, "i5"); eq(S.prevIn(items, null, false)?.id, "i5"); eq(S.prevIn([], null, true), null);
  let cur: string | null = "i0", played: string[] = ["i0"]; const seen: string[] = [];
  for (let k = 0; k < 5; k++) { const r = S.shuffleNext(items, cur, played, false, rnd); ok(r && !r.newRound, "round continues"); cur = r!.item.id; played = [...played, cur]; seen.push(cur); }
  eq(new Set(seen).size, 5, "no repeats within a round"); eq(S.shuffleNext(items, cur, played, false, rnd), null, "round over without Loop");
  const r2 = S.shuffleNext(items, cur, played, true, rnd); ok(r2 && r2.newRound && r2.item.id !== cur, "new round with Loop, not the same item again");
  const counts = new Map<string, number>(); for (let k = 0; k < 6000; k++) { const r = S.shuffleNext(items, "i0", [], false, rnd)!; counts.set(r.item.id, (counts.get(r.item.id) ?? 0) + 1); }
  eq(counts.has("i0"), false, "never the current item");
  const chi = [...counts.values()].reduce((s, c) => s + (c - 1200) ** 2 / 1200, 0);
  ok(chi < 18.47, `χ² ${chi.toFixed(2)} ≥ 18.47 (df 4, p = 0.001)`);
  eq(S.shuffleNext(items.slice(0, 1), "i0", ["i0"], true, rnd)?.item.id, "i0", "a one-item list loops onto itself");
});

finish();
