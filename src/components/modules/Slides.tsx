"use client";

import { useEffect, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";

type Slide = { title: string; body: string[]; notes: string };
type Deck = { title: string; slides: Slide[] };
const blank = (): Deck => ({ title: "Untitled presentation", slides: [{ title: "Title slide", body: ["Subtitle"], notes: "" }] });

/** First-party slide text editor; PPTX output is a fresh, minimal PresentationML package. */
export default function SlidesModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [deck, setDeck] = useState<Deck>(blank);
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      let d = blank();
      if (path.endsWith(".pptx")) {
        try {
          const r = await post<{ deck: Deck; losses: string[] }>("/api/office", { op: "importPptx", path });
          d = r.deck; setStatus(`Imported grade C; not retained: ${r.losses.join(", ")}`);
        } catch (e) { shell.toast(`PPTX import failed: ${String((e as Error).message)}`, "bad"); }
      } else if (path) {
        try { const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`); d = JSON.parse(r.node.content) as Deck; }
        catch { /* start new */ }
      }
      if (live) { setDeck(d); setLoaded(true); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const mutate = (fn: (d: Deck) => Deck) => { setDeck((d) => fn(d)); setDirty(true); };
  const slide = deck.slides[active];
  const save = async () => {
    const dest = path.endsWith(".fdeck") ? path : `/Documents/${slug(deck.title)}.fdeck`;
    await post("/api/fs", { op: "write", path: dest, content: JSON.stringify(deck), reason: "slides-save" });
    setDirty(false); setStatus(`saved ${dest}`); shell.bumpRefresh();
    if (!path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest, title: deck.title } });
  };
  const exportPptx = async () => {
    const r = await post<{ base64: string; bytes: number }>("/api/office", { op: "exportPptx", deck });
    const dest = `/Documents/${slug(deck.title)}.pptx`;
    await post("/api/fs", { op: "upload", path: dest, content: r.base64, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    setStatus(`exported ${r.bytes} B → ${dest} (grade C; text shapes only)`); shell.bumpRefresh();
  };
  const importPptx = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) { shell.toast("PPTX exceeds the 8 MB import guard", "warn"); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await post<{ deck: Deck; losses: string[] }>("/api/office", { op: "importPptx", base64: toB64(bytes) });
    setDeck(r.deck); setActive(0); setDirty(true); setStatus(`import grade C; lost: ${r.losses.join(", ")}`);
  };

  if (!loaded) return <div style={{ padding: 16 }}>Loading deck…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="fs-row" style={{ padding: 6, gap: 5, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <input className="fs-input" style={{ width: 210 }} aria-label="Deck title" value={deck.title} onChange={(e) => mutate((d) => ({ ...d, title: e.target.value }))} />
        <Btn variant="primary" onClick={() => void save()}>Save .fdeck</Btn>
        <Btn variant="ghost" onClick={() => void exportPptx()}>Export .pptx</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import .pptx<input type="file" accept=".pptx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPptx(f).catch((x) => shell.toast(String((x as Error).message), "bad")); }} /></label>
        <Badge tone="warn">PPTX subset · grade C</Badge>
        {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
      </div>
      {status ? <div className="fs-dim" style={{ padding: "4px 8px", fontSize: 11 }}>{status}</div> : null}
      <div className="fs-row" style={{ padding: 5, gap: 4, overflowX: "auto", borderBottom: "1px solid var(--fs-border)" }}>
        {deck.slides.map((s, i) => <button key={i} className="fs-btn" data-variant={i === active ? "primary" : "ghost"} onClick={() => setActive(i)}>{i + 1}. {s.title || "Untitled"}</button>)}
        <Btn variant="ghost" onClick={() => { mutate((d) => ({ ...d, slides: [...d.slides, { title: "New slide", body: [""], notes: "" }] })); setActive(deck.slides.length); }}>+ Slide</Btn>
        <Btn variant="ghost" disabled={deck.slides.length <= 1} onClick={() => { const slides = deck.slides.filter((_, i) => i !== active); mutate((d) => ({ ...d, slides })); setActive(Math.max(0, active - 1)); }}>Delete</Btn>
        <Btn variant="ghost" disabled={active <= 0} onClick={() => { const slides = [...deck.slides]; [slides[active - 1], slides[active]] = [slides[active], slides[active - 1]]; mutate((d) => ({ ...d, slides })); setActive(active - 1); }}>←</Btn>
        <Btn variant="ghost" disabled={active >= deck.slides.length - 1} onClick={() => { const slides = [...deck.slides]; [slides[active], slides[active + 1]] = [slides[active + 1], slides[active]]; mutate((d) => ({ ...d, slides })); setActive(active + 1); }}>→</Btn>
      </div>
      {slide ? (
        <div className="fs-scroll" style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 14 }}>
          <div style={{ width: "min(720px, 96%)", aspectRatio: "16/9", background: "#fff", color: "#111827", borderRadius: 8, boxShadow: "0 12px 40px rgba(0,0,0,.35)", padding: "7%", display: "flex", flexDirection: "column", gap: 12 }}>
            <textarea aria-label="Slide title" value={slide.title} onChange={(e) => mutate((d) => ({ ...d, slides: d.slides.map((s, i) => i === active ? { ...s, title: e.target.value } : s) }))}
              style={{ border: 0, outline: 0, resize: "none", fontSize: 26, fontWeight: 700, minHeight: 52 }} />
            <div style={{ display: "grid", gap: 4, flex: 1 }}>
              {slide.body.map((line, i) => <div key={i} className="fs-row" style={{ alignItems: "flex-start" }}><span style={{ paddingTop: 7 }}>•</span><textarea aria-label={`Slide bullet ${i + 1}`} value={line} onChange={(e) => mutate((d) => ({ ...d, slides: d.slides.map((s, j) => j === active ? { ...s, body: s.body.map((x, k) => k === i ? e.target.value : x) } : s) }))} style={{ flex: 1, resize: "vertical", border: 0, outline: 0, fontSize: 16, minHeight: 32 }} /></div>)}
              <Btn variant="ghost" onClick={() => mutate((d) => ({ ...d, slides: d.slides.map((s, i) => i === active ? { ...s, body: [...s.body, ""] } : s) }))}>+ Bullet</Btn>
            </div>
          </div>
          <textarea aria-label="Speaker notes" placeholder="Speaker notes (kept in .fdeck; not exported to PPTX in this subset)" value={slide.notes}
            onChange={(e) => mutate((d) => ({ ...d, slides: d.slides.map((s, i) => i === active ? { ...s, notes: e.target.value } : s) }))}
            className="fs-textarea" style={{ maxWidth: 720, height: 80, marginTop: 10 }} />
        </div>
      ) : <Empty title="No slides" />}
      <div className="fs-dim" style={{ padding: "4px 8px", borderTop: "1px solid var(--fs-border)", fontSize: 10.5 }}>
        PPTX subset: slide order, title and bullet text shapes. Speaker notes persist in .fdeck but are not yet encoded as Notes Slide parts.
        Animations, transitions, media, charts, themes/master editing and arbitrary shape positioning are not claimed.
      </div>
    </div>
  );
}
function slug(s: string) { return s.replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").toLowerCase() || "presentation"; }
function toB64(bytes: Uint8Array) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
