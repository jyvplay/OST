"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { toVtt } from "@/lib/forge";
import { capAvailable } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";
import { PLAYBACK_RATES, snapRate, rateLabel } from "@/lib/playback-rate";
import { loopLabel, nextLoop } from "@/lib/loop-pref";
import { askText } from "@/lib/ask";
import { losslessTrim, isTrimError } from "@/lib/media/trim";

/**
 * MD-02 + CA-01. Remote Playback is media-element scoped: on the web you cast a
 * <video>, not an application. That single fact shapes the whole Beam design —
 * so the player owns the cast button and registers its element as a Beam source.
 */
export default function MediaModule({ win }: ModuleProps) {
  const shell = useShell();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [src, setSrc] = useState<string>((win.props.url as string) ?? "");
  const [path, setPath] = useState<string>((win.props.path as string) ?? "");
  const [remoteAvailable, setRemoteAvailable] = useState<boolean | null>(null);
  const [sinks, setSinks] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState("");
  const [captions, setCaptions] = useState<string | null>(null);
  const [capSize, setCapSize] = useState("100%");
  const [trim, setTrim] = useState<[number, number]>([0, 5]);
  const [trimming, setTrimming] = useState(false);

  const [exactStart, setExactStart] = useState(true);
  const store = async (bytes: Uint8Array, ext: string, mime: string, what: string) => {
    if (bytes.length <= 8 * 1024 * 1024) {
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const out = `/Documents/trim-${Date.now()}.${ext}`;
      await post("/api/fs", { op: "upload", path: out, content: btoa(bin), mime });
      setStatus(`${what}, saved to ${out}`); shell.bumpRefresh();
    } else {
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })); a.download = `trim.${ext}`; a.click();
      setStatus(`${what} — over 8 MB, downloaded instead of stored.`);
    }
  };
  // MD-08 lossless: copy the compressed samples of the range into a new container (no decode, no re-encode)
  const runLossless = async () => {
    setTrimming(true);
    try {
      let bytes: Uint8Array;
      const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(src);
      if (m) { const bin = atob(m[1]); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
      else bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
      const r = losslessTrim(bytes, trim[0], trim[1], exactStart, path || src);
      await store(r.bytes, r.ext, r.mime, `Lossless cut ${r.start.toFixed(3)}–${r.end.toFixed(3)} s (${r.note})`);
    } catch (e) { setStatus(isTrimError(e) ? `Lossless cut not possible: ${(e as Error).message}` : `Lossless cut failed: ${String((e as Error).message)}`); }
    finally { setTrimming(false); }
  };

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
      await store(new Uint8Array(await blob.arrayBuffer()), "webm", "video/webm", `Re-encoded ${trim[0]}–${trim[1]} s`);
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
        <Btn variant="ghost" onClick={async () => { const p = await askText("Open media from Files (path)", "/Documents/clip.mp4", { okLabel: "Open" }); if (p) setPath(p); }}>Open VFS file</Btn>
      </div>

      <video ref={videoRef} src={src || undefined} controls playsInline
        /* Safari-only attribute that enables its native AirPlay route */
        {...{ "x-webkit-airplay": "allow" }}
        style={{ width: "100%", maxHeight: 320, background: "#000", borderRadius: 10 }}>
        {captions ? <track kind="subtitles" src={captions} srcLang="en" label="Subtitles" default /> : null}
      </video>

      <div className="fs-row" style={{ gap: 6, alignItems: "center" }} data-testid="media-rate">
        <label style={{ fontSize: fz(12) }}>Speed
          <select className="fs-select" style={{ width: "auto", marginLeft: 6 }} aria-label="Playback speed" value={rate}
            onChange={(e) => { const r = snapRate(Number(e.target.value)); setRate(r); if (videoRef.current) videoRef.current.playbackRate = r; }}>
            {PLAYBACK_RATES.map((r) => <option key={r} value={r}>{rateLabel(r)}</option>)}
          </select>
        </label>
        <span className="fs-dim" style={{ fontSize: fz(11) }}>applies to the local player; embeds keep their own controls</span>
        <Btn variant={loop ? "primary" : "ghost"} aria-pressed={loop} onClick={() => { const next = nextLoop(loop); setLoop(next); if (videoRef.current) videoRef.current.loop = next; }} data-testid="media-loop">{loopLabel(loop)}</Btn>
      </div>

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
              // Register the target before opening a session: the native chooser is the
              // user's confirmation, but the registry still has to hold the row the
              // indicator and the trust decision hang off (CA-14/SC-09).
              const target = "remote-playback target";
              const post = (body: unknown) => fetch("/api/beam", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
              await post({ action: "seen", name: target, kind: "remote-playback", capability: { transport: "remote-playback" } });
              await post({ action: "start", name: target, transport: "remote-playback", source: path || src });
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
            <span className="fs-dim" style={{ fontSize: fz(11) }}>output</span>
            <select className="fs-select" style={{ width: fz(200) }} aria-label="Audio output device"
              onChange={async (e) => {
                const v = videoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
                try { await v?.setSinkId?.(e.target.value); setStatus(`Audio routed to ${e.target.selectedOptions[0].text}`); }
                catch (err) { setStatus(String((err as Error).message)); }
              }}>
              {sinks.map((s) => <option key={s.deviceId} value={s.deviceId}>{s.label || s.deviceId}</option>)}
            </select>
          </label>
        ) : <Badge tone="warn">per-element audio routing unavailable</Badge>}
        {status ? <span className="fs-dim" style={{ fontSize: fz(11) }} data-testid="media-status">{status}</span> : null}
      </div>

      <Section title="Captions (AX-07)">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={async () => {
            const p = await askText("Subtitle file in Files (.vtt or .srt)", "/Documents/subs.srt", { okLabel: "Load captions" });
            if (!p) return;
            try {
              const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(p)}`);
              setCaptions(URL.createObjectURL(new Blob([toVtt(r.node.content)], { type: "text/vtt" })));
              setStatus(`Captions loaded from ${p}${p.endsWith(".srt") ? " (converted SRT to WebVTT)" : ""}`);
            } catch (e) { setStatus(String((e as Error).message)); }
          }}>Load subtitles…</Btn>
          <label className="fs-row" style={{ gap: 4, fontSize: fz(11.5) }}>size
            <select className="fs-select" style={{ width: fz(90) }} value={capSize} onChange={(e) => setCapSize(e.target.value)}>
              {["80%", "100%", "130%", "170%"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <style>{`video::cue { font-size: ${capSize}; background: rgba(0,0,0,.75); }`}</style>
        <div className="fs-dim" style={{ fontSize: fz(11) }}>Browsers only render WebVTT; SRT is converted (comma-to-dot timestamps, WEBVTT header) instead of silently failing.</div>
      </Section>

      <Section title="Trim / export (MD-08)">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input className="fs-input" type="number" step="0.1" style={{ width: fz(90) }} value={trim[0]} onChange={(e) => setTrim([Number(e.target.value), trim[1]])} aria-label="Start seconds" />
          <input className="fs-input" type="number" step="0.1" style={{ width: fz(90) }} value={trim[1]} onChange={(e) => setTrim([trim[0], Number(e.target.value)])} aria-label="End seconds" />
          <Btn variant="primary" disabled={!src || trimming || trim[1] <= trim[0]} onClick={() => void runLossless()} data-testid="trim-lossless">Lossless cut (instant)</Btn>
          <Btn disabled={!src || trimming || trim[1] <= trim[0]} onClick={() => void runTrim()} data-testid="trim-reencode">{trimming ? "Working…" : "Re-encode (real time)"}</Btn>
          <label className="fs-row" style={{ gap: 4, fontSize: fz(11.5) }}>
            <input type="checkbox" checked={exactStart} onChange={(e) => setExactStart(e.target.checked)} data-testid="trim-exact" /> exact start (MP4)
          </label>
        </div>
        <div className="fs-dim" style={{ fontSize: fz(11) }}>
          Lossless: MP4/MOV/M4A and WebM/MKV are cut by copying the compressed frames into a new file — no quality loss,
          no waiting. MP4 keeps an exact start with an edit list; WebM has none, so its start moves back to the previous
          key frame (the status line says where). Re-encode replays the range through MediaRecorder at 1× speed and works
          for any format the browser can play.
        </div>
      </Section>

      <Section title="What casting means here">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          The Remote Playback API hands this media element to the browser&apos;s own AirPlay/Cast picker; the receiver
          fetches the stream itself. A web app cannot speak RAOP, FairPlay or castv2 directly — those need raw UDP/TCP
          sockets and mDNS, which no browser exposes. Those rows are marked <strong>blocked</strong> in the Spec
          register with the exact missing primitive, rather than being quietly dropped.
        </div>
      </Section>
    </div>
  );
}
