/**
 * TT51 — DrawingML preset geometry (ECMA-376 Part 1 §20.1.10.56 ST_ShapeType) as SVG paths, original code.
 * Each preset is computed from the formulas' intent (adjust values in 1/100000 of min(w,h) or of w/h as the spec's
 * presetShapeDefinitions.xml defines them). Presets not listed fall back to a rectangle and are reported (`approx`).
 */
export interface GeomOut { d: string; approx?: boolean; open?: boolean }
type Adj = Record<string, number>;
const f = (n: number) => (Math.round(n * 100) / 100).toString();
const poly = (pts: [number, number][], close = true) => "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L") + (close ? " Z" : "");
const ellipse = (cx: number, cy: number, rx: number, ry: number) => `M${f(cx - rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)} Z`;
function star(n: number, w: number, h: number, inner: number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + (i * Math.PI) / n; const r = i % 2 ? inner : 1; pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]); }
  return poly(pts);
}
function regular(n: number, w: number, h: number, rot = -Math.PI / 2): string {
  const pts: [number, number][] = []; for (let i = 0; i < n; i++) { const a = rot + (i * 2 * Math.PI) / n; pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]); }
  return poly(pts);
}
const roundRect = (w: number, h: number, r: number) => { r = Math.max(0, Math.min(r, w / 2, h / 2)); return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`; };

export function presetPath(prst: string, w: number, h: number, adj: Adj = {}): GeomOut {
  const ss = Math.min(w, h); const a = (k: string, def: number) => (adj[k] ?? def) / 100000;
  switch (prst) {
    case "rect": case "flowChartProcess": case "textBox": return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]) };
    case "roundRect": case "flowChartAlternateProcess": return { d: roundRect(w, h, ss * a("adj", 16667)) };
    case "flowChartTerminator": return { d: roundRect(w, h, Math.min(w, h) / 2) };
    case "ellipse": case "flowChartConnector": return { d: ellipse(w / 2, h / 2, w / 2, h / 2) };
    case "triangle": { const x = w * a("adj", 50000); return { d: poly([[x, 0], [w, h], [0, h]]) }; }
    case "rtTriangle": return { d: poly([[0, 0], [w, h], [0, h]]) };
    case "diamond": case "flowChartDecision": return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) };
    case "parallelogram": case "flowChartInputOutput": { const o = prst === "parallelogram" ? ss * a("adj", 25000) : w / 5; return { d: poly([[o, 0], [w, 0], [w - o, h], [0, h]]) }; }
    case "trapezoid": { const o = ss * a("adj", 25000); return { d: poly([[o, 0], [w - o, 0], [w, h], [0, h]]) }; }
    case "flowChartManualOperation": return { d: poly([[0, 0], [w, 0], [w * 0.8, h], [w * 0.2, h]]) };
    case "pentagon": case "homePlate": {
      if (prst === "homePlate") { const o = ss * a("adj", 50000); return { d: poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h]]) }; }
      return { d: poly([[w / 2, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]]) };
    }
    case "hexagon": case "flowChartPreparation": { const o = prst === "hexagon" ? ss * a("adj", 25000) : w / 5; return { d: poly([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]) }; }
    case "heptagon": return { d: regular(7, w, h) };
    case "octagon": { const o = ss * a("adj", 29289); return { d: poly([[o, 0], [w - o, 0], [w, o], [w, h - o], [w - o, h], [o, h], [0, h - o], [0, o]]) }; }
    case "decagon": return { d: regular(10, w, h, 0) };
    case "dodecagon": return { d: regular(12, w, h, 0) };
    case "star4": return { d: star(4, w, h, a("adj", 12500) * 2) };
    case "star5": return { d: star(5, w, h, 0.382) };
    case "star6": return { d: star(6, w, h, 0.577) };
    case "star7": return { d: star(7, w, h, 0.6) };
    case "star8": return { d: star(8, w, h, a("adj", 38250) * 2 > 0 ? a("adj", 38250) * 2 : 0.7) };
    case "star10": return { d: star(10, w, h, 0.8) };
    case "star12": return { d: star(12, w, h, 0.75) };
    case "star16": case "star24": case "star32": return { d: star(Number(prst.slice(4)), w, h, 0.85) };
    case "rightArrow": case "leftArrow": case "upArrow": case "downArrow": {
      const vert = prst === "upArrow" || prst === "downArrow"; const L = vert ? h : w, T = vert ? w : h;
      const shaft = T * a("adj1", 50000), head = Math.min(L, ss * a("adj2", 50000));
      const y0 = (T - shaft) / 2, y1 = (T + shaft) / 2;
      let pts: [number, number][] = [[0, y0], [L - head, y0], [L - head, 0], [L, T / 2], [L - head, T], [L - head, y1], [0, y1]];
      if (prst === "leftArrow" || prst === "upArrow") pts = pts.map(([x, y]) => [L - x, y]);
      if (vert) pts = pts.map(([x, y]) => [y, x]);
      return { d: poly(pts) };
    }
    case "leftRightArrow": { const shaft = h * a("adj1", 50000), head = Math.min(w / 2, ss * a("adj2", 50000)); const y0 = (h - shaft) / 2, y1 = (h + shaft) / 2; return { d: poly([[0, h / 2], [head, 0], [head, y0], [w - head, y0], [w - head, 0], [w, h / 2], [w - head, h], [w - head, y1], [head, y1], [head, h]]) }; }
    case "upDownArrow": { const shaft = w * a("adj1", 50000), head = Math.min(h / 2, ss * a("adj2", 50000)); const x0 = (w - shaft) / 2, x1 = (w + shaft) / 2; return { d: poly([[w / 2, 0], [w, head], [x1, head], [x1, h - head], [w, h - head], [w / 2, h], [0, h - head], [x0, h - head], [x0, head], [0, head]]) }; }
    case "chevron": { const o = ss * a("adj", 50000); return { d: poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]) }; }
    case "plus": case "flowChartSummingJunction": { const o = ss * a("adj", 25000); return { d: poly([[o, 0], [w - o, 0], [w - o, o], [w, o], [w, h - o], [w - o, h - o], [w - o, h], [o, h], [o, h - o], [0, h - o], [0, o], [o, o]]) }; }
    case "donut": { const t = ss * a("adj", 25000); return { d: ellipse(w / 2, h / 2, w / 2, h / 2) + " " + ellipse(w / 2, h / 2, Math.max(0, w / 2 - t), Math.max(0, h / 2 - t)) }; }
    case "frame": { const t = ss * a("adj1", 12500); return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]) + " " + poly([[t, t], [t, h - t], [w - t, h - t], [w - t, t]]) }; }
    case "can": case "flowChartMagneticDisk": { const ry = Math.min(h / 2, ss * a("adj", 25000) / 2); return { d: `M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 1 ${f(w)} ${f(ry)} V${f(h - ry)} A${f(w / 2)} ${f(ry)} 0 0 1 0 ${f(h - ry)} Z M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 0 ${f(w)} ${f(ry)}` }; }
    case "flowChartDocument": return { d: `M0 0 H${f(w)} V${f(h * 0.83)} C${f(w * 0.75)} ${f(h * 0.7)} ${f(w * 0.5)} ${f(h * 1.05)} 0 ${f(h * 0.9)} Z` };
    case "flowChartPredefinedProcess": return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]) + ` M${f(w / 8)} 0 V${f(h)} M${f(w * 7 / 8)} 0 V${f(h)}` };
    case "flowChartManualInput": return { d: poly([[0, h / 5], [w, 0], [w, h], [0, h]]) };
    case "flowChartOffpageConnector": return { d: poly([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]) };
    case "flowChartExtract": case "flowChartMerge": return { d: prst === "flowChartMerge" ? poly([[0, 0], [w, 0], [w / 2, h]]) : poly([[w / 2, 0], [w, h], [0, h]]) };
    case "round2SameRect": { const r = ss * a("adj1", 16667); return { d: `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h)} H0 V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z` }; }
    case "round1Rect": { const r = ss * a("adj", 16667); return { d: `M0 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h)} H0 Z` }; }
    case "snip1Rect": { const o = ss * a("adj", 16667); return { d: poly([[0, 0], [w - o, 0], [w, o], [w, h], [0, h]]) }; }
    case "snip2SameRect": { const o = ss * a("adj1", 16667); return { d: poly([[o, 0], [w - o, 0], [w, o], [w, h], [0, h], [0, o]]) }; }
    case "wedgeRectCallout": case "wedgeRoundRectCallout": case "wedgeEllipseCallout": {
      const tx = w / 2 + w * a("adj1", -20833), ty = h / 2 + h * a("adj2", 62500);
      const body = prst === "wedgeEllipseCallout" ? ellipse(w / 2, h / 2, w / 2, h / 2) : prst === "wedgeRoundRectCallout" ? roundRect(w, h, ss * 0.16667) : poly([[0, 0], [w, 0], [w, h], [0, h]]);
      const bx = Math.max(w * 0.2, Math.min(w * 0.8, tx)); const by = ty > h ? h : ty < 0 ? 0 : h;
      return { d: body + " " + poly([[bx - w * 0.08, by], [tx, ty], [bx + w * 0.08, by]]) };
    }
    case "heart": return { d: `M${f(w / 2)} ${f(h / 4)} C${f(w / 2)} 0 0 0 0 ${f(h / 4)} C0 ${f(h / 2)} ${f(w / 2)} ${f(h * 0.75)} ${f(w / 2)} ${f(h)} C${f(w / 2)} ${f(h * 0.75)} ${f(w)} ${f(h / 2)} ${f(w)} ${f(h / 4)} C${f(w)} 0 ${f(w / 2)} 0 ${f(w / 2)} ${f(h / 4)} Z` };
    case "stripedRightArrow": case "notchedRightArrow": {
      const shaft = h * a("adj1", 50000), head = Math.min(w, ss * a("adj2", 50000)); const y0 = (h - shaft) / 2, y1 = (h + shaft) / 2;
      if (prst === "notchedRightArrow") { const n = (shaft / 2) * (head / (h / 2)); return { d: poly([[0, y0], [w - head, y0], [w - head, 0], [w, h / 2], [w - head, h], [w - head, y1], [0, y1], [n, h / 2]]) }; }
      const t = ss / 32; return { d: poly([[0, y0], [t, y0], [t, y1], [0, y1]]) + " " + poly([[t * 2, y0], [t * 4, y0], [t * 4, y1], [t * 2, y1]]) + " " + poly([[t * 5, y0], [w - head, y0], [w - head, 0], [w, h / 2], [w - head, h], [w - head, y1], [t * 5, y1]]) };
    }
    case "flowChartDelay": return { d: `M0 0 H${f(w / 2)} A${f(w / 2)} ${f(h / 2)} 0 0 1 ${f(w / 2)} ${f(h)} H0 Z` };
    case "flowChartPunchedCard": return { d: poly([[w / 5, 0], [w, 0], [w, h], [0, h], [0, h / 5]]) };
    case "flowChartSort": return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) + ` M0 ${f(h / 2)} H${f(w)}` };
    case "flowChartCollate": return { d: poly([[0, 0], [w, 0], [0, h], [w, h]]) };
    case "flowChartOnlineStorage": return { d: `M${f(w / 6)} 0 H${f(w)} A${f(w / 6)} ${f(h / 2)} 0 0 0 ${f(w)} ${f(h)} H${f(w / 6)} A${f(w / 6)} ${f(h / 2)} 0 0 1 ${f(w / 6)} 0 Z` };
    case "bentUpArrow": {
      const t = ss * a("adj1", 25000), hw = ss * a("adj2", 25000), hl = ss * a("adj3", 25000); const sx = w - hw - t / 2;
      return { d: poly([[0, h - t], [sx, h - t], [sx, hl], [w - hw * 2, hl], [w - hw, 0], [w, hl], [sx + t, hl], [sx + t, h], [0, h]]) };
    }
    case "foldedCorner": { const o = ss * a("adj", 16667); return { d: poly([[0, 0], [w, 0], [w, h - o], [w - o, h], [0, h]]) + ` M${f(w - o)} ${f(h)} L${f(w - o * 0.8)} ${f(h - o * 0.8)} L${f(w)} ${f(h - o)}` }; }
    case "plaque": { const r = ss * a("adj", 16667); return { d: `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 0 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 0 ${f(w - r)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 0 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 0 ${f(r)} 0 Z` }; }
    case "teardrop": return { d: `M0 ${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 0 ${f(w / 2)} 0 H${f(w)} V${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 0 1 0 ${f(h / 2)} Z`, approx: true };
    case "bevel": case "cube": { const o = ss * a("adj", prst === "cube" ? 25000 : 12500); return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]) + " " + (prst === "cube" ? poly([[0, o], [o, 0], [w, 0], [w - o, o]]) + " " + poly([[w - o, o], [w, 0], [w, h - o], [w - o, h]]) : poly([[o, o], [w - o, o], [w - o, h - o], [o, h - o]])) }; }
    case "sun": return { d: star(16, w, h, 0.62) + " " + ellipse(w / 2, h / 2, w / 4, h / 4), approx: true };
    case "actionButtonBlank": case "actionButtonHome": case "actionButtonHelp": case "actionButtonInformation": case "actionButtonForwardNext": case "actionButtonBackPrevious": case "actionButtonEnd": case "actionButtonBeginning": case "actionButtonReturn": case "actionButtonDocument": case "actionButtonSound": case "actionButtonMovie": {
      const o = ss * 0.1; const body = poly([[0, 0], [w, 0], [w, h], [0, h]]) + " " + poly([[o, o], [w - o, o], [w - o, h - o], [o, h - o]]);
      if (prst === "actionButtonForwardNext") return { d: body + " " + poly([[w * 0.35, h * 0.25], [w * 0.7, h / 2], [w * 0.35, h * 0.75]]) };
      if (prst === "actionButtonBackPrevious") return { d: body + " " + poly([[w * 0.65, h * 0.25], [w * 0.3, h / 2], [w * 0.65, h * 0.75]]) };
      return { d: body, approx: prst !== "actionButtonBlank" };
    }
    case "cloud": case "cloudCallout": return { d: ellipse(w / 2, h / 2, w / 2, h / 2), approx: true };
    case "pie": case "blockArc": case "arc": case "chord": {
      const st = ((adj.adj1 ?? (prst === "arc" ? 16200000 : 0)) / 60000) * Math.PI / 180, en = ((adj.adj2 ?? (prst === "arc" ? 0 : 16200000)) / 60000) * Math.PI / 180;
      const p = (t: number) => [w / 2 + (w / 2) * Math.cos(t), h / 2 + (h / 2) * Math.sin(t)] as const;
      const [x0, y0] = p(st), [x1, y1] = p(en); let sweep = en - st; if (sweep <= 0) sweep += 2 * Math.PI;
      const large = sweep > Math.PI ? 1 : 0;
      const arc = `M${f(x0)} ${f(y0)} A${f(w / 2)} ${f(h / 2)} 0 ${large} 1 ${f(x1)} ${f(y1)}`;
      return prst === "arc" ? { d: arc, open: true } : prst === "pie" ? { d: `${arc} L${f(w / 2)} ${f(h / 2)} Z` } : { d: `${arc} Z`, approx: prst === "blockArc" };
    }
    case "line": case "straightConnector1": return { d: `M0 0 L${f(w)} ${f(h)}`, open: true };
    case "bentConnector2": return { d: `M0 0 H${f(w)} V${f(h)}`, open: true };
    case "bentConnector3": { const x = w * a("adj1", 50000); return { d: `M0 0 H${f(x)} V${f(h)} H${f(w)}`, open: true }; }
    case "bentConnector4": case "bentConnector5": return { d: `M0 0 H${f(w / 2)} V${f(h)} H${f(w)}`, open: true, approx: true };
    case "curvedConnector2": return { d: `M0 0 C${f(w)} 0 ${f(w)} 0 ${f(w)} ${f(h)}`, open: true };
    case "curvedConnector3": case "curvedConnector4": case "curvedConnector5": return { d: `M0 0 C${f(w / 2)} 0 ${f(w / 2)} ${f(h)} ${f(w)} ${f(h)}`, open: true };
    case "leftBracket": return { d: `M${f(w)} 0 Q0 0 0 ${f(h / 2)} Q0 ${f(h)} ${f(w)} ${f(h)}`, open: true };
    case "rightBracket": return { d: `M0 0 Q${f(w)} 0 ${f(w)} ${f(h / 2)} Q${f(w)} ${f(h)} 0 ${f(h)}`, open: true };
    case "leftBrace": return { d: `M${f(w)} 0 Q${f(w / 2)} 0 ${f(w / 2)} ${f(h / 4)} V${f(h * 0.4)} Q${f(w / 2)} ${f(h / 2)} 0 ${f(h / 2)} Q${f(w / 2)} ${f(h / 2)} ${f(w / 2)} ${f(h * 0.6)} V${f(h * 0.75)} Q${f(w / 2)} ${f(h)} ${f(w)} ${f(h)}`, open: true };
    case "rightBrace": return { d: `M0 0 Q${f(w / 2)} 0 ${f(w / 2)} ${f(h / 4)} V${f(h * 0.4)} Q${f(w / 2)} ${f(h / 2)} ${f(w)} ${f(h / 2)} Q${f(w / 2)} ${f(h / 2)} ${f(w / 2)} ${f(h * 0.6)} V${f(h * 0.75)} Q${f(w / 2)} ${f(h)} 0 ${f(h)}`, open: true };
    case "lightningBolt": return { d: poly([[w * 0.39, 0], [w * 0.6, h * 0.3], [w * 0.52, h * 0.34], [w * 0.8, h * 0.62], [w * 0.7, h * 0.67], [w, h], [w * 0.45, h * 0.73], [w * 0.55, h * 0.68], [w * 0.2, h * 0.42], [w * 0.3, h * 0.38], [0, h * 0.13]]) };
    case "moon": return { d: `M${f(w)} 0 A${f(w)} ${f(h / 2)} 0 0 0 ${f(w)} ${f(h)} A${f(w / 2)} ${f(h / 2)} 0 0 1 ${f(w)} 0 Z` };
    case "smileyFace": return { d: ellipse(w / 2, h / 2, w / 2, h / 2) + " " + ellipse(w * 0.35, h * 0.38, w * 0.05, h * 0.05) + " " + ellipse(w * 0.65, h * 0.38, w * 0.05, h * 0.05) + ` M${f(w * 0.3)} ${f(h * 0.65)} Q${f(w / 2)} ${f(h * 0.82)} ${f(w * 0.7)} ${f(h * 0.65)}` };
    case "noSmoking": return { d: ellipse(w / 2, h / 2, w / 2, h / 2), approx: true };
    default: return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]), approx: true };
  }
}

/**
 * a:custGeom → SVG path. Path coordinates live in each a:path's own w/h space and are scaled to the shape box.
 * Supports moveTo, lnTo, cubicBezTo, quadBezTo, arcTo (wR, hR, stAng, swAng) and close; guide names resolve through
 * a:gdLst constants ("val n") — formula guides are unsupported and reported.
 */
export interface CustPath { w: number; h: number; cmds: { op: string; pts: [string, string][]; arc?: [string, string, string, string] }[]; fill: boolean; stroke: boolean }
export function custPathD(paths: CustPath[], W: number, H: number, guides: Record<string, number>): { d: string; approx: boolean; open: boolean } {
  let approx = false, open = true; const out: string[] = [];
  const num = (s: string) => { const n = Number(s); if (Number.isFinite(n)) return n; if (s in guides) return guides[s]; approx = true; return 0; };
  for (const p of paths) {
    const sx = p.w ? W / p.w : 1, sy = p.h ? H / p.h : 1; let cx = 0, cy = 0;
    if (p.fill) open = false;
    for (const c of p.cmds) {
      const P = c.pts.map(([x, y]) => [num(x) * sx, num(y) * sy] as [number, number]);
      if (c.op === "moveTo" && P[0]) { [cx, cy] = P[0]; out.push(`M${f(cx)} ${f(cy)}`); }
      else if (c.op === "lnTo" && P[0]) { [cx, cy] = P[0]; out.push(`L${f(cx)} ${f(cy)}`); }
      else if (c.op === "cubicBezTo" && P.length === 3) { out.push(`C${P.map(([x, y]) => `${f(x)} ${f(y)}`).join(" ")}`); [cx, cy] = P[2]; }
      else if (c.op === "quadBezTo" && P.length === 2) { out.push(`Q${P.map(([x, y]) => `${f(x)} ${f(y)}`).join(" ")}`); [cx, cy] = P[1]; }
      else if (c.op === "arcTo" && c.arc) {
        const wR = num(c.arc[0]) * sx, hR = num(c.arc[1]) * sy, st = (num(c.arc[2]) / 60000) * Math.PI / 180, sw = (num(c.arc[3]) / 60000) * Math.PI / 180;
        // the current point lies on the ellipse at angle st; find the centre, then the end point at st + sw
        const ox = cx - wR * Math.cos(st), oy = cy - hR * Math.sin(st);
        const ex = ox + wR * Math.cos(st + sw), ey = oy + hR * Math.sin(st + sw);
        if (Math.abs(sw) >= 2 * Math.PI - 1e-6) { const mx = ox + wR * Math.cos(st + Math.PI), my = oy + hR * Math.sin(st + Math.PI); out.push(`A${f(wR)} ${f(hR)} 0 0 ${sw > 0 ? 1 : 0} ${f(mx)} ${f(my)} A${f(wR)} ${f(hR)} 0 0 ${sw > 0 ? 1 : 0} ${f(ex)} ${f(ey)}`); }
        else out.push(`A${f(wR)} ${f(hR)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${f(ex)} ${f(ey)}`);
        cx = ex; cy = ey;
      } else if (c.op === "close") out.push("Z");
    }
  }
  return { d: out.join(" ") || "M0 0", approx, open };
}
