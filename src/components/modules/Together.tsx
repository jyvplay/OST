"use client";
import { newRoomCode } from "@/lib/room-code";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, clientId, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";

interface Room { code: string; mediaRef: string; positionMs: number; playing: boolean; anchorMs: number; leaderClient: string }
interface Ev { id: number; clientId: string; kind: string; payload: Record<string, unknown>; serverTs: number }

/**
 * CA-11 Together — anchor-clock synchronisation.
 *
 * Correction is done with playbackRate nudges (±5 %) toward the authoritative
 * position, never with seeks. Seeking to correct drift is what makes naive
 * watch-parties judder; rate nudging converges invisibly. Clock offset is
 * estimated NTP-style from the request round trip.
 */
export default function TogetherModule({ win }: ModuleProps) {
  const shell = useShell();
  const me = clientId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const offsetRef = useRef(0);
  const sinceRef = useRef(0);
  const [code, setCode] = useState("ROOM1");
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState<Room | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [drift, setDrift] = useState(0);
  const [rtt, setRtt] = useState(0);
  const [mediaRef, setMediaRef] = useState<string>((win.props.mediaRef as string) ?? "");
  const [chat, setChat] = useState("");

  /** Three-sample clock offset estimate (lowest RTT wins). */
  const syncClock = useCallback(async () => {
    let best = { rtt: Infinity, offset: 0 };
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r = await api<{ serverNow: number }>(`/api/together?t0=${t0}`);
      const t1 = Date.now();
      const roundTrip = t1 - t0;
      const offset = r.serverNow + roundTrip / 2 - t1;
      if (roundTrip < best.rtt) best = { rtt: roundTrip, offset };
    }
    offsetRef.current = best.offset;
    setRtt(best.rtt);
  }, []);

  const poll = useCallback(async () => {
    const r = await api<{ room: Room | null; events: Ev[]; serverNow: number; authoritativePositionMs: number }>(
      `/api/together?room=${encodeURIComponent(code)}&since=${sinceRef.current}`,
    );
    if (r.room) setRoom(r.room);
    if (r.events.length) {
      sinceRef.current = r.events[r.events.length - 1].id;
      setEvents((e) => [...e, ...r.events].slice(-60));
    }
    const v = videoRef.current;
    if (v && r.room) {
      const serverNow = Date.now() + offsetRef.current;
      const authoritative = r.room.playing
        ? r.room.positionMs + (serverNow - Number(r.room.anchorMs))
        : r.room.positionMs;
      const local = v.currentTime * 1000;
      const d = local - authoritative;
      setDrift(Math.round(d));
      if (r.room.playing && v.paused) void v.play().catch(() => undefined);
      if (!r.room.playing && !v.paused) v.pause();
      if (Math.abs(d) > 2000) {
        v.currentTime = authoritative / 1000; // only a gross desync earns a seek
      } else if (Math.abs(d) > 60) {
        v.playbackRate = d > 0 ? 0.95 : 1.05;
      } else {
        v.playbackRate = 1;
      }
    }
  }, [code]);

  useEffect(() => {
    if (!joined) return;
    void syncClock();
    const t = window.setInterval(() => void poll(), 1000);
    const c = window.setInterval(() => void syncClock(), 30_000);
    return () => { window.clearInterval(t); window.clearInterval(c); };
  }, [joined, poll, syncClock]);

  const send = (kind: string, payload: Record<string, unknown> = {}, positionMs?: number) =>
    post("/api/together", { room: code, clientId: me, kind, payload, positionMs, mediaRef });

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ width: fz(120) }} value={code} aria-label="Room code"
          onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <Btn variant="ghost" onClick={() => setCode(newRoomCode(Math.random))} data-testid="together-newcode" title="Start a fresh room code">New code</Btn>
        <input className="fs-input" placeholder="Media URL or VFS path" value={mediaRef} aria-label="Media reference"
          onChange={(e) => setMediaRef(e.target.value)} />
        {joined
          ? <Btn variant="danger" onClick={() => { setJoined(false); void send("leave"); }}>Leave</Btn>
          : <Btn variant="primary" onClick={async () => { await send("join"); setJoined(true); }}>Join / create</Btn>}
        <Badge tone={Math.abs(drift) <= 100 ? "ok" : Math.abs(drift) <= 400 ? "warn" : "bad"}>drift {drift} ms</Badge>
        <Badge tone="info">rtt {rtt} ms · offset {Math.round(offsetRef.current)} ms</Badge>
      </div>

      <video ref={videoRef} controls playsInline src={mediaRef.startsWith("http") ? mediaRef : undefined}
        style={{ width: "100%", maxHeight: 280, background: "#000", borderRadius: 10 }}
        onPlay={() => void send("play", {}, (videoRef.current?.currentTime ?? 0) * 1000)}
        onPause={() => void send("pause", {}, (videoRef.current?.currentTime ?? 0) * 1000)}
        onSeeked={() => void send("seek", {}, (videoRef.current?.currentTime ?? 0) * 1000)} />

      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={() => void send("play", {}, (videoRef.current?.currentTime ?? 0) * 1000)}>Play all</Btn>
        <Btn variant="ghost" onClick={() => void send("pause", {}, (videoRef.current?.currentTime ?? 0) * 1000)}>Pause all</Btn>
        <Btn variant="ghost" onClick={() => void send("setMedia", { mediaRef }, 0)}>Set media for everyone</Btn>
        <Btn variant="ghost" onClick={() => void shell.copy(`${location.origin}/present?room=${code}`, "together")}>Copy receiver link</Btn>
      </div>

      <Section title="Room state">
        <div className="fs-mono" style={{ fontSize: fz(11.5) }}>
          {room ? JSON.stringify({ code: room.code, playing: room.playing, positionMs: room.positionMs, leader: room.leaderClient === me ? "me" : room.leaderClient }, null, 1) : "not joined"}
        </div>
        <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
          Each participant plays their own copy of the media; only the clock is shared. That keeps bandwidth at zero
          and avoids re-transmitting content we have no right to relay. Drift is corrected by playbackRate nudges of
          ±5 %, with a seek reserved for gross desync above 2 s.
        </div>
      </Section>

      <Section title="Events">
        <div className="fs-scroll fs-mono" style={{ maxHeight: 130, fontSize: fz(11) }}>
          {events.map((e) => <div key={e.id}>#{e.id} {e.clientId === me ? "me" : e.clientId.slice(0, 6)} {e.kind}</div>)}
          {events.length === 0 ? <span className="fs-dim">no events yet</span> : null}
        </div>
        <div className="fs-row">
          <input className="fs-input" placeholder="Say something" value={chat} aria-label="Chat message"
            onChange={(e) => setChat(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && chat) { void send("chat", { text: chat }); setChat(""); } }} />
        </div>
      </Section>
    </div>
  );
}
