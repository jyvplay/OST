"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";
import { validateAlarms, nextFire, upcomingAlarms, lapStats, daysBetween, addDays, businessDaysBetween, type Alarm } from "@/lib/clock-core";

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
  const [timerSec, setTimerSec] = useState(0);
  const timerMs = (timerMin * 60 + timerSec) * 1000;
  const fired = useRef(false);
  const zones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney"];
  // TT117 CK-01: alarms persist browser-local (a closed web app cannot fire them; stated below).
  const [alarms, setAlarms] = useState<Alarm[]>(() => { try { return validateAlarms(JSON.parse(localStorage.getItem("fusion.alarms.v1") ?? "[]")); } catch { return []; } });
  const [alarmTime, setAlarmTime] = useState("07:30");
  const [alarmLabel, setAlarmLabel] = useState("");
  const [dateA, setDateA] = useState(() => new Date().toISOString().slice(0, 10));
  const [dateB, setDateB] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  useEffect(() => { try { localStorage.setItem("fusion.alarms.v1", JSON.stringify(alarms)); } catch { /* private mode */ } }, [alarms]);
  const firedAlarms = useRef(new Set<string>());
  useEffect(() => {
    const t = window.setInterval(() => {
      const nowD = new Date();
      for (const a of alarms) {
        const at = nextFire(a, new Date(nowD.getTime() - 60000));
        const key = `${a.id}@${at?.getTime() ?? 0}`;
        if (at && Math.abs(at.getTime() - nowD.getTime()) < 60000 && at <= nowD && !firedAlarms.current.has(key)) {
          firedAlarms.current.add(key);
          shell.toast(`Alarm: ${a.label || a.time}`, "ok");
          if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(`Alarm: ${a.label || a.time}`);
        }
      }
    }, 5000);
    return () => window.clearInterval(t);
  }, [alarms, shell]);

  useEffect(() => {
    let raf = 0;
    let t: number | undefined;
    let due: number | undefined;
    const running = swStart !== null || timerEnd !== null;
    if (running) {
      const loop = () => { setNow(performance.now()); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      // TT57: rAF stops in a hidden tab, so a running timer also gets ONE timeout at its end time (a lone timeout is only
      // clamped to ~1 s when hidden, unlike chained ticks) — the alarm fires on time behind other tabs; display stays rAF
      if (timerEnd !== null) due = window.setTimeout(() => setNow(performance.now()), Math.max(0, timerEnd - performance.now()) + 5);
    } else {
      t = window.setInterval(() => setNow(performance.now()), 1000); // idle: 1 Hz, no rAF (RG-03)
    }
    return () => { cancelAnimationFrame(raf); if (t) window.clearInterval(t); if (due) window.clearTimeout(due); };
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
        <div className="fs-mono" data-testid="clock-sw" style={{ fontSize: fz(30) }}>{fmt(sw)}</div>
        <div className="fs-row" style={{ gap: 6 }}>
          {swStart === null
            ? <Btn variant="primary" onClick={() => setSwStart(performance.now())}>Start<span className="sr-only"> stopwatch</span></Btn>
            : <Btn onClick={() => { setSwAcc(sw); setSwStart(null); }}>Pause</Btn>}
          <Btn variant="ghost" disabled={swStart === null} onClick={() => setLaps((l) => [sw, ...l])}>Lap</Btn>
          <Btn variant="ghost" onClick={() => { setSwStart(null); setSwAcc(0); setLaps([]); }}>Reset</Btn>
        </div>
        {laps.map((l, i) => <div key={i} data-testid="clock-lap" className="fs-mono fs-dim" style={{ fontSize: fz(11.5) }}>lap {laps.length - i}: {fmt(l)}</div>)}
        {laps.length > 1 ? (() => { const st = lapStats([...laps].reverse()); return <div className="fs-dim" data-testid="clock-lap-stats" style={{ fontSize: fz(11) }}>fastest lap {st.fastest!.index} ({fmt(st.fastest!.splitMs)}) · slowest lap {st.slowest!.index} ({fmt(st.slowest!.splitMs)}) · average split {fmt(Math.round(st.averageSplitMs))}</div>; })() : null}
      </Section>

      <Section title="Alarms">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input className="fs-input" type="time" style={{ width: fz(110) }} value={alarmTime} onChange={(e) => setAlarmTime(e.target.value)} aria-label="Alarm time" />
          <input className="fs-input" style={{ flex: 1, minWidth: fz(120) }} placeholder="Label" value={alarmLabel} onChange={(e) => setAlarmLabel(e.target.value)} aria-label="Alarm label" />
          <Btn variant="primary" onClick={() => { try { setAlarms((a) => validateAlarms([...a, { id: `a${Date.now().toString(36)}`, label: alarmLabel, time: alarmTime, days: [], enabled: true, snoozeMin: 9 }])); setAlarmLabel(""); } catch (e) { shell.toast(String((e as Error).message), "warn"); } }}>Add<span className="sr-only"> alarm</span></Btn>
        </div>
        {upcomingAlarms(alarms, new Date()).slice(0, 1).map(({ alarm, at }) => <Badge key={alarm.id} tone="info">next: {alarm.label || alarm.time} · {at.toLocaleString()}</Badge>)}
        {alarms.map((a) => { const at = nextFire(a, new Date()); return (
          <div key={a.id} className="fs-row" style={{ justifyContent: "space-between", gap: 6 }}>
            <span style={{ fontSize: fz(12) }}>{a.time} {a.label} <span className="fs-dim">{a.days.length ? a.days.map((d) => "SMTWTFS"[d]).join(" ") : "daily"}{at ? ` · next ${at.toLocaleString()}` : ""}</span></span>
            <span className="fs-row" style={{ gap: 4 }}>
              <Btn variant="ghost" aria-pressed={a.enabled} onClick={() => setAlarms((l) => l.map((x) => x.id === a.id ? { ...x, enabled: !x.enabled } : x))}>{a.enabled ? "On" : "Off"}</Btn>
              <Btn variant="ghost" onClick={() => setAlarms((l) => l.filter((x) => x.id !== a.id))}>Remove<span className="sr-only"> alarm {a.label || a.time}</span></Btn>
            </span>
          </div> ); })}
        <div className="fs-dim" style={{ fontSize: fz(11) }}>Alarms fire while Fusion is open; a closed web app cannot schedule an exact alarm. No weekday picked means every day.</div>
      </Section>

      <Section title="Date calculator">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input className="fs-input" type="date" value={dateA} onChange={(e) => setDateA(e.target.value)} aria-label="From date" />
          <input className="fs-input" type="date" value={dateB} onChange={(e) => setDateB(e.target.value)} aria-label="To date" />
          {dateA && dateB ? <Badge tone="info">{daysBetween(new Date(dateA + "T00:00:00"), new Date(dateB + "T00:00:00"))} days · {businessDaysBetween(new Date(dateA + "T00:00:00"), new Date(dateB + "T00:00:00"))} business days</Badge> : null}
          <Btn variant="ghost" onClick={() => { if (dateA) setDateB(addDays(new Date(dateA + "T00:00:00"), 30).toISOString().slice(0, 10)); }}>+30 days</Btn>
        </div>
      </Section>

      <Section title="Timer" right={remaining !== null ? <Badge tone="warn">running</Badge> : null}>
        <div className="fs-mono" data-testid="clock-timer" style={{ fontSize: fz(30) }}>{remaining !== null ? fmt(Math.max(0, remaining)) : fmt(timerMs)}</div>
        <div className="fs-row" style={{ gap: 6 }}>
          <input className="fs-input" type="number" min={0} max={600} style={{ width: fz(90) }} value={timerMin}
            onChange={(e) => setTimerMin(Math.max(0, Math.min(600, Math.trunc(Number(e.target.value)) || 0)))} aria-label="Minutes" />
          <input className="fs-input" type="number" min={0} max={59} style={{ width: fz(70) }} value={timerSec}
            onChange={(e) => setTimerSec(Math.max(0, Math.min(59, Math.trunc(Number(e.target.value)) || 0)))} aria-label="Seconds" />
          {remaining === null
            ? <Btn variant="primary" disabled={timerMs <= 0} onClick={() => { fired.current = false; setTimerEnd(performance.now() + timerMs); }}>Start<span className="sr-only"> timer</span></Btn>
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
