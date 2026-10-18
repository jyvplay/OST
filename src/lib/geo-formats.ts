/**
 * TT34 MP-08: GPX 1.1 / 1.0 and KML 2.2 import + export for Maps — pure, original code (no XML library).
 *
 *   GPX (topografix.com/GPX/1/1): saved places ⇄ <wpt>, the measured path ⇄ <trk><trkseg><trkpt> (or <rte><rtept>).
 *   KML (OGC 12-007r2): places ⇄ <Placemark><Point>, the path ⇄ <Placemark><LineString> (Polygon outer rings and
 *   MultiGeometry are read too). Coordinates in KML are "lng,lat[,alt]" tuples separated by whitespace.
 *
 * The XML reader is deliberately small and strict about what it will NOT do: any DOCTYPE that declares entities is
 * refused (no entity expansion → no "billion laughs", no external entities), only the five predefined entities and
 * numeric character references are decoded, and input is capped at 20 MB. Element names are matched by local name,
 * so default or prefixed namespaces (gpx:wpt, kml:Placemark) both work. Checked by scripts/tt34-unit.mts against
 * gpxpy (Apache-2.0) in both directions and Python's xml.etree for KML.
 */

export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }
export const XML_MAX = 20 * 1024 * 1024;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (e in ENT) return ENT[e];
    throw new Error(`XML: undeclared entity &${e};`);
  });
}
const localName = (q: string) => q.slice(q.indexOf(":") + 1);

/** Parse XML into a light element tree. Throws on malformed input or entity declarations. */
export function parseXml(src: string): XNode {
  if (src.length > XML_MAX) throw new Error("XML: file is larger than 20 MB");
  const root: XNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) { if (src.slice(i).trim()) throw new Error("XML: text after the root element"); break; }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); if (e < 0) throw new Error("XML: unterminated comment"); i = e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt + 9); if (e < 0) throw new Error("XML: unterminated CDATA"); top.text += src.slice(lt + 9, e); i = e + 3; continue; }
    if (src.startsWith("<?", lt)) { const e = src.indexOf("?>", lt + 2); if (e < 0) throw new Error("XML: unterminated processing instruction"); i = e + 2; continue; }
    if (src.startsWith("<!DOCTYPE", lt) || src.startsWith("<!doctype", lt)) {
      // find the end, honouring an internal subset [...]
      let j = lt + 9, depth = 0;
      for (; j < n; j++) { const c = src[j]; if (c === "[") depth++; else if (c === "]") depth--; else if (c === ">" && depth <= 0) break; }
      const decl = src.slice(lt, j + 1);
      if (/<!ENTITY/i.test(decl)) throw new Error("XML: entity declarations are not accepted");
      i = j + 1; continue;
    }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt);
      if (e < 0) throw new Error("XML: unterminated end tag");
      const name = localName(src.slice(lt + 2, e).trim());
      const open = stack.pop();
      if (!open || open === root || open.name !== name) throw new Error(`XML: </${name}> does not match <${open?.name ?? "?"}>`);
      i = e + 1; continue;
    }
    // start tag: scan to '>' outside quotes
    let j = lt + 1, q = "";
    for (; j < n; j++) { const c = src[j]; if (q) { if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === ">") break; }
    if (j >= n) throw new Error("XML: unterminated start tag");
    let body = src.slice(lt + 1, j);
    const selfClose = body.endsWith("/");
    if (selfClose) body = body.slice(0, -1);
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new Error("XML: empty tag name");
    const node: XNode = { name: localName(m[1]), attrs: {}, children: [], text: "" };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(m[1].length);
    while ((a = re.exec(rest))) node.attrs[localName(a[1])] = decodeEntities(a[3] ?? a[4] ?? "");
    if (stack.length === 1 && root.children.length) throw new Error("XML: more than one root element");
    top.children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  if (stack.length !== 1) throw new Error(`XML: <${stack[stack.length - 1].name}> is not closed`);
  if (!root.children.length) throw new Error("XML: no root element");
  return root.children[0];
}

const kids = (x: XNode, name: string) => x.children.filter((c) => c.name === name);
const kid = (x: XNode, name: string) => x.children.find((c) => c.name === name);
/** element text exactly as written (XML text is significant: names keep their spaces, as gpxpy and ElementTree do) */
const textOf = (x: XNode | undefined): string => (x ? x.text + x.children.map(textOf).join("") : "");
function* walk(x: XNode): Generator<XNode> { yield x; for (const c of x.children) yield* walk(c); }

export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string)
  // characters XML 1.0 cannot carry at all
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");

/* ---------------------------------------------------------------- model */

export interface GeoPoint { lat: number; lng: number; name: string; note: string; ele?: number; time?: string }
export interface GeoPath { name: string; points: { lat: number; lng: number; ele?: number; time?: string }[]; kind: "track" | "route" | "line" | "polygon" }
export interface GeoDoc { points: GeoPoint[]; paths: GeoPath[]; warnings: string[] }

const okLat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90;
const okLng = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180;
const fmtNum = (v: number) => String(Math.round(v * 1e8) / 1e8); // ≤ 8 decimals ≈ 1 mm; no exponent for |v| ≥ 1e-7

/* ---------------------------------------------------------------- GPX */

function gpxPt(x: XNode, warnings: string[]): { lat: number; lng: number; ele?: number; time?: string } | null {
  const lat = parseFloat(x.attrs.lat ?? ""), lng = parseFloat(x.attrs.lon ?? "");
  if (!okLat(lat) || !okLng(lng)) { warnings.push(`skipped <${x.name}> with invalid lat/lon "${x.attrs.lat}","${x.attrs.lon}"`); return null; }
  const e = parseFloat(textOf(kid(x, "ele")));
  const t = textOf(kid(x, "time")).trim();
  return { lat, lng, ...(Number.isFinite(e) ? { ele: e } : {}), ...(t ? { time: t } : {}) };
}

export function parseGPX(src: string): GeoDoc {
  const root = parseXml(src);
  if (root.name !== "gpx") throw new Error(`not a GPX file (root element <${root.name}>)`);
  const warnings: string[] = [];
  const points: GeoPoint[] = [];
  for (const w of kids(root, "wpt")) {
    const p = gpxPt(w, warnings); if (!p) continue;
    points.push({ ...p, name: textOf(kid(w, "name")) || "Waypoint", note: textOf(kid(w, "desc")) || textOf(kid(w, "cmt")) });
  }
  const paths: GeoPath[] = [];
  for (const t of kids(root, "trk")) {
    const name = textOf(kid(t, "name")) || "Track";
    const segs = kids(t, "trkseg");
    segs.forEach((s, k) => {
      const pts = kids(s, "trkpt").map((x) => gpxPt(x, warnings)).filter((p): p is NonNullable<typeof p> => !!p);
      if (pts.length) paths.push({ name: segs.length > 1 ? `${name} (${k + 1})` : name, points: pts, kind: "track" });
    });
  }
  for (const r of kids(root, "rte")) {
    const pts = kids(r, "rtept").map((x) => gpxPt(x, warnings)).filter((p): p is NonNullable<typeof p> => !!p);
    if (pts.length) paths.push({ name: textOf(kid(r, "name")) || "Route", points: pts, kind: "route" });
  }
  return { points, paths, warnings };
}

export function toGPX(doc: { points: GeoPoint[]; paths: GeoPath[] }, opts: { name?: string; time?: string } = {}): string {
  const L: string[] = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Fusion Maps" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">'];
  if (opts.name || opts.time) L.push(`  <metadata>${opts.name ? `<name>${xmlEscape(opts.name)}</name>` : ""}${opts.time ? `<time>${xmlEscape(opts.time)}</time>` : ""}</metadata>`);
  const inner = (p: { ele?: number; time?: string }) => `${p.ele !== undefined ? `<ele>${fmtNum(p.ele)}</ele>` : ""}${p.time ? `<time>${xmlEscape(p.time)}</time>` : ""}`;
  for (const p of doc.points) {
    // GPX 1.1 schema order inside wpt: ele, time, …, name, cmt, desc
    L.push(`  <wpt lat="${fmtNum(p.lat)}" lon="${fmtNum(p.lng)}">${inner(p)}<name>${xmlEscape(p.name)}</name>${p.note ? `<desc>${xmlEscape(p.note)}</desc>` : ""}</wpt>`);
  }
  for (const path of doc.paths) {
    if (path.kind === "route") {
      L.push(`  <rte><name>${xmlEscape(path.name)}</name>`);
      for (const p of path.points) L.push(`    <rtept lat="${fmtNum(p.lat)}" lon="${fmtNum(p.lng)}">${inner(p)}</rtept>`);
      L.push("  </rte>");
    } else {
      L.push(`  <trk><name>${xmlEscape(path.name)}</name><trkseg>`);
      for (const p of path.points) L.push(`    <trkpt lat="${fmtNum(p.lat)}" lon="${fmtNum(p.lng)}">${inner(p)}</trkpt>`);
      L.push("  </trkseg></trk>");
    }
  }
  L.push("</gpx>", "");
  return L.join("\n");
}

/* ---------------------------------------------------------------- KML */

function kmlCoords(s: string, warnings: string[]): { lat: number; lng: number; ele?: number }[] {
  const out: { lat: number; lng: number; ele?: number }[] = [];
  for (const tup of s.trim().split(/\s+/)) {
    if (!tup) continue;
    const [lng, lat, ele] = tup.split(",").map(Number);
    if (!okLat(lat) || !okLng(lng)) { warnings.push(`skipped KML coordinate "${tup}"`); continue; }
    out.push({ lat, lng, ...(Number.isFinite(ele) && tup.split(",").length > 2 ? { ele } : {}) });
  }
  return out;
}

export function parseKML(src: string): GeoDoc {
  const root = parseXml(src);
  if (root.name !== "kml") throw new Error(`not a KML file (root element <${root.name}>)`);
  const warnings: string[] = [];
  const points: GeoPoint[] = [], paths: GeoPath[] = [];
  for (const pm of walk(root)) {
    if (pm.name !== "Placemark") continue;
    const name = textOf(kid(pm, "name")), note = textOf(kid(pm, "description"));
    const geoms: XNode[] = [];
    const collect = (x: XNode) => { for (const c of x.children) { if (c.name === "MultiGeometry") collect(c); else if (["Point", "LineString", "LinearRing", "Polygon"].includes(c.name)) geoms.push(c); } };
    collect(pm);
    if (!geoms.length) warnings.push(`Placemark "${name || "?"}" has no Point/LineString/Polygon (skipped)`);
    for (const g of geoms) {
      if (g.name === "Point") {
        const c = kmlCoords(textOf(kid(g, "coordinates")), warnings)[0];
        if (c) points.push({ ...c, name: name || "Placemark", note });
      } else if (g.name === "LineString" || g.name === "LinearRing") {
        const pts = kmlCoords(textOf(kid(g, "coordinates")), warnings);
        if (pts.length) paths.push({ name: name || "Line", points: pts, kind: g.name === "LinearRing" ? "polygon" : "line" });
      } else {
        const outer = kid(g, "outerBoundaryIs"), ring = outer ? kid(outer, "LinearRing") : undefined;
        const pts = ring ? kmlCoords(textOf(kid(ring, "coordinates")), warnings) : [];
        if (pts.length > 1 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lng === pts[pts.length - 1].lng) pts.pop();
        if (pts.length) paths.push({ name: name || "Polygon", points: pts, kind: "polygon" });
        if (kids(g, "innerBoundaryIs").length) warnings.push(`Polygon "${name || "?"}": holes are not imported`);
      }
    }
  }
  return { points, paths, warnings };
}

export function toKML(doc: { points: GeoPoint[]; paths: GeoPath[] }, opts: { name?: string } = {}): string {
  const c = (p: { lat: number; lng: number; ele?: number }) => `${fmtNum(p.lng)},${fmtNum(p.lat)}${p.ele !== undefined ? `,${fmtNum(p.ele)}` : ""}`;
  const L: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', "<Document>"];
  if (opts.name) L.push(`  <name>${xmlEscape(opts.name)}</name>`);
  for (const p of doc.points) L.push(`  <Placemark><name>${xmlEscape(p.name)}</name>${p.note ? `<description>${xmlEscape(p.note)}</description>` : ""}<Point><coordinates>${c(p)}</coordinates></Point></Placemark>`);
  for (const path of doc.paths) {
    if (path.kind === "polygon") {
      const ring = [...path.points, path.points[0]];
      L.push(`  <Placemark><name>${xmlEscape(path.name)}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring.map(c).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
    } else {
      L.push(`  <Placemark><name>${xmlEscape(path.name)}</name><LineString><tessellate>1</tessellate><coordinates>${path.points.map(c).join(" ")}</coordinates></LineString></Placemark>`);
    }
  }
  L.push("</Document>", "</kml>", "");
  return L.join("\n");
}

/** Pick the reader by content (root element), not by file name. */
export function parseGeoFile(src: string): GeoDoc & { format: "gpx" | "kml" } {
  const head = src.slice(0, 4096);
  if (/<(\w+:)?gpx[\s>]/.test(head)) return { ...parseGPX(src), format: "gpx" };
  if (/<(\w+:)?kml[\s>]/.test(head)) return { ...parseKML(src), format: "kml" };
  throw new Error("not a GPX or KML file");
}
