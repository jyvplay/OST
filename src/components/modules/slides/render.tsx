"use client";
/**
 * TT51 — draws a resolved slide view (src/lib/office/pmlview.ts) with HTML/CSS/SVG. Original code.
 * Fills are CSS backgrounds clipped by the shape's geometry path (solid, gradient and picture fills share one code
 * path); outlines are SVG strokes with arrow-head markers; text is HTML laid out from the resolved paragraph/run
 * properties (points → pixels at the current zoom); pictures honour srcRect crops; charts are drawn lazily by the
 * TT50 chart engine from the caches stored in the chart part (no workbook needed).
 */
import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Fill, VLine, VPara, VShape, VSlide, VText } from "@/lib/office/pmlview";
import type { PptxDoc } from "@/lib/office/pml";
/** placeholder label in slide coordinates — scaled with the slide itself, like the slide text (document space, not UI) */
const PLACEHOLDER_PX = 11;

/* ---------------- picture URLs (one blob URL per part's bytes) ---------------- */
const urls = new WeakMap<Uint8Array, string>();
export function partUrl(doc: PptxDoc, part: string, mime: string): string | undefined {
  const b = doc.zip.get(part); if (!b) return undefined;
  let u = urls.get(b); if (!u) { u = URL.createObjectURL(new Blob([b as Uint8Array<ArrayBuffer>], { type: mime })); urls.set(b, u); }
  return u;
}

const fillCss = (doc: PptxDoc, f: Fill): CSSProperties | null => {
  if (f.kind === "solid") return { background: f.color };
  if (f.kind === "grad") return { background: f.css };
  if (f.kind === "img") { const u = partUrl(doc, f.part, f.mime); return u ? { backgroundImage: `url("${u}")`, backgroundSize: "100% 100%" } : null; }
  return null;
};
const DASH: Record<string, (w: number) => string> = {
  dash: (w) => `${4 * w} ${3 * w}`, sysDash: (w) => `${3 * w} ${w}`, dot: (w) => `${w} ${w}`, sysDot: (w) => `${w} ${w}`, lgDash: (w) => `${8 * w} ${3 * w}`,
  dashDot: (w) => `${4 * w} ${3 * w} ${w} ${3 * w}`, lgDashDot: (w) => `${8 * w} ${3 * w} ${w} ${3 * w}`, lgDashDotDot: (w) => `${8 * w} ${3 * w} ${w} ${3 * w} ${w} ${3 * w}`, sysDashDot: (w) => `${3 * w} ${w} ${w} ${w}`,
};
/** Wingdings / Symbol bullet characters → the Unicode glyph they draw */
const WING: Record<string, string> = { "§": "■", "Ø": "➢", "ü": "✓", "q": "❑", "v": "❖", "n": "■", "l": "●", "Ÿ": "•", "è": "➔", "à": "→", "Ö": "▶", "o": "□", "w": "◆", "u": "◆", "p": "□", "": "■", "": "➢", "": "✓", "": "❑", "": "❖", "": "●", "": "•" };
const bulletGlyph = (t: string, font?: string) => (font && /wingdings|symbol/i.test(font)) || /[\uf000-\uf0ff]/.test(t) ? (WING[t] ?? "•") : t;
const cssFamily = (f: string) => `"${f.replace(/"/g, "")}", Calibri, Carlito, "Segoe UI", Arial, sans-serif`;

export function TextBody({ t, s, editingHidden }: { t: VText; s: number; editingHidden?: boolean }) {
  const pt = 12700 * s; // px per point
  const vertical = t.vert === "vert" || t.vert === "eaVert" || t.vert === "vert270" || t.vert === "wordArtVert";
  const box: CSSProperties = {
    position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: t.anchor === "ctr" ? "center" : t.anchor === "b" ? "flex-end" : "flex-start",
    padding: `${t.ins[1] * s}px ${t.ins[2] * s}px ${t.ins[3] * s}px ${t.ins[0] * s}px`, whiteSpace: t.wrap ? "pre-wrap" : "pre", overflowWrap: "break-word", lineHeight: 1.2,
    writingMode: vertical ? (t.vert === "vert270" ? "sideways-lr" : "vertical-rl") as CSSProperties["writingMode"] : undefined, visibility: editingHidden ? "hidden" : undefined, alignItems: t.anchorCtr ? "center" : undefined,
  };
  return <div style={box}>{t.paras.map((p, i) => <Para key={i} p={p} pt={pt} s={s} />)}</div>;
}
function Para({ p, pt, s }: { p: VPara; pt: number; s: number }) {
  const first = p.runs.find((r) => r.kind !== "br" && r.text) ?? p.runs[0]; const base = (first?.sz ?? p.endSz) * pt;
  const st: CSSProperties = {
    textAlign: p.algn === "ctr" ? "center" : p.algn === "r" ? "right" : p.algn === "just" || p.algn === "dist" ? "justify" : "left",
    marginLeft: p.marL * s, textIndent: p.indent * s, lineHeight: p.lnPts ? `${p.lnPts * pt}px` : p.lnPct ? 1.2 * p.lnPct : undefined,
    marginTop: p.spcBefPct ? p.spcBefPct * base : p.spcBef * pt, marginBottom: p.spcAft * pt, minHeight: !p.runs.length ? p.endSz * pt * 1.2 : undefined,
  };
  const bullet = p.bullet ? (
    <span aria-hidden style={{ display: "inline-block", minWidth: p.indent < 0 ? -p.indent * s : undefined, textIndent: 0, fontSize: base * p.bullet.sizePct, color: p.bullet.color ?? first?.color, fontFamily: p.bullet.font && !/wingdings|symbol/i.test(p.bullet.font) ? cssFamily(p.bullet.font) : undefined }}>{bulletGlyph(p.bullet.text, p.bullet.font)}</span>
  ) : null;
  return (
    <div style={st}>
      {bullet}
      {p.runs.map((r, k) => r.kind === "br" ? <br key={k} /> : (
        <span key={k} style={{
          fontSize: r.sz * pt * (r.baseline ? 0.7 : 1), fontWeight: r.b ? 700 : 400, fontStyle: r.i ? "italic" : undefined, color: r.color, fontFamily: cssFamily(r.font),
          textDecoration: [r.u || r.link ? "underline" : "", r.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined, verticalAlign: r.baseline > 0 ? "super" : r.baseline < 0 ? "sub" : undefined,
          textTransform: r.caps ? "uppercase" : undefined, background: r.highlight,
        }}>{r.text}</span>
      ))}
      {!p.runs.length || p.runs.every((r) => !r.text) ? <span style={{ fontSize: p.endSz * pt }}>{"\u200b"}</span> : null}
    </div>
  );
}

function Stroke({ d, w, h, line, s, id }: { d: string; w: number; h: number; line: VLine; s: number; id: string }) {
  const sw = Math.max(0.6, line.width * s);
  const marker = (type: string | undefined, which: string) => !type || type === "none" ? null : (
    <marker id={`${id}-${which}`} viewBox="0 0 10 10" refX={which === "h" ? 1 : 9} refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
      {type === "oval" ? <circle cx="5" cy="5" r="4" fill={line.color} /> : type === "diamond" ? <path d="M5 0 L10 5 L5 10 L0 5 Z" fill={line.color} /> : <path d="M0 0 L10 5 L0 10 Z" fill={line.color} />}
    </marker>
  );
  return (
    <svg width={w} height={h} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }} aria-hidden>
      <defs>{marker(line.head, "h")}{marker(line.tail, "t")}</defs>
      <path d={d} fill="none" stroke={line.color} strokeWidth={sw} strokeDasharray={line.dash && DASH[line.dash] ? DASH[line.dash](sw) : undefined} strokeLinejoin="round"
        markerStart={line.head && line.head !== "none" ? `url(#${id}-h)` : undefined} markerEnd={line.tail && line.tail !== "none" ? `url(#${id}-t)` : undefined} />
    </svg>
  );
}

const LIGHT: [RegExp, string][] = [[/fill="#0f172a"/g, 'fill="none"'], [/#e2e8f0/g, "#1f2937"], [/#cbd5e1/g, "#374151"], [/#94a3b8/g, "#4b5563"], [/#1e293b/g, "#e5e7eb"], [/#64748b/g, "#6b7280"]];
/** charts are laid out at HALF their natural size (EMU / 19050 px: the chart engine's ~11 px labels then read like
 *  PowerPoint's 18 pt default chart text) and scaled with the slide, so thumbnails
 *  and the slide show look like the editor instead of re-flowing labels at every zoom */
function ChartBox({ doc, part, w, h }: { doc: PptxDoc; part: string; w: number; h: number }) {
  const [svg, setSvg] = useState<string | null>(null); const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [{ parseChartXml }, { buildChartSvg }] = await Promise.all([import("@/lib/formula/chartxml"), import("@/lib/formula/sheetmeta")]);
        const bytes = doc.zip.get(part); if (!bytes) throw new Error("chart part missing");
        const spec = parseChartXml(new TextDecoder().decode(bytes), { id: part, sheet: "", src: part }); if (!spec || !spec.series?.length) throw new Error("chart type not drawable");
        const cats = spec.series[0].catCache ?? (spec.series[0].valCache ?? []).map((_, i) => String(i + 1));
        const data = { categories: cats, series: spec.series.map((x, i) => ({ name: x.name ?? `Series ${i + 1}`, values: x.valCache ?? [], color: x.color, trend: x.trend })) };
        let out = buildChartSvg(spec.kind, spec.title, data, Math.max(120, Math.round(w)), Math.max(80, Math.round(h)), { grouping: spec.grouping, catTitle: spec.catTitle, valTitle: spec.valTitle, legend: spec.legend, blanks: spec.blanks });
        for (const [re, to] of LIGHT) out = out.replace(re, to);
        out = out.replace(/^<svg([^>]*?) width="[\d.]+" height="[\d.]+"/, '<svg$1 width="100%" height="100%" preserveAspectRatio="none"');
        if (live) setSvg(out);
      } catch (e) { if (live) setErr((e as Error).message); }
    })();
    return () => { live = false; };
  }, [doc, part, w, h]);
  if (err) return <Placeholder label={`Chart (kept) — ${err}`} />;
  return svg ? <div style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: svg }} /> : null;
}
function Placeholder({ label }: { label: string }) {
  return <div style={{ position: "absolute", inset: 0, border: "1px dashed rgba(100,116,139,.8)", background: "repeating-linear-gradient(45deg, rgba(148,163,184,.12) 0 8px, transparent 8px 16px)", display: "grid", placeItems: "center", color: "#475569", fontSize: PLACEHOLDER_PX, fontFamily: "system-ui, sans-serif", textAlign: "center", padding: 4, overflow: "hidden" }}>{label}</div>;
}

function TableBox({ t, s }: { t: NonNullable<VShape["table"]>; s: number }) {
  const bd = (l?: VLine) => (l ? `${Math.max(0.6, l.width * s)}px solid ${l.color}` : undefined);
  return (
    <table style={{ position: "absolute", left: 0, top: 0, borderCollapse: "collapse", tableLayout: "fixed", width: t.cols.reduce((a, b) => a + b, 0) * s }}>
      <colgroup>{t.cols.map((c, i) => <col key={i} style={{ width: c * s }} />)}</colgroup>
      <tbody>{t.rows.map((r, ri) => (
        <tr key={ri} style={{ height: r.h * s }}>{r.cells.map((c, ci) => c.merged ? null : (
          <td key={ci} data-cell={`${ri},${ci}`} colSpan={c.span > 1 ? c.span : undefined} rowSpan={c.rowSpan > 1 ? c.rowSpan : undefined}
            style={{ ...(c.fill.kind === "solid" ? { background: c.fill.color } : c.fill.kind === "grad" ? { background: c.fill.css } : {}), borderLeft: bd(c.borders.l), borderRight: bd(c.borders.r), borderTop: bd(c.borders.t), borderBottom: bd(c.borders.b), position: "relative", padding: 0, verticalAlign: "top" }}>
            {c.text ? <div style={{ position: "relative", minHeight: r.h * s }}><TextBody t={c.text} s={s} /></div> : null}
          </td>
        ))}</tr>
      ))}</tbody>
    </table>
  );
}

function ShapeBox({ doc, v, s, uid, hideText }: { doc: PptxDoc; v: VShape; s: number; uid: string; hideText?: string | null }) {
  if (v.hidden) return null;
  const w = v.w * s, h = v.h * s;
  const wrap: CSSProperties = { position: "absolute", left: v.x * s, top: v.y * s, width: w, height: h, transform: [v.rot ? `rotate(${v.rot}deg)` : "", v.flipH ? "scaleX(-1)" : "", v.flipV ? "scaleY(-1)" : ""].filter(Boolean).join(" ") || undefined, pointerEvents: v.layer === "slide" ? undefined : "none" };
  const top = v.addr.split(/[/~]/)[0];
  let inner: ReactNode = null;
  if (v.kind === "group") return <>{v.children?.map((c, i) => <ShapeBox key={i} doc={doc} v={c} s={s} uid={`${uid}g${i}`} hideText={hideText} />)}</>;
  const d = v.geom ? v.geom.d(w, h) : `M0 0 H${w} V${h} H0 Z`;
  const fc = fillCss(doc, v.fill);
  const fillLayer = fc && !(v.geom?.open) ? <div style={{ position: "absolute", inset: 0, ...fc, clipPath: v.geom && v.geom.name !== "rect" ? `path("${d}")` : undefined }} /> : null;
  if (v.kind === "pic" || (v.kind === "graphic" && v.img)) {
    const im = v.img!; const url = im.part && !im.unsupported ? partUrl(doc, im.part, im.mime) : undefined;
    if (!url) inner = <Placeholder label={im.unsupported ?? v.note ?? "picture"} />;
    else {
      const c = im.crop ?? { l: 0, t: 0, r: 0, b: 0 }; const iw = w / Math.max(0.01, 1 - c.l - c.r), ih = h / Math.max(0.01, 1 - c.t - c.b);
      // eslint-disable-next-line @next/next/no-img-element -- package bytes as a blob: URL; next/image cannot optimise those
      inner = <div style={{ position: "absolute", inset: 0, overflow: "hidden", clipPath: v.geom && v.geom.name !== "rect" ? `path("${d}")` : undefined }}><img alt={v.descr || v.name} src={url} draggable={false} style={{ position: "absolute", left: -c.l * iw, top: -c.t * ih, width: iw, height: ih, maxWidth: "none" }} /></div>;
    }
  } else if (v.kind === "table" && v.table) inner = <TableBox t={v.table} s={s} />;
  else if (v.kind === "chart") inner = v.chart ? <ChartBox doc={doc} part={v.chart.part} w={Math.max(160, v.w / 19050)} h={Math.max(110, v.h / 19050)} /> : <Placeholder label={v.note ?? "chart"} />;
  else if (v.kind === "graphic") inner = v.children?.length ? <>{v.children.map((c, i) => <ShapeBox key={i} doc={doc} v={{ ...c, x: c.x - v.x, y: c.y - v.y }} s={s} uid={`${uid}d${i}`} />)}</> : <Placeholder label={v.note ?? "object"} />;
  else if (v.kind === "other") inner = <Placeholder label={v.note ?? "object"} />;
  return (
    <div data-addr={v.layer === "slide" ? top : undefined} data-kind={v.kind} title={v.note} style={wrap}>
      {fillLayer}
      {inner}
      {v.layer === "slide" && (w < 8 || h < 8) ? <div aria-hidden style={{ position: "absolute", left: w < 8 ? -5 : 0, right: w < 8 ? -5 : 0, top: h < 8 ? -5 : 0, bottom: h < 8 ? -5 : 0 }} /> /* lines/connectors: a clickable band */ : null}
      {v.line && (v.kind === "sp" || v.kind === "cxn" || v.kind === "pic") ? <Stroke d={d} w={w} h={h} line={v.line} s={s} id={`${uid}`} /> : null}
      {v.text ? <div style={{ position: "absolute", inset: 0, transform: v.flipH || v.flipV ? `${v.flipH ? "scaleX(-1)" : ""} ${v.flipV ? "scaleY(-1)" : ""}` : undefined }}><TextBody t={v.text} s={s} editingHidden={hideText === top} /></div> : null}
    </div>
  );
}

/** a whole slide at `width` CSS pixels */
export const SlideCanvas = memo(function SlideCanvas({ doc, view, width, uid, hideText, children }: { doc: PptxDoc; view: VSlide; width: number; uid: string; hideText?: string | null; children?: ReactNode }) {
  const s = width / view.size.cx; const h = view.size.cy * s;
  const bg = fillCss(doc, view.bg) ?? { background: "#fff" };
  return (
    <div className="fs-slide" style={{ position: "relative", width, height: h, overflow: "hidden", ...bg, color: "#000", contain: "strict", userSelect: "none" }}>
      {view.shapes.map((v, i) => <ShapeBox key={`${v.addr}-${i}`} doc={doc} v={v} s={s} uid={`${uid}-${i}`} hideText={hideText} />)}
      {children}
    </div>
  );
});
