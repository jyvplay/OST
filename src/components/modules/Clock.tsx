"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";

const fmt = (ms: number) => {
  const neg = ms < 0;
  const t = Math.abs(ms);
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${neg ? "-" : ""}${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

/**
 * PR-10. Elapsed time is derived from performance.now() anchors, never from
 * counting setInterval ticks: background tabs are throttled to ~1 Hz (or frozen),
 * so tick-counting drifts by minutes; anchor arithmetic is exact on wake.
 */
export default function ClockModule(_: ModuleProps) {
  const shell = useShell();
  const [now, setNow] = useState(() => performance.now());
  const [swStart, setSwStart] = useState<number | null>(null);
  const [swAcc, setSwAcc] = useState(0);
  const [laps, setLaps] = useState<number[]>([]);
  const [timerEnd, setTimerEnd] = useState<number | null>(null);
  const [timerMin, setTimerMin] = useState(5);
  const fired = useRef(false);
  const zones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney"];

  useEffect(() => {
    let raf = 0;
    let t: number | undefined;
    const running = swStart !== null || timerEnd !== null;
    if (running) {
      const loop = () => { setNow(performance.now()); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    } else {
      t = window.setInterval(() => setNow(performance.now()), 1000); // idle: 1 Hz, no rAF (RG-03)
    }
    return () => { cancelAnimationFrame(raf); if (t) window.clearInterval(t); };
  }, [swStart, timerEnd]);

  const sw = swAcc + (swStart !== null ? now - swStart : 0);
  const remaining = timerEnd !== null ? timerEnd - now : null;

  useEffect(() => {
    if (remaining !== null && remaining <= 0 && !fired.current) {
      fired.current = true;
      setTimerEnd(null);
      shell.toast("Timer finished", "ok");
      if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Fusion timer finished");
      try {
        const ctx = new AudioContext();
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.2, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        o.start(); o.stop(ctx.currentTime + 0.8);
      } catch { /* audio needs a prior gesture; the toast is the fallback */ }
    }
  }, [remaining, shell]);

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="World clock">
        {zones.map((z) => (
          <div key={z} className="fs-row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: fz(12) }}>{z.replace("_", " ")}</span>
            <span className="fs-mono">{new Date().toLocaleTimeString([], { timeZone: z, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          </div>
        ))}
      </Section>

      <Section title="Stopwatch">
        <div className="fs-mono" style={{ fontSize: fz(30) }}>{fmt(sw)}</div>
        <div className="fs-row" style={{ gap: 6 }}>
          {swStart === null
            ? <Btn variant="primary" onClick={() => setSwStart(performance.now())}>Start</Btn>
            : <Btn onClick={() => { setSwAcc(sw); setSwStart(null); }}>Pause</Btn>}
          <Btn variant="ghost" disabled={swStart === null} onClick={() => setLaps((l) => [sw, ...l])}>Lap</Btn>
          <Btn variant="ghost" onClick={() => { setSwStart(null); setSwAcc(0); setLaps([]); }}>Reset</Btn>
        </div>
        {laps.map((l, i) => <div key={i} className="fs-mono fs-dim" style={{ fontSize: fz(11.5) }}>lap {laps.length - i}: {fmt(l)}</div>)}
      </Section>

      <Section title="Timer" right={remaining !== null ? <Badge tone="warn">running</Badge> : null}>
        <div className="fs-mono" style={{ fontSize: fz(30) }}>{remaining !== null ? fmt(Math.max(0, remaining)) : fmt(timerMin * 60_000)}</div>
        <div className="fs-row" style={{ gap: 6 }}>
          <input className="fs-input" type="number" min={1} max={600} style={{ width: fz(90) }} value={timerMin}
            onChange={(e) => setTimerMin(Number(e.target.value) || 1)} aria-label="Minutes" />
          {remaining === null
            ? <Btn variant="primary" onClick={() => { fired.current = false; setTimerEnd(performance.now() + timerMin * 60_000); }}>Start</Btn>
            : <Btn variant="danger" onClick={() => setTimerEnd(null)}>Cancel</Btn>}
        </div>
        <div className="fs-dim" style={{ fontSize: fz(11) }}>
          Fires while Fusion is open. A closed web app cannot schedule an exact alarm (Notification Triggers never
          shipped), so this is stated rather than implied.
        </div>
      </Section>
    </div>
  );
}
