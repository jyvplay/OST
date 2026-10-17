"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, clientId } from "@/lib/api";

interface Room { code: string; mediaRef: string; positionMs: number; playing: boolean; anchorMs: number }

export default function PresentView() {
  const params = useSearchParams();
  const room = (params.get("room") ?? "BEAM1").toUpperCase();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const offset = useRef(0);
  const [state, setState] = useState<Room | null>(null);
  const [drift, setDrift] = useState(0);

  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const t0 = Date.now();
      const r = await api<{ serverNow: number }>(`/api/together?t0=${t0}`);
      const t1 = Date.now();
      offset.current = r.serverNow + (t1 - t0) / 2 - t1;
    };
    const poll = async () => {
      const r = await api<{ room: Room | null }>(`/api/together?room=${room}`);
      if (!alive || !r.room) return;
      setState(r.room);
      const v = videoRef.current;
      if (!v) return;
      const serverNow = Date.now() + offset.current;
      const authoritative = r.room.playing ? r.room.positionMs + (serverNow - Number(r.room.anchorMs)) : r.room.positionMs;
      const d = v.currentTime * 1000 - authoritative;
      setDrift(Math.round(d));
      if (r.room.playing && v.paused) void v.play().catch(() => undefined);
      if (!r.room.playing && !v.paused) v.pause();
      if (Math.abs(d) > 2000) v.currentTime = authoritative / 1000;
      else v.playbackRate = Math.abs(d) < 60 ? 1 : d > 0 ? 0.95 : 1.05;
    };
    void sync();
    void poll();
    const a = window.setInterval(poll, 1000);
    const b = window.setInterval(sync, 30_000);
    return () => { alive = false; window.clearInterval(a); window.clearInterval(b); };
  }, [room]);

  return (
    <main style={{ height: "100dvh", background: "#000", color: "#dbe6ff", display: "grid", placeItems: "center", gap: 10 }}>
      <div style={{ position: "fixed", top: 10, left: 12, fontSize: fz(12), opacity: .7, fontFamily: "ui-monospace, monospace" }}>
        Fusion receiver · room {room} · client {clientId().slice(0, 8)} · drift {drift} ms
      </div>
      {state?.mediaRef?.startsWith("http") ? (
        <video ref={videoRef} src={state.mediaRef} playsInline style={{ maxWidth: "100%", maxHeight: "100%" }} />
      ) : (
        <div style={{ textAlign: "center", display: "grid", gap: 8 }}>
          <div style={{ fontSize: fz(42) }}>📡</div>
          <div style={{ fontSize: fz(14) }}>Waiting for the sender to set media for room {room}</div>
          <div style={{ fontSize: fz(12), opacity: .6, maxWidth: 520, lineHeight: 1.6 }}>
            This receiver plays its own copy of the media and follows the room&apos;s anchor clock. Only timing is
            transmitted, which is why a browser can do this at all: it never needs raw sockets, mDNS or a codec
            pipeline it does not own.
          </div>
        </div>
      )}
    </main>
  );
}
