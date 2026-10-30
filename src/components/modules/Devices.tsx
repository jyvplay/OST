"use client";
import { userMedia } from "@/lib/access-log";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { fmtBytes, post } from "@/lib/api";
import { capAvailable } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Section, Tabs } from "../ui";
import { batteryLabel, type BatteryLike } from "@/lib/battery-status";
import { deviceInfoText } from "@/lib/device-info";

type Tab = "recorder" | "scan" | "color" | "audio" | "serial" | "peripherals" | "gamepad";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNav = Navigator & Record<string, any>;

export default function DevicesModule(_: ModuleProps) {
  const shell = useShell();
  const [tab, setTab] = useState<Tab>("recorder");
  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: "recorder", label: "Voice" }, { id: "scan", label: "QR scan" }, { id: "color", label: "Colour" },
        { id: "audio", label: "Audio devices" }, { id: "serial", label: "Serial" },
        { id: "peripherals", label: "HID/USB/BT" }, { id: "gamepad", label: "Gamepad" },
      ]} />
      <Section title="Battery" icon="battery">
        <BatteryCard />
        <Btn variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(deviceInfoText({ ua: navigator.userAgent, platform: (navigator as any).userAgentData?.platform ?? navigator.platform ?? "", cores: navigator.hardwareConcurrency, memory: (navigator as any).deviceMemory, touch: navigator.maxTouchPoints > 0, online: navigator.onLine })); shell.toast("Device info copied."); } catch { shell.toast("Clipboard unavailable.", "bad"); } }} data-testid="devices-copy-info">Copy device info</Btn>
      </Section>
      {tab === "recorder" ? <Recorder /> : null}
      {tab === "scan" ? <Scanner /> : null}
      {tab === "color" ? <ColorPicker /> : null}
      {tab === "audio" ? <AudioDevices /> : null}
      {tab === "serial" ? (capAvailable(shell.caps, "webserial") ? <SerialConsole /> :
        <Blocked what="Serial console" missing="navigator.serial (Web Serial)" workaround="Chromium-based desktop browsers implement it." />) : null}
      {tab === "peripherals" ? <Peripherals /> : null}
      {tab === "gamepad" ? <Gamepads /> : null}
    </div>
  );
}

/** MD-04: opus recording, committed to the VFS; a live level meter proves the input. */
function Recorder() {
  const shell = useShell();
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [level, setLevel] = useState(0);
  const [saved, setSaved] = useState("");
  const [ns, setNs] = useState(true);
  const chunks = useRef<Blob[]>([]);
  const raf = useRef(0);

  const start = async () => {
    const stream = await userMedia("Devices · Voice", { audio: { noiseSuppression: ns, echoCancellation: ns, autoGainControl: ns } });
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      setLevel(peak / 128); raf.current = requestAnimationFrame(tick);
    };
    tick();
    const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = async () => {
      setRec(null); // TT72: also when the tracks were stopped elsewhere (Privacy → Device access → Stop)
      cancelAnimationFrame(raf.current); void ctx.close(); stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks.current, { type: r.mimeType });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) { shell.toast("Recording exceeds the 8 MB store limit — not stored.", "bad"); return; }
      let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
      const path = `/Documents/voice-${Date.now()}.${r.mimeType.includes("mp4") ? "m4a" : "webm"}`;
      await post("/api/fs", { op: "upload", path, content: btoa(bin), mime: r.mimeType.split(";")[0] });
      setSaved(`${path} · ${fmtBytes(bytes.length)}`); shell.bumpRefresh();
    };
    r.start(500); setRec(r);
  };

  return (
<Section title="Voice recorder (MD-04)">
      <label className="fs-row" style={{ gap: 6, fontSize: fz(12) }}>
        <input type="checkbox" checked={ns} onChange={(e) => setNs(e.target.checked)} disabled={Boolean(rec)} />
        browser DSP: noise suppression + echo cancellation + AGC
      </label>
      <div className="fs-row" style={{ gap: 6 }}>
        {rec ? <Btn variant="danger" onClick={() => { rec.stop(); setRec(null); }}>⏹ Stop</Btn>
          : <Btn variant="primary" disabled={!capAvailable(shell.caps, "userMedia")} onClick={() => void start().catch((e) => shell.toast(String(e.message), "bad"))}>⏺ Record</Btn>}
        <div style={{ flex: 1, height: 8, background: "rgba(255,255,255,.08)", borderRadius: 4, overflow: "hidden" }} role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, level * 140))}>
          <div style={{ width: `${Math.min(100, level * 140)}%`, height: "100%", background: level > .7 ? "var(--fs-bad)" : "var(--fs-ok)" }} />
        </div>
      </div>
      {saved ? <Badge tone="ok">saved {saved}</Badge> : null}
    </Section>
  );
}

/** MD-05: BarcodeDetector when present; never a bundled decoder. */
function Scanner() {
  const shell = useShell();
  const video = useRef<HTMLVideoElement | null>(null);
  const [result, setResult] = useState("");
  const [running, setRunning] = useState(false);
  const has = capAvailable(shell.caps, "barcode");

  useEffect(() => {
    if (!running) return;
    let stop = false; let stream: MediaStream | null = null;
    (async () => {
      stream = await userMedia("Devices · Scan", { video: { facingMode: "environment" } });
      video.current!.srcObject = stream; await video.current!.play();
      const det = new (window as any).BarcodeDetector({ formats: ["qr_code", "ean_13", "code_128"] });
      while (!stop) {
        try {
          const codes = await det.detect(video.current);
          if (codes[0]) { setResult(codes[0].rawValue); break; }
        } catch { /* frame not ready */ }
        await new Promise((r) => setTimeout(r, 250));
      }
    })().catch((e) => shell.toast(String(e.message), "bad"));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [running, shell]);

  if (!has) return <Blocked what="QR / barcode scanning" missing="BarcodeDetector (Shape Detection API)" workaround="Paste the code manually; Chrome on Android and ChromeOS implement it." />;
  return (
    <Section title="QR / barcode (MD-05)">
      <Btn variant={running ? "danger" : "primary"} onClick={() => { setResult(""); setRunning((r) => !r); }}>{running ? "Stop" : "Scan"}</Btn>
      <video ref={video} muted playsInline style={{ width: "100%", maxHeight: 240, background: "#000", borderRadius: 8 }} />
      {result ? (
        <div className="fs-row" style={{ gap: 6 }}>
          <span className="fs-mono" style={{ fontSize: fz(12), wordBreak: "break-all" }}>{result}</span>
          <Btn variant="ghost" onClick={() => void shell.copy(result, "scanner")}>Copy</Btn>
          {/^https?:\/\//.test(result) ? <Btn variant="ghost" onClick={() => shell.open("browser", { url: result })}>Open</Btn> : null}
        </div>
      ) : null}
    </Section>
  );
}

/** MD-07: EyeDropper samples the whole screen; fallback is a native colour input, not a fake. */
function ColorPicker() {
  const shell = useShell();
  const [colors, setColors] = useState<string[]>([]);
  const add = (c: string) => setColors((cs) => [c, ...cs.filter((x) => x !== c)].slice(0, 16));
  return (
    <Section title="Colour picker (MD-07)">
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="primary" disabled={!capAvailable(shell.caps, "eyeDropper")}
          title={capAvailable(shell.caps, "eyeDropper") ? "Pick any pixel on screen" : "EyeDropper unavailable in this browser"}
          onClick={async () => { try { const r = await new (window as any).EyeDropper().open(); add(r.sRGBHex); } catch { /* cancelled */ } }}>
          Pick from screen
        </Btn>
        <input type="color" data-testid="md07-input" aria-label="Choose colour" onChange={(e) => add(e.target.value)} />
        {!capAvailable(shell.caps, "eyeDropper") ? <Badge tone="warn">no EyeDropper — palette input only</Badge> : null}
      </div>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {colors.map((c) => (
          <button key={c} className="fs-btn" data-testid={`swatch-${c}`} onClick={() => void shell.copy(c, "color")} title="Copy">
            <span style={{ width: 14, height: 14, borderRadius: 3, background: c, display: "inline-block" }} />{c}
          </button>
        ))}
      </div>
    </Section>
  );
}

/** MD-06: real per-element output routing (setSinkId) with a test tone. */
function AudioDevices() {
  const shell = useShell();
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  const refresh = () => navigator.mediaDevices?.enumerateDevices().then(setDevs).catch(() => undefined);
  useEffect(() => { void refresh(); navigator.mediaDevices?.addEventListener?.("devicechange", refresh); return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh); }, []);
  const tone = async (sinkId: string) => {
    const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (ctx.setSinkId) await ctx.setSinkId(sinkId).catch(() => undefined);
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 523; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.start(); o.stop(ctx.currentTime + 0.6);
  };
  return (
    <Section title="Audio devices (MD-06)" right={<Btn variant="ghost" onClick={async () => {
      try { (await userMedia("Devices · Reveal labels", { audio: true })).getTracks().forEach((t) => t.stop()); await refresh(); }
      catch (e) { shell.toast(String((e as Error).message), "bad"); }
    }}>Reveal labels</Btn>}>
      {devs.map((d) => (
        <div key={d.kind + d.deviceId} className="fs-row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: fz(12) }}>{d.kind === "audiooutput" ? "🔊" : d.kind === "audioinput" ? "🎙" : "📷"} {d.label || "(label hidden until a permission is granted)"}</span>
          {d.kind === "audiooutput" ? <Btn variant="ghost" onClick={() => void tone(d.deviceId)}>Test tone</Btn> : null}
        </div>
      ))}
      <div className="fs-dim" style={{ fontSize: fz(11) }}>Labels are withheld by the browser until a media permission exists — a fingerprinting defence, not a bug.</div>
    </Section>
  );
}

/** TD-03: Web Serial console with line discipline and baud selection. */
function SerialConsole() {
  const shell = useShell();
  const [port, setPort] = useState<any>(null);
  const [log, setLog] = useState("");
  const [line, setLine] = useState("");
  const [baud, setBaud] = useState(115200);
  const writer = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const reading = useRef(false);

  const connect = async () => {
    const p = await (navigator as AnyNav).serial.requestPort();
    await p.open({ baudRate: baud });
    setPort(p);
    writer.current = p.writable.getWriter();
    reading.current = true;
    const reader = p.readable.getReader();
    const dec = new TextDecoder();
    (async () => {
      while (reading.current) {
        const { value, done } = await reader.read();
        if (done) break;
        setLog((l) => (l + dec.decode(value)).slice(-20000));
      }
      reader.releaseLock();
    })().catch((e) => setLog((l) => `${l}\n[read error] ${e.message}`));
  };

  return (
    <Section title="Serial console (TD-03)">
      <div className="fs-row" style={{ gap: 6 }}>
        <select className="fs-select" style={{ width: fz(120) }} value={baud} onChange={(e) => setBaud(Number(e.target.value))} disabled={Boolean(port)}>
          {[9600, 19200, 57600, 115200, 230400, 921600].map((b) => <option key={b} value={b}>{b} baud</option>)}
        </select>
        {port ? <Btn variant="danger" onClick={async () => { reading.current = false; writer.current?.releaseLock(); await port.close().catch(() => undefined); setPort(null); }}>Disconnect</Btn>
          : <Btn variant="primary" onClick={() => void connect().catch((e) => shell.toast(String(e.message), "bad"))}>Connect…</Btn>}
      </div>
      <pre className="fs-mono" style={{ background: "#05080f", padding: 8, borderRadius: 8, height: 180, overflow: "auto", fontSize: fz(11.5), margin: 0 }}>{log || "(no data)"}</pre>
      <input className="fs-input fs-mono" placeholder="send line (CRLF appended)" value={line} disabled={!port}
        onChange={(e) => setLine(e.target.value)}
        onKeyDown={async (e) => { if (e.key === "Enter" && writer.current) { await writer.current.write(new TextEncoder().encode(`${line}\r\n`)); setLine(""); } }} />
      <div className="fs-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="fs-dim" style={{ fontSize: fz(11), flex: 1, minWidth: 200 }}>Serial uses Web Serial, a device API you grant per port. Remote machines over the network: SSH and SFTP have their own window (the host key is checked before any password is sent).</span>
        <Btn onClick={() => shell.open("ssh")}>Open SSH…</Btn>
      </div>
    </Section>
  );
}

/** CT-06: list only previously granted devices on load (getDevices), request on gesture. */
function Peripherals() {
  const shell = useShell();
  const nav = navigator as AnyNav;
  const [list, setList] = useState<string[]>([]);
  const refresh = async () => {
    const out: string[] = [];
    if (nav.hid) for (const d of await nav.hid.getDevices()) out.push(`HID · ${d.productName} (${d.vendorId.toString(16)}:${d.productId.toString(16)})`);
    if (nav.usb) for (const d of await nav.usb.getDevices()) out.push(`USB · ${d.productName ?? "device"} (${d.vendorId.toString(16)}:${d.productId.toString(16)})`);
    if (nav.serial) for (const _p of await nav.serial.getPorts()) out.push("Serial · granted port");
    setList(out);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const req = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { shell.toast(String((e as Error).message), "warn"); } };
  return (
    <Section title="Peripherals (CT-06)">
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn disabled={!nav.hid} onClick={() => void req(() => nav.hid.requestDevice({ filters: [] }))}>Grant HID…</Btn>
        <Btn disabled={!nav.usb} onClick={() => void req(() => nav.usb.requestDevice({ filters: [] }))}>Grant USB…</Btn>
        <Btn disabled={!nav.bluetooth} onClick={() => void req(async () => { const d = await nav.bluetooth.requestDevice({ acceptAllDevices: true }); shell.toast(`Bluetooth: ${d.name ?? d.id}`, "ok"); })}>Pick Bluetooth…</Btn>
      </div>
      {list.map((l) => <div key={l} style={{ fontSize: fz(12) }}>{l}</div>)}
      {list.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>No devices granted to this origin yet.</div> : null}
      <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
        {(["webhid", "webusb", "webserial", "bluetooth"] as const).map((c) => <Badge key={c} tone={capAvailable(shell.caps, c) ? "ok" : "bad"}>{c}</Badge>)}
      </div>
    </Section>
  );
}

/** IN-07: polled inside rAF only while this tab is visible. */
function Gamepads() {
  const [pads, setPads] = useState<{ id: string; axes: number[]; buttons: number[] }[]>([]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const list = Array.from(navigator.getGamepads?.() ?? []).filter(Boolean) as Gamepad[];
      setPads(list.map((g) => ({ id: g.id, axes: g.axes.map((a) => Math.round(a * 100) / 100), buttons: g.buttons.map((b) => b.value) })));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <Section title="Gamepad (IN-07)">
      {pads.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>Connect a controller and press any button (browsers hide pads until first input).</div> : null}
      <div data-testid="gp-help" style={{ display: "grid", gap: 4, fontSize: fz(11.5) }}>
        <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <b>Pointer mode</b>
          <span>On while a controller is connected — Start turns it on / off.</span>
          <button className="fs-btn" data-variant="ghost" data-testid="gp-toggle" disabled={pads.length === 0} onClick={() => dispatchEvent(new Event("fusion:gamepad-toggle"))}>Toggle pointer mode</button>
        </div>
        <span className="fs-dim">Left stick moves the pointer (fine near the centre), d-pad nudges 1 px, A clicks, X right-clicks, B is Escape, LB / RB move keyboard focus (the pointer follows), right stick scrolls. Not reachable: embedded players and Private proxy pages (cross-origin / sandboxed frames), native drop-down lists; dragging windows is not mapped.</span>
      </div>
      {pads.map((p) => (
        <div key={p.id} style={{ display: "grid", gap: 4 }}>
          <strong style={{ fontSize: fz(12) }}>{p.id}</strong>
          <div className="fs-mono" style={{ fontSize: fz(11) }}>axes {p.axes.join("  ")}</div>
          <div className="fs-row" style={{ gap: 3, flexWrap: "wrap" }}>
            {p.buttons.map((b, i) => <Badge key={i} tone={b > 0.5 ? "ok" : "default"}>{i}</Badge>)}
          </div>
        </div>
      ))}
    </Section>
  );
}

/** DV-01: the browser battery API where offered; stated, never faked, where not. */
function BatteryCard() {
  const [b, setB] = useState<BatteryLike | null>(null);
  const [state, setState] = useState("checking…");
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike & { addEventListener?: (t: string, f: () => void) => void }> };
    if (typeof nav.getBattery !== "function") { setState("Battery API not offered by this browser — charge state cannot be read from a web app here."); return; }
    let live = true;
    void nav.getBattery().then((bat) => {
      if (!live) return;
      const read = () => setB({ level: bat.level, charging: bat.charging, chargingTime: bat.chargingTime, dischargingTime: bat.dischargingTime });
      read();
      bat.addEventListener?.("levelchange", read);
      bat.addEventListener?.("chargingchange", read);
    }).catch(() => setState("Battery API refused."));
    return () => { live = false; };
  }, []);
  return b ? <Badge tone={b.charging ? "ok" : "info"} data-testid="devices-battery">{batteryLabel(b)}</Badge> : <span className="fs-dim" style={{ fontSize: fz(11.5) }}>{state}</span>;
}
