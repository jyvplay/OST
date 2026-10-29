"use client";
import { displayMedia, userMedia } from "@/lib/access-log";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState } from "react";
import { capAvailable } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Section, Toggle } from "../ui";

interface Fx {
  blur: number; brightness: number; contrast: number; saturate: number; relight: number;
  vignette: boolean; matte: number; autoframe: boolean; presenter: boolean; mirror: boolean;
}
const DEFAULT_FX: Fx = { blur: 10, brightness: 1.05, contrast: 1.05, saturate: 1.1, relight: 0, vignette: true, matte: 0.62, autoframe: false, presenter: false, mirror: true };

/**
 * LN-08 voice gate as an AudioWorklet (audio thread). A main-thread gate clicks
 * whenever layout runs; this one has attack/hold/release so words are not chopped.
 */
const GATE_WORKLET = `
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: "threshold", defaultValue: 0.02 }]; }
  constructor() { super(); this.env = 0; this.gain = 0; this.hold = 0; }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) return true;
    const th = params.threshold[0];
    for (let i = 0; i < input[0].length; i++) {
      const x = Math.abs(input[0][i]);
      this.env = Math.max(x, this.env * 0.999);
      if (this.env > th) this.hold = 4800; else if (this.hold > 0) this.hold--;
      const target = this.hold > 0 ? 1 : 0;
      this.gain += (target - this.gain) * (target > this.gain ? 0.02 : 0.0008);
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = (input[ch] || input[0])[i] * this.gain;
    }
    return true;
  }
}
registerProcessor("fusion-gate", Gate);`;

/**
 * LN-01..15. Camera pipeline without a bundled ML model.
 *
 * Why not MediaPipe here: a segmentation model is a 2-10 MB download that would
 * break the install/offline budget and the no-surprise-network rule. So the
 * subject matte is a feathered ellipse positioned by FaceDetector when the
 * browser has it, and the UI grades the result "C — heuristic matte" instead of
 * claiming ML quality. The composite itself is genuinely GPU-accelerated:
 * ctx.filter blur runs on the compositor, not in JS.
 */
export default function LensModule(_: ModuleProps) {
  const shell = useShell();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const faceRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const detectorRef = useRef<{ detect: (s: CanvasImageSource) => Promise<{ boundingBox: DOMRectReadOnly }[]> } | null>(null);
  const frameCost = useRef<number[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [fx, setFx] = useState<Fx>(DEFAULT_FX);
  const [fps, setFps] = useState(0);
  const winStart = useRef(0);
  const winFrames = useRef(0);
  const [height, setHeight] = useState(720);
  const [err, setErr] = useState("");
  const [screenLayer, setScreenLayer] = useState<MediaStream | null>(null);
  const gateRef = useRef<AudioWorkletNode | null>(null);
  // LN-08: the gate's AudioContext is owned here so it can be closed again. Chromium
  // caps how many AudioContexts one document may hold open at once, so a module that
  // opens one per start and never closes it will eventually fail to build its gate
  // and silently degrade to the raw track.
  const acRef = useRef<AudioContext | null>(null);
  // Why the gate fell back, if it did. Surfaced on the element so a failure is
  // diagnosable instead of anonymous; empty string means the gate is live.
  const gateFallbackRef = useRef<string>("");
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const [gate, setGate] = useState(0.02);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    stream?.getTracks().forEach((t) => t.stop());
    screenLayer?.getTracks().forEach((t) => t.stop());
    gateRef.current = null;
    if (acRef.current) { void acRef.current.close().catch(() => {}); acRef.current = null; }
    setStream(null);
    setScreenLayer(null);
    shell.publishStream("lens", null);
  }, [stream, screenLayer, shell]);

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setErr("");
    try {
      const s = await userMedia("Lens", {
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setStream(s);
      const v = videoRef.current!;
      v.srcObject = s;
      await v.play();
      const FD = (window as unknown as { FaceDetector?: new (o: { fastMode: boolean }) => { detect: (s: CanvasImageSource) => Promise<{ boundingBox: DOMRectReadOnly }[]> } }).FaceDetector;
      if (FD) detectorRef.current = new FD({ fastMode: true });
      loop();
      const out = canvasRef.current!.captureStream(30);
      // LN-08: route the mic through the worklet gate; fall back to the raw track
      // Loading a worklet means fetching a blob URL and compiling it on the audio
      // thread; on a loaded machine that can lose a race that a second attempt wins.
      // Two bounded attempts, each fully cleaned up, then the honest raw-track fallback.
      gateFallbackRef.current = "";
      for (let attempt = 0; attempt < 2 && !gateRef.current; attempt++) {
        const url = URL.createObjectURL(new Blob([GATE_WORKLET], { type: "text/javascript" }));
        let ac: AudioContext | null = null;
        try {
          ac = new AudioContext({ latencyHint: "interactive" });
          await ac.audioWorklet.addModule(url);
          // A context that autoplay policy left suspended never pulls audio through.
          if (ac.state === "suspended") await ac.resume().catch(() => {});
          const node = new AudioWorkletNode(ac, "fusion-gate");
          const dest = ac.createMediaStreamDestination();
          ac.createMediaStreamSource(s).connect(node).connect(dest);
          dest.stream.getAudioTracks().forEach((t) => out.addTrack(t));
          gateRef.current = node;
          acRef.current = ac;
        } catch (e) {
          gateFallbackRef.current = `attempt ${attempt + 1}: ${String((e as Error)?.message ?? e)}`;
          if (ac) await ac.close().catch(() => {});
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!gateRef.current) s.getAudioTracks().forEach((t) => out.addTrack(t));
      // Make the outcome observable: "" when the gate is live, otherwise the reason.
      if (videoRef.current) videoRef.current.dataset.gateFallback = gateFallbackRef.current;
      shell.publishStream("lens", out);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const loop = useCallback(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const draw = (ts: number) => {
      const t0 = performance.now();
      const ctx = c.getContext("2d");
      if (!ctx || v.videoWidth === 0) { rafRef.current = requestAnimationFrame(draw); return; }
      // RG-01 ladder: resolution follows the governor, not a constant
      const target = Math.min(height, shell.gov.maxCastHeight);
      const scale = target / v.videoHeight;
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);

      ctx.save();
      if (fx.mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }

      // LN-05: bicubic upscale when output > input; the browser's drawImage uses
      // bilinear by default, so we set imageSmoothingQuality first.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // layer 1: background (optionally the shared screen), blurred
      ctx.filter = `blur(${fx.blur}px) brightness(${fx.brightness}) saturate(${fx.saturate})`;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      ctx.filter = "none";

      // layer 2: subject matte — feathered ellipse, positioned by FaceDetector when available
      const f = faceRef.current;
      const cx = f ? (f.x + f.w / 2) * scale : c.width / 2;
      const cy = f ? (f.y + f.h * 0.9) * scale : c.height * 0.56;
      const rx = (f ? f.w * 1.9 : c.width * 0.33) * scale * (fx.matte * 1.6);
      const ry = (f ? f.h * 2.4 : c.height * 0.62) * scale * (fx.matte * 1.6);
      ctx.save();
      const grad = ctx.createRadialGradient(cx, cy, Math.max(rx, ry) * 0.55, cx, cy, Math.max(rx, ry));
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      // FIX: reuse one mask canvas (v3.2 allocated a full-size canvas per frame)
      const mask = maskRef.current ?? (maskRef.current = document.createElement("canvas"));
      if (mask.width !== c.width || mask.height !== c.height) { mask.width = c.width; mask.height = c.height; }
      const mctx = mask.getContext("2d")!;
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.globalCompositeOperation = "source-over";
      mctx.clearRect(0, 0, mask.width, mask.height);
      mctx.filter = `brightness(${fx.brightness}) contrast(${fx.contrast}) saturate(${fx.saturate})`;
      if (fx.mirror) { mctx.translate(c.width, 0); mctx.scale(-1, 1); }
      mctx.drawImage(v, 0, 0, c.width, c.height);
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.globalCompositeOperation = "destination-in";
      mctx.fillStyle = grad;
      mctx.beginPath();
      mctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      mctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(mask, 0, 0);
      ctx.restore();
      ctx.restore();

      // LN-06 virtual key light: additive warm radial light centred on the subject
      if (fx.relight > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "soft-light";
        const kl = ctx.createRadialGradient(cx - rx * 0.35, cy - ry * 0.45, 0, cx, cy, Math.max(rx, ry) * 1.1);
        kl.addColorStop(0, `rgba(255,236,210,${fx.relight})`);
        kl.addColorStop(1, "rgba(255,236,210,0)");
        ctx.fillStyle = kl;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.restore();
      }

      if (fx.vignette) {
        const vg = ctx.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.72);
        vg.addColorStop(0, "rgba(0,0,0,0)");
        vg.addColorStop(1, "rgba(0,0,0,0.45)");
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, c.width, c.height);
      }

      const cost = performance.now() - t0;
      frameCost.current.push(cost);
      // TT15 FIX: report DELIVERED frames per wall-clock second over a ≥1 s window.
      // v3.x waited for 31 frames and reported 1000/avg-cost ("capacity"), so on a slow
      // software-rendered machine the badge sat at "0 fps" for seconds and, once shown,
      // overstated the real rate. Delivered fps is what the viewer actually receives.
      const now = performance.now();
      if (!winStart.current) winStart.current = now;
      winFrames.current++;
      if (now - winStart.current >= 1000) {
        setFps(Math.round((winFrames.current * 1000) / (now - winStart.current)));
        winStart.current = now; winFrames.current = 0;
        if (frameCost.current.length > 120) frameCost.current = frameCost.current.slice(-60);
      }
      shell.pulse(ts);
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
  }, [fx, height, shell]);

  // restart the loop when the effect chain changes (built once, not per frame)
  useEffect(() => {
    if (!stream) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    loop();
  }, [fx, height, stream, loop]);

  // face detection at 4 Hz, never per frame
  useEffect(() => {
    if (!stream || !detectorRef.current || !fx.autoframe) return;
    const t = window.setInterval(async () => {
      try {
        const faces = await detectorRef.current!.detect(videoRef.current!);
        const b = faces[0]?.boundingBox;
        faceRef.current = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
      } catch { faceRef.current = null; }
    }, 250);
    return () => window.clearInterval(t);
  }, [stream, fx.autoframe]);

  if (!capAvailable(shell.caps, "userMedia")) {
    return <div style={{ padding: 12 }}><Blocked what="Camera pipeline" missing="navigator.mediaDevices.getUserMedia" /></div>;
  }

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {stream ? <Btn variant="danger" onClick={stop}>Stop camera</Btn> : <Btn variant="primary" onClick={() => void start()}>Start camera</Btn>}
        <Btn variant="ghost" disabled={!capAvailable(shell.caps, "displayCapture")} onClick={async () => {
          try {
            const s = await displayMedia("Lens · presenter", { video: true });
            setScreenLayer(s);
            setFx((f) => ({ ...f, presenter: true }));
          } catch (e) { setErr(String((e as Error).message)); }
        }}>Presenter: add screen</Btn>
        <Badge tone={fps >= 24 ? "ok" : "warn"}>{fps} fps · {Math.min(height, shell.gov.maxCastHeight)}p</Badge>
        <Badge tone="warn" title="No segmentation model is bundled; the matte is heuristic.">matte grade C</Badge>
        <Badge tone={capAvailable(shell.caps, "faceDetector") ? "ok" : "warn"}>
          {capAvailable(shell.caps, "faceDetector") ? "FaceDetector present" : "no FaceDetector — centred matte"}
        </Badge>
      </div>

      {err ? <Badge tone="bad">{err}</Badge> : null}

      <div style={{ display: "grid", gridTemplateColumns: `minmax(0, 1fr) min(${fz(220)}, 40%)`, gap: 10 }}>
        <div>
          <canvas ref={canvasRef} style={{ width: "100%", background: "#000", borderRadius: 10 }} />
          <video ref={videoRef} muted playsInline style={{ display: "none" }} />
        </div>
        <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
          {([
            ["blur", 0, 30, 1], ["matte", 0.2, 1.2, 0.02], ["brightness", 0.5, 1.8, 0.01],
            ["contrast", 0.5, 1.8, 0.01], ["saturate", 0, 2, 0.01],
          ] as const).map(([k, min, max, step]) => (
            <label key={k} style={{ display: "grid", gap: 2 }}>
              <span className="fs-dim" style={{ fontSize: fz(11) }}>{k} — {String(fx[k])}</span>
              <input type="range" min={min} max={max} step={step} value={fx[k] as number}
                onChange={(e) => setFx({ ...fx, [k]: Number(e.target.value) })} />
            </label>
          ))}
          <label style={{ display: "grid", gap: 2 }}>
            <span className="fs-dim" style={{ fontSize: fz(11) }}>key light (LN-06) — {fx.relight.toFixed(2)}</span>
            <input type="range" min={0} max={0.8} step={0.02} value={fx.relight} onChange={(e) => setFx({ ...fx, relight: Number(e.target.value) })} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span className="fs-dim" style={{ fontSize: fz(11) }}>voice gate threshold (LN-08) — {gate.toFixed(3)}</span>
            <input type="range" min={0} max={0.12} step={0.002} value={gate} onChange={(e) => {
              const v = Number(e.target.value); setGate(v);
              const p = gateRef.current?.parameters.get("threshold");
              if (p) p.value = v;
            }} />
          </label>
          <Toggle label="Vignette" on={fx.vignette} onChange={(v) => setFx({ ...fx, vignette: v })} />
          <Toggle label="Mirror" on={fx.mirror} onChange={(v) => setFx({ ...fx, mirror: v })} />
          <Toggle label="Auto-frame (FaceDetector)" on={fx.autoframe} disabled={!capAvailable(shell.caps, "faceDetector")}
            reason="This browser has no FaceDetector" onChange={(v) => setFx({ ...fx, autoframe: v })} />
          <label style={{ display: "grid", gap: 2 }}>
            <span className="fs-dim" style={{ fontSize: fz(11) }}>output height</span>
            <select className="fs-select" value={height} onChange={(e) => setHeight(Number(e.target.value))}>
              {[1080, 720, 540, 360].map((h) => <option key={h} value={h}>{h}p</option>)}
            </select>
          </label>
        </div>
      </div>

      <Section title="Where this stream can go">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="ghost" disabled={!stream} onClick={() => shell.open("beam")}>Beam hub</Btn>
          <Btn variant="ghost" disabled={!stream} onClick={() => shell.open("together")}>Together room</Btn>
          <Btn variant="ghost" disabled={!stream} onClick={() => {
            const s = shell.streams.get("lens");
            if (!s) return;
            const rec = new MediaRecorder(s);
            const parts: Blob[] = [];
            rec.ondataavailable = (e) => parts.push(e.data);
            rec.onstop = () => {
              const url = URL.createObjectURL(new Blob(parts, { type: rec.mimeType }));
              const a = document.createElement("a"); a.href = url; a.download = `lens-${Date.now()}.webm`; a.click();
              URL.revokeObjectURL(url);
            };
            rec.start();
            shell.toast("Recording the processed stream for 10 s…", "info");
            window.setTimeout(() => rec.stop(), 10_000);
          }}>Record 10 s</Btn>
        </div>
        <Blocked what="Use Lens as a camera in other sites or native apps (a virtual camera)"
          missing="there is no web API to publish a MediaStream to another origin or to the OS; virtual cameras are a system-level privilege"
          workaround="Use the processed stream inside Fusion (Together, Beam, recording), or run a native virtual-camera tool outside the browser." />
      </Section>
    </div>
  );
}
