"use client";

import { useEffect, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { toVtt } from "@/lib/forge";
import { capAvailable } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";

/**
 * MD-02 + CA-01. Remote Playback is media-element scoped: on the web you cast a
 * <video>, not an application. That single fact shapes the whole Beam design —
 * so the player owns the cast button and registers its element as a Beam source.
 */
export default function MediaModule({ win }: ModuleProps) {
  const shell = useShell();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState<string>((win.props.url as string) ?? "");
  const [path, setPath] = useState<string>((win.props.path as string) ?? "");
  const [remoteAvailable, setRemoteAvailable] = useState<boolean | null>(null);
  const [sinks, setSinks] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState("");
  const [captions, setCaptions] = useState<string | null>(null);
  const [capSize, setCapSize] = useState("100%");
  const [trim, setTrim] = useState<[number, number]>([0, 5]);
  const [trimming, setTrimming] = useState(false);

  const runTrim = async () => {
    const v = videoRef.current as (HTMLVideoElement & { captureStream?: () => MediaStream }) | null;
    if (!v?.captureStream) { setStatus("captureStream() unavailable in this browser — trim needs it."); return; }
    setTrimming(true);
    try {
      v.currentTime = trim[0];
      await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
      const rec = new MediaRecorder(v.captureStream());
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      const done = new Promise((r) => { rec.onstop = r; });
      rec.start(250);
      await v.play();
      await new Promise<void>((r) => {
        const check = () => { if (v.currentTime >= trim[1] || v.ended) { v.removeEventListener("timeupdate", check); r(); } };
        v.addEventListener("timeupdate", check);
      });
      v.pause(); rec.stop(); await done;
      const blob = new Blob(parts, { type: rec.mimeType || "video/webm" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length <= 8 * 1024 * 1024) {
        let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
        const out = `/Documents/trim-${Date.now()}.webm`;
        await post("/api/fs", { op: "upload", path: out, content: btoa(bin), mime: "video/webm" });
        setStatus(`Exported ${trim[0]}–${trim[1]} s → ${out}`); shell.bumpRefresh();
      } else {
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "trim.webm"; a.click();
        setStatus("Export over 8 MB — downloaded instead of stored.");
      }
    } catch (e) { setStatus(`Trim failed: ${String((e as Error).message)}`); }
    finally { setTrimming(false); }
  };

  useEffect(() => {
    if (!path) return;
    api<{ node: { content: string; encoding: string; mime: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`)
      .then((r) => setSrc(r.node.encoding === "base64" ? `data:${r.node.mime};base64,${r.node.content}` : ""))
      .catch(() => undefined);
  }, [path]);

  // CA-01: watchAvailability tells us whether a receiver really exists, so the
  // cast affordance appears only when it can work.
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & { remote?: { watchAvailability: (cb: (a: boolean) => void) => Promise<number>; cancelWatchAvailability: (id?: number) => Promise<void>; prompt: () => Promise<void> } }) | null;
    if (!v?.remote) { setRemoteAvailable(null); return; }
    let id: number | undefined;
    v.remote.watchAvailability((available) => setRemoteAvailable(available))
      .then((watchId) => { id = watchId; })
      .catch(() => setRemoteAvailable(null));
    return () => { v.remote?.cancelWatchAvailability(id).catch(() => undefined); };
  }, [src]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.()
      .then((d) => setSinks(d.filter((x) => x.kind === "audiooutput")))
      .catch(() => undefined);
  }, []);

  // Media Session: OS media keys + lock-screen metadata
  useEffect(() => {
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (!ms) return;
    ms.metadata = new MediaMetadata({ title: path || src || "Fusion Media", artist: "Fusion Shell Web", album: "Local" });
    ms.setActionHandler?.("play", () => void videoRef.current?.play());
    ms.setActionHandler?.("pause", () => videoRef.current?.pause());
  }, [path, src]);

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
        <input className="fs-input" placeholder="Media URL (or open a file from Files)" value={src.startsWith("data:") ? "(file from the VFS)" : src}
          onChange={(e) => { setSrc(e.target.value); setPath(""); }} aria-label="Media URL" />
        <Btn variant="ghost" onClick={() => { const p = prompt("VFS path", "/Documents/clip.mp4"); if (p) setPath(p); }}>Open VFS file</Btn>
      </div>

      <video ref={videoRef} src={src || undefined} controls playsInline
        /* Safari-only attribute that enables its native AirPlay route */
        {...{ "x-webkit-airplay": "allow" }}
        style={{ width: "100%", maxHeight: 320, background: "#000", borderRadius: 10 }}>
        {captions ? <track kind="subtitles" src={captions} srcLang="en" label="Subtitles" default /> : null}
      </video>

      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="primary"
          disabled={!capAvailable(shell.caps, "remotePlayback") || remoteAvailable === false}
          title={capAvailable(shell.caps, "remotePlayback")
            ? "Opens the browser's own AirPlay / Cast picker for this element"
            : "HTMLMediaElement.remote is not implemented in this browser"}
          onClick={async () => {
            const v = videoRef.current as (HTMLVideoElement & { remote?: { prompt: () => Promise<void> } }) | null;
            try {
              await v?.remote?.prompt();
              setStatus("Remote playback prompt shown.");
              await fetch("/api/beam", { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "start", name: "remote-playback target", transport: "remote-playback", source: path || src }) });
            } catch (e) { setStatus(`Remote playback: ${String((e as Error).message)}`); }
          }}>
          📡 Cast this media
        </Btn>
        <Btn variant="ghost" disabled={!capAvailable(shell.caps, "pip")}
          onClick={async () => {
            try { await videoRef.current?.requestPictureInPicture(); }
            catch (e) { setStatus(String((e as Error).message)); }
          }}>Picture in picture</Btn>
        <Btn variant="ghost" onClick={() => {
          const v = videoRef.current;
          if (!v) return;
          const stream = (v as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
          if (stream) { shell.publishStream("media", stream); shell.toast("Published as a Beam source (WM-15).", "ok"); }
          else shell.toast("captureStream() is not available for this element in this browser.", "warn");
        }}>Publish as Beam source</Btn>
        <Btn variant="ghost" onClick={() => shell.open("together", { mediaRef: path || src })}>Watch together</Btn>
      </div>

      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Badge tone={remoteAvailable ? "ok" : remoteAvailable === false ? "warn" : "bad"}>
          remote playback: {remoteAvailable === null ? "unsupported" : remoteAvailable ? "receiver available" : "no receiver found"}
        </Badge>
        {capAvailable(shell.caps, "setSinkId") ? (
          <label className="fs-row" style={{ gap: 4 }}>
            <span className="fs-dim" style={{ fontSize: 11 }}>output</span>
            <select className="fs-select" style={{ width: 200 }} aria-label="Audio output device"
              onChange={async (e) => {
                const v = videoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
                try { await v?.setSinkId?.(e.target.value); setStatus(`Audio routed to ${e.target.selectedOptions[0].text}`); }
                catch (err) { setStatus(String((err as Error).message)); }
              }}>
              {sinks.map((s) => <option key={s.deviceId} value={s.deviceId}>{s.label || s.deviceId}</option>)}
            </select>
          </label>
        ) : <Badge tone="warn">per-element audio routing unavailable</Badge>}
        {status ? <span className="fs-dim" style={{ fontSize: 11 }}>{status}</span> : null}
      </div>

      <Section title="Captions (AX-07)">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={async () => {
            const p = prompt("Subtitle file in the VFS (.vtt or .srt)", "/Documents/subs.srt");
            if (!p) return;
            try {
              const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(p)}`);
              setCaptions(URL.createObjectURL(new Blob([toVtt(r.node.content)], { type: "text/vtt" })));
              setStatus(`Captions loaded from ${p}${p.endsWith(".srt") ? " (converted SRT → WebVTT)" : ""}`);
            } catch (e) { setStatus(String((e as Error).message)); }
          }}>Load subtitles…</Btn>
          <label className="fs-row" style={{ gap: 4, fontSize: 11.5 }}>size
            <select className="fs-select" style={{ width: 90 }} value={capSize} onChange={(e) => setCapSize(e.target.value)}>
              {["80%", "100%", "130%", "170%"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <style>{`video::cue { font-size: ${capSize}; background: rgba(0,0,0,.75); }`}</style>
        <div className="fs-dim" style={{ fontSize: 11 }}>Browsers only render WebVTT; SRT is converted (comma → dot timestamps, WEBVTT header) instead of silently failing.</div>
      </Section>

      <Section title="Trim / export (MD-08)">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input className="fs-input" type="number" step="0.1" style={{ width: 90 }} value={trim[0]} onChange={(e) => setTrim([Number(e.target.value), trim[1]])} aria-label="Start seconds" />
          <input className="fs-input" type="number" step="0.1" style={{ width: 90 }} value={trim[1]} onChange={(e) => setTrim([trim[0], Number(e.target.value)])} aria-label="End seconds" />
          <Btn variant="primary" disabled={!src || trimming || trim[1] <= trim[0]} onClick={() => void runTrim()}>{trimming ? "Exporting (real time)…" : "Export range"}</Btn>
        </div>
        <div className="fs-dim" style={{ fontSize: 11 }}>
          Honest path: the range is replayed and re-encoded by MediaRecorder at 1× speed (a 30 s clip takes 30 s). A
          lossless cut would need a container muxer in WASM, which is not bundled.
        </div>
      </Section>

      <Section title="What casting means here">
        <div className="fs-dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          The Remote Playback API hands this media element to the browser&apos;s own AirPlay/Cast picker; the receiver
          fetches the stream itself. A web app cannot speak RAOP, FairPlay or castv2 directly — those need raw UDP/TCP
          sockets and mDNS, which no browser exposes. Those rows are marked <strong>blocked</strong> in the Spec
          register with the exact missing primitive, rather than being quietly dropped.
        </div>
      </Section>
    </div>
  );
}
