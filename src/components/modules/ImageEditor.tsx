"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtBytes, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";

interface Crop { left: number; top: number; width: number; height: number }
interface Fx { rotate: 0 | 90 | 180 | 270; flipX: boolean; flipY: boolean; brightness: number; contrast: number; saturate: number; grayscale: number; sepia: number }
const DEFAULT_CROP: Crop = { left: 0, top: 0, width: 100, height: 100 };
const DEFAULT_FX: Fx = { rotate: 0, flipX: false, flipY: false, brightness: 100, contrast: 100, saturate: 100, grayscale: 0, sepia: 0 };

/**
 * MD-03 / FF-05: first-party, non-destructive raster editor.
 * Original bytes remain untouched. Adjustments are a recipe in memory; export
 * makes a new raster through Canvas. Canvas is a raster pipeline (not a layer
 * editor); PSD layers remain FF-08 grade E. Pixel guard: 32 megapixels, and
 * the source remains authoritative if the browser can't allocate the output.
 */
export default function ImageEditorModule({ win }: ModuleProps) {
  const shell = useShell();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceMime, setSourceMime] = useState("image/png");
  const [sourcePath, setSourcePath] = useState((win.props.path as string) ?? "");
  const [crop, setCrop] = useState<Crop>(DEFAULT_CROP);
  const [fx, setFx] = useState<Fx>(DEFAULT_FX);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const loadBlob = useCallback(async (blob: Blob, name: string, path = "") => {
    const b = await createImageBitmap(blob);
    setBitmap((old) => { old?.close(); return b; });
    setSourceName(name); setSourceMime(blob.type || "image/png"); setSourcePath(path);
    setCrop(DEFAULT_CROP); setFx(DEFAULT_FX); setStatus(`${b.width}×${b.height} · ${fmtBytes(blob.size)}`);
  }, []);

  useEffect(() => {
    let live = true;
    if (sourcePath) api<{ node: { content: string; encoding: string; mime: string; name: string; size: number } }>(`/api/fs?op=read&path=${encodeURIComponent(sourcePath)}`)
      .then(async (r) => {
        if (!live) return;
        const bytes = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
        await loadBlob(new Blob([Uint8Array.from(bytes).buffer as ArrayBuffer], { type: r.node.mime }), r.node.name, sourcePath);
      })
      .catch((e) => { if (live) setStatus(`Could not open image: ${(e as Error).message}`); });
    return () => { live = false; bitmap?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath]);

  const draw = useCallback((target: HTMLCanvasElement, maxDim = Infinity) => {
    if (!bitmap) return;
    const sx = Math.round(bitmap.width * crop.left / 100);
    const sy = Math.round(bitmap.height * crop.top / 100);
    const sw = Math.max(1, Math.round(bitmap.width * crop.width / 100));
    const sh = Math.max(1, Math.round(bitmap.height * crop.height / 100));
    const outW = fx.rotate % 180 ? sh : sw;
    const outH = fx.rotate % 180 ? sw : sh;
    const scale = Math.min(1, maxDim / Math.max(outW, outH));
    target.width = Math.max(1, Math.round(outW * scale));
    target.height = Math.max(1, Math.round(outH * scale));
    const ctx = target.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.save();
    ctx.translate(target.width / 2, target.height / 2);
    ctx.rotate(fx.rotate * Math.PI / 180);
    ctx.scale(fx.flipX ? -1 : 1, fx.flipY ? -1 : 1);
    ctx.filter = `brightness(${fx.brightness}%) contrast(${fx.contrast}%) saturate(${fx.saturate}%) grayscale(${fx.grayscale}%) sepia(${fx.sepia}%)`;
    ctx.drawImage(bitmap, sx, sy, sw, sh, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
    ctx.restore();
  }, [bitmap, crop, fx]);

  useEffect(() => {
    if (!bitmap || !canvasRef.current) return;
    try { draw(canvasRef.current, 1400); }
    catch (e) { setStatus(`Preview error: ${(e as Error).message}`); }
  }, [bitmap, draw]);

  const exportImage = async () => {
    if (!bitmap) return;
    const sx = Math.round(bitmap.width * crop.left / 100), sy = Math.round(bitmap.height * crop.top / 100);
    const sw = Math.max(1, Math.round(bitmap.width * crop.width / 100)), sh = Math.max(1, Math.round(bitmap.height * crop.height / 100));
    const ow = fx.rotate % 180 ? sh : sw, oh = fx.rotate % 180 ? sw : sh;
    if (ow * oh > 32_000_000) { shell.toast(`Output ${ow}×${oh} exceeds 32 MP guard; lower the crop first.`, "warn"); return; }
    setBusy(true);
    try {
      const canvas = document.createElement("canvas"); draw(canvas);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Canvas export failed (possibly tainted or out of memory)")), "image/png"));
      if (blob.size > 8 * 1024 * 1024) {
        const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${stem(sourceName)}-edited.png`; a.click(); URL.revokeObjectURL(url);
        setStatus(`Downloaded ${fmtBytes(blob.size)}; over the 8 MB Postgres VFS limit.`); return;
      }
      const b64 = await blobToB64(blob);
      const dst = `/Pictures/${stem(sourceName)}-edited.png`;
      await post("/api/fs", { op: "upload", path: dst, content: b64, mime: "image/png" });
      setStatus(`exported ${ow}×${oh}, ${fmtBytes(blob.size)} → ${dst}`); shell.bumpRefresh();
    } catch (e) { shell.toast(`Export failed: ${(e as Error).message} — original remains unchanged.`, "bad"); }
    finally { setBusy(false); }
  };

  const saveRecipe = async () => {
    const recipe = { version: 1, source: sourcePath || sourceName, sourceShaNote: "recipe only; source bytes are never modified", crop, fx };
    const dst = `/Pictures/${stem(sourceName)}.edits.json`;
    await post("/api/fs", { op: "write", path: dst, content: JSON.stringify(recipe, null, 2), reason: "image-recipe" });
    setStatus(`non-destructive recipe saved → ${dst}`); shell.bumpRefresh();
  };

  if (!bitmap) return (
    <div className="fs-scroll" style={{ padding: 12, display: "grid", gap: 10, alignContent: "start" }}>
      <label className="fs-btn" data-variant="primary" style={{ width: "fit-content", cursor: "pointer" }}>Open image…<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadBlob(f, f.name).catch((x) => shell.toast(String((x as Error).message), "bad")); }} /></label>
      <Btn variant="ghost" onClick={() => { const p = prompt("VFS image path", "/Pictures/logo.svg"); if (p) setSourcePath(p); }}>Open from Files…</Btn>
      <div className="fs-dim" style={{ fontSize: 11.5 }}>Raster: PNG/JPEG/WebP/GIF where the browser can decode it. HEIC decode is capability-probed. PSD remains metadata-only.</div>
    </div>
  );

  const range = (label: string, value: number, min: number, max: number, change: (n: number) => void) => (
    <label style={{ display: "grid", gridTemplateColumns: "75px 1fr 42px", gap: 6, alignItems: "center", fontSize: 11 }}>{label}<input type="range" min={min} max={max} value={value} onChange={(e) => change(Number(e.target.value))}/><span className="fs-mono">{value}</span></label>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 270px", height: "100%", minHeight: 0 }}>
      <div className="fs-scroll" style={{ padding: 10, display: "grid", placeItems: "center", background: "#060a14" }}>
        <canvas ref={canvasRef} aria-label={`Edited preview of ${sourceName}`} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", backgroundImage: "linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%)", backgroundSize: "16px 16px", backgroundPosition: "0 0,0 8px,8px -8px,-8px 0" }} />
      </div>
      <aside className="fs-scroll" style={{ borderLeft: "1px solid var(--fs-border)", padding: 8, display: "grid", alignContent: "start", gap: 8 }}>
        <div className="fs-row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 12 }}>{sourceName}</strong><Badge tone="info">non-destructive</Badge></div>
        <div className="fs-dim" style={{ fontSize: 10.5 }}>{status}</div>
        <Section title="Crop (%)" dense>
          {range("left", crop.left, 0, Math.max(0, 100 - crop.width), (n) => setCrop((c) => ({ ...c, left: n })))}
          {range("top", crop.top, 0, Math.max(0, 100 - crop.height), (n) => setCrop((c) => ({ ...c, top: n })))}
          {range("width", crop.width, 5, 100 - crop.left, (n) => setCrop((c) => ({ ...c, width: n })))}
          {range("height", crop.height, 5, 100 - crop.top, (n) => setCrop((c) => ({ ...c, height: n })))}
        </Section>
        <Section title="Transform" dense>
          <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
            {[0,90,180,270].map((n) => <Btn key={n} variant={fx.rotate === n ? "primary" : "ghost"} onClick={() => setFx((f) => ({ ...f, rotate: n as Fx["rotate"] }))}>{n}°</Btn>)}
            <Btn variant={fx.flipX ? "primary" : "ghost"} onClick={() => setFx((f) => ({ ...f, flipX: !f.flipX }))}>↔ Flip X</Btn>
            <Btn variant={fx.flipY ? "primary" : "ghost"} onClick={() => setFx((f) => ({ ...f, flipY: !f.flipY }))}>↕ Flip Y</Btn>
          </div>
        </Section>
        <Section title="Adjust" dense>
          {range("brightness", fx.brightness, 0, 200, (n) => setFx((f) => ({ ...f, brightness: n })))}
          {range("contrast", fx.contrast, 0, 200, (n) => setFx((f) => ({ ...f, contrast: n })))}
          {range("saturate", fx.saturate, 0, 200, (n) => setFx((f) => ({ ...f, saturate: n })))}
          {range("grayscale", fx.grayscale, 0, 100, (n) => setFx((f) => ({ ...f, grayscale: n })))}
          {range("sepia", fx.sepia, 0, 100, (n) => setFx((f) => ({ ...f, sepia: n })))}
        </Section>
        <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
          <Btn variant="primary" disabled={busy} onClick={() => void exportImage()}>{busy ? "Exporting…" : "Export PNG copy"}</Btn>
          <Btn variant="ghost" onClick={() => void saveRecipe()}>Save recipe</Btn>
          <Btn variant="ghost" onClick={() => { setCrop(DEFAULT_CROP); setFx(DEFAULT_FX); }}>Reset edits</Btn>
        </div>
        <div className="fs-dim" style={{ fontSize: 10.5, lineHeight: 1.5 }}>Single raster layer; no PSD layers. Source is never overwritten. Export is capped at 32 MP and 8 MB VFS; larger files download instead.</div>
      </aside>
    </div>
  );
}

function stem(n: string) { return n.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-") || "image"; }
function fromB64(s: string): Uint8Array { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function blobToB64(blob: Blob) { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }
