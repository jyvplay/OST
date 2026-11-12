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
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Btn, KV, Section } from "../ui";
import { describeDecision, TIER_LABEL, type Surface } from "@/lib/net/quality";
import { useQuality } from "@/lib/net/use-quality";
import { probeCodecMatrix, summarise, verdictText, webCodecsProbe, type CodecReport } from "@/lib/media/codecs";
import { planChunks, probeWasm, runThreadProbe, wasmSimdProbeBytes, type WasmReport } from "@/lib/wasm/probe";
import { describeHandoff, encodeHandoff, type EncodeResult } from "@/lib/handoff/continue-link";
import { useShell } from "../shell-context";
import { MODULES } from "@/lib/registry";
import { browserAccelerators, type AcceleratorReport } from "@/lib/gpu/accelerators";
import { browserInventory, type PeripheralInventory } from "@/lib/peripherals/inventory";
import { applyOutcome, describeConfinement, initialConfinement, planConfinement, type ConfinementState } from "@/lib/windowing/pointer-lock";

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
      <AcceleratorCard />
      <PeripheralCard />
      <ConfinementCard />
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
        <Btn variant="ghost" data-testid="runtime-measure" onClick={() => void q.measure()}>Measure</Btn>
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
    <Section title="Continue on another device (CT-03)" icon="link"
      right={<Badge tone={built?.ok ? "ok" : "default"} data-testid="handoff-state">{built ? (built.ok ? "link ready" : "refused") : "not built"}</Badge>}>
      <div className="fs-dim" style={{ fontSize: fz(11) }}>
        Layout in the URL fragment — never sent to a server.
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

/** HW-04 — where inference would actually run. One line, then the raw strings. */
export function AcceleratorCard() {
  const [report, setReport] = useState<AcceleratorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const probe = useCallback(async () => {
    setBusy(true);
    try { setReport(await browserAccelerators()); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void probe(); }, [probe]);
  return (
    <Section title="Accelerated inference (HW-04)" icon="chip"
      right={<Badge tone={report?.webgpu.verdict === "hardware" ? "ok" : "default"} data-testid="accel-verdict">{report ? report.webgpu.verdict : "probing"}</Badge>}>
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="ghost" data-testid="accel-probe" disabled={busy} onClick={() => void probe()}>Re-probe</Btn>
        <span className="fs-dim" style={{ fontSize: fz(11) }} data-testid="accel-summary">{report?.summary ?? "asking this engine…"}</span>
      </div>
      {report ? (
        <>
          <KV k="WebGPU" v={report.webgpu.available ? `present · ${report.webgpu.reason}` : report.webgpu.reason} />
          <KV k="WebNN" v={report.webnn.available ? `${report.webnn.deviceType} · ${report.webnn.reason}` : report.webnn.reason} />
          <KV k="Fallback" v={report.fallback.note} />
        </>
      ) : null}
    </Section>
  );
}

/** HW-07 — granted devices, and the choosers that can add one. */
export function PeripheralCard() {
  const [inv, setInv] = useState<PeripheralInventory | null>(null);
  useEffect(() => { void browserInventory().then(setInv).catch(() => setInv(null)); }, []);
  return (
    <Section title="Peripherals (HW-07)" icon="plug" right={<Badge>{inv ? `${inv.granted} granted` : "reading"}</Badge>}>
      {inv ? inv.buses.map((b) => <KV key={b.bus} k={b.bus.toUpperCase()} v={`${b.present ? (b.canRequest ? "chooser available" : "no chooser") : "absent"} · ${b.reason}`} />) : null}
      <div className="fs-dim" style={{ fontSize: fz(10.5) }} data-testid="peripheral-limits">{inv?.limits[0] ?? ""}</div>
    </Section>
  );
}

/** WM-16 — a real pointer lock, requested from a real click. */
export function ConfinementCard() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [st, setSt] = useState<ConfinementState>(initialConfinement);
  const [note, setNote] = useState("the cursor is free");
  const api = typeof document !== "undefined" && "pointerLockElement" in document;
  const displays = typeof screen !== "undefined" ? 1 : null;

  useEffect(() => {
    const onChange = () => {
      const locked = document.pointerLockElement === ref.current;
      setSt((s) => applyOutcome(s, { kind: locked ? "locked" : "unlocked" }).state);
      setNote(locked ? "the cursor is confined to this element" : "the pointer is free");
    };
    document.addEventListener("pointerlockchange", onChange);
    document.addEventListener("pointerlockerror", () => {
      setSt((s) => applyOutcome(s, { kind: "rejected", error: "the browser refused the lock" }).state);
      setNote("the browser refused the lock");
    });
    return () => { document.removeEventListener("pointerlockchange", onChange); };
  }, []);

  const toggle = useCallback(async () => {
    const want = document.pointerLockElement !== ref.current;
    const plan = planConfinement(st, { apiAvailable: api, userGesture: true, wantLocked: want });
    if (plan.action === "refuse" || plan.action === "wait") { setNote(plan.reason); return; }
    if (plan.action === "unlock") { document.exitPointerLock(); return; }
    setSt((s) => ({ ...s, pending: true }));
    try {
      await (ref.current as unknown as { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> }).requestPointerLock(plan.options ?? undefined);
    } catch (e) {
      setSt((s) => applyOutcome(s, { kind: "rejected", error: (e as Error).message }).state);
    }
  }, [api, st]);

  return (
    <Section title="Cursor confinement (WM-16)" icon="cursor" right={<Badge tone={st.locked ? "ok" : "default"}>{st.locked ? "locked" : "free"}</Badge>}>
      <div ref={ref} className="fs-panel" style={{ padding: 10, minHeight: fz(44), display: "grid", placeItems: "center" }} data-testid="confine-surface">
        <span className="fs-dim" style={{ fontSize: fz(11) }}>click to confine</span>
      </div>
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="ghost" data-testid="confine-toggle" onClick={() => void toggle()}>{st.locked ? "Release" : "Confine cursor"}</Btn>
        <span className="fs-dim" style={{ fontSize: fz(11) }} data-testid="confine-note">{describeConfinement(st, displays)}</span>
      </div>
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{note}</div>
    </Section>
  );
}
