"use client";

/**
 * TT146 — the runtime truth pane (HW-03, HW-09, HW-10).
 *
 * Three questions, one screen, no adjectives: how fast is the link right now,
 * which codec configurations does this engine accept, and does the WASM engine
 * actually execute the SIMD instructions it parses. Every value shown is either
 * measured in this tab or reported by an API — nothing is inferred from a user
 * agent string.
 */

import { fz } from "@/lib/uiscale";
import { useCallback, useEffect, useState } from "react";
import { Badge, Btn, KV, Section } from "../ui";
import { describeDecision, TIER_LABEL, type Surface } from "@/lib/net/quality";
import { useQuality } from "@/lib/net/use-quality";
import { probeCodecMatrix, summarise, verdictText, webCodecsProbe, type CodecReport } from "@/lib/media/codecs";
import { planChunks, probeWasm, runThreadProbe, wasmSimdProbeBytes, type WasmReport } from "@/lib/wasm/probe";
import { describeHandoff, encodeHandoff, type EncodeResult } from "@/lib/handoff/continue-link";
import { useShell } from "../shell-context";
import { MODULES } from "@/lib/registry";

const SURFACES: { id: Surface; label: string }[] = [
  { id: "photoThumb", label: "Gallery thumbnails" },
  { id: "photoPreview", label: "Photo previews" },
  { id: "video", label: "Video" },
  { id: "prefetch", label: "Prefetch budget" },
  { id: "sync", label: "Parallel transfers" },
];

export default function RuntimePanel() {
  return (
    <div style={{ display: "grid", gap: 10 }} data-testid="runtime-panel">
      <NetworkCard />
      <HandoffCard />
      <CodecCard />
      <EngineCard />
    </div>
  );
}

export function NetworkCard() {
  const q = useQuality("photoThumb");
  return (
    <Section title="Network quality (HW-09)" icon="sliders" right={<Badge tone={q.decision.tier >= 2 ? "ok" : "warn"}>{TIER_LABEL[q.decision.tier]}</Badge>}>
      <KV k="Reported" v={q.facts.reported
        ? `${q.facts.effectiveType}${q.facts.downlinkMbps !== null ? ` · ${q.facts.downlinkMbps} Mbit/s (capped by the browser)` : ""}${q.facts.rttMs !== null ? ` · ${q.facts.rttMs} ms` : ""}`
        : "this browser exposes no NetworkInformation"} mono />
      <KV k="Save-Data" v={q.facts.saveData ? "on — the lowest rung is forced" : "off"} />
      <KV k="Measured" v={q.bps === null ? `nothing measured yet` : `${(q.bps / 1e6).toFixed(2)} Mbit/s · ${q.confidence} confidence`} mono />
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="ghost" data-testid="runtime-measure" onClick={() => void q.measure()}>Measure now</Btn>
        <span className="fs-dim" style={{ fontSize: fz(11) }}>{q.note}</span>
      </div>
      <div style={{ display: "grid", gap: 3 }}>
        {SURFACES.map((s) => {
          const d = planSurface(q, s.id);
          return <KV key={s.id} k={s.label} v={describeDecision(d, s.id)} />;
        })}
      </div>
    </Section>
  );
}

/** Plan a surface on the data the card already holds (no extra hook per row). */
function planSurface(q: ReturnType<typeof useQuality>, surface: Surface) {
  // The card's own decision is for thumbnails; the numbers differ per surface but
  // the rung does not, so reuse it and map the value through RUNGS.
  const rung = q.decision.rung;
  const value = surface === "photoThumb" ? rung.photoThumb
    : surface === "photoPreview" ? rung.photoPreview
    : surface === "video" ? rung.videoHeight
    : surface === "prefetch" ? rung.prefetchBytes
    : rung.parallelTransfers;
  return { ...q.decision, value };
}

export function CodecCard() {
  const [report, setReport] = useState<CodecReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const source = typeof window === "undefined" ? {} : (window as unknown as { VideoDecoder?: never; VideoEncoder?: never });

  const run = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const bound = webCodecsProbe(source as Parameters<typeof webCodecsProbe>[0]);
      if (bound.reason) { setError(bound.reason); setReport({ at: Date.now(), cells: [], unavailableReason: bound.reason }); return; }
      setReport(await probeCodecMatrix(bound.probe, Date.now()));
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }, [source]);

  useEffect(() => { void run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const rows = report ? summarise(report) : [];
  return (
    <Section title="Codecs (HW-03)" icon="contrast" right={<Btn variant="ghost" onClick={() => void run()} disabled={busy}>{busy ? "Asking…" : "Re-probe"}</Btn>}>
      {error ? <Badge tone="warn">{error}</Badge> : null}
      <div className="fs-dim" style={{ fontSize: fz(11) }} data-testid="runtime-codecs-note">
        Asked with <span className="fs-mono">isConfigSupported</span>; a “supported” answer means the browser accepted the configuration, not that silicon did the work.
      </div>
      {rows.map((r) => (
        <KV key={r.codec} k={`${r.label}`} mono
          v={`decode ${verdictText(r.decode === "not probed" ? "unanswered" : r.decode)} · encode ${verdictText(r.encode === "not probed" ? "unanswered" : r.encode)}${r.maxHeight ? ` · to ${r.maxHeight}p` : ""}`} />
      ))}
    </Section>
  );
}

export function EngineCard() {
  const [report, setReport] = useState<WasmReport | null>(null);
  useEffect(() => {
    const env = {
      validate: (b: Uint8Array) => WebAssembly.validate(new Uint8Array(b)),
      instantiate: (b: Uint8Array) => {
        const m = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(b)), {});
        const mem = new Uint8Array((m.exports.mem as WebAssembly.Memory).buffer);
        return { probe: () => (m.exports.probe as () => number)(), memory: mem };
      },
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
      atomics: typeof Atomics === "object",
      spawnSharedWorker: async () => {
        // A real worker, a real SharedArrayBuffer and a real Atomics handshake;
        // if any part is unavailable this throws and the probe reports the reason.
        const buf = new SharedArrayBuffer(8);
        const view = new Int32Array(buf);
        const code = `self.onmessage = (e) => { const v = new Int32Array(e.data); Atomics.store(v, 0, 7); Atomics.notify(v, 0); };`;
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        const w = new Worker(url);
        try {
          w.postMessage(buf);
          const deadline = Date.now() + 1500;
          while (Atomics.load(view, 0) !== 7) {
            if (Date.now() > deadline) return false;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
          }
          return true;
        } finally { w.terminate(); URL.revokeObjectURL(url); }
      },
    };
    const base = probeWasm(env, Date.now());
    setReport(base);
    void runThreadProbe(env, base).then(setReport).catch(() => undefined);
  }, []);

  const chunks = planChunks(1000, Math.max(1, navigator.hardwareConcurrency || 2), 16);
  return (
    <Section title="Execution engine (HW-10)" icon="tree">
      <KV k="SIMD" v={report ? (report.simd ? "executed" : "not available") : "probing…"} />
      <KV k="Why" v={report?.simdReason ?? ""} />
      <KV k="Shared memory" v={report ? (report.sharedMemory ? "available" : "unavailable") : ""} />
      <KV k="Why" v={report?.sharedMemoryReason ?? ""} />
      <KV k="Threads" v={report ? (report.threads ? "worker handshake passed" : "single-threaded path") : ""} />
      <KV k="Strategy" v={report?.strategy ?? ""} mono />
      <KV k="Probe module" v={`${wasmSimdProbeBytes().length} bytes, assembled in code`} mono />
      <KV k="Chunk plan" v={`${chunks.length} chunk(s) over ${navigator.hardwareConcurrency || 1} core(s)`} />
    </Section>
  );
}

/**
 * CT-03 — a continue-on link, made on this device and opened on another.
 *
 * The card is deliberately two lines and one button: what will be carried, and
 * what will not. A person should be able to read the cost before pasting a URL
 * into a chat.
 */
export function HandoffCard() {
  const shell = useShell();
  const [built, setBuilt] = useState<EncodeResult | null>(null);
  const build = useCallback(() => {
    const st = shell.state;
    const r = encodeHandoff(st, window.location.origin, (m) => MODULES.some((x) => x.id === m));
    setBuilt(r);
    if (r.ok && r.url) void shell.copy(r.url, "Continue on", false);
  }, [shell]);
  return (
    <Section title="Continue on another device (CT-03)" icon="forward"
      right={<Badge tone={built?.ok ? "ok" : "default"} data-testid="handoff-state">{built ? (built.ok ? "link ready" : "refused") : "not built"}</Badge>}>
      <div className="fs-dim" style={{ fontSize: fz(11) }}>
        The layout goes in the URL fragment — the part a browser never sends to a server.
      </div>
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="primary" data-testid="handoff-build" onClick={build}>Build link</Btn>
        {built?.ok ? <Btn variant="ghost" data-testid="handoff-copy" onClick={() => built.url && void shell.copy(built.url, "Continue on", false)}>Copy again</Btn> : null}
        <span className="fs-dim" style={{ fontSize: fz(11) }} data-testid="handoff-note">{built ? describeHandoff(built) : `${shell.state.windows.length} window(s) open`}</span>
      </div>
      {built && !built.ok ? <Badge tone="bad">{built.reason}</Badge> : null}
      {built?.dropped.length ? (
        <div className="fs-dim" style={{ fontSize: fz(11) }} data-testid="handoff-dropped">Left behind: {built.dropped.slice(0, 3).join("; ")}{built.dropped.length > 3 ? "…" : ""}</div>
      ) : null}
      {built?.ok && built.url ? <code className="fs-mono" style={{ fontSize: fz(10), wordBreak: "break-all" }} data-testid="handoff-url">{built.url}</code> : null}
    </Section>
  );
}
