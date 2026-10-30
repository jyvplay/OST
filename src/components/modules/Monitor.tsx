"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, fmtBytes, fmtTime } from "@/lib/api";
import { stateHash } from "@/lib/windowing/state";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, KV, Section } from "../ui";

interface Job { id: number; op: string; src: string; dst: string; state: string; error: string; updatedAt: string }
interface LogRow { id: number; actor: string; action: string; detail: string; createdAt: string }

/** RG-04 + DP-08 + DP-14: the app's own measurements, exposed so claims are checkable. */
export default function MonitorModule(_: ModuleProps) {
  const shell = useShell();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [mem, setMem] = useState<string>("measuring…");
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
    } else if (perf.memory) {
      setMem(`${fmtBytes(perf.memory.usedJSHeapSize)} of ${fmtBytes(perf.memory.jsHeapSizeLimit)} (performance.memory — Chromium estimate)`);
    } else {
      setMem("no memory measurement API in this browser");
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
        }}>Inject a long task (falsification test)</Btn>
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

      <Section title="Jobs — file operation journal (DP-14)">
        <div style={{ display: "grid", gap: 2 }}>
          {jobs.map((j) => (
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
        </div>
      </Section>

      <Section title="Audit log">
        <div className="fs-scroll fs-mono" tabIndex={0} role="region" aria-label="Audit log" style={{ maxHeight: fz(130), fontSize: fz(10.5) }}>
          {log.map((l) => <div key={l.id}>{fmtTime(l.createdAt)} {l.action} {l.detail}</div>)}
        </div>
      </Section>
    </div>
  );
}
