/**
 * TT49 conditional-format icon sets (ECMA-376 §18.18.42 ST_IconSetType + the Excel 2010 x14 sets 3Stars,
 * 3Triangles, 5Boxes). Each set lists its icons from the LOWEST value band to the highest, the order the file's
 * <cfvo> thresholds use. The glyphs are original 16×16 SVG drawings (no emoji — the UI font does not render them);
 * they reproduce each icon's shape and colour family, not Excel's exact bitmaps.
 */
export type IconGlyph = string;

/** Null-prototype: a hostile name such as "__proto__" or "constructor" never resolves to an inherited value (TT49 adversary). */
export const ICON_SETS: Record<string, IconGlyph[]> = Object.assign(Object.create(null) as Record<string, IconGlyph[]>, {
  "3Arrows": ["arrowDown:red", "arrowSide:yellow", "arrowUp:green"],
  "3ArrowsGray": ["arrowDown:gray", "arrowSide:gray", "arrowUp:gray"],
  "3Flags": ["flag:red", "flag:yellow", "flag:green"],
  "3TrafficLights1": ["dot:red", "dot:yellow", "dot:green"],
  "3TrafficLights2": ["light:red", "light:yellow", "light:green"],
  "3Signs": ["diamond:red", "triangle:yellow", "dot:green"],
  "3Symbols": ["xCircle:red", "bangCircle:yellow", "checkCircle:green"],
  "3Symbols2": ["x:red", "bang:yellow", "check:green"],
  "3Stars": ["star0:gold", "star1:gold", "star2:gold"],
  "3Triangles": ["triDown:red", "dash:yellow", "triUp:green"],
  "4Arrows": ["arrowDown:red", "arrowDownRight:yellow", "arrowUpRight:yellow", "arrowUp:green"],
  "4ArrowsGray": ["arrowDown:gray", "arrowDownRight:gray", "arrowUpRight:gray", "arrowUp:gray"],
  "4RedToBlack": ["dot:black", "dot:gray", "dot:pink", "dot:red"],
  "4Rating": ["bars1:blue", "bars2:blue", "bars3:blue", "bars4:blue"],
  "4TrafficLights": ["dot:black", "dot:red", "dot:yellow", "dot:green"],
  "5Arrows": ["arrowDown:red", "arrowDownRight:yellow", "arrowSide:yellow", "arrowUpRight:yellow", "arrowUp:green"],
  "5ArrowsGray": ["arrowDown:gray", "arrowDownRight:gray", "arrowSide:gray", "arrowUpRight:gray", "arrowUp:gray"],
  "5Rating": ["bars0:blue", "bars1:blue", "bars2:blue", "bars3:blue", "bars4:blue"],
  "5Quarters": ["pie0:black", "pie1:black", "pie2:black", "pie3:black", "pie4:black"],
  "5Boxes": ["boxes0:blue", "boxes1:blue", "boxes2:blue", "boxes3:blue", "boxes4:blue"],
});
/** Excel's default thresholds (type percent) for an n-icon set. */
export const DEFAULT_ICON_PERCENTS: Record<number, number[]> = { 3: [0, 33, 67], 4: [0, 25, 50, 75], 5: [0, 20, 40, 60, 80] };
/** Sets the 2007 main schema can carry (the others exist only in the x14 extension). */
export const MAIN_ICON_SETS = Object.keys(ICON_SETS).filter((k) => !["3Stars", "3Triangles", "5Boxes"].includes(k));

const COLOR: Record<string, string> = { red: "#e5484d", yellow: "#f5b301", green: "#2fa84f", gray: "#7d8590", black: "#1f2328", pink: "#f4a3a6", gold: "#f2b705", blue: "#2f6fdc" };
const NAMES: Record<string, string> = {
  arrowUp: "up arrow", arrowDown: "down arrow", arrowSide: "sideways arrow", arrowUpRight: "up-right arrow", arrowDownRight: "down-right arrow",
  flag: "flag", dot: "circle", light: "traffic light", diamond: "diamond", triangle: "triangle", xCircle: "cross in circle", bangCircle: "exclamation in circle",
  checkCircle: "check in circle", x: "cross", bang: "exclamation", check: "check", triDown: "down triangle", triUp: "up triangle", dash: "dash",
};

/** Accessible name, e.g. "green up arrow", "3 of 4 bars". */
export function iconLabel(g: IconGlyph): string {
  const [shape, color] = g.split(":");
  const m = /^(bars|pie|boxes|star)(\d)$/.exec(shape);
  if (m) return m[1] === "bars" ? `${m[2]} bars` : m[1] === "pie" ? `${Number(m[2]) * 25}% filled circle` : m[1] === "boxes" ? `${m[2]} of 4 boxes` : ["empty", "half", "full"][Number(m[2])] + " star";
  return `${color} ${NAMES[shape] ?? shape}`;
}

/** Original SVG for one glyph (16×16 viewBox). */
export function iconSvg(g: IconGlyph): string {
  const [shape, cname] = g.split(":"); const c = COLOR[cname] ?? "#888";
  const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>`;
  const arrow = (rot: number) => wrap(`<g transform="rotate(${rot} 8 8)"><path d="M8 1.5 14 8h-3.6v6.5H5.6V8H2z" fill="${c}"/></g>`);
  const m = /^(bars|pie|boxes|star)(\d)$/.exec(shape);
  if (m) {
    const k = Number(m[2]);
    if (m[1] === "bars") return wrap([0, 1, 2, 3].map((i) => `<rect x="${1.5 + i * 3.5}" y="${11 - i * 3}" width="2.6" height="${3.5 + i * 3}" rx=".5" fill="${i < k ? c : "#c9d1d9"}"/>`).join(""));
    if (m[1] === "boxes") return wrap([[1.5, 1.5], [8.5, 1.5], [1.5, 8.5], [8.5, 8.5]].map(([x, y], i) => `<rect x="${x}" y="${y}" width="6" height="6" rx="1" fill="${i < k ? c : "#c9d1d9"}"/>`).join(""));
    if (m[1] === "pie") {
      const ring = `<circle cx="8" cy="8" r="6.3" fill="#fff" stroke="${c}" stroke-width="1.4"/>`;
      if (k === 0) return wrap(ring);
      if (k === 4) return wrap(`<circle cx="8" cy="8" r="7" fill="${c}"/>`);
      const a = (k / 4) * 2 * Math.PI, x = 8 + 6.3 * Math.sin(a), y = 8 - 6.3 * Math.cos(a);
      return wrap(`${ring}<path d="M8 8V1.7A6.3 6.3 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}z" fill="${c}"/>`.replace("0 0 1", k > 2 ? "0 1 1" : "0 0 1"));
    }
    const star = "M8 1.2l2 4.3 4.7.6-3.4 3.2.9 4.6L8 11.6l-4.2 2.3.9-4.6L1.3 6.1 6 5.5z";
    if (k === 0) return wrap(`<path d="${star}" fill="#fff" stroke="${c}" stroke-width="1.1"/>`);
    if (k === 2) return wrap(`<path d="${star}" fill="${c}"/>`);
    return wrap(`<defs><clipPath id="h"><rect width="8" height="16"/></clipPath></defs><path d="${star}" fill="#fff" stroke="${c}" stroke-width="1.1"/><path d="${star}" fill="${c}" clip-path="url(#h)"/>`);
  }
  switch (shape) {
    case "arrowUp": return arrow(0);
    case "arrowUpRight": return arrow(45);
    case "arrowSide": return arrow(90);
    case "arrowDownRight": return arrow(135);
    case "arrowDown": return arrow(180);
    case "dot": return wrap(`<circle cx="8" cy="8" r="6.5" fill="${c}"/>`);
    case "light": return wrap(`<circle cx="8" cy="8" r="7" fill="#1f2328"/><circle cx="8" cy="8" r="5" fill="${c}"/>`);
    case "flag": return wrap(`<path d="M3 1.5v13" stroke="#57606a" stroke-width="1.6"/><path d="M3.8 2h9.5l-2.6 3.3 2.6 3.3H3.8z" fill="${c}"/>`);
    case "diamond": return wrap(`<path d="M8 1 15 8 8 15 1 8z" fill="${c}"/>`);
    case "triangle": return wrap(`<path d="M8 1.5 15 14.5H1z" fill="${c}"/>`);
    case "triUp": return wrap(`<path d="M8 3 14 12H2z" fill="${c}"/>`);
    case "triDown": return wrap(`<path d="M8 13 2 4h12z" fill="${c}"/>`);
    case "dash": return wrap(`<rect x="2.5" y="6.5" width="11" height="3" rx="1" fill="${c}"/>`);
    case "xCircle": return wrap(`<circle cx="8" cy="8" r="7" fill="${c}"/><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`);
    case "bangCircle": return wrap(`<circle cx="8" cy="8" r="7" fill="${c}"/><path d="M8 4v5" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/><circle cx="8" cy="11.7" r="1.1" fill="#fff"/>`);
    case "checkCircle": return wrap(`<circle cx="8" cy="8" r="7" fill="${c}"/><path d="M4.6 8.3l2.3 2.3 4.6-4.9" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    case "x": return wrap(`<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`);
    case "bang": return wrap(`<path d="M8 2v8" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/><circle cx="8" cy="13.3" r="1.6" fill="${c}"/>`);
    case "check": return wrap(`<path d="M2.5 8.5l3.8 3.8 7.2-8" stroke="${c}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    default: return wrap(`<rect x="3" y="3" width="10" height="10" fill="${c}"/>`);
  }
}
export const iconDataUri = (g: IconGlyph) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(g))}`;
