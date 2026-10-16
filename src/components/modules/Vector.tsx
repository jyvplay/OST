"use client";

import { useEffect, useMemo, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";

type Shape =
  | { id: string; kind: "rect"; x: number; y: number; w: number; h: number; fill: string; stroke: string }
  | { id: string; kind: "circle"; x: number; y: number; r: number; fill: string; stroke: string }
  | { id: string; kind: "line"; x: number; y: number; x2: number; y2: number; fill: string; stroke: string }
  | { id: string; kind: "text"; x: number; y: number; text: string; fill: string; stroke: string };
interface VectorDoc { title: string; width: number; height: number; shapes: Shape[] }
const blank = (): VectorDoc => ({ title: "Untitled vector", width: 800, height: 600, shapes: [
  { id: "s1", kind: "rect", x: 80, y: 80, w: 220, h: 150, fill: "#5b8cff", stroke: "#1e293b" },
  { id: "s2", kind: "circle", x: 430, y: 180, r: 90, fill: "#39d98a", stroke: "#1e293b" },
  { id: "s3", kind: "text", x: 90, y: 300, text: "Edit vector shapes", fill: "#f8fafc", stroke: "none" },
] });

/**
 * FF-04/09 vector editor: structured primitives (rect/circle/line/text), no
 * arbitrary DOM insertion. Import reads only an allowlist from SVG via DOMParser;
 * scripts, foreignObject, external hrefs, filters and unsupported path commands
 * are not carried through. Export is a new plain SVG file.
 */
export default function VectorModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [doc, setDoc] = useState<VectorDoc>(blank);
  const [selected, setSelected] = useState("s1");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const shape = doc.shapes.find((s) => s.id === selected) ?? null;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (path.toLowerCase().endsWith(".svg")) {
        try {
          const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
          const p = parseSvg(r.node.content, path);
          if (alive) { setDoc(p.doc); setSelected(p.doc.shapes[0]?.id ?? ""); setStatus(p.dropped.length ? `Imported subset; not retained: ${p.dropped.join(", ")}` : "Imported clean SVG"); }
        } catch (e) { if (alive) setStatus(`Import failed: ${(e as Error).message}`); }
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, [path]);

  const patchShape = (patch: Partial<Shape>) => {
    if (!shape) return;
    setDoc((d) => ({ ...d, shapes: d.shapes.map((s) => s.id === selected ? { ...s, ...patch } as Shape : s) }));
    setDirty(true);
  };
  const add = (kind: Shape["kind"]) => {
    const id = `s${Date.now()}`;
    const s: Shape = kind === "rect" ? { id, kind, x: 80, y: 80, w: 180, h: 100, fill: "#5b8cff", stroke: "#1e293b" }
      : kind === "circle" ? { id, kind, x: 180, y: 180, r: 70, fill: "#39d98a", stroke: "#1e293b" }
      : kind === "line" ? { id, kind, x: 40, y: 40, x2: 240, y2: 160, fill: "none", stroke: "#f8fafc" }
      : { id, kind, x: 80, y: 80, text: "Text", fill: "#f8fafc", stroke: "none" };
    setDoc((d) => ({ ...d, shapes: [...d.shapes, s] })); setSelected(id); setDirty(true);
  };
  const svgString = useMemo(() => serializeSvg(doc), [doc]);

  const saveNative = async () => {
    const dest = `/Documents/${slug(doc.title)}.fsvg`;
    await post("/api/fs", { op: "write", path: dest, content: JSON.stringify(doc), reason: "vector-save" });
    setDirty(false); setStatus(`saved native model → ${dest}`); shell.bumpRefresh();
  };
  const exportSvg = async () => {
    const dest = `/Pictures/${slug(doc.title)}.svg`;
    await post("/api/fs", { op: "write", path: dest, content: svgString, mime: "image/svg+xml", reason: "vector-export" });
    setStatus(`exported ${dest}; ${doc.shapes.length} primitive(s)`); shell.bumpRefresh();
  };
  const importFile = async (f: File) => {
    const parsed = parseSvg(await f.text(), f.name);
    setDoc(parsed.doc); setSelected(parsed.doc.shapes[0]?.id ?? ""); setDirty(true);
    setStatus(parsed.dropped.length ? `subset imported; dropped unsupported: ${parsed.dropped.join(", ")}` : "imported");
  };

  if (!loaded) return <div style={{ padding: 16 }}>Loading SVG…</div>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 250px", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="fs-row" style={{ padding: 6, gap: 4, flexWrap: "wrap", borderBottom: "1px solid var(--fs-border)" }}>
          <input className="fs-input" style={{ width: 190 }} aria-label="Vector document title" value={doc.title} onChange={(e) => { setDoc({ ...doc, title: e.target.value }); setDirty(true); }} />
          <Btn variant="primary" onClick={() => void exportSvg()}>Export SVG</Btn>
          <Btn variant="ghost" onClick={() => void saveNative()}>Save .fsvg</Btn>
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import SVG<input type="file" accept="image/svg+xml,.svg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} /></label>
          <Badge tone={dirty ? "warn" : "ok"}>{dirty ? "unsaved" : "saved"}</Badge>
        </div>
        {status ? <div className="fs-dim" style={{ padding: "4px 8px", fontSize: 10.5 }}>{status}</div> : null}
        <div className="fs-scroll" style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 12, background: "#080d18" }}>
          <svg viewBox={`0 0 ${doc.width} ${doc.height}`} role="img" aria-label={doc.title} style={{ width: "100%", maxHeight: "100%", background: "#fff", borderRadius: 5 }}>
            {doc.shapes.map((s) => {
              const common = { fill: s.fill, stroke: s.stroke, strokeWidth: 2, onClick: (e: React.MouseEvent) => { e.stopPropagation(); setSelected(s.id); }, style: { cursor: "pointer", outline: s.id === selected ? "2px solid #5b8cff" : "none" } };
              if (s.kind === "rect") return <rect key={s.id} {...common} x={s.x} y={s.y} width={s.w} height={s.h} />;
              if (s.kind === "circle") return <circle key={s.id} {...common} cx={s.x} cy={s.y} r={s.r} />;
              if (s.kind === "line") return <line key={s.id} {...common} x1={s.x} y1={s.y} x2={s.x2} y2={s.y2} />;
              return <text key={s.id} {...common} x={s.x} y={s.y} fontSize={24}>{s.text}</text>;
            })}
          </svg>
        </div>
      </div>
      <aside className="fs-scroll" style={{ borderLeft: "1px solid var(--fs-border)", padding: 8, display: "grid", alignContent: "start", gap: 8 }}>
        <div className="fs-row" style={{ flexWrap: "wrap", gap: 3 }}>{(["rect", "circle", "line", "text"] as const).map((k) => <Btn key={k} variant="ghost" onClick={() => add(k)}>+ {k}</Btn>)}</div>
        <Section title={`Shapes (${doc.shapes.length})`} dense>
          {doc.shapes.map((s, i) => <button key={s.id} className="fs-list-item" data-selected={s.id === selected} onClick={() => setSelected(s.id)} style={{ width: "100%" }}>{i + 1}. {s.kind} · {s.id}</button>)}
          {shape ? <Btn variant="danger" onClick={() => { setDoc((d) => ({ ...d, shapes: d.shapes.filter((s) => s.id !== selected) })); setSelected(""); setDirty(true); }}>Delete selected</Btn> : null}
        </Section>
        {shape ? <Section title={`Edit ${shape.kind}`} dense>
          {("x" in shape) ? num("x", shape.x, (v) => patchShape({ x: v })) : null}
          {("y" in shape) ? num("y", shape.y, (v) => patchShape({ y: v })) : null}
          {shape.kind === "rect" ? <>{num("width", shape.w, (v) => patchShape({ w: v }))}{num("height", shape.h, (v) => patchShape({ h: v }))}</> : null}
          {shape.kind === "circle" ? num("radius", shape.r, (v) => patchShape({ r: v })) : null}
          {shape.kind === "line" ? <>{num("x2", shape.x2, (v) => patchShape({ x2: v }))}{num("y2", shape.y2, (v) => patchShape({ y2: v }))}</> : null}
          {shape.kind === "text" ? <input className="fs-input" aria-label="Vector text" value={shape.text} onChange={(e) => patchShape({ text: e.target.value })} /> : null}
          {shape.kind !== "line" ? <label className="fs-row" style={{ justifyContent: "space-between", fontSize: 11 }}>Fill <input type="color" value={shape.fill === "none" ? "#ffffff" : shape.fill} onChange={(e) => patchShape({ fill: e.target.value })} /></label> : null}
          <label className="fs-row" style={{ justifyContent: "space-between", fontSize: 11 }}>Stroke <input type="color" value={shape.stroke === "none" ? "#000000" : shape.stroke} onChange={(e) => patchShape({ stroke: e.target.value })} /></label>
        </Section> : null}
        <div className="fs-dim" style={{ fontSize: 10.5 }}>SVG subset: rect/circle/line/text. Imported paths, gradients, filters and external resources are dropped; scripts are never executed. Source is never overwritten.</div>
      </aside>
    </div>
  );
}

function num(label: string, v: number, change: (n: number) => void) { return <label className="fs-row" style={{ justifyContent: "space-between", fontSize: 11 }}>{label}<input className="fs-input" type="number" value={v} onChange={(e) => change(Number(e.target.value))} style={{ width: 90 }} /></label>; }
function slug(s: string) { return s.replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").toLowerCase() || "vector"; }
function escape(s: string) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function serializeSvg(d: VectorDoc) {
  const shapes = d.shapes.map((s) => s.kind === "rect" ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${s.fill}" stroke="${s.stroke}"/>`
    : s.kind === "circle" ? `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${s.fill}" stroke="${s.stroke}"/>`
    : s.kind === "line" ? `<line x1="${s.x}" y1="${s.y}" x2="${s.x2}" y2="${s.y2}" stroke="${s.stroke}"/>`
    : `<text x="${s.x}" y="${s.y}" fill="${s.fill}" stroke="${s.stroke}">${escape(s.text)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}">${shapes}</svg>`;
}
function parseSvg(src: string, title: string): { doc: VectorDoc; dropped: string[] } {
  const xml = new DOMParser().parseFromString(src, "image/svg+xml");
  if (xml.querySelector("parsererror")) throw new Error("invalid SVG XML");
  const root = xml.documentElement;
  if (root.localName !== "svg") throw new Error("root is not <svg>");
  const vb = root.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const widthRaw = vb?.[2] ?? Number.parseFloat(root.getAttribute("width") ?? "800");
  const heightRaw = vb?.[3] ?? Number.parseFloat(root.getAttribute("height") ?? "600");
  const width = Math.max(1, Math.min(4096, Math.round(Number.isFinite(widthRaw) && widthRaw ? widthRaw : 800)));
  const height = Math.max(1, Math.min(4096, Math.round(Number.isFinite(heightRaw) && heightRaw ? heightRaw : 600)));
  const shapes: Shape[] = []; let n = 0; const dropped = new Set<string>();
  for (const el of [...root.querySelectorAll("rect,circle,ellipse,line,text")]) {
    const kind = el.localName; const color = (k: string, d: string) => { const v = el.getAttribute(k) ?? d; return /^(#[0-9a-f]{3,8}|none|[a-z]+)$/i.test(v) ? v : d; };
    const numv = (k: string, d: number) => { const x = Number.parseFloat(el.getAttribute(k) ?? String(d)); return Number.isFinite(x) ? x : d; };
    const id = `s${++n}`, fill = color("fill", kind === "line" ? "none" : "#5b8cff"), stroke = color("stroke", "none");
    if (kind === "rect") shapes.push({ id, kind, x: numv("x", 0), y: numv("y", 0), w: numv("width", 100), h: numv("height", 80), fill, stroke });
    else if (kind === "circle" || kind === "ellipse") shapes.push({ id, kind: "circle", x: numv("cx", 0), y: numv("cy", 0), r: Math.min(numv("r", numv("rx", 40)), numv("r", numv("ry", 40))), fill, stroke });
    else if (kind === "line") shapes.push({ id, kind, x: numv("x1", 0), y: numv("y1", 0), x2: numv("x2", 100), y2: numv("y2", 100), fill, stroke });
    else shapes.push({ id, kind: "text", x: numv("x", 0), y: numv("y", 20), text: el.textContent ?? "", fill, stroke });
  }
  if (root.querySelector("path,polygon,polyline,defs,linearGradient,radialGradient,filter,image,use,foreignObject,script")) dropped.add("paths/gradients/filters/images/external objects");
  if (!shapes.length) dropped.add("no supported primitive found");
  return { doc: { title: title.replace(/\.svg$/i, ""), width, height, shapes }, dropped: [...dropped] };
}
