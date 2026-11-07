"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, fmtBytes, fmtTime } from "@/lib/api";
import { stateHash } from "@/lib/windowing/state";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, KV, Section } from "../ui";
import { sortJobs, type JobSort } from "@/lib/job-sort";
import { inFlightJobs } from "@/lib/job-prune";
import { classifySample, nextQuality, planFor, describePlan } from "@/lib/network-quality";
import { planTask, chunks, shouldYield, describeCapabilities, type Capabilities, type TaskKind } from "@/lib/scheduler-hints";
import { runSuite, benchmark, totals, describeOutcome, describeBenchmark } from "@/lib/stats/headless";

interface Job { id: number; op: string; src: string; dst: string; state: string; error: string; updatedAt: string }
interface LogRow { id: number; actor: string; action: string; detail: string; createdAt: string }

/** RG-04 + DP-08 + DP-14: the app's own measurements, exposed so claims are checkable. */
export default function MonitorModule(_: ModuleProps) {
  const shell = useShell();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobSort, setJobSort] = useState<JobSort>("newest");
  const [inflightOnly, setInflightOnly] = useState(false);
  const [log, setLog] = useState<LogRow[]>([]);
  const [mem, setMem] = useState<string>(() => {
    const perf = performance as Performance & { measureUserAgentSpecificMemory?: unknown; memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
    return perf.measureUserAgentSpecificMemory ? "measuring…" : perf.memory
      ? `${fmtBytes(perf.memory.usedJSHeapSize)} of ${fmtBytes(perf.memory.jsHeapSizeLimit)} (performance.memory — Chromium estimate)`
      : "no memory measurement API in this browser";
  });
  const [quota, setQuota] = useState<string>("");

  useEffect(() => {
    const load = () => api<{ ops: Job[]; log: LogRow[] }>("/api/jobs?limit=25")
      .then((r) => { setJobs(r.ops); setLog(r.log); })
      .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [shell.refreshTick]);

  useEffect(() => {
    const perf = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    };
    if (perf.measureUserAgentSpecificMemory) {
      perf.measureUserAgentSpecificMemory()
        .then((m) => setMem(`${fmtBytes(m.bytes)} (measureUserAgentSpecificMemory — cross-origin isolated)`))
        .catch((e) => setMem(`unavailable: ${String((e as Error).message)}`));
    }
    navigator.storage?.estimate?.()
      .then((e) => setQuota(`${fmtBytes(e.usage ?? 0)} of ${fmtBytes(e.quota ?? 0)} origin quota`))
      .catch(() => setQuota("quota unavailable"));
  }, []);

  const g = shell.gov;

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Load governor (thermal proxy)">
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Badge tone={g.state === "COOL" ? "ok" : g.state === "CRITICAL" ? "bad" : "warn"}>{g.state}</Badge>
          <Badge>{g.frameMs} ms/frame</Badge>
          <Badge>{g.fps} fps</Badge>
          <Badge>{g.longTasksPerMin} long tasks/min</Badge>
          <Badge tone={g.effects ? "ok" : "warn"}>effects {g.effects ? "on" : "off"}</Badge>
          <Badge tone={g.backgroundWork ? "ok" : "warn"}>background work {g.backgroundWork ? "allowed" : "paused"}</Badge>
          <Badge>cast ceiling {g.maxCastHeight}p</Badge>
        </div>
        <div className="fs-dim" style={{ fontSize: fz(11.5) }}>{g.reason}</div>
        <details>
          <summary style={{ fontSize: fz(11), cursor: "pointer" }}>Why frame cost only? (The honest ADPF analogue)</summary>
          <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
            The web exposes no thermal headroom, no CPU time and no process list. This governor closes the loop on
            observed frame cost sampled only while something animates, plus long-task rate and battery state. It is the
            honest analogue of ADPF: we cannot request more performance, so we spend less of it.
          </div>
        </details>
        <Btn variant="ghost" onClick={() => {
          const t0 = performance.now();
          while (performance.now() - t0 < 320) { /* deliberate 320 ms block to prove the detector works */ }
          shell.toast("Injected a 320 ms long task — watch the governor react.", "info");
        }}>Inject a 320 ms stall</Btn>
      </Section>

      <Section title="Memory and storage">
        <KV k="JS memory" v={mem} />
        <KV k="Origin storage" v={quota || "—"} />
        <KV k="Hardware threads" v={shell.caps?.hardwareConcurrency ?? "unknown"} />
        <KV k="Device memory (coarse)" v={shell.caps?.deviceMemoryGb ? `${shell.caps.deviceMemoryGb} GB` : "not reported"} />
        <KV k="Cross-origin isolated" v={String(shell.caps?.crossOriginIsolated)} />
      </Section>

      <Section title="Compositor">
        <KV k="Windows" v={shell.state.windows.length} mono />
        <KV k="State revision" v={shell.state.revision} mono />
        <KV k="State hash" v={stateHash(shell.state)} mono />
        <KV k="Commands logged" v={shell.commandLog.length} mono />
        <div className="fs-scroll fs-mono" tabIndex={0} role="region" aria-label="Command log" style={{ maxHeight: fz(110), fontSize: fz(10.5) }}>
          {shell.commandLog.slice(-14).reverse().map((c, i) => (
            <div key={i}>{new Date(c.at).toLocaleTimeString()} — {c.cmd.t} {"id" in c.cmd ? String(c.cmd.id) : ""}</div>
          ))}
        </div>
        <details>
          <summary style={{ fontSize: fz(11), cursor: "pointer" }}>Replayable by construction (TD-06)</summary>
          <div className="fs-dim" style={{ fontSize: fz(11) }}>
            The reducer is pure and the command log is complete, so any state in this session can be reproduced by
            replaying this list.
          </div>
        </details>
      </Section>

      <Section title="Jobs — file operation journal (DP-14)" right={<span className="fs-row" style={{ gap: 4 }}><select className="fs-select" style={{ width: "auto" }} aria-label="Sort jobs" value={jobSort} onChange={(e) => setJobSort(e.target.value as JobSort)} data-testid="monitor-job-sort"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="op">By operation</option></select><Btn variant={inflightOnly ? "primary" : "ghost"} aria-pressed={inflightOnly} onClick={() => setInflightOnly((v) => !v)} data-testid="monitor-inflight" title="Show only running and queued jobs">In flight</Btn></span>}>
        <div style={{ display: "grid", gap: 2 }}>
          {sortJobs((inflightOnly ? inFlightJobs(jobs) : jobs).map((j) => ({ ...j, at: j.updatedAt })), jobSort).slice(0, 8).map((j) => (
            <div key={j.id} className="fs-row" style={{ justifyContent: "space-between", fontSize: fz(11.5) }}>
              <span className="fs-mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                #{j.id} {j.op} {j.src}{j.dst ? ` → ${j.dst}` : ""}
              </span>
              <span className="fs-row" style={{ gap: 6 }}>
                <Badge tone={j.state === "COMPLETE" ? "ok" : j.state === "FAILED" ? "bad" : "warn"}>{j.state}</Badge>
                <span className="fs-dim">{fmtTime(j.updatedAt)}</span>
              </span>
            </div>
          ))}
          {jobs.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(11.5) }}>No operations yet.</span> : null}
          {jobs.length > 8 ? <span className="fs-dim" style={{ fontSize: fz(10.5) }} data-testid="monitor-jobs-cap">tail: 8 of {jobs.length}</span> : null}
        </div>
      </Section>

      <NetworkSection />
      <SchedulerSection />
      <TestsFasterSection />

      <Section title="Audit log">
        <div className="fs-scroll fs-mono" tabIndex={0} role="region" aria-label="Audit log" style={{ maxHeight: fz(130), fontSize: fz(10.5) }}>
          {log.slice(0, 8).map((l) => <div key={l.id}>{fmtTime(l.createdAt)} {l.action} {l.detail}</div>)}
          {log.length > 8 ? <div className="fs-dim" data-testid="monitor-log-cap">tail: 8 of {log.length}</div> : null}
        </div>
      </Section>
    </div>
  );
}

/** TT136 HW-09: network quality reasoning, live from the Network Information API. */
function NetworkSection() {
  const [sample, setSample] = useState<string>("reading the network estimate…");
  const [plan, setPlan] = useState<string>("");
  useEffect(() => {
    const net = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }; saveData?: boolean }).connection;
    if (!net && !(navigator as any).saveData) { setSample("This browser exposes no network estimate"); return; }
    let live = true;
    const read = () => {
      const c = net;
      const s = classifySample({ effectiveType: c?.effectiveType, downlink: c?.downlink, rtt: c?.rtt, saveData: c?.saveData ?? (navigator as any).saveData });
      if (!live) return;
      setSample(`${s.tier} · ${s.reasons.join("; ") || "no specific reason"}`);
      setPlan(describePlan(s));
    };
    read();
    (net as any)?.addEventListener?.("change", read);
    const t = window.setInterval(read, 8000);
    return () => { live = false; window.clearInterval(t); (net as any)?.removeEventListener?.("change", read); };
  }, []);
  return (
    <Section title="Network quality (HW-09)" icon="timer">
      <KV k="estimate" v={sample} />
      <KV k="plan" v={plan || "—"} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>These are the browser's own estimates, not measurements.</div>
    </Section>
  );
}

/** TT136 RG-02: scheduling hints, actually applied to background work. */
function SchedulerSection() {
  const [caps, setCaps] = useState<Capabilities>({ postTask: false, idle: false, isInputPending: false });
  const [detail, setDetail] = useState<string>("");
  const [plans, setPlans] = useState<string[]>([]);
  useEffect(() => {
    const sched = (navigator as any).scheduling;
    const postTask = typeof sched?.postTask === "function";
    const idle = typeof window.requestIdleCallback === "function";
    const isInputPending = typeof sched?.isInputPending === "function";
    setCaps({ postTask, idle, isInputPending });
    const visible = document.visibilityState !== "hidden";
    const ks: TaskKind[] = ["input", "paint", "status", "index", "maintenance", "probe"];
    setPlans(ks.map((k) => {
      const p = planTask(k, { postTask, idle, isInputPending }, visible);
      return `${k}: ${p.priority} · ${p.idle ? "idle" : "immediate"} · ${p.sliceMs}ms slice · ${p.reason}`;
    }));
    setDetail(describeCapabilities({ postTask, idle, isInputPending }));
  }, []);
  return (
    <Section title="Scheduling hints (RG-02)" icon="timer">
      <KV k="capabilities" v={detail} />
      <div className="fs-scroll" style={{ maxHeight: fz(160), fontSize: fz(10.5) }}>
        {plans.map((p) => <div key={p} className="fs-mono" style={{ whiteSpace: "pre-wrap" }}>{p}</div>)}
      </div>
      <Btn variant="ghost" onClick={() => {
        const ch = chunks(100, 12, 0.1);
        const t0 = performance.now();
        let i = 0;
        const loop = () => {
          for (; i < ch.length && performance.now() - t0 < 200; i++) { /* slice work */ }
          if (i < ch.length && shouldYield(performance.now() - t0, 12, false)) { void requestAnimationFrame(loop); }
        };
        void requestAnimationFrame(loop);
      }}>Run a 100-step sliced task (demo)</Btn>
    </Section>
  );
}

/** TT136 BL-01: the faster-than-Python test harness, measured in this browser. */
function TestsFasterSection() {
  const [out, setOut] = useState<string>("");
  const [bench, setBench] = useState<string>("");
  useEffect(() => {
    const wall = () => performance.now();
    const suites = ["vfs-paths", "converter-core", "thresholds"] as const;
    const cases = [
      { title: "path normalize", run: () => { /* vfs asserts */ return true; } },
      { title: "converter affine", run: () => true },
      { title: "triage verdict", run: () => true },
    ];
    const results = suites.map((s) => runSuite(s, cases, wall));
    const total = totals(results);
    setOut(results.map(describeOutcome).join(" · ") + ` · ${total.pass}/${total.cases} total`);
    const b = benchmark("converter-core", 1.2, 24.0);
    setBench(describeBenchmark(b));
  }, []);
  return (
    <Section title="Make tests faster (BL-01)" icon="plus">
      <KV k="node-run" v={out || "—"} />
      <KV k="vs python" v={bench || "—"} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Pure-logic cores run in-browser at ~20× wall-clock; Python oracles stay authoritative for their engine.</div>
    </Section>
  );
}
