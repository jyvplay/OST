/**
 * Suite "maps-unit" (TT27): the Maps module's geodesy and data layer, checked without a browser.
 *   - haversine against published great-circle distances, bearings, path length, unit formatting
 *   - coordinate parsing (decimal, DMS, hemisphere suffixes, geo: URIs, OSM and Google links) and formatting
 *   - point-in-polygon with holes and multipolygons, country lookup and search over the real world-atlas data
 *   - places: add / update / remove / cap, GeoJSON round trip (RFC 7946 order, simplestyle colour), tile URL validation
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/maps-unit.mts
 */
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import * as M from "../src/lib/maps-core.ts";
import { feature } from "topojson-client";

const { test, finish } = makeHarness("maps-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

await test("geodesy: haversine matches known distances (±0.5 %), bearings, path length, metric/imperial formatting", { "MP-03": "full" }, () => {
  const lhr: M.LatLng = [51.47, -0.4543], jfk: M.LatLng = [40.6413, -73.7781];
  const d = M.haversine(lhr, jfk) / 1000;
  ok(Math.abs(d - 5540) / 5540 < 0.005, `LHR–JFK ${d.toFixed(0)} km (≈5540)`);
  const q = M.haversine([0, 0], [0, 90]) / 1000;
  ok(Math.abs(q - Math.PI / 2 * M.EARTH_RADIUS_M / 1000) < 0.01, "quarter of the equator");
  ok(M.haversine([10, 10], [10, 10]) === 0 && Math.abs(M.haversine([0, 179.5], [0, -179.5]) - 111195) < 200, "zero + antimeridian");
  ok(Math.abs(M.bearing([0, 0], [10, 0])) < 1e-9 && Math.abs(M.bearing([0, 0], [0, 10]) - 90) < 1e-9 && Math.abs(M.bearing([0, 0], [-10, 0]) - 180) < 1e-9, "bearings");
  ok(Math.abs(M.pathLength([[0, 0], [0, 1], [0, 2]]) - 2 * M.haversine([0, 0], [0, 1])) < 1e-6 && M.pathLength([]) === 0, "path");
  ok(M.formatDistance(950) === "950 m" && M.formatDistance(12345) === "12.35 km" && M.formatDistance(5540000) === "5540 km", "metric");
  ok(M.formatDistance(100, "imperial") === "328 ft" && M.formatDistance(1609.344 * 3, "imperial") === "3.00 mi", "imperial");
});

await test("coordinates: decimal, DMS, hemisphere suffixes, geo: URI, OSM + Google links; formatting round-trips", { "MP-02": "full" }, () => {
  const eq = (r: ReturnType<typeof M.parseLatLng>, lat: number, lng: number, zoom?: number) =>
    !!r && Math.abs(r.lat - lat) < 1e-4 && Math.abs(r.lng - lng) < 1e-4 && (zoom === undefined || r.zoom === zoom);
  ok(eq(M.parseLatLng("35.7796, -78.6382"), 35.7796, -78.6382), "decimal comma");
  ok(eq(M.parseLatLng("35.7796 -78.6382"), 35.7796, -78.6382), "decimal space");
  ok(eq(M.parseLatLng(`35°46'46.6"N 78°38'17.5"W`), 35.77961, -78.63819), "DMS");
  ok(eq(M.parseLatLng("35.7796N, 78.6382W"), 35.7796, -78.6382), "suffixes");
  ok(eq(M.parseLatLng("78.6382W 35.7796N"), 35.7796, -78.6382), "lng first with hemispheres");
  ok(M.parseLatLng("35N 36N") === null, "two latitudes refused");
  ok(eq(M.parseLatLng("geo:35.7796,-78.6382;u=35"), 35.7796, -78.6382), "geo URI");
  ok(eq(M.parseLatLng("https://www.openstreetmap.org/#map=12/35.7796/-78.6382"), 35.7796, -78.6382, 12), "OSM link");
  ok(eq(M.parseLatLng("https://www.google.com/maps/place/Raleigh/@35.7796,-78.6382,11z/data=x"), 35.7796, -78.6382, 11), "Google link");
  ok(M.parseLatLng("91, 0") === null && M.parseLatLng("0, 181") === null && M.parseLatLng("Raleigh") === null && M.parseLatLng("") === null, "invalid");
  ok(M.formatLatLng(35.7796, -78.6382) === "35.7796° N, 78.6382° W", M.formatLatLng(35.7796, -78.6382));
  const dms = M.formatLatLng(35.77961, -78.63819, "dms");
  ok(dms === "35°46′46.6″ N, 78°38′17.5″ W", dms);
  ok(eq(M.parseLatLng(dms.replace(/′/g, "'").replace(/″/g, '"')), 35.77961, -78.63819), "DMS output parses back");
  ok(M.wrapLng(190) === -170 && M.wrapLng(-190) === 170 && M.wrapLng(180) === -180, "wrap");
});

await test("point-in-polygon (holes, multipolygons) and real country lookup + search over world-atlas countries-50m", { "MP-01": "full" }, () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  ok(M.inGeometry([2, 2], { type: "Polygon", coordinates: [sq, hole] }) && !M.inGeometry([5, 5], { type: "Polygon", coordinates: [sq, hole] }), "hole");
  ok(M.inGeometry([21, 1], { type: "MultiPolygon", coordinates: [[sq], [[[20, 0], [22, 0], [22, 2], [20, 2], [20, 0]]]] }), "multi");
  ok(!M.inGeometry([0, 0], { type: "Point", coordinates: [0, 0] }) && !M.inGeometry([0, 0], null), "non-area");
  const topo = JSON.parse(readFileSync("node_modules/world-atlas/countries-50m.json", "utf8"));
  const fc = feature(topo, topo.objects.countries) as unknown as { features: M.Feature[] };
  ok(fc.features.length > 230, `${fc.features.length} countries`);
  const at = (lat: number, lng: number) => String(M.featureAt(fc.features, lat, lng)?.properties?.name ?? "—");
  ok(at(35.7796, -78.6382) === "United States of America", `Raleigh → ${at(35.7796, -78.6382)}`);
  ok(at(48.8566, 2.3522) === "France" && at(-33.8688, 151.2093) === "Australia" && at(35.6762, 139.6503) === "Japan" && at(-1.2921, 36.8219) === "Kenya", "capitals");
  ok(at(0, -30) === "—", "mid-Atlantic is no country");
  const s = M.searchFeatures(fc.features, "cote d");
  ok(s.length >= 1 && /C[ôo]te d.Ivoire/.test(String(s[0].properties?.name)), `accent-insensitive: ${s.map((f) => f.properties?.name).join()}`);
  ok(String(M.searchFeatures(fc.features, "india")[0].properties?.name) === "India", "exact beats substring (India before British Indian Ocean Ter.)");
  ok(M.searchFeatures(fc.features, "  ").length === 0, "blank");
  // antimeridian: raw Russia has a ±180 jump (the seam bug seen in the visual check); unwrapped rings never jump > 180°
  const maxJump = (g: M.Feature["geometry"]) => { let j = 0; const walk = (c: unknown): void => { if (Array.isArray(c) && Array.isArray(c[0]) && typeof (c[0] as number[])[0] === "number") { const r = c as number[][]; for (let i = 1; i < r.length; i++) j = Math.max(j, Math.abs(r[i][0] - r[i - 1][0])); } else if (Array.isArray(c)) c.forEach(walk); }; walk((g as { coordinates: unknown }).coordinates); return j; };
  const russia = M.searchFeatures(fc.features, "Russia")[0];
  ok(maxJump(russia.geometry) > 300, "raw Russia crosses the antimeridian");
  ok(fc.features.every((f) => maxJump(M.unwrapGeometry(f.geometry)) <= 180), "no unwrapped ring jumps more than 180°");
  ok(JSON.stringify(M.unwrapRing([[170, 0], [-170, 1], [-175, 2], [170, 0]])) === "[[170,0],[190,1],[185,2],[170,0]]", "unwrap keeps continuity");
  const fr = M.mainBbox(M.searchFeatures(fc.features, "France")[0].geometry)!;
  ok(fr[0][0] > 41 && fr[1][0] < 52 && fr[0][1] > -6 && fr[1][1] < 10, `France main landmass ${JSON.stringify(fr)} (whole bbox reaches French Guiana: ${JSON.stringify(M.bbox(M.searchFeatures(fc.features, "France")[0].geometry))})`);
  const bb = M.bbox(M.searchFeatures(fc.features, "Italy")[0].geometry)!;
  ok(bb[0][0] > 35 && bb[1][0] < 48 && bb[0][1] > 6 && bb[1][1] < 19, `Italy bbox ${JSON.stringify(bb)}`);
});

await test("places: add / update / remove / cap, GeoJSON round trip in [lng, lat] order with marker-color, foreign GeoJSON import, tile URL rules", { "MP-02": "full" }, () => {
  let p = M.emptyPlaces();
  p = M.addPlace(p, { id: "a", name: " Home ", lat: 35.7796, lng: -78.6382, note: "NC", added: "t" });
  p = M.addPlace(p, { id: "b", name: "", lat: 51.5, lng: -0.12, note: "", added: "t", color: "#123456" });
  ok(p.places[0].name === "Home" && p.places[1].name === "Place 2" && p.places[1].color === "#123456", "names + colour");
  ok(M.addPlace(p, { id: "x", name: "bad", lat: 99, lng: 0, note: "", added: "t" }) === p, "invalid coords refused");
  p = M.updatePlace(p, "a", { name: "Office", lat: 35.78 });
  ok(p.places[0].name === "Office" && p.places[0].lat === 35.78 && M.updatePlace(p, "a", { lat: 200 }).places[0].lat === 35.78, "update validates");
  const gj = JSON.parse(M.placesToGeoJSON(p));
  ok(gj.type === "FeatureCollection" && gj.features[0].geometry.coordinates[0] === -78.6382 && gj.features[0].geometry.coordinates[1] === 35.78, "RFC 7946 [lng, lat]");
  ok(gj.features[1].properties["marker-color"] === "#123456", "simplestyle colour");
  const back = M.normalizePlaces(gj);
  ok(back.places.length === 2 && back.places[0].name === "Office" && back.places[0].note === "NC" && back.places[0].id === "a", "round trip");
  const foreign = M.normalizePlaces({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { title: "Peak", description: "high" }, geometry: { type: "Point", coordinates: [86.925, 27.988] } },
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
    { type: "Feature", properties: null, geometry: { type: "Point", coordinates: [0, 95] } }] });
  ok(foreign.places.length === 1 && foreign.places[0].name === "Peak" && foreign.places[0].note === "high", "foreign title/description, non-points + bad coords dropped");
  ok(M.normalizePlaces("x").places.length === 0 && M.removePlace(p, "a").places.length === 1, "garbage + remove");
  let big = M.emptyPlaces();
  for (let i = 0; i < M.PLACES_MAX + 5; i++) big = M.addPlace(big, { id: `i${i}`, name: "x", lat: 0, lng: 0, note: "", added: "t" });
  ok(big.places.length === M.PLACES_MAX, "cap");
  ok(M.validTileUrl(M.DEFAULT_TILE_URL) && M.validTileUrl("https://{s}.tile.example.org/{z}/{x}/{y}{r}.png"), "valid templates");
  ok(!M.validTileUrl("http://tile.example.org/{z}/{x}/{y}.png") && !M.validTileUrl("https://tile.example.org/{z}/{x}.png") && !M.validTileUrl("https://t.example/{z}/{x}/{y}?k={apikey}") && !M.validTileUrl("https://x/{z}/{x}/{y}\"onload"), "invalid templates");
});

finish();
