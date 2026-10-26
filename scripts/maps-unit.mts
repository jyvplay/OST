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
import * as G from "../src/lib/gazetteer-core.ts";
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

await test("gazetteer (TT28): own TSV parser over GeoNames cities15000; folding (Zürich = Zurich, St. = Saint); exact > prefix > word-prefix ranked by population; qualifiers 'Paris, TX' / 'Paris, France' / 'Springfield, Illinois'; garbage-safe", { "MP-04": "full" }, () => {
  const t0 = Date.now();
  const g = G.parseGeoNames(readFileSync("node_modules/cities-15000-structured/dist/cities15000.txt", "utf8"));
  const parseMs = Date.now() - t0;
  ok(g.cities.length > 25000, `rows ${g.cities.length}`); ok(parseMs < 4000, `parse ${parseMs} ms`);
  ok(G.fold("Zürich") === "zurich" && G.fold("St. Louis") === "saint louis" && G.fold("Kraków") === "krakow" && G.fold("Straße") === "strasse", "folding");
  const top = (q: string) => G.searchCities(g, q, 5)[0]?.label ?? "(none)";
  ok(top("Raleigh") === "Raleigh, NC, United States", `Raleigh → ${top("Raleigh")}`);
  ok(top("paris") === "Paris, France", `paris → ${top("paris")}`);
  ok(top("Paris, TX") === "Paris, TX, United States", `Paris, TX → ${top("Paris, TX")}`);
  ok(top("Paris, Texas") === "Paris, TX, United States", `Paris, Texas → ${top("Paris, Texas")}`);
  ok(top("Springfield, Illinois") === "Springfield, IL, United States", `Springfield, Illinois → ${top("Springfield, Illinois")}`);
  ok(top("London, Canada") === "London, Canada", `London, Canada → ${top("London, Canada")}`);
  ok(top("london") === "London, United Kingdom", `london → ${top("london")}`);
  ok(top("zurich").startsWith("Zürich"), `zurich → ${top("zurich")}`);
  ok(top("St Louis, MO").startsWith("St. Louis") || top("St Louis, MO").startsWith("Saint Louis"), `St Louis, MO → ${top("St Louis, MO")}`);
  ok(top("Tokyo") === "Tokyo, Japan" && top("東京") === "Tokyo, Japan", `Tokyo / 東京 → ${top("Tokyo")} / ${top("東京")}`);
  ok(top("Mumbai") === "Mumbai, India", `Mumbai → ${top("Mumbai")}`);
  ok(top("Rale").startsWith("Raleigh"), `Rale → ${top("Rale")}`);
  // a qualifier that matches nothing returns nothing; it is not silently ignored
  ok(G.searchCities(g, "Paris, Atlantis").length === 0, "unknown qualifier");
  ok(G.searchCities(g, "r").length === 0 && G.searchCities(g, "").length === 0, "too short");
  ok(G.searchCities(g, "Qqzxqq").length === 0, "no match");
  ok(G.searchCities(g, "a".repeat(5000)).length === 0, "long query");
  ok(G.searchCities(g, "par", 3).length === 3 && G.searchCities(g, "par", 999).length === 50, "limit clamp");
  const bad = G.parseGeoNames("garbage\n1\tX\tX\t\tnotanumber\t5\nexample\n#comment\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\n");
  ok(bad.cities.length === 0, "garbage rows skipped");
  ok(G.countryName("FR") === "France" && G.countryName("xx") === "XX", "Intl country names");
});

await test("gazetteer nearest (TT28): grid ring search is EXACT: 400 random points (incl. polar + antimeridian) agree with a brute-force scan; 'N km NE of …' labels; Raleigh downtown → In Raleigh", { "MP-05": "full" }, () => {
  const g = G.parseGeoNames(readFileSync("node_modules/cities-15000-structured/dist/cities15000.txt", "utf8"));
  const brute = (lat: number, lng: number) => {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < g.cities.length; i++) { const c = g.cities[i]; const d = M.haversine([lat, lng], [c.lat, c.lng]); if (d < bd) { bd = d; bi = i; } }
    return { c: g.cities[bi], km: bd / 1000 };
  };
  let seed = 28; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pts: [number, number][] = [[89.9, 0], [-89.9, 120], [0, 179.99], [0, -179.99], [64.8, -147.7], [-54.8, -68.3], [78.2, 15.6], [-77.8, 166.7], [21.3, -157.8], [51.5, 179.5]];
  while (pts.length < 400) pts.push([Math.asin(rnd() * 2 - 1) * 180 / Math.PI, rnd() * 360 - 180]);
  let worst = 0; const t0 = Date.now();
  for (const [lat, lng] of pts) {
    const a = G.nearestCities(g, lat, lng, 1)[0]; const b = brute(lat, lng);
    ok(!!a, `no answer at ${lat},${lng}`);
    if (a.city.id !== b.c.id) ok(Math.abs(a.km - b.km) < 0.05, `at ${lat.toFixed(2)},${lng.toFixed(2)}: grid ${a.city.name} ${a.km} km vs brute ${b.c.name} ${b.km.toFixed(1)} km`);
    worst = Math.max(worst, Math.abs(a.km - b.km));
  }
  const ms = Date.now() - t0;
  const r = G.nearestCities(g, 35.7796, -78.6382, 3);
  ok(r[0].city.name === "Raleigh" && G.describeNear(r[0]) === "In Raleigh", `downtown → ${G.describeNear(r[0])}`);
  ok(r.length === 3 && r[0].km <= r[1].km && r[1].km <= r[2].km, "k=3 sorted");
  const d = G.describeNear(G.nearestCities(g, 35.9, -79.3, 1)[0]);
  ok(/^\d+ km (N|NE|E|SE|S|SW|W|NW) of /.test(d), `described: ${d}`);
  ok(/ mi /.test(G.describeNear(G.nearestCities(g, 35.9, -79.3, 1)[0], "imperial")), "imperial");
  ok(G.nearestCities(g, NaN, 0).length === 0 && G.nearestCities(g, 91, 0).length === 0, "invalid input");
  ok(G.compass(0) === "N" && G.compass(44) === "NE" && G.compass(359) === "N" && G.compass(225) === "SW", "compass");
  console.log(`      nearest: 400 points in ${ms} ms, max |grid − brute| ${worst.toFixed(3)} km`);
});

finish();
