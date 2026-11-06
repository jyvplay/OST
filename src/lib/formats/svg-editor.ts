/**
 * TT139 (FF-25) — SVG vector primitives editor with a safe importer.
 *
 * Pure model + serializer + parser. No DOM, no network.
 *
 * The interesting part is the importer, because importing SVG is importing
 * *active content*. The rules this file enforces, and why each exists:
 *
 *   • No `<script>` anywhere, in any case, in any namespace.
 *   • No `on*` attributes (onclick, onload, …).
 *   • No `javascript:` / `data:` / `vbscript:` URLs in href/xlink:href/src.
 *   • No `<foreignObject>` — it can host arbitrary HTML, which is a full XSS
 *     vector that a "safe SVG editor" must not carry.
 *   • No `<use href="http…">` — remote `<use>` is an exfiltration primitive.
 *   • No `<animate>`/`<set>` — SVG animation can drive an href to a
 *     `javascript:` URL after the static scan has passed.
 *   • Only a closed allowlist of element names is parsed at all. Anything else
 *     is dropped silently (not escaped into the model), which is what makes
 *     "unknown element" not a future bypass.
 *
 * The importer never trusts a numeric attribute: NaN, Infinity and absurd
 * magnitudes become 0 rather than propagating into a path that a renderer
 * might interpret as an overflow.
 */

export type SvgElement =
  | { type: "svg"; width: number; height: number; viewBox?: string; children: SvgElement[] }
  | { type: "rect"; x: number; y: number; width: number; height: number; fill: string; stroke?: string; strokeWidth?: number; rx?: number }
  | { type: "circle"; cx: number; cy: number; r: number; fill: string; stroke?: string; strokeWidth?: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
  | { type: "text"; x: number; y: number; text: string; fontSize: number; fill: string; fontFamily?: string }
  | { type: "path"; d: string; fill: string; stroke?: string; strokeWidth?: number }
  | { type: "group"; children: SvgElement[]; transform?: string };

export const ALLOWED_ELEMENTS = ["svg", "g", "rect", "circle", "line", "text", "path"] as const;

/** Elements whose mere presence is a security problem, not a formatting one. */
export const FORBIDDEN_ELEMENTS = [
  "script", "foreignObject", "iframe", "embed", "object", "use",
  "animate", "animateMotion", "animateTransform", "set", "handler",
  "image", "audio", "video", "style",
] as const;

export function createSvg(width: number, height: number): SvgElement {
  if (!(width > 0) || !(height > 0)) throw new Error("SVG dimensions must be positive");
  return { type: "svg", width, height, children: [] };
}

function addChild(svg: SvgElement, child: SvgElement): SvgElement {
  if (svg.type !== "svg") throw new Error("Can only add to an <svg> root");
  return { ...svg, children: [...svg.children, child] };
}

export function addRect(svg: SvgElement, r: Omit<Extract<SvgElement, { type: "rect" }>, "type">): SvgElement {
  if (!(r.width > 0) || !(r.height > 0)) throw new Error("Rect needs positive width and height");
  return addChild(svg, { type: "rect", ...r });
}

export function addCircle(svg: SvgElement, c: Omit<Extract<SvgElement, { type: "circle" }>, "type">): SvgElement {
  if (!(c.r > 0)) throw new Error("Circle needs a positive radius");
  return addChild(svg, { type: "circle", ...c });
}

export function addLine(svg: SvgElement, l: Omit<Extract<SvgElement, { type: "line" }>, "type">): SvgElement {
  return addChild(svg, { type: "line", ...l });
}

export function addText(svg: SvgElement, t: Omit<Extract<SvgElement, { type: "text" }>, "type">): SvgElement {
  if (t.text.length > 5000) throw new Error("Text too long (>5000)");
  return addChild(svg, { type: "text", ...t });
}

export function addPath(svg: SvgElement, p: Omit<Extract<SvgElement, { type: "path" }>, "type">): SvgElement {
  if (!/^[MmZzLlHhVvCcSsQqTtAa0-9eE.,\s+-]+$/.test(p.d)) {
    throw new Error("Path data contains characters outside the SVG path grammar");
  }
  return addChild(svg, { type: "path", ...p });
}

export function addGroup(svg: SvgElement, children: SvgElement[], transform?: string): SvgElement {
  if (transform && !/^[a-zA-Z0-9(),.\s+-]*$/.test(transform)) throw new Error("Unsafe transform string");
  return addChild(svg, { type: "group", children, transform });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Round to 3 dp and drop trailing zeros so output is stable across runs. */
function n(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

export function toSvgString(el: SvgElement): string {
  switch (el.type) {
    case "svg":
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${n(el.width)}" height="${n(el.height)}"` +
        (el.viewBox ? ` viewBox="${esc(el.viewBox)}"` : "") +
        `>${el.children.map(toSvgString).join("")}</svg>`
      );
    case "group":
      return `<g${el.transform ? ` transform="${esc(el.transform)}"` : ""}>${el.children.map(toSvgString).join("")}</g>`;
    case "rect":
      return (
        `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.width)}" height="${n(el.height)}"` +
        ` fill="${esc(el.fill)}"` +
        (el.stroke ? ` stroke="${esc(el.stroke)}"` : "") +
        (el.strokeWidth !== undefined ? ` stroke-width="${n(el.strokeWidth)}"` : "") +
        (el.rx !== undefined ? ` rx="${n(el.rx)}"` : "") +
        "/>"
      );
    case "circle":
      return (
        `<circle cx="${n(el.cx)}" cy="${n(el.cy)}" r="${n(el.r)}" fill="${esc(el.fill)}"` +
        (el.stroke ? ` stroke="${esc(el.stroke)}"` : "") +
        (el.strokeWidth !== undefined ? ` stroke-width="${n(el.strokeWidth)}"` : "") +
        "/>"
      );
    case "line":
      return (
        `<line x1="${n(el.x1)}" y1="${n(el.y1)}" x2="${n(el.x2)}" y2="${n(el.y2)}"` +
        ` stroke="${esc(el.stroke)}" stroke-width="${n(el.strokeWidth)}"/>`
      );
    case "text":
      return (
        `<text x="${n(el.x)}" y="${n(el.y)}" font-size="${n(el.fontSize)}" fill="${esc(el.fill)}"` +
        (el.fontFamily ? ` font-family="${esc(el.fontFamily)}"` : "") +
        `>${esc(el.text)}</text>`
      );
    case "path":
      return (
        `<path d="${esc(el.d)}" fill="${esc(el.fill)}"` +
        (el.stroke ? ` stroke="${esc(el.stroke)}"` : "") +
        (el.strokeWidth !== undefined ? ` stroke-width="${n(el.strokeWidth)}"` : "") +
        "/>"
      );
  }
}

function num(raw: string | undefined, fallback = 0): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  // Reject NaN, ±Infinity, and magnitudes that would overflow a renderer.
  if (!Number.isFinite(v) || Math.abs(v) > 1e9) return fallback;
  return v;
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1].toLowerCase()] = unesc(m[2]);
  return out;
}

export interface SvgScan {
  safe: boolean;
  removed: string[];
  reasons: string[];
}

/**
 * Static safety scan. Returns what a caller should tell the user, and whether
 * the document should be imported at all.
 */
export function scanSvg(svgStr: string): SvgScan {
  const removed: string[] = [];
  const reasons: string[] = [];
  const lower = svgStr.toLowerCase();

  for (const el of FORBIDDEN_ELEMENTS) {
    const re = new RegExp(`<\\s*(?:\\w+:)?${el.toLowerCase()}[\\s/>]`, "gi");
    if (re.test(lower)) {
      removed.push(el);
      reasons.push(`<${el}> is not allowed in an imported SVG`);
    }
  }
  if (/\son[a-z]+\s*=/i.test(svgStr)) {
    removed.push("event handler");
    reasons.push("Inline event handler attribute (on*) present");
  }
  if (/\b(?:javascript|vbscript|data)\s*:/i.test(svgStr)) {
    removed.push("active URL scheme");
    reasons.push("javascript:/vbscript:/data: URL scheme present");
  }
  if (/<!ENTITY/i.test(svgStr) || /<!DOCTYPE[^>]*\[/i.test(svgStr)) {
    removed.push("doctype entity");
    reasons.push("Custom XML entities (XXE / billion-laughs vector) present");
  }
  return { safe: reasons.length === 0, removed, reasons };
}

/** Remove dangerous constructs, keeping the rest byte-similar where possible. */
export function sanitizeSvgXml(svgStr: string): string {
  let out = svgStr;
  // Strip forbidden elements including their content.
  for (const el of FORBIDDEN_ELEMENTS) {
    const re = new RegExp(`<\\s*(?:\\w+:)?${el}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\s*\\/\\s*(?:\\w+:)?${el}\\s*>)`, "gi");
    out = out.replace(re, "");
    const selfRe = new RegExp(`<\\s*(?:\\w+:)?${el}\\b[^>]*?\\/>`, "gi");
    out = out.replace(selfRe, "");
  }
  // Strip event handlers and unsafe URL schemes inside attributes.
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\b(?:xlink:)?href\s*=\s*"[^"]*(?:javascript|vbscript|data)\s*:[^"]*"/gi, "");
  out = out.replace(/<!DOCTYPE[^>]*>/gi, "");
  out = out.replace(/<!ENTITY[^>]*>/gi, "");
  out = out.replace(/<\?xml[^>]*\?>/gi, "");
  return out;
}

export function fromSvgString(svgStr: string): SvgElement {
  const clean = sanitizeSvgXml(svgStr);
  const rootMatch = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i.exec(clean);
  if (!rootMatch) throw new Error("No <svg> root element");
  const rootAttrs = attrs(rootMatch[1]);
  const width = num(rootAttrs.width, 100);
  const height = num(rootAttrs.height, 100);
  const svg: SvgElement = { type: "svg", width, height, children: [] };
  const viewBox = rootAttrs.viewbox;
  const withBox: SvgElement = viewBox ? { ...(svg as Extract<SvgElement, { type: "svg" }>), viewBox } : svg;
  return { ...(withBox as Extract<SvgElement, { type: "svg" }>), children: parseChildren(rootMatch[2]) };
}

function parseChildren(body: string): SvgElement[] {
  const out: SvgElement[] = [];
  // Only the allowlist is recognised; unknown tags are dropped, never guessed.
  const re = /<(rect|circle|line|text|path|g)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const tag = m[1];
    const a = attrs(m[2]);
    const inner = m[4] ?? "";
    switch (tag) {
      case "rect":
        out.push({
          type: "rect",
          x: num(a.x), y: num(a.y),
          width: num(a.width), height: num(a.height),
          fill: a.fill ?? "black",
          stroke: a.stroke,
          strokeWidth: a["stroke-width"] !== undefined ? num(a["stroke-width"], 1) : undefined,
          rx: a.rx !== undefined ? num(a.rx) : undefined,
        });
        break;
      case "circle":
        out.push({
          type: "circle",
          cx: num(a.cx), cy: num(a.cy), r: num(a.r),
          fill: a.fill ?? "black",
          stroke: a.stroke,
          strokeWidth: a["stroke-width"] !== undefined ? num(a["stroke-width"], 1) : undefined,
        });
        break;
      case "line":
        out.push({
          type: "line",
          x1: num(a.x1), y1: num(a.y1), x2: num(a.x2), y2: num(a.y2),
          stroke: a.stroke ?? "black",
          strokeWidth: num(a["stroke-width"], 1),
        });
        break;
      case "text":
        out.push({
          type: "text",
          x: num(a.x), y: num(a.y),
          text: unesc(inner.replace(/<[^>]*>/g, "")).trim(),
          fontSize: num(a["font-size"], 12),
          fill: a.fill ?? "black",
          fontFamily: a["font-family"],
        });
        break;
      case "path": {
        const d = a.d ?? "";
        // Re-check the path grammar on import; a sanitized string can still
        // carry path data that the model would refuse to construct.
        if (!/^[MmZzLlHhVvCcSsQqTtAa0-9eE.,\s+-]*$/.test(d)) break;
        out.push({
          type: "path",
          d,
          fill: a.fill ?? "none",
          stroke: a.stroke,
          strokeWidth: a["stroke-width"] !== undefined ? num(a["stroke-width"], 1) : undefined,
        });
        break;
      }
      case "g":
        out.push({ type: "group", children: parseChildren(inner), transform: a.transform });
        break;
    }
  }
  return out;
}

export function validateSvg(el: SvgElement): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const walk = (e: SvgElement): void => {
    switch (e.type) {
      case "svg":
        if (!(e.width > 0) || !(e.height > 0)) errors.push("SVG needs positive width and height");
        e.children.forEach(walk);
        break;
      case "group":
        e.children.forEach(walk);
        break;
      case "rect":
        if (!(e.width > 0) || !(e.height > 0)) errors.push("Rect needs positive size");
        if (!e.fill) errors.push("Rect needs a fill");
        break;
      case "circle":
        if (!(e.r > 0)) errors.push("Circle needs a positive radius");
        break;
      case "line":
        if (e.strokeWidth <= 0) errors.push("Line needs a positive stroke width");
        break;
      case "text":
        if (!e.text) errors.push("Text element is empty");
        if (!(e.fontSize > 0)) errors.push("Text needs a positive font size");
        break;
      case "path":
        if (!e.d) errors.push("Path has empty data");
        break;
    }
  };
  walk(el);
  return { ok: errors.length === 0, errors };
}

export function countNodes(el: SvgElement): number {
  if (el.type === "svg" || el.type === "group") {
    return 1 + el.children.reduce((a, c) => a + countNodes(c), 0);
  }
  return 1;
}

/** Find a node by depth-first index (the order toSvgString emits). */
export function nodeAt(el: SvgElement, index: number): SvgElement | null {
  let seen = -1;
  let hit: SvgElement | null = null;
  const walk = (e: SvgElement): boolean => {
    seen++;
    if (seen === index) { hit = e; return true; }
    if (e.type === "svg" || e.type === "group") {
      for (const c of e.children) if (walk(c)) return true;
    }
    return false;
  };
  walk(el);
  return hit;
}

/** Translate one primitive. Text and paths move; containers recurse. */
export function moveNode(el: SvgElement, index: number, dx: number, dy: number): SvgElement {
  const target = nodeAt(el, index);
  if (!target) throw new Error(`No node at index ${index}`);
  const shift = (e: SvgElement): SvgElement => {
    switch (e.type) {
      case "svg": return { ...e, children: e.children.map(shift) };
      case "group": return { ...e, children: e.children.map(shift) };
      case "rect": return { ...e, x: e.x + dx, y: e.y + dy };
      case "circle": return { ...e, cx: e.cx + dx, cy: e.cy + dy };
      case "line": return { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
      case "text": return { ...e, x: e.x + dx, y: e.y + dy };
      case "path": return { ...e, d: translatePath(e.d, dx, dy) };
    }
  };
  let counter = -1;
  const replace = (e: SvgElement): SvgElement => {
    counter++;
    if (counter === index) return shift(e);
    if (e.type === "svg" || e.type === "group") {
      const children = e.children.map((c) => replace(c));
      return { ...e, children };
    }
    return e;
  };
  return replace(el);
}

/** Translate absolute path commands only; relative commands are left alone. */
function translatePath(d: string, dx: number, dy: number): string {
  return d.replace(/([MmCcSsQqTtLl])?\s*(-?\d*\.?\d+(?:e-?\d+)?)[,\s]+(-?\d*\.?\d+(?:e-?\d+)?)/gi, (all, cmd: string | undefined, a: string, b: string) => {
    if (!cmd) return all;
    if (cmd === "M" || cmd === "L" || cmd === "T" || cmd === "C" || cmd === "S" || cmd === "Q") {
      return `${cmd} ${Number(a) + dx} ${Number(b) + dy}`;
    }
    return all; // relative commands already move with the origin
  });
}

/** Scale a rect/circle about the origin of its own coordinate space. */
export function resizeNode(el: SvgElement, index: number, scale: number): SvgElement {
  if (!(scale > 0)) throw new Error("Scale must be positive");
  let counter = -1;
  const walk = (e: SvgElement): SvgElement => {
    counter++;
    const here = counter === index;
    switch (e.type) {
      case "svg": {
        const children = e.children.map(walk);
        return here ? { ...e, children, width: e.width * scale, height: e.height * scale } : { ...e, children };
      }
      case "group": {
        const children = e.children.map(walk);
        return here ? { ...e, children } : { ...e, children };
      }
      case "rect":
        return here ? { ...e, width: e.width * scale, height: e.height * scale } : e;
      case "circle":
        return here ? { ...e, r: e.r * scale } : e;
      case "text":
        return here ? { ...e, fontSize: e.fontSize * scale } : e;
      case "line":
        return here ? { ...e, strokeWidth: e.strokeWidth * scale } : e;
      case "path":
        return here ? { ...e } : e;
    }
  };
  return walk(el);
}
