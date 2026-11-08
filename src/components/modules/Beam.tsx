"use client";
import { QrCard } from "../tt151-panels";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { api, fmtTime, post } from "@/lib/api";
import { capOf } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";
import { elapsedLabel } from "@/lib/elapsed";
import { sessionListText } from "@/lib/session-list-text";
import { filterSessions } from "@/lib/session-filter";

interface SessionRow { id: number; targetName: string; transport: string; source: string; state: string; startedAt: string }

interface Transport {
  id: string; label: string; capId: string | null; available: boolean;
  how: string; blocked?: string;
}

/**
 * CA-05 Beam hub.
 *
 * The inversion that matters: a browser cannot discover receivers (no mDNS, no
 * SSDP, no raw sockets). So Beam does not show a device list it cannot build —
 * it shows the *transports* the platform actually grants, each with the API
 * behind it, and lets the browser's own picker enumerate devices at the moment
 * of use. Blocked transports stay visible with the exact missing primitive.
 */
export default function BeamModule(_: ModuleProps) {
  const shell = useShell();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [media, setMedia] = useState<{ url: string; name: string } | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [beamQ, setBeamQ] = useState("");
  const [status, setStatus] = useState("");
  const [beamNow, setBeamNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setBeamNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  // Each selected local file owns exactly one browser object URL; no upload.
  useEffect(() => { if (!media) return; return () => URL.revokeObjectURL(media.url); }, [media]);
  const [remoteAvailable, setRemoteAvailable] = useState<boolean | null>(null);

  const load = () => api<{ sessions: SessionRow[] }>("/api/beam").then((r) => setSessions(r.sessions)).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const remote = (videoRef.current as (HTMLVideoElement & { remote?: {
      watchAvailability: (cb: (a: boolean) => void) => Promise<number>;
      cancelWatchAvailability: (id: number) => Promise<void>;
    } }) | null)?.remote;
    if (!remote) return;
    let active = true, watch: number | undefined;
    const cancel = (id: number) => { void remote.cancelWatchAvailability(id).catch(() => undefined); };
    void remote.watchAvailability(a => { if (active) setRemoteAvailable(a); }).then(id => {
      if (active) watch = id; else cancel(id);
    }).catch(() => { if (active) setRemoteAvailable(null); });
    return () => { active = false; if (watch !== undefined) cancel(watch); };
  }, []);

  const startSession = async (target: string, transport: string, source: string, stop: () => void) => {
    try {
    const seen = await post<{ firstSeen: boolean; trusted: boolean }>("/api/beam", {
      action: "seen", name: target, kind: transport, capability: { transport },
    });
    if (!seen.trusted && !confirm(`Trust "${target}" for this and future sessions?`)) {
      setStatus("Cancelled — unknown targets are never auto-trusted (CA-14).");
      stop(); return false;
    }
    await post("/api/beam", { action: "trust", name: target, trusted: true });
    const r = await post<{ sessionId: number; startedAt: string }>("/api/beam", { action: "start", name: target, transport, source });
    shell.setBeam({
      id: r.sessionId, target, transport, source, startedAt: Date.parse(r.startedAt),
      stop: () => {
        stop();
        void post("/api/beam", { action: "stop", sessionId: r.sessionId }).then(load);
        shell.setBeam(null);
      },
    });
    await load(); return true;
    } catch (error) { stop(); throw error; }
  };

  const runTransport = async (id: string): Promise<string> => {
    if (id === "remote-playback") {
      const video = videoRef.current as (HTMLVideoElement & { remote?: { prompt: () => Promise<void> } }) | null;
      if (!media || !video?.remote?.prompt) throw new Error("Choose a playable local media file first; Remote Playback must be available.");
      await video.remote.prompt(); await video.play();
      return await startSession("remote-playback receiver", "remote-playback", media.name, () => video.pause()) ? "Remote Playback route selected" : "Cancelled";
    }
    if (id === "presentation") {
      const PR = (window as unknown as { PresentationRequest?: new (urls: string[]) => { start: () => Promise<{ close: () => void }> } }).PresentationRequest;
      if (!PR) throw new Error("PresentationRequest missing");
      const connection = await new PR([`${location.origin}/present?room=BEAM1`]).start();
      return await startSession("presentation display", "presentation", "/present", () => connection.close()) ? "Presentation opened" : "Cancelled";
    }
    if (id === "second-window") {
      const details = await (window as unknown as { getScreenDetails: () => Promise<{ screens: { label: string; availLeft: number; availTop: number; availWidth: number; availHeight: number }[] }> }).getScreenDetails();
      const screen = details.screens[1] ?? details.screens[0];
      if (!screen) throw new Error("The browser reported no screens");
      const child = window.open("/display", "fusion-display-2", `popup=1,left=${screen.availLeft},top=${screen.availTop},width=${screen.availWidth},height=${screen.availHeight}`);
      if (!child) throw new Error("Popup blocked; allow the display window and retry");
      const opened = await startSession(screen.label || "display window", "second-window", "/display", () => child.close());
      return opened ? details.screens.length > 1 ? "Opened on the second reported screen" : "Only one screen reported; opened a separate window there" : "Cancelled";
    }
    if (id === "pip") return "Use ⧉ in a window title bar to request picture-in-picture.";
    if (id === "webrtc") { shell.open("share"); return "Share opened. Choose a role and join there; no screen capture has started yet."; }
    throw new Error("This transport is not available to the web app");
  };

  const transports: Transport[] = [
    {
      id: "remote-playback", label: "Remote Playback (AirPlay / Cast picker)",
      capId: "remotePlayback", available: Boolean(capOf(shell.caps, "remotePlayback")?.available),
      how: "HTMLMediaElement.remote.prompt() — the browser enumerates receivers and streams the element",
      blocked: "HTMLMediaElement.remote is not implemented in this browser",
    },
    {
      id: "presentation", label: "Presentation API (cast a Fusion page)",
      capId: "presentation", available: Boolean(capOf(shell.caps, "presentation")?.available),
      how: "new PresentationRequest(['/present']) — the receiver runs our own page and joins the Together clock",
      blocked: "navigator.presentation is unavailable",
    },
    {
      id: "second-window", label: "Second screen / extended display",
      capId: "multiScreen", available: Boolean(capOf(shell.caps, "multiScreen")?.available),
      how: "getScreenDetails() + window.open on the target screen — zero latency, full desktop, its own layout",
      blocked: "window.getScreenDetails() unavailable (grant the window-management permission)",
    },
    {
      id: "pip", label: "Document picture-in-picture (always on top)",
      capId: "documentPiP", available: Boolean(capOf(shell.caps, "documentPiP")?.available),
      how: "documentPictureInPicture.requestWindow() — pop any Fusion window above every other app",
      blocked: "documentPictureInPicture is unavailable",
    },
    {
      id: "webrtc", label: "Peer screen share (our own Miracast analog)",
      capId: "rtc", available: Boolean(capOf(shell.caps, "rtc")?.available) && Boolean(capOf(shell.caps, "displayCapture")?.available),
      how: "getDisplayMedia → RTCPeerConnection with Postgres signalling; encrypted, peer to peer",
      blocked: "WebRTC or screen capture unavailable",
    },
    { id: "raop", label: "AirPlay audio (RAOP/ALAC) direct", capId: null, available: false,
      how: "—", blocked: "raw UDP/TCP sockets + mDNS service discovery + RSA key exchange: no browser exposes any of these" },
    { id: "castv2", label: "Google Cast (castv2) direct", capId: null, available: false,
      how: "—", blocked: "protobuf over TLS to port 8009 requires raw sockets" },
    { id: "airplay-mirror", label: "AirPlay screen mirroring (FairPlay)", capId: null, available: false,
      how: "—", blocked: "raw sockets plus Apple's FairPlay client authentication — blocked twice over, and we would not vendor the DRM anyway" },
    { id: "dlna", label: "DLNA / UPnP", capId: null, available: false,
      how: "—", blocked: "SSDP is UDP multicast discovery" },
    { id: "miracast", label: "Miracast", capId: null, available: false,
      how: "—", blocked: "no web API; it is an OS-level display sink" },
    { id: "receiver", label: "Act as an AirPlay / Cast receiver", capId: null, available: false,
      how: "—", blocked: "a web page cannot register as a system media sink; only our own Presentation receiver page can accept a Fusion sender" },
  ];

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <strong style={{ fontSize: fz(13) }}>Beam</strong>
        <Badge tone={remoteAvailable ? "ok" : "warn"}>
          receivers: {remoteAvailable === null ? "cannot be detected by a web app" : remoteAvailable ? "at least one" : "none reported"}
        </Badge>
        {shell.beam ? <Badge tone="bad">live: {shell.beam.transport} → {shell.beam.target}</Badge> : null}
      </div>

      <QrCard value="" title="QR · local text or link" />
      <label className="fs-dim" style={{ fontSize: fz(12), display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>Local media
        <input type="file" accept="video/*,audio/*" aria-label="Media to cast" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file) { setMedia({ url: URL.createObjectURL(file), name: file.name }); setStatus("Local file selected; nothing uploaded or cast yet."); }
        }} />
      </label>
      <video ref={videoRef} playsInline controls preload="metadata" style={{ display: media ? "block" : "none", width: "100%", maxHeight: 180 }} src={media?.url}
        onError={() => setStatus("This browser could not play that media file. Choose a supported audio/video format.")} />

      <Section title="Browser transports">
        <div style={{ display: "grid", gap: 6 }}>
          {transports.map((t) => (
            <div key={t.id} className="fs-panel" style={{ padding: 8, display: "grid", gap: 4, borderColor: t.available ? "var(--fs-border)" : "rgba(255,107,107,.3)" }}>
              <div className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span className="fs-row" style={{ gap: 6 }}>
                  <Badge tone={t.available ? "ok" : "bad"}>{t.available ? "available" : "blocked"}</Badge>
                  <strong style={{ fontSize: fz(12) }}>{t.label}</strong>
                </span>
                {t.available ? (
                  <Btn variant="primary" disabled={t.id === "remote-playback" && !media} onClick={async () => {
                    try { setStatus(await runTransport(t.id)); }
                    catch (e) { setStatus(`${t.label}: ${String((e as Error).message)}`); }
                  }}>{t.id === "webrtc" ? "Open Share" : t.id === "pip" ? "How to" : "Start"}</Btn>
                ) : null}
              </div>
              <div className="fs-dim" style={{ fontSize: fz(11.5) }}>
                {t.available ? t.how : <>Missing primitive: <span className="fs-mono">{t.blocked}</span></>}
              </div>
            </div>
          ))}
        </div>
        {status ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>{status}</div> : null}
      </Section>

      <Section title="Sources published in this session (LN-13 / WM-15)">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {[...shell.streams.keys()].map((k) => <Badge key={k} tone="info">{k}</Badge>)}
          {shell.streams.size === 0 ? <span className="fs-dim" style={{ fontSize: fz(11.5) }}>None. Start Lens, Capture or Media to publish one.</span> : null}
        </div>
      </Section>

      <div className="fs-row" style={{ gap: 6, padding: "6px 0 0" }}><input className="fs-input" style={{ flex: 1 }} placeholder="Filter sessions" aria-label="Filter sessions by target, transport or state" value={beamQ} onChange={(e) => setBeamQ(e.target.value)} data-testid="beam-filter" /></div>
      <Section title="Session history" right={<span className="fs-row" style={{ gap: 4 }}><Btn variant="ghost" onClick={() => void load()}>↻</Btn><Btn variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(sessionListText(sessions, beamNow)); shell.toast("Session list copied."); } catch { shell.toast("Clipboard unavailable.", "bad"); } }} data-testid="beam-copy-sessions">Copy list</Btn></span>}>
        <div style={{ display: "grid", gap: 2 }}>
          {filterSessions(sessions, beamQ, (s) => s.targetName).map((s) => (
            <div key={s.id} className="fs-row" style={{ justifyContent: "space-between", fontSize: fz(11.5) }}>
              <span>{s.transport} → {s.targetName}</span>
              <span className="fs-row" style={{ gap: 6 }}>
                <Badge tone={s.state === "active" ? "warn" : "ok"}>{s.state}</Badge>
                <span className="fs-dim">{fmtTime(s.startedAt)}{s.state === "active" ? ` · ${elapsedLabel(new Date(s.startedAt).getTime() || beamNow, beamNow)}` : ""}</span>
              </span>
            </div>
          ))}
          {sessions.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(11.5) }}>No sessions yet.</span> : null}
        </div>
      </Section>

      <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
        Privacy (CA-14 / SC-09): a session cannot run without the indicator in the top bar, unknown targets require
        confirmation on first use, and the session stops automatically when the shell is hidden
        (toggle in Settings → beam.autoStopOnHide).
      </div>
    </div>
  );
}
