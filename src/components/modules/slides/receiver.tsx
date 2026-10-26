"use client";
/**
 * TT76 (CA-02) — the audience screen of a Slides show: /present?show=<sid>. Holds its own copy of the deck (sent once
 * by the presenter) and renders each state message with the same ShowStage the presenter uses (transitions + builds).
 * Clicks / keys here ask the presenter to advance; the presenter stays the single source of truth.
 */
import { useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import * as M from "@/lib/office/pml";
import { slideView, type VSlide } from "@/lib/office/pmlview";
import { channelPort, connectionPort, newSid, type ShowPort, type ShowState } from "@/lib/office/showlink";
import { ShowStage } from "./motion";

const views = new WeakMap<M.PSlide, VSlide>();
type PresReceiver = { connectionList?: Promise<{ connections: unknown[]; addEventListener: (t: "connectionavailable", f: (e: { connection: unknown }) => void) => void }> };

export default function SlidesReceiver({ sid }: { sid: string }) {
  const [doc, setDoc] = useState<M.PptxDoc | null>(null);
  const [st, setSt] = useState<ShowState | null>(null);
  const [phase, setPhase] = useState<"waiting" | "loading" | "live" | "ended" | "error">("waiting");
  const [err, setErr] = useState("");
  const [vp, setVp] = useState({ w: 1280, h: 720 });
  const ports = useRef<ShowPort[]>([]);
  const rid = useRef("");
  useEffect(() => {
    rid.current = newSid();
    const f = () => setVp({ w: window.innerWidth, h: window.innerHeight }); f();
    window.addEventListener("resize", f);
    let haveDeck = false;
    const attach = (p: ShowPort) => {
      ports.current.push(p);
      p.onmsg = (m) => {
        if (m.t === "deck") {
          if (haveDeck) return; haveDeck = true; setPhase("loading");
          M.readPptxDoc(m.bytes, m.name).then((d) => { setDoc(d); setPhase("live"); p.send({ t: "ready", rid: rid.current, slides: d.slides.length }); })
            .catch((e: Error) => { haveDeck = false; setErr(e.message); setPhase("error"); });
        } else if (m.t === "state") setSt(m.s);
        else if (m.t === "end") setPhase("ended");
      };
    };
    attach(channelPort(sid));
    // a Presentation API receiver also gets its controller's connection(s)
    const pr = (navigator as unknown as { presentation?: { receiver?: PresReceiver } }).presentation?.receiver;
    void pr?.connectionList?.then((l) => { const add = (c: unknown) => attach(connectionPort(c as Parameters<typeof connectionPort>[0])); l.connections.forEach(add); l.addEventListener("connectionavailable", (e) => add(e.connection)); }).catch(() => undefined);
    // the presenter may open us before it is listening: say hello until the deck arrives
    const hello = () => { if (!haveDeck) for (const p of ports.current) p.send({ t: "hello", rid: rid.current }); };
    hello(); const iv = window.setInterval(hello, 700);
    return () => { window.clearInterval(iv); window.removeEventListener("resize", f); for (const p of ports.current) p.close(); ports.current = []; };
  }, [sid]);
  const nav = (dir: "next" | "prev") => { for (const p of ports.current) p.send({ t: "nav", dir }); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); nav("next"); }
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); nav("prev"); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);
  const w = doc ? Math.min(vp.w, vp.h * (doc.size.cx / doc.size.cy)) : 0;
  const msg = phase === "waiting" ? "Waiting for the presenter…" : phase === "loading" ? "Loading the presentation…" : phase === "ended" ? "The presentation has ended. You can close this window." : phase === "error" ? `Could not open the presentation: ${err}` : "";
  return (
    <main data-testid="audience" data-phase={phase} data-slide={st?.i ?? -1} onClick={() => nav("next")}
      style={{ height: "100dvh", background: "#000", color: "#dbe6ff", display: "grid", placeItems: "center", overflow: "hidden", cursor: phase === "live" ? "none" : undefined }}>
      {phase === "live" && doc && st && doc.slides[st.i] ? (
        <ShowStage doc={doc} i={st.i} done={st.done} animate={st.animate} animKey={st.key} from={st.from} viewOf={(s) => { let v = views.get(s); if (!v) { v = slideView(doc, s); views.set(s, v); } return v; }} w={w} />
      ) : <div role="status" style={{ fontSize: fz(16), opacity: 0.8, textAlign: "center", padding: 24 }}>{msg || "Waiting for the first slide…"}<div style={{ fontSize: fz(12), opacity: 0.6, marginTop: 8 }}>Fusion audience screen · session {sid.slice(0, 4)}…</div></div>}
    </main>
  );
}
