"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { fmtBytes, post } from "@/lib/api";
import { capAvailable } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Section } from "../ui";

/**
 * MD-01. The recording is committed to the VFS BEFORE any editor opens
 * (file-first rule), so an annotation crash cannot lose the capture.
 * We also never imply we can hide the browser's own sharing indicator.
 */
export default function CaptureModule(_: ModuleProps) {
  const shell = useShell();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saved, setSaved] = useState<{ path: string; bytes: number } | null>(null);
  const [withAudio, setWithAudio] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  const start = async () => {
    setErr("");
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: shell.gov.maxCastHeight >= 1080 ? 60 : 30 },
        audio: withAudio,
      });
      setStream(s);
      shell.publishStream("capture", s);
      s.getVideoTracks()[0]?.addEventListener("ended", () => stop());
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
        .find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const rec = new MediaRecorder(s, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks.current, { type: rec.mimeType || "video/webm" });
        const buf = new Uint8Array(await blob.arrayBuffer());
        if (buf.byteLength > 8 * 1024 * 1024) {
          setErr(`Recording is ${fmtBytes(buf.byteLength)} — over the 8 MB store limit. Download it instead; the VFS keeps bytes in Postgres on purpose and refuses silent truncation.`);
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `capture-${Date.now()}.webm`; a.click();
          URL.revokeObjectURL(url);
          return;
        }
        let bin = "";
        buf.forEach((b) => { bin += String.fromCharCode(b); });
        const path = `/Documents/capture-${Date.now()}.webm`;
        await post("/api/fs", { op: "upload", path, content: btoa(bin), mime: blob.type });
        setSaved({ path, bytes: buf.byteLength });
        shell.bumpRefresh();
        shell.toast(`Capture committed to ${path} before any editing (MD-01).`, "ok");
      };
      rec.start(1000);
      recorder.current = rec;
      setRecording(true);
      setElapsed(0);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const stop = () => {
    recorder.current?.state !== "inactive" && recorder.current?.stop();
    stream?.getTracks().forEach((t) => t.stop());
    shell.publishStream("capture", null);
    setStream(null);
    setRecording(false);
  };

  if (!capAvailable(shell.caps, "displayCapture")) {
    return (
      <div style={{ padding: 12 }}>
        <Blocked what="Screen capture" missing="navigator.mediaDevices.getDisplayMedia"
          workaround="Use the Lens camera pipeline, or run Fusion in a browser that implements screen capture." />
      </div>
    );
  }

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {recording
          ? <Btn variant="danger" onClick={stop}>⏹ Stop ({elapsed}s)</Btn>
          : <Btn variant="primary" onClick={() => void start()}>⏺ Capture screen / window / tab</Btn>}
        <label className="fs-row" style={{ gap: 4, fontSize: fz(12) }}>
          <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} /> include audio
        </label>
        {recording ? <Badge tone="bad">recording</Badge> : null}
        {capAvailable(shell.caps, "webCodecs") ? <Badge tone="ok">hardware encode available</Badge> : <Badge tone="warn">no WebCodecs — MediaRecorder defaults</Badge>}
      </div>

      <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", maxHeight: 300, background: "#000", borderRadius: 10 }} />

      {err ? <Badge tone="bad">{err}</Badge> : null}
      {saved ? (
        <div className="fs-row" style={{ gap: 6 }}>
          <Badge tone="ok">saved {fmtBytes(saved.bytes)}</Badge>
          <span className="fs-mono" style={{ fontSize: fz(11.5) }}>{saved.path}</span>
          <Btn variant="ghost" onClick={() => shell.open("media", { path: saved.path, title: "Capture" })}>Play</Btn>
          <Btn variant="ghost" onClick={() => shell.open("files", { path: "/Documents" })}>Reveal</Btn>
        </div>
      ) : null}

      <Section title="Honest boundaries">
        <ul className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
          <li>The browser always shows its own sharing indicator; no web app can suppress it, and we do not claim to.</li>
          <li>There is no FLAG_SECURE equivalent: we cannot exclude a window from someone else&apos;s capture. The Vault instead auto-locks when the shell is hidden (SC-06, marked partial).</li>
          <li>Captures above 8 MB are downloaded instead of stored, because the VFS keeps bytes in Postgres and will not truncate silently.</li>
        </ul>
      </Section>
    </div>
  );
}
