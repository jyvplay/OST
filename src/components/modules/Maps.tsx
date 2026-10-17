"use client";
import "leaflet/dist/leaflet.css";
import type * as LT from "leaflet";
import { fz } from "@/lib/uiscale";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import * as M from "@/lib/maps-core";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

/**
 * TT27 MP-01..MP-03: Maps. Leaflet 1.9 (BSD-2-Clause) draws an offline world — Natural Earth admin-0 countries from
 * world-atlas (public domain data, ISC package) — so the map works with no network at all. Street tiles from
 * tile.openstreetmap.org are opt-in (they send your IP and the area you look at to the OSM Foundation; the iframe-free
 * <img> requests carry a strict-origin Referer, which the OSM tile policy requires) or any https {z}/{x}/{y} template.
 * Places live in /Documents/Places.geojson (RFC 7946), so other GIS tools can read them.
 */
export const PLACES_PATH = "/Documents/Places.geojson";
type Mode = "pan" | "pin" | "measure";
interface CountryHit { name: string; feature: M.Feature }

export default function MapsModule({ win }: ModuleProps) {
  const shell = useShell();
  const host = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LT.Map | null>(null);
  const LRef = useRef<typeof LT | null>(null);
  const feats = useRef<{ f: M.Feature; bb: [M.LatLng, M.LatLng] | null }[]>([]);
  const layers = useRef<{ countries?: LT.GeoJSON; places?: LT.LayerGroup; measure?: LT.LayerGroup; tiles?: LT.TileLayer; sel?: LT.GeoJSON; me?: LT.CircleMarker }>({});
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [mode, setMode] = useState<Mode>("pan");
  const modeRef = useRef<Mode>("pan");
  const [places, setPlaces] = useState<M.Places | null>(null);
  const placesRef = useRef<M.Places | null>(null);
  const dirty = useRef(false);
  const [saveErr, setSaveErr] = useState("");
  const [measure, setMeasure] = useState<M.LatLng[]>([]);
  const [cursor, setCursor] = useState<{ lat: number; lng: number; country: string } | null>(null);
  const [selCountry, setSelCountry] = useState<string>("");
  const [selPlace, setSelPlace] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [fmt, setFmt] = useState<"dd" | "dms">("dd");
  const [units, setUnits] = useState<"metric" | "imperial">("metric");
  const [status, setStatus] = useState("");
  const [tileDraft, setTileDraft] = useState(shell.settings["maps.tileUrl"] ?? "");
  const tiles = shell.settings["maps.tiles"] ?? "off";
  const tileUrl = shell.settings["maps.tileUrl"] ?? "";
  const theme = shell.settings["appearance.theme"] === "light" ? "light" : "dark";

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const countryAt = (lat: number, lng: number): CountryHit | null => {
    const w = M.wrapLng(lng);
    for (const { f, bb } of feats.current) {
      if (bb && (lat < bb[0][0] || lat > bb[1][0] || w < bb[0][1] || w > bb[1][1])) continue;
      if (M.inGeometry([w, lat], f.geometry)) return { name: String(f.properties?.name ?? ""), feature: f };
    }
    return null;
  };

  /* --------------------------------------------------------------- places file */
  useEffect(() => {
    let live = true;
    api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(PLACES_PATH)}`)
      .then((r) => { if (!live) return; let raw: unknown = null; try { raw = JSON.parse(r.node.content); } catch { setSaveErr("Places.geojson is not valid JSON — it will be replaced on the next save"); } setPlaces(M.normalizePlaces(raw)); })
      .catch((e: Error) => { if (!live) return; if (/not found|404/i.test(e.message)) setPlaces(M.emptyPlaces()); else setSaveErr(e.message); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    placesRef.current = places;
    if (!places || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      post("/api/fs", { op: "write", path: PLACES_PATH, content: M.placesToGeoJSON(places), mime: "application/geo+json", reason: "maps" })
        .then(() => setSaveErr("")).catch((e: Error) => setSaveErr(`Save failed: ${e.message}`));
    }, 400);
    return () => clearTimeout(t);
  }, [places]);
  // flush a pending save when the tab is hidden/closed (pagehide) and on unmount — the debounce must never lose an edit
  useEffect(() => {
    const flush = () => {
      if (!dirty.current || !placesRef.current) return;
      dirty.current = false;
      const body = JSON.stringify({ op: "write", path: PLACES_PATH, content: M.placesToGeoJSON(placesRef.current), mime: "application/geo+json", reason: "maps" });
      void fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: body.length < 60_000 }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  const change = (fn: (p: M.Places) => M.Places) => setPlaces((p) => { if (!p) return p; const n = fn(p); if (n !== p) dirty.current = true; return n; });
  const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const addAt = (lat: number, lng: number, name?: string) => {
    const id = newId();
    change((p) => M.addPlace(p, { id, name: name ?? countryAt(lat, lng)?.name ?? "", lat, lng, note: "", added: new Date().toISOString() }));
    setSelPlace(id);
  };
  const addRef = useRef(addAt);
  useEffect(() => { addRef.current = addAt; });

  // a .geojson handed over by Files ("Open with Maps") is merged into the places
  const openPath = (win.props.path as string) ?? "";
  useEffect(() => {
    if (!openPath || openPath === PLACES_PATH || !places) return;
    let live = true;
    api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(openPath)}`).then((r) => {
      if (!live) return;
      let raw: unknown = null; try { raw = JSON.parse(r.node.content); } catch { setStatus(`${openPath} is not valid JSON`); return; }
      const inc = M.normalizePlaces(raw).places;
      change((p) => inc.reduce((acc, x) => M.addPlace(acc, { ...x, id: newId() }), p));
      setStatus(`Imported ${inc.length} place(s) from ${openPath.split("/").pop()}`);
    }).catch((e: Error) => setStatus(e.message));
    return () => { live = false; };
    // run once when the places file has loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath, places === null]);

  /* ------------------------------------------------------------------- the map */
  useEffect(() => {
    let live = true; let ro: ResizeObserver | null = null;
    (async () => {
      try {
        const mod = await import("leaflet");
        const L = ((mod as unknown as { default?: typeof LT }).default ?? mod) as typeof LT;
        const [{ feature }, topoMod] = await Promise.all([import("topojson-client"), import("world-atlas/countries-50m.json")]);
        if (!live || !host.current) return;
        const topo = ((topoMod as unknown as { default?: unknown }).default ?? topoMod) as { objects: { countries: unknown } };
        const fc = feature(topo as never, topo.objects.countries as never) as unknown as { type: "FeatureCollection"; features: M.Feature[] };
        feats.current = fc.features.map((f) => ({ f, bb: M.bbox(f.geometry) })); // lookups use the raw (±180) rings
        const drawn = { ...fc, features: fc.features.map((f) => ({ ...f, geometry: M.unwrapGeometry(f.geometry) })) }; // no world-wide seam lines
        LRef.current = L;
        const map = L.map(host.current, { worldCopyJump: true, minZoom: 1, maxZoom: 18, zoomSnap: 0.5, preferCanvas: true, keyboard: true, attributionControl: true })
          .setView([30, 0], 2);
        map.attributionControl.setPrefix(false);
        map.attributionControl.addAttribution("Borders: Natural Earth (public domain) · Leaflet");
        layers.current.countries = L.geoJSON(drawn as never, { interactive: false }).addTo(map);
        layers.current.places = L.layerGroup().addTo(map);
        layers.current.measure = L.layerGroup().addTo(map);
        L.control.scale({ imperial: true, metric: true }).addTo(map);
        const sync = () => {
          const c = map.getCenter(), el = host.current; if (!el) return;
          el.dataset.zoom = String(map.getZoom()); el.dataset.lat = c.lat.toFixed(4); el.dataset.lng = c.lng.toFixed(4);
        };
        map.on("moveend zoomend", sync); sync();
        let raf = 0;
        map.on("mousemove", (e: LT.LeafletMouseEvent) => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => setCursor({ lat: e.latlng.lat, lng: M.wrapLng(e.latlng.lng), country: countryAt(e.latlng.lat, e.latlng.lng)?.name ?? "" }));
        });
        map.on("click", (e: LT.LeafletMouseEvent) => {
          const { lat } = e.latlng, lng = M.wrapLng(e.latlng.lng);
          if (modeRef.current === "pin") addRef.current(lat, lng);
          else if (modeRef.current === "measure") setMeasure((m) => [...m, [lat, lng]]);
          else { const hit = countryAt(lat, lng); setSelCountry(hit?.name ?? ""); }
        });
        mapRef.current = map;
        host.current.dataset.countries = String(fc.features.length);
        ro = new ResizeObserver(() => map.invalidateSize());
        ro.observe(host.current);
        setReady(true);
      } catch (e) { if (live) setLoadErr(`Map failed to load: ${(e as Error).message}`); }
    })();
    return () => { live = false; ro?.disconnect(); mapRef.current?.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // colours follow the theme; land is hidden under street tiles (borders stay as a hairline)
  useEffect(() => {
    const c = layers.current.countries; if (!ready || !c) return;
    const pal = theme === "light" ? { land: "#f3efe6", border: "#b3aa98" } : { land: "#2b3b47", border: "#5b7080" };
    c.setStyle({ color: pal.border, weight: 0.7, fillColor: pal.land, fillOpacity: tiles === "off" ? 1 : 0, opacity: tiles === "off" ? 1 : 0.35 });
  }, [ready, theme, tiles]);

  // street tiles (opt-in)
  useEffect(() => {
    const L = LRef.current, map = mapRef.current; if (!ready || !L || !map) return;
    layers.current.tiles?.remove(); layers.current.tiles = undefined;
    const url = tiles === "osm" ? M.DEFAULT_TILE_URL : tiles === "custom" && M.validTileUrl(tileUrl) ? tileUrl : "";
    if (!url) { if (host.current) host.current.dataset.tiles = "off"; return; }
    const attribution = tiles === "osm" ? `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">${M.OSM_ATTRIBUTION}</a>` : `Tiles: ${new URL(url.replace(/\{[a-z]\}/g, "a")).hostname}`;
    layers.current.tiles = L.tileLayer(url, { maxZoom: 19, attribution, referrerPolicy: "strict-origin-when-cross-origin" } as LT.TileLayerOptions).addTo(map);
    layers.current.tiles.bringToBack();
    if (host.current) host.current.dataset.tiles = tiles;
  }, [ready, tiles, tileUrl]);

  // selected country outline
  useEffect(() => {
    const L = LRef.current, map = mapRef.current; if (!ready || !L || !map) return;
    layers.current.sel?.remove(); layers.current.sel = undefined;
    const f = feats.current.find((x) => String(x.f.properties?.name) === selCountry)?.f;
    if (f) layers.current.sel = L.geoJSON(f as never, { interactive: false, style: { color: "#0a84ff", weight: 2.2, fillColor: "#0a84ff", fillOpacity: 0.12 } }).addTo(map);
  }, [ready, selCountry]);

  // place markers
  useEffect(() => {
    const L = LRef.current, g = layers.current.places; if (!ready || !L || !g || !places) return;
    g.clearLayers();
    for (const p of places.places) {
      const sel = p.id === selPlace;
      L.circleMarker([p.lat, p.lng], { radius: sel ? 10 : 7.5, color: "#ffffff", weight: sel ? 3 : 2, fillColor: p.color, fillOpacity: 1 })
        .bindTooltip(p.name, { direction: "top", offset: [0, -8] })
        .on("click", (e: LT.LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); setSelPlace(p.id); })
        .addTo(g);
    }
    if (host.current) host.current.dataset.places = String(places.places.length);
  }, [ready, places, selPlace]);

  // measuring line
  useEffect(() => {
    const L = LRef.current, g = layers.current.measure; if (!ready || !L || !g) return;
    g.clearLayers();
    if (measure.length > 1) L.polyline(measure, { color: "#ff9f0a", weight: 3, dashArray: "6 6" }).addTo(g);
    measure.forEach((pt) => L.circleMarker(pt, { radius: 5, color: "#ffffff", weight: 2, fillColor: "#ff9f0a", fillOpacity: 1, interactive: false }).addTo(g));
  }, [ready, measure]);

  /* ------------------------------------------------------------------ search */
  const results = useMemo(() => {
    const out: { label: string; go: () => void; kind: "coord" | "country" | "place" }[] = [];
    if (!q.trim()) return out;
    const c = M.parseLatLng(q);
    if (c) out.push({ kind: "coord", label: `Go to ${M.formatLatLng(c.lat, c.lng, fmt)}`, go: () => mapRef.current?.flyTo([c.lat, c.lng], c.zoom ?? Math.max(mapRef.current.getZoom(), 9)) });
    const n = q.trim().toLowerCase();
    for (const p of places?.places ?? []) if (p.name.toLowerCase().includes(n) && out.length < 12) out.push({ kind: "place", label: p.name, go: () => { setSelPlace(p.id); mapRef.current?.flyTo([p.lat, p.lng], Math.max(mapRef.current.getZoom(), 10)); } });
    if (ready) for (const f of M.searchFeatures(feats.current.map((x) => x.f), q, 8)) {
      const name = String(f.properties?.name);
      out.push({ kind: "country", label: name, go: () => { setSelCountry(name); const bb = M.mainBbox(f.geometry); if (bb && mapRef.current) mapRef.current.flyToBounds(bb, { padding: [24, 24], maxZoom: 7 }); } });
    }
    return out;
  }, [q, ready, places, fmt]);

  const centre = () => { const c = mapRef.current?.getCenter(); return c ? { lat: c.lat, lng: M.wrapLng(c.lng) } : null; };
  const locate = () => {
    if (!("geolocation" in navigator)) { setStatus("This browser has no Geolocation API."); return; }
    setStatus("Asking the browser for your location…");
    navigator.geolocation.getCurrentPosition((pos) => {
      const L = LRef.current, map = mapRef.current; if (!L || !map) return;
      const ll: M.LatLng = [pos.coords.latitude, pos.coords.longitude];
      layers.current.me?.remove();
      layers.current.me = L.circleMarker(ll, { radius: 8, color: "#ffffff", weight: 3, fillColor: "#0a84ff", fillOpacity: 1 }).addTo(map);
      map.flyTo(ll, 13);
      setStatus(`You are here: ${M.formatLatLng(ll[0], ll[1], fmt)} (±${Math.round(pos.coords.accuracy)} m)`);
    }, (err) => setStatus(`Location unavailable: ${err.message || ["", "permission denied", "position unavailable", "timed out"][err.code]}`), { timeout: 10000, maximumAge: 60000 });
  };
  const exportFile = () => {
    if (!places) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([M.placesToGeoJSON(places)], { type: "application/geo+json" }));
    a.download = "places.geojson"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importFile = async (file: File) => {
    let raw: unknown = null;
    try { raw = JSON.parse(await file.text()); } catch { setStatus(`${file.name} is not valid JSON`); return; }
    const inc = M.normalizePlaces(raw).places;
    change((p) => inc.reduce((acc, x) => M.addPlace(acc, { ...x, id: newId() }), p));
    setStatus(`Imported ${inc.length} place(s) from ${file.name}`);
  };

  const sel = places?.places.find((p) => p.id === selPlace) ?? null;
  const dist = M.pathLength(measure);

  return (
    <div className="fs-maps" data-testid="mp-app">
      <aside className="fs-maps-side" aria-label="Map tools">
        <div className="fs-maps-search">
          <input className="fs-input" data-testid="mp-search" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" && results[0]) { e.preventDefault(); results[0].go(); } }}
            placeholder="Country, place or coordinates" aria-label="Search countries, saved places or coordinates" />
          {results.length ? (
            <ul className="fs-maps-results" data-testid="mp-results">
              {results.map((r, i) => <li key={`${r.kind}${i}`}><button type="button" className="fs-maps-result" data-testid="mp-result" data-kind={r.kind} onClick={r.go}>{r.label}<span className="fs-dim">{r.kind}</span></button></li>)}
            </ul>
          ) : null}
        </div>

        <div role="radiogroup" aria-label="Map click does" className="fs-maps-modes">
          {(["pan", "pin", "measure"] as const).map((m) => (
            <label key={m} className="fs-layout-opt" data-checked={mode === m}>
              <input type="radio" name={`mp-mode-${win.id}`} className="fs-visually-hidden-radio" checked={mode === m} onChange={() => setMode(m)} data-testid={`mp-mode-${m}`} />
              {m === "pan" ? "Explore" : m === "pin" ? "Add place" : "Measure"}
            </label>
          ))}
        </div>

        {mode === "measure" ? (
          <div className="fs-maps-card" data-testid="mp-measure-card">
            <strong data-testid="mp-measure" data-metres={Math.round(dist)}>{measure.length > 1 ? M.formatDistance(dist, units) : "Click the map to add points"}</strong>
            {measure.length > 1 ? <span className="fs-dim">{measure.length} points · first leg bearing {Math.round(M.bearing(measure[0], measure[1]))}°</span> : null}
            <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Btn onClick={() => { const c = centre(); if (c) setMeasure((m) => [...m, [c.lat, c.lng]]); }} data-testid="mp-measure-centre">Add map centre</Btn>
              <Btn variant="ghost" onClick={() => setMeasure((m) => m.slice(0, -1))} disabled={!measure.length}>Undo point</Btn>
              <Btn variant="ghost" onClick={() => setMeasure([])} disabled={!measure.length} data-testid="mp-measure-clear">Clear</Btn>
            </div>
          </div>
        ) : null}
        {selCountry && mode === "pan" ? <div className="fs-maps-card" data-testid="mp-country"><strong>{selCountry}</strong><span className="fs-dim">Selected country (Natural Earth borders)</span></div> : null}

        <div className="fs-row" style={{ gap: 8 }}>
          <strong style={{ fontSize: fz(14) }}>Places</strong><Badge>{places?.places.length ?? "…"}</Badge><span style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={() => { const c = centre(); if (c) addAt(c.lat, c.lng); }} disabled={!ready || !places} data-testid="mp-add-centre" title="Add a place at the centre of the map (keyboard alternative to clicking the map)">Add at centre</Btn>
        </div>
        <ul className="fs-maps-places" data-testid="mp-places">
          {places && !places.places.length ? <li className="fs-dim" style={{ padding: 6 }}>Choose “Add place” and click the map, or use “Add at centre”.</li> : null}
          {places?.places.map((p) => (
            <li key={p.id} data-testid="mp-place" data-current={p.id === selPlace ? "1" : undefined}>
              <button type="button" className="fs-maps-place" onClick={() => { setSelPlace(p.id); mapRef.current?.flyTo([p.lat, p.lng], Math.max(mapRef.current.getZoom(), 8)); }}>
                <span className="fs-maps-dot" style={{ background: p.color }} aria-hidden="true" />
                <span className="fs-maps-place-name">{p.name}</span>
                <span className="fs-dim fs-maps-place-ll">{M.formatLatLng(p.lat, p.lng, fmt)}</span>
              </button>
            </li>
          ))}
        </ul>
        {sel ? (
          <div className="fs-maps-card" data-testid="mp-place-edit">
            <input className="fs-input" value={sel.name} aria-label="Place name" data-testid="mp-place-name" onChange={(e) => change((p) => M.updatePlace(p, sel.id, { name: e.target.value || " " }))} />
            <textarea className="fs-input" value={sel.note} aria-label="Note" rows={2} placeholder="Note" onChange={(e) => change((p) => M.updatePlace(p, sel.id, { note: e.target.value }))} />
            <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="Pin colour">
              {M.PLACE_COLORS.map((c) => <button key={c} type="button" className="fs-maps-swatch" style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={sel.color === c} onClick={() => change((p) => M.updatePlace(p, sel.id, { color: c }))} />)}
            </div>
            <div className="fs-row" style={{ gap: 6 }}>
              <Btn variant="ghost" onClick={() => { const a = mapRef.current?.getCenter(); if (a) { const b: M.LatLng = [sel.lat, sel.lng]; setStatus(`${sel.name} is ${M.formatDistance(M.haversine([a.lat, M.wrapLng(a.lng)], b), units)} from the map centre`); } }}>Distance from centre</Btn>
              <Btn variant="danger" onClick={() => { change((p) => M.removePlace(p, sel.id)); setSelPlace(null); }} data-testid="mp-place-remove">Remove</Btn>
            </div>
          </div>
        ) : null}

        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={locate} data-testid="mp-locate">Locate me</Btn>
          <Btn variant="ghost" onClick={exportFile} disabled={!places?.places.length} data-testid="mp-export">Export GeoJSON</Btn>
          <label className="fs-btn fs-maps-import" data-variant="ghost">Import…<input type="file" accept=".geojson,.json,application/geo+json" className="fs-visually-hidden-radio" data-testid="mp-import" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} /></label>
        </div>

        <details className="fs-maps-card" data-testid="mp-layers">
          <summary>Map layers &amp; units</summary>
          <label className="fs-row" style={{ gap: 8 }}><input type="radio" name={`mp-tiles-${win.id}`} checked={tiles === "off"} onChange={() => void shell.setSetting("maps.tiles", "off")} data-testid="mp-tiles-off" />Offline world (no network)</label>
          <label className="fs-row" style={{ gap: 8 }}><input type="radio" name={`mp-tiles-${win.id}`} checked={tiles === "osm"} onChange={() => void shell.setSetting("maps.tiles", "osm")} data-testid="mp-tiles-osm" />Street map — OpenStreetMap tiles</label>
          <span className="fs-dim" style={{ fontSize: fz(11.5) }}>Street tiles are loaded from tile.openstreetmap.org, which sees your IP address and the area you view. Their policy is for light use; set your own provider for heavy use.</span>
          <label className="fs-row" style={{ gap: 8 }}><input type="radio" name={`mp-tiles-${win.id}`} checked={tiles === "custom"} disabled={!M.validTileUrl(tileUrl)} onChange={() => void shell.setSetting("maps.tiles", "custom")} data-testid="mp-tiles-custom" />Custom tiles</label>
          <div className="fs-row" style={{ gap: 6 }}>
            <input className="fs-input" value={tileDraft} onChange={(e) => setTileDraft(e.target.value)} placeholder="https://…/{z}/{x}/{y}.png" aria-label="Custom tile URL template" data-testid="mp-tile-url" />
            <Btn onClick={() => { if (M.validTileUrl(tileDraft)) { void shell.setSetting("maps.tileUrl", tileDraft).then(() => shell.setSetting("maps.tiles", "custom")); } else setStatus("Tile URL must be https:// and contain {z}, {x} and {y}"); }} data-testid="mp-tile-save">Use</Btn>
          </div>
          <div className="fs-row" style={{ gap: 10 }}>
            <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={fmt === "dms"} onChange={(e) => setFmt(e.target.checked ? "dms" : "dd")} data-testid="mp-dms" />Degrees-minutes-seconds</label>
            <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={units === "imperial"} onChange={(e) => setUnits(e.target.checked ? "imperial" : "metric")} data-testid="mp-imperial" />Miles</label>
          </div>
        </details>
        {status ? <p className="fs-dim" role="status" data-testid="mp-status" style={{ margin: 0 }}>{status}</p> : null}
        {saveErr ? <p className="fs-stream-err" role="alert">{saveErr}</p> : null}
      </aside>

      <div className="fs-maps-stage">
        <div ref={host} className="fs-maps-map" data-testid="mp-map" data-theme={theme} data-mode={mode} data-ready={ready ? "1" : "0"}
          role="application" aria-label="Map — arrow keys pan, plus and minus zoom" tabIndex={0} />
        {loadErr ? <p className="fs-stream-err" role="alert" style={{ position: "absolute", inset: "auto 12px 12px" }}>{loadErr}</p> : null}
        <div className="fs-maps-coords" data-testid="mp-coords" aria-live="off">
          {cursor ? <>{M.formatLatLng(cursor.lat, cursor.lng, fmt)}{cursor.country ? <> · <b data-testid="mp-hover-country">{cursor.country}</b></> : null}</> : "Move over the map"}
        </div>
      </div>
    </div>
  );
}
