"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, clientId, post } from "@/lib/api";
import { capAvailable } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, KV, Section } from "../ui";

interface Signal { id: number; fromClient: string; toClient: string; kind: string; payload: Record<string, unknown> }
interface Stats { fps: number; kbps: number; rttMs: number; height: number; limitedBy: string }

const CHUNK = 16 * 1024;

/**
 * CA-09 peer screen share + CT-02 device bridge.
 *
 * Nuances vs. the usual WebRTC demo:
 *  - Roles are deterministic: the peer with the lexically smaller id makes the
 *    offer. No "perfect negotiation" glare handling is needed for 1:1.
 *  - The peer id is per WINDOW (clientId + random), because two tabs of the same
 *    browser share localStorage — using clientId alone makes them ignore each other.
 *  - ICE candidates that arrive before the remote description are queued; dropping
 *    them is the classic "connects on LAN only sometimes" bug.
 *  - No STUN/TURN by default: host candidates only, so nothing leaves the LAN unless
 *    the user adds a server (stated in the UI).
 *  - CA-13: the sender's bitrate/resolution are set from live RTCStats and the shell
 *    governor via RTCRtpSender.setParameters, not a constant.
 */
export default function ShareModule(_: ModuleProps) {
  const shell = useShell();
  const me = useRef(`${clientId()}-${Math.random().toString(36).slice(2, 6)}`).current;
  const [room, setRoom] = useState("SHARE1");
  const [role, setRole] = useState<"share" | "view">("view");
  const [joined, setJoined] = useState(false);
  const [state, setState] = useState("idle");
  const [peer, setPeer] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [stun, setStun] = useState("");
  const [msgs, setMsgs] = useState<string[]>([]);
  const [text, setText] = useState("");
  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const local = useRef<MediaStream | null>(null);
  const cursor = useRef(0);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const incoming = useRef<{ name: string; size: number; parts: ArrayBuffer[]; got: number } | null>(null);

  const signal = useCallback((to: string, kind: string, payload: unknown = {}) =>
    post("/api/rtc", { room, from: me, to, kind, payload }), [room, me]);

  const log = (m: string) => setMsgs((x) => [...x, m].slice(-60));

  const wireChannel = useCallback((ch: RTCDataChannel) => {
    ch.binaryType = "arraybuffer";
    dc.current = ch;
    ch.onopen = () => log("bridge channel open");
    ch.onmessage = async (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data) as { t: string; text?: string; name?: string; size?: number };
        if (m.t === "text") log(`peer: ${m.text}`);
        if (m.t === "file") incoming.current = { name: m.name!, size: m.size!, parts: [], got: 0 };
        if (m.t === "file-end" && incoming.current) {
          const f = incoming.current; incoming.current = null;
          const bytes = new Uint8Array(await new Blob(f.parts).arrayBuffer());
          let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
          const path = `/Downloads/${f.name.replace(/[/\\]/g, "_")}`;
          await post("/api/fs", { op: "upload", path, content: btoa(bin) });
          log(`received ${f.name} (${bytes.length} B) → ${path}`); shell.bumpRefresh();
        }
      } else if (incoming.current) {
        incoming.current.parts.push(e.data as ArrayBuffer);
        incoming.current.got += (e.data as ArrayBuffer).byteLength;
      }
    };
  }, [shell]);

  const makePc = useCallback((to: string) => {
    const conn = new RTCPeerConnection({ iceServers: stun ? [{ urls: stun }] : [] });
    conn.onicecandidate = (e) => { if (e.candidate) void signal(to, "ice", e.candidate.toJSON()); };
    conn.onconnectionstatechange = () => setState(conn.connectionState);
    conn.ontrack = (e) => { if (videoRef.current) videoRef.current.srcObject = e.streams[0] ?? new MediaStream([e.track]); };
    conn.ondatachannel = (e) => wireChannel(e.channel);
    pc.current = conn;
    setPeer(to);
    return conn;
  }, [signal, stun, wireChannel]);

  const flushIce = async () => {
    for (const c of pendingIce.current.splice(0)) await pc.current?.addIceCandidate(c).catch(() => undefined);
  };

  const handle = useCallback(async (s: Signal) => {
    if (s.kind === "hello" && !pc.current) {
      if (me < s.fromClient) {
        const conn = makePc(s.fromClient);
        wireChannel(conn.createDataChannel("bridge"));
        if (local.current) local.current.getTracks().forEach((t) => conn.addTrack(t, local.current!));
        else conn.addTransceiver("video", { direction: "recvonly" });
        await conn.setLocalDescription(await conn.createOffer());
        await signal(s.fromClient, "offer", conn.localDescription!.toJSON());
        setState("offering");
      } else {
        await signal(s.fromClient, "hello"); // make sure the smaller id learns about us
      }
    } else if (s.kind === "offer" && s.toClient === me) {
      const conn = pc.current ?? makePc(s.fromClient);
      await conn.setRemoteDescription(s.payload as unknown as RTCSessionDescriptionInit);
      const track = local.current?.getVideoTracks()[0];
      if (track) {
        const tr = conn.getTransceivers().find((t) => t.receiver.track.kind === "video");
        if (tr) { tr.direction = "sendonly"; await tr.sender.replaceTrack(track); }
        else conn.addTrack(track, local.current!);
      }
      await flushIce();
      await conn.setLocalDescription(await conn.createAnswer());
      await signal(s.fromClient, "answer", conn.localDescription!.toJSON());
    } else if (s.kind === "answer" && s.toClient === me && pc.current) {
      await pc.current.setRemoteDescription(s.payload as unknown as RTCSessionDescriptionInit);
      await flushIce();
    } else if (s.kind === "ice" && s.toClient === me) {
      if (pc.current?.remoteDescription) await pc.current.addIceCandidate(s.payload as RTCIceCandidateInit).catch(() => undefined);
      else pendingIce.current.push(s.payload as RTCIceCandidateInit);
    } else if (s.kind === "bye" && s.fromClient === peer) {
      pc.current?.close(); pc.current = null; setPeer(null); setState("peer left");
    }
  }, [me, makePc, signal, wireChannel, peer]);

  useEffect(() => {
    if (!joined) return;
    let alive = true;
    const t = window.setInterval(async () => {
      try {
        const r = await api<{ rows: Signal[]; cursor: number }>(`/api/rtc?room=${room}&me=${me}&since=${cursor.current}`);
        cursor.current = r.cursor;
        for (const s of r.rows) if (alive) await handle(s);
      } catch { /* offline: next tick retries */ }
    }, 700);
    return () => { alive = false; window.clearInterval(t); };
  }, [joined, room, me, handle]);

  // CA-13 quality governor from live stats
  useEffect(() => {
    if (!joined) return;
    const t = window.setInterval(async () => {
      const conn = pc.current;
      if (!conn) return;
      const report = await conn.getStats();
      let fps = 0, bytes = 0, rtt = 0, height = 0, avail = 0;
      report.forEach((r) => {
        const x = r as Record<string, number | string>;
        if ((x.type === "outbound-rtp" || x.type === "inbound-rtp") && x.kind === "video") {
          fps = Number(x.framesPerSecond ?? 0); bytes = Number(x.bytesSent ?? x.bytesReceived ?? 0); height = Number(x.frameHeight ?? 0);
        }
        if (x.type === "candidate-pair" && x.state === "succeeded") {
          rtt = Number(x.currentRoundTripTime ?? 0) * 1000; avail = Number(x.availableOutgoingBitrate ?? 0);
        }
      });
      const prev = (conn as unknown as { _b?: number })._b ?? bytes;
      (conn as unknown as { _b?: number })._b = bytes;
      const kbps = Math.max(0, Math.round(((bytes - prev) * 8) / 2000));
      let limitedBy = "none";
      const sender = conn.getSenders().find((s) => s.track?.kind === "video");
      if (sender && local.current) {
        const p = sender.getParameters();
        if (p.encodings?.length) {
          const srcH = local.current.getVideoTracks()[0]?.getSettings().height ?? 1080;
          const cap = shell.gov.maxCastHeight;
          p.encodings[0].scaleResolutionDownBy = Math.max(1, srcH / cap);
          p.encodings[0].maxBitrate = avail ? Math.min(6_000_000, Math.round(avail * 0.85)) : 2_500_000;
          limitedBy = cap < srcH ? `governor ${shell.gov.state} → ${cap}p` : avail ? "measured bandwidth" : "default 2.5 Mbps";
          await sender.setParameters(p).catch(() => undefined);
        }
      }
      setStats({ fps, kbps, rttMs: Math.round(rtt), height, limitedBy });
    }, 2000);
    return () => window.clearInterval(t);
  }, [joined, shell.gov.maxCastHeight, shell.gov.state]);

  const join = async () => {
    try {
      if (role === "share") {
        local.current = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        if (videoRef.current) { videoRef.current.srcObject = local.current; videoRef.current.muted = true; }
        local.current.getVideoTracks()[0].addEventListener("ended", () => void leave());
        shell.setBeam({ id: null, target: `room ${room}`, transport: "webrtc", source: "screen", startedAt: Date.now(), stop: () => void leave() });
      }
      cursor.current = 0;
      setJoined(true); setState("waiting for peer");
      await signal("*", "hello");
    } catch (e) { shell.toast(String((e as Error).message), "bad"); }
  };

  const leave = async () => {
    if (peer) await signal(peer, "bye").catch(() => undefined);
    pc.current?.close(); pc.current = null; dc.current = null;
    local.current?.getTracks().forEach((t) => t.stop()); local.current = null;
    setJoined(false); setPeer(null); setState("idle"); setStats(null);
    shell.setBeam(null);
  };

  useEffect(() => () => { void leave(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!capAvailable(shell.caps, "rtc")) return <div style={{ padding: 12 }}><Blocked what="Peer share" missing="RTCPeerConnection" /></div>;

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ width: 110 }} value={room} disabled={joined} aria-label="Room"
          onChange={(e) => setRoom(e.target.value.toUpperCase())} />
        <select className="fs-select" style={{ width: 150 }} value={role} disabled={joined} onChange={(e) => setRole(e.target.value as "share" | "view")}>
          <option value="view">view / bridge only</option>
          <option value="share" disabled={!capAvailable(shell.caps, "displayCapture")}>share my screen</option>
        </select>
        {joined ? <Btn variant="danger" onClick={() => void leave()}>Leave</Btn> : <Btn variant="primary" onClick={() => void join()}>Join</Btn>}
        <Badge tone={state === "connected" ? "ok" : joined ? "warn" : "default"}>{state}</Badge>
        {peer ? <Badge tone="info">peer {peer.slice(-6)}</Badge> : null}
      </div>
      <input className="fs-input fs-mono" placeholder="optional STUN, e.g. stun:stun.example.org:3478 (default: LAN host candidates only)"
        value={stun} disabled={joined} onChange={(e) => setStun(e.target.value)} aria-label="STUN server" />

      <video ref={videoRef} autoPlay playsInline style={{ width: "100%", maxHeight: 300, background: "#000", borderRadius: 10 }} />

      {stats ? (
        <Section title="Link (CA-13 governor)">
          <KV k="frames/s" v={stats.fps} mono /><KV k="bitrate" v={`${stats.kbps} kbps`} mono />
          <KV k="rtt" v={`${stats.rttMs} ms`} mono /><KV k="frame height" v={stats.height} mono />
          <KV k="quality limited by" v={stats.limitedBy} />
        </Section>
      ) : null}

      <Section title="Device bridge (CT-02) — data channel">
        <div className="fs-row" style={{ gap: 6 }}>
          <input className="fs-input" placeholder="message or text to send" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && dc.current?.readyState === "open") { dc.current.send(JSON.stringify({ t: "text", text })); log(`me: ${text}`); setText(""); } }} />
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>
            Send file
            <input type="file" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; const ch = dc.current;
              if (!f || !ch || ch.readyState !== "open") { shell.toast("Bridge not connected", "warn"); return; }
              if (f.size > 8 * 1024 * 1024) { shell.toast("Over the 8 MB VFS limit", "warn"); return; }
              ch.send(JSON.stringify({ t: "file", name: f.name, size: f.size }));
              const buf = await f.arrayBuffer();
              for (let o = 0; o < buf.byteLength; o += CHUNK) {
                while (ch.bufferedAmount > 1_000_000) await new Promise((r) => setTimeout(r, 20)); // backpressure
                ch.send(buf.slice(o, o + CHUNK));
              }
              ch.send(JSON.stringify({ t: "file-end" }));
              log(`sent ${f.name} (${f.size} B)`);
            }} />
          </label>
        </div>
        <div className="fs-mono" style={{ fontSize: 11, maxHeight: 120, overflow: "auto" }}>{msgs.map((m, i) => <div key={i}>{m}</div>)}</div>
      </Section>

      <div className="fs-dim" style={{ fontSize: 11, lineHeight: 1.6 }}>
        Test with two windows: open Share twice (or on two devices against the same server), pick “share my screen” in
        one and “view” in the other, same room. Signalling rides on Postgres (~1 s to connect); media and files flow
        peer to peer, encrypted (DTLS-SRTP), and never touch the server.
      </div>
    </div>
  );
}
