"use client";
/** TT52 — first-party PDF preview for Peek (replaces <embed>, which the app's CSP object-src 'none' blocks, and the
 *  browser-viewer iframe that headless/mobile browsers without a PDF viewer download instead of showing). */
import { useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { PdfDoc, PasswordRequired } from "@/lib/pdf/pdfdoc";
import { renderPage } from "@/lib/pdf/pdfcanvas";

export default function PdfPreview({ bytes, width = 420, onOpen, testid = "peek-pdf" }: { bytes: Uint8Array; width?: number; onOpen?: () => void; testid?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ pages: number; page: number; msg: string }>({ pages: 0, page: 0, msg: "Rendering…" });
  const docRef = useRef<PdfDoc | null>(null);
  useEffect(() => {
    try { docRef.current = PdfDoc.open(bytes); setState({ pages: docRef.current.pages().length, page: 0, msg: "" }); }
    catch (e) { docRef.current = null; setState({ pages: 0, page: 0, msg: e instanceof PasswordRequired ? "Password-protected — open it in the PDF app to enter the password." : `Cannot render: ${(e as Error).message}` }); }
  }, [bytes]);
  useEffect(() => {
    const d = docRef.current; const c = ref.current; if (!d || !c || !state.pages) return; let live = true;
    const p = d.pages()[state.page]; const w = (p.rotate % 180 ? p.crop[3] - p.crop[1] : p.crop[2] - p.crop[0]) || 612;
    const dpr = Math.min(2, window.devicePixelRatio || 1); const off = document.createElement("canvas");
    void renderPage(d, p, off, { scale: (width / w) * dpr, deadline: Date.now() + 15000 }).then(() => { if (!live) return; c.width = off.width; c.height = off.height; c.style.width = `${off.width / dpr}px`; c.style.height = `${off.height / dpr}px`; c.getContext("2d")!.drawImage(off, 0, 0); });
    return () => { live = false; };
  }, [state.pages, state.page, width]);
  return (
    <div data-testid={testid} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
      {state.msg ? <div className="fs-dim" style={{ fontSize: fz(12) }}>{state.msg}</div> : <canvas ref={ref} aria-label={`PDF page ${state.page + 1} of ${state.pages}`} role="img" style={{ boxShadow: "0 1px 6px rgba(0,0,0,.2)", background: "#fff", maxWidth: "100%" }} />}
      <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: fz(12) }}>
        {state.pages > 1 ? <><button type="button" className="fs-btn" disabled={state.page === 0} onClick={() => setState((s) => ({ ...s, page: s.page - 1 }))}>Previous</button><span>{state.page + 1} / {state.pages}</span><button type="button" className="fs-btn" disabled={state.page >= state.pages - 1} onClick={() => setState((s) => ({ ...s, page: s.page + 1 }))}>Next</button></> : null}
        {onOpen ? <button type="button" className="fs-btn" data-testid={`${testid}-open`} onClick={onOpen}>Open in PDF app</button> : null}
      </div>
    </div>
  );
}
