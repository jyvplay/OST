"use client";
/**
 * TT145 surfaces. One file, because these twenty panels are the *same* shape: a
 * couple of measured inputs, a button, and the engine's own sentence. Keeping them
 * together means the copy budget and the panel chrome are reviewed in one place,
 * and it means a module imports one thing rather than fifteen.
 *
 * Every panel follows the same rule as the engines: the sentence shown is the
 * engine's, not the component's. If a panel ever has to explain an outcome in its
 * own words, that is a signal the engine is missing a case.
 */
import { useEffect, useMemo, useState } from "react";
import { fz } from "@/lib/uiscale";
import { Badge, Btn, KV, Section } from "./ui";
import { planBlackout, coalesceTouches, OBLIGATIONS, type Fill } from "@/lib/blackout-budget";
import { decide as decideEntitlement, parseGrant, type CacheEntry } from "@/lib/entitlement-cache";
import { parseRules, decide as decideFilter, report as filterReport } from "@/lib/content-filter";
import { planOutbound, planInbound, type OutboundInput, type InboundInput } from "@/lib/drop-claim";
import { makeChord, keydown, release, limitsSentence, type Chord, type Mod } from "@/lib/shortcut-latch";
import { estimate, report as audioReport, type Graph } from "@/lib/audio-quantum";
import { parse as parseExclusions, EMPTY as NO_EXCLUSIONS, mayCapture, redactUrl } from "@/lib/exclusion-rules";
import { health as volumeHealth, spaceSentence, type Volume } from "@/lib/volume-access";
import { planRendition, efficiency } from "@/lib/codec-probe";
import { makeAlarm, evaluate, scheduleText, deliverySentence, type PartsOf } from "@/lib/alarm-due";
import { health as backupHealth, sample as drillSample, interpretDrill, dueSentence } from "@/lib/backup-health";
import { snapshot, verify, compactPlan, type FileEntry } from "@/lib/backup-timeline";
import { trash, restore, sweep, summary as trashSummary, emptyTrash, DEFAULT_RETENTION_DAYS } from "@/lib/trash-policy";
import { place, adoptionPlan, closeBehaviour } from "@/lib/pip-placement";
import { summarise, STOREFRONTS } from "@/lib/sm7-summary";
import { emptyModel, admit, shouldYield, type Slice } from "@/lib/task-budget";
import { emptyBroker, decide as decideLane, matrix } from "@/lib/workspace-lanes";
import { classify } from "@/lib/launch-claim";
import { makeRoutine, checkAction, plan as planRoutine, auditEntry, importRoutine } from "@/lib/routine-guard";
import { planUpscale, chooseKernel, resampleRow, maxDiff, lanczos } from "@/lib/upscale-plan";
import { planCapture, frameQuality, provenance, DOM_FALLBACK_LIMITS } from "@/lib/snapshot-plan";

const partsOf: PartsOf = (ts) => {
  const d = new Date(ts);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), min: d.getMinutes(), dow: d.getDay() };
};

/**
 * The clock as state, not as a render-time call.
 *
 * React 19's compiler lint is right to reject `Date.now()` inside render: a render
 * that reads the clock produces a different tree for the same props, which is
 * exactly the impurity that makes memoisation unsound. So time enters through
 * `useState` in an effect (and on an interval for the panels that show a countdown),
 * and every panel below takes `now` as an argument.
 */
function useNow(refreshMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // The interval is installed once; the first tick happens one period from now,
    // so the effect does not write state synchronously on mount (which would be a
    // cascading render) and the value it shows is still a real reading, taken in the
    // initialiser above.
    const t = window.setInterval(() => setNow(Date.now()), refreshMs);
    return () => window.clearInterval(t);
  }, [refreshMs]);
  return now;
}

/** Shared chrome: the engine's sentence, then the facts behind it. */
function Rows({ pairs }: { pairs: [string, string][] }) {
  return <>{pairs.map(([k, v]) => <KV key={k} k={k} v={v} />)}</>;
}

// ── SH-10 BlackTop budget ───────────────────────────────────────────────────
export function BlackoutPanel() {
  const [fill, setFill] = useState<Fill>("flat");
  const [ownsLayer, setOwnsLayer] = useState(true);
  const [animated, setAnimated] = useState(false);
  const [hidden, setHidden] = useState(false);
  const plan = planBlackout({ fill, ownsLayer, animated, hidden, refreshHz: typeof screen !== "undefined" ? 60 : undefined });
  const [moves] = useState([{ at: 0, x: 1, y: 1 }, { at: 4, x: 2, y: 2 }, { at: 12, x: 3, y: 3 }, { at: 20, x: 4, y: 4 }]);
  return (
    <Section icon="budget" title="Blackout budget (SH-10)" right={<Badge tone={plan.refuses.length ? "bad" : "ok"} data-testid="sh10-tone">{plan.refuses.length ? "refused" : `${plan.fps} fps`}</Badge>}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <select className="fs-select" style={{ width: fz(120) }} value={fill} aria-label="Blackout fill" onChange={(e) => setFill(e.target.value as Fill)}>
          <option value="flat">flat black</option><option value="gradient">gradient</option><option value="video">video</option><option value="image">image</option>
        </select>
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11) }}><input type="checkbox" checked={ownsLayer} onChange={(e) => setOwnsLayer(e.target.checked)} />full-bleed</label>
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11) }}><input type="checkbox" checked={animated} onChange={(e) => setAnimated(e.target.checked)} />animated</label>
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11) }}><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />tab hidden</label>
      </div>
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="sh10-sentence">{plan.sentence}</div>
      <Rows pairs={[["presents avoided", `${Math.round(plan.presentsRemoved * 100)} %`], ["single layer", plan.singleLayer ? "yes" : "no"], ["touch coalescing", `${coalesceTouches(moves, 1000 / 60, 60).length} of ${moves.length} moves kept`]]} />
      <div className="fs-dim" style={{ fontSize: fz(10.5), lineHeight: 1.6 }}>{OBLIGATIONS[4]}</div>
    </Section>
  );
}

// ── BL-02 entitlement cache ─────────────────────────────────────────────────
export function EntitlementPanel() {
  const [verdict, setVerdict] = useState("");
  const [days, setDays] = useState(30);
  const run = () => {
    const now = Date.now();
    // A locally constructed grant, unsigned: the panel's point is the *decision*, and
    // it says so — `signatureValid:false` is passed honestly rather than faked true.
    const grant = { v: 1 as const, product: "fusion-pro", features: ["recall.archive", "backup.timeline"], seats: 1, issuedAt: now - 86400000, expiresAt: now + days * 86400000, reference: "local-preview" };
    const entry: CacheEntry = { grant, signature: "", confirmedAt: now };
    const d = decideEntitlement(entry, "recall.archive", now, { highWater: now, graceMs: 7 * 86400000, signatureValid: false, knownProducts: ["fusion-pro"] });
    const g = decideEntitlement(entry, "recall.archive", now, { highWater: now, graceMs: 7 * 86400000, signatureValid: true, knownProducts: ["fusion-pro"] });
    setVerdict(`unsigned: ${d.verdict} — ${d.why}\nif the signature had verified: ${g.verdict} — ${g.why}\nparsed cleanly: ${parseGrant(grant).ok}`);
  };
  return (
    <Section icon="seal" title="Entitlement cache (BL-02)" right={<Badge tone="warn">no key in this build</Badge>}>
      <div className="fs-row" style={{ gap: 6 }}>
        <input className="fs-input" style={{ width: fz(80) }} type="number" value={days} aria-label="Grant days" onChange={(e) => setDays(Number(e.target.value))} />
        <Btn variant="ghost" onClick={run} data-testid="bl02-run">Decide</Btn>
      </div>
      {verdict ? <pre className="fs-mono" style={{ fontSize: fz(10.5), margin: 0, whiteSpace: "pre-wrap" }} data-testid="bl02-verdict">{verdict}</pre> : null}
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>A grant is only useful offline if its signature verifies without a server. No signing key ships with this build, so every cached grant here reports bad-signature rather than being trusted on faith.</div>
    </Section>
  );
}

// ── PR-07p content filter ───────────────────────────────────────────────────
export function FilterPanel() {
  const [text, setText] = useState("block host ads.example\nblock host *.tracker.example category=tracking embeds\nallow host cdn.tracker.example");
  const [url, setUrl] = useState("https://ads.example/pixel.gif");
  const parsed = useMemo(() => parseRules(text), [text]);
  const decision = parsed.ok ? decideFilter(parsed.rules, url, { kind: "navigate" }) : null;
  return (
    <Section icon="scope" title="Content filter (PR-07p)" right={parsed.ok ? <Badge tone="ok" data-testid="pr07p-report">{filterReport(parsed)}</Badge> : <Badge tone="bad">parse failed</Badge>}>
      <textarea className="fs-input fs-mono" rows={4} value={text} aria-label="Filter rules" data-testid="pr07p-rules" onChange={(e) => setText(e.target.value)} style={{ fontSize: fz(10.5), resize: "vertical" }} />
      <div className="fs-row" style={{ gap: 6 }}>
        <input className="fs-input" value={url} aria-label="Filter test address" onChange={(e) => setUrl(e.target.value)} />
      </div>
      {parsed.ok ? <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="pr07p-decision">{decision?.effect}: {decision?.why}</div> : <div className="fs-dim">{parsed.why}</div>}
      {parsed.ok && parsed.rejected.length ? <ul className="fs-dim" style={{ fontSize: fz(10.5), margin: 0, paddingLeft: 16 }}>{parsed.rejected.map((r) => <li key={r.line}>line {r.line}: {r.why}</li>)}</ul> : null}
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Cooperative: it filters what this app opens and embeds, not the browser&apos;s own requests.</div>
    </Section>
  );
}

// ── RC-15 exclusions ────────────────────────────────────────────────────────
export function ExclusionPanel() {
  const [text, setText] = useState("host bank.example\npath /account/*");
  const [url, setUrl] = useState("https://shop.example/acct?sessionid=SECRET&keep=1");
  const parsed = useMemo(() => parseExclusions(text), [text]);
  const decision = mayCapture(parsed.rules, { url });
  return (
    <Section icon="shield" title="Recall exclusions (RC-15)" right={<Badge tone={decision.allowed ? "ok" : "warn"} data-testid="rc15-tone">{decision.allowed ? "capture allowed" : "excluded"}</Badge>}>
      <textarea className="fs-input fs-mono" rows={3} value={text} aria-label="Exclusion rules" onChange={(e) => setText(e.target.value)} style={{ fontSize: fz(10.5), resize: "vertical" }} />
      <input className="fs-input" value={url} aria-label="Exclusion test address" onChange={(e) => setUrl(e.target.value)} />
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="rc15-decision">{decision.why}</div>
      <KV k="receipt address" v={<span className="fs-mono" style={{ wordBreak: "break-all" }} data-testid="rc15-redacted">{redactUrl(parsed.rules, url)}</span>} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{parsed.rules.queryParams.length} parameter names and {parsed.rules.literals.length} literals are redacted in every receipt; {NO_EXCLUSIONS.hosts.length} hosts are excluded by default.</div>
      {parsed.rejected.length ? <Badge tone="warn">{parsed.rejected.length} rules rejected</Badge> : null}
    </Section>
  );
}

// ── FM-14 drop rules ────────────────────────────────────────────────────────
export function DropPanel() {
  const out = planOutbound({ name: "report.pdf", mime: "application/pdf", bytes: 204800, canBlob: true, downloadUrl: typeof document !== "undefined", sameOrigin: false });
  const inb = planInbound({ types: ["Files"], fileCount: 2, largestBytes: 2048, textLength: 0, visible: typeof document !== "undefined" && document.visibilityState === "visible", accepts: ["files"] });
  return (
    <Section icon="export" title="Drag and drop (FM-14)" right={<Badge tone="ok" data-testid="fm14-led">{out.kind}</Badge>}>
      <Rows pairs={[["drag out", out.sentence], ["drag in", inb.sentence], ["can drag a file out", out.kind === "download" ? "yes" : "no — Download button instead"]]} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Files arrive as DataTransfer.files; the string types are empty for files by design.</div>
    </Section>
  );
}

// ── FM-08 volumes ───────────────────────────────────────────────────────────
export function VolumePanel() {
  const [est, setEst] = useState<string>("reading…");
  useEffect(() => {
    let live = true;
    void navigator.storage?.estimate?.().then((e) => { if (live) setEst(spaceSentence({ usage: e.usage ?? null, quota: e.quota ?? null })); })
      .catch(() => { if (live) setEst(spaceSentence(null)); });
    return () => { live = false; };
  }, []);
  const now = useNow();
  const demo: Volume = { id: "vol-demo", label: "Work USB", kind: "directory", permission: "granted", lastSeenAt: now - 3 * 86400000, entries: 12, lastError: null };
  const h = volumeHealth(demo, now);
  return (
    <Section icon="bucket" title="Volumes (FM-08)" right={<Badge tone="ok" data-testid="fm08-tone">{h.status}</Badge>}>
      <KV k="origin quota" v={est} />
      <KV k="granted volume" v={`${demo.label} · ${h.why}`} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>A page cannot list volumes: every entry needs a picker or a past grant, and a moved device reads as broken, never as empty.</div>
    </Section>
  );
}

// ── HW-03 codecs ────────────────────────────────────────────────────────────
export function CodecPanel() {
  const [codec, setCodec] = useState("h264");
  const [container, setContainer] = useState("mp4");
  // The answer is derived from the current selection, not stored: `canPlayType` is a
  // cheap synchronous query, so deriving it keeps the panel consistent with the
  // selects without an effect that writes state back into a render.
  const [probe, setProbe] = useState(0);
  const answer = useMemo(() => {
    const el = document.createElement("video");
    const mime = container === "webm" ? "video/webm" : "video/mp4";
    const code = codec === "h264" ? "avc1.640028" : codec === "hevc" ? "hvc1.1.6.L93" : codec === "av1" ? "av01.0.05M.08" : "vp09.00.10.08";
    void probe;
    return el.canPlayType(`${mime}; codecs="${code}"`) || "no answer";
  }, [codec, container, probe]);
  // `mediaCapabilities.decodingInfo` is async, so the efficiency probe is a promise the
  // caller drives; without a configuration to ask about, this build reports unmeasured.
  const eff = efficiency(null);
  const plan = planRendition({ name: "main", spec: { container, codec }, answer, efficiency: eff.efficiency });
  return (
    <Section icon="gauge" title="Codec probe (HW-03)" right={<Badge tone={plan.support === "probably" ? "ok" : plan.support === "maybe" ? "warn" : "bad"} data-testid="hw03-tone">{plan.support}</Badge>}>
      <div className="fs-row" style={{ gap: 6 }}>
        <select className="fs-select" style={{ width: fz(110) }} value={container} aria-label="Container" onChange={(e) => setContainer(e.target.value)}><option value="mp4">mp4</option><option value="webm">webm</option></select>
        <select className="fs-select" style={{ width: fz(110) }} value={codec} aria-label="Codec" onChange={(e) => setCodec(e.target.value)}><option value="h264">h264</option><option value="hevc">hevc</option><option value="av1">av1</option><option value="vp9">vp9</option></select>
      </div>
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="hw03-sentence">{plan.sentence}</div>
      <Rows pairs={[["canPlayType", answer], ["efficiency", eff.sentence]]} />
      <Btn variant="ghost" onClick={() => setProbe((n) => n + 1)}>Re-probe</Btn>
    </Section>
  );
}

// ── HW-05 audio budget ──────────────────────────────────────────────────────
export function AudioBudgetPanel() {
  const [state, setState] = useState<"unknown" | "measured">("unknown");
  const [sentence, setSentence] = useState("start an audio context to read the browser's own latency estimate");
  const graph: Graph = { nodes: [{ kind: "gain", latencyFrames: 0, costUs: 120 }, { kind: "limiter", latencyFrames: 128, costUs: 900 }], sampleRate: 48000, budgetUs: 2000 };
  const e = estimate(graph);
  const heavy = estimate({ ...graph, nodes: [...graph.nodes, { kind: "convolver", latencyFrames: 1024, costUs: 4000 }] });
  const measure = async () => {
    try {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      await ctx.resume();
      const r = audioReport({ state: ctx.state as "running" | "suspended" | "closed", sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency ?? null, outputLatency: ctx.outputLatency ?? null, worklet: "audioWorklet" in ctx });
      setSentence(r.sentence); setState("measured");
      void ctx.close();
    } catch (err) { setSentence(`cannot start an audio context here: ${(err as Error).message}`); setState("measured"); }
  };
  return (
    <Section icon="timer" title="Audio budget (HW-05)" right={<Badge tone={state === "measured" ? "ok" : "default"}>{state}</Badge>}>
      <Btn variant="ghost" onClick={() => void measure()} data-testid="hw05-measure">Measure this device</Btn>
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="hw05-sentence">{sentence}</div>
      <Rows pairs={[["light graph", e.why], ["with a convolver", heavy.why]]} />
    </Section>
  );
}

// ── CK-01 alarms ────────────────────────────────────────────────────────────
export function AlarmPanel() {
  const [at, setAt] = useState("07:00");
  const [cadence, setCadence] = useState<"daily" | "weekdays" | "weekly">("daily");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [out, setOut] = useState("");
  const build = () => {
    try {
      const a = makeAlarm("preview", "Preview", at, cadence, { days: cadence === "daily" ? undefined : days });
      const at0 = Date.now();
      const ev = evaluate(a, at0 - 3 * 86400000, at0, partsOf);
      setOut(`${scheduleText(a)} · ${ev.sentence}\ndue in the last 3 days: ${ev.due.map((d) => new Date(d.at).toLocaleString()).join(" · ") || "none"}`);
    } catch (e) { setOut(`refused: ${(e as Error).message}`); }
  };
  return (
    <Section icon="alarm" title="Alarms (CK-01)" right={<Badge tone="warn">foreground only</Badge>}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ width: fz(90) }} value={at} aria-label="Alarm time" onChange={(e) => setAt(e.target.value)} />
        <select className="fs-select" style={{ width: fz(120) }} value={cadence} aria-label="Alarm cadence" onChange={(e) => setCadence(e.target.value as "daily" | "weekdays" | "weekly")}>
          <option value="daily">daily</option><option value="weekdays">weekdays</option><option value="weekly">weekly</option>
        </select>
        {cadence !== "daily" ? <span className="fs-row" style={{ gap: 3 }}>{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <label key={i} className="fs-row" style={{ gap: 1, fontSize: fz(10) }}><input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays(e.target.checked ? [...days, i] : days.filter((x) => x !== i))} />{d}</label>
        ))}</span> : null}
        <Btn variant="ghost" onClick={build} data-testid="ck01-preview">Preview schedule</Btn>
      </div>
      {out ? <pre className="fs-mono" style={{ fontSize: fz(10.5), margin: 0, whiteSpace: "pre-wrap" }} data-testid="ck01-out">{out}</pre> : null}
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{deliverySentence()}</div>
    </Section>
  );
}

// ── BK-05 health + BK-01 timeline ───────────────────────────────────────────
export function BackupEvidencePanel() {
  const now = useNow();
  const [drilled, setDrilled] = useState(true);
  const h = backupHealth({ writtenAt: now - 3600000, verifiedAt: now - 1800000, drilledAt: drilled ? now - 86400000 : null, files: 412, drillRestored: drilled ? 9 : 0, rawStatus: "ok" }, now);
  const paths = useMemo(() => Array.from({ length: 412 }, (_, i) => `Backups/${i % 12}/file-${i}.bin`), []);
  const sampled = drillSample(paths, 7);
  const result = interpretDrill(sampled.length, sampled.length, []);
  const chain = useMemo(() => {
    const files: FileEntry[] = [{ path: "a.txt", bytes: 12, digest: 1 }, { path: "b.txt", bytes: 34, digest: 2 }];
    // `reduce` rather than a reassigned `let`: the compiler lint is right that a
    // captured variable mutated inside a memo can escape it.
    return Array.from({ length: 12 }, (_, i) => i).reduce<ReturnType<typeof snapshot>[]>((acc, i) => {
      const parent = acc.length ? acc[acc.length - 1].id : null;
      acc.push(snapshot(`t${i}`, parent, now - (12 - i) * 86400000, "k1", files));
      return acc;
    }, []);
  }, [now]);
  const cpu = compactPlan(chain, now);
  const ver = verify(chain, chain[chain.length - 1].id, new Set(chain.flatMap((s) => s.chunks)));
  return (
    <Section icon="verify" title="Backup evidence (BK-05 / BK-01)" right={<Badge tone={h.verdict === "healthy" ? "ok" : "warn"} data-testid="bk05-verdict">{h.verdict}</Badge>}>
      <label className="fs-row" style={{ gap: 4, fontSize: fz(11) }}><input type="checkbox" checked={drilled} onChange={(e) => setDrilled(e.target.checked)} />a drill was run</label>
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="bk05-sentence">{h.sentence}</div>
      <Rows pairs={[
        ["next drill", dueSentence(h)],
        ["sample of 412 files", `${sampled.length} files across ${new Set(sampled.map((p) => p.split("/")[1])).size} folders`],
        ["drill result", result.sentence],
        ["chain verification", ver.sentence],
        ["compaction", cpu.sentence],
      ]} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>A backup is not evidence; a restore is. Nothing here is called healthy until a sample has been restored and read back.</div>
    </Section>
  );
}

// ── FM-11 trash ─────────────────────────────────────────────────────────────
export function TrashPanel() {
  const now = useNow();
  const t = useMemo(() => {
    const base = emptyTrash(DEFAULT_RETENTION_DAYS);
    const first = trash(base, { id: "a", origin: "home/a.txt", name: "a.txt", bytes: 1024, digest: 1, deletedAt: now - 40 * 86400000, kind: "file", copyElsewhere: false }).trash;
    return trash(first, { id: "b", origin: "home/b.txt", name: "b.txt", bytes: 2048, digest: 2, deletedAt: now - 40 * 86400000, kind: "file", copyElsewhere: true }).trash;
  }, [now]);
  const s = sweep(t, now);
  const back = restore(t, "b", false);
  return (
    <Section icon="tray" title="Trash policy (FM-11)" right={<Badge tone="ok" data-testid="fm11-tone">{s.remove.length} emptied</Badge>}>
      <Rows pairs={[["trash", trashSummary(t, now)], ["sweep", s.sentence], ["restore", back.note]]} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Nothing is emptied while it is the only copy of its content, whatever its age.</div>
    </Section>
  );
}

// ── WM-11 PiP + WM-19 snapshot (share one section: both are window mechanics) ──
export function WindowMechanicsPanel() {
  const pip = place({ w: 640, h: 400 }, { pip: typeof document !== "undefined" && "documentPictureInPicture" in document, styleBytes: 180000 });
  const adoption = adoptionPlan({ sheets: [{ href: "app.css", bytes: 180000 }], inline: [{ bytes: 0 }] });
  const snap = planCapture({ mode: "current-tab", gesture: true, visible: typeof document !== "undefined" && document.visibilityState === "visible", protected: false, css: { w: 1280, h: 720 }, devicePixelRatio: typeof devicePixelRatio === "number" ? devicePixelRatio : 1, fps: 0 });
  const close = closeBehaviour("user-closed");
  return (
    <Section icon="split" title="Window mechanics (WM-11 / WM-19)" right={<Badge tone={pip.ok ? "ok" : "bad"} data-testid="wm11-surface">{pip.surface}</Badge>}>
      <Rows pairs={[
        ["mini window", pip.sentence],
        ["stylesheet adoption", adoption.sentence],
        ["closing it", close.sentence],
        ["snapshot plan", snap.sentence],
        ["snapshot provenance", provenance(snap, true)],
      ]} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{DOM_FALLBACK_LIMITS[0]} · {DOM_FALLBACK_LIMITS[1]}</div>
    </Section>
  );
}

// ── WM-06 lanes ─────────────────────────────────────────────────────────────
export function LanePanel() {
  const [origin, setOrigin] = useState("https://frames.example/app");
  const b = emptyBroker();
  const d = decideLane(b, { origin, userHasApp: false, preferSplit: false });
  const m = matrix();
  return (
    <Section icon="lane" title="External-app broker (WM-06)" right={<Badge tone="warn" data-testid="wm06-lane">{d.lane}</Badge>}>
      <input className="fs-input" value={origin} aria-label="Broker origin" onChange={(e) => setOrigin(e.target.value)} />
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="wm06-sentence">{d.why}</div>
      <div style={{ display: "grid", gap: 2 }}>
        {m.map((r) => <div key={r.lane} className="fs-row" style={{ justifyContent: "space-between", fontSize: fz(10.5) }}>
          <span className="fs-mono">{r.lane} {r.name}</span><span className="fs-dim" style={{ textAlign: "right" }}>{r.honest}</span>
        </div>)}
      </div>
    </Section>
  );
}

// ── RG-02 frame budget ──────────────────────────────────────────────────────
export function FrameBudgetPanel() {
  const [n, setN] = useState(8);
  const slices: Slice[] = useMemo(() => Array.from({ length: n }, (_, i) => ({ id: `task-${i}`, priority: i === 0 ? "user-blocking" : i % 3 === 0 ? "user-visible" : "background", expectedMs: 1 + i * 0.4, resumable: i % 2 === 0 })), [n]);
  const a = admit(slices, emptyModel());
  const y = shouldYield({ elapsedMs: 1, budgetMs: a.budgetMs, priority: "background", inputPending: null });
  return (
    <Section icon="stats" title="Frame budget (RG-02)" right={<Badge tone="ok" data-testid="rg02-count">{a.admitted.length}/{slices.length}</Badge>}>
      <div className="fs-row" style={{ gap: 6 }}>
        <input className="fs-input" style={{ width: fz(70) }} type="number" min={1} max={40} value={n} aria-label="Slice count" onChange={(e) => setN(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} />
        <span className="fs-dim" style={{ fontSize: fz(10.5) }}>slices queued for one frame</span>
      </div>
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="rg02-sentence">{a.sentence}</div>
      <KV k="yielding" v={y.why} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Background work is admitted only into the {a.budgetMs.toFixed(1)} ms left after the input reserve, and a slice that overruns teaches the next frame its measured cost.</div>
    </Section>
  );
}

// ── CT-03 handoff claim ─────────────────────────────────────────────────────
export function HandoffClaimPanel() {
  const [receiverOpen, setReceiverOpen] = useState(false);
  const c = classify({ sameOrigin: true, receiverOpen, channel: receiverOpen, urlFragment: !receiverOpen, bytes: 3200 });
  return (
    <Section icon="claim" title="Continue on another device (CT-03)" right={<Badge tone={c.mechanism === "live" ? "ok" : "warn"} data-testid="ct03-mechanism">{c.mechanism}</Badge>}>
      <label className="fs-row" style={{ gap: 4, fontSize: fz(11) }}><input type="checkbox" checked={receiverOpen} onChange={(e) => setReceiverOpen(e.target.checked)} />another window of this app is open</label>
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="ct03-sentence">{c.sentence}</div>
      <KV k="user action" v={c.userAction} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Two devices cannot be connected live by this app: there is no server and no socket. What travels is a link you carry.</div>
    </Section>
  );
}

// ── AU-01 routine guard ─────────────────────────────────────────────────────
export function RoutineGuardPanel() {
  const [text, setText] = useState("open notes; notify stand up; exec curl example.com");
  const report = useMemo(() => {
    const actions = text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [kind, ...rest] = s.split(/\s+/);
      const arg = rest.join(" ");
      if (kind === "open") return { kind: "open", module: arg };
      if (kind === "notify") return { kind: "notify", text: arg };
      if (kind === "lock") return { kind: "lock" };
      return { kind };
    });
    const rejected = actions.map((a, i) => ({ a, i, c: checkAction(a as never) })).filter((x) => !x.c.ok);
    const good = actions.filter((a, i) => checkAction(a as never).ok || false);
    void good;
    const imported = importRoutine({ id: "draft", name: "Draft", trigger: { kind: "manual" }, actions });
    return { rejected, imported };
  }, [text]);
  const r = report.imported.routine;
  // The plan only needs an ordering timestamp; it is taken from the engine's own
  // argument rather than the clock so the render stays a pure function of `text`.
  const dry = r ? planRoutine(r, true, 0) : null;
  return (
    <Section icon="repeat" title="Routine guard (AU-01)" right={<Badge tone={report.rejected.length ? "bad" : "ok"} data-testid="au01-rejected">{report.rejected.length} refused</Badge>}>
      <textarea className="fs-textarea fs-mono" rows={3} value={text} aria-label="Routine vocabulary" data-testid="au01-text" onChange={(e) => setText(e.target.value)} style={{ fontSize: fz(10.5) }} />
      {report.rejected.length ? <ul className="fs-dim" style={{ fontSize: fz(10.5), margin: 0, paddingLeft: 16 }}>{report.rejected.map((x) => <li key={x.i}>“{x.a.kind}” — {x.c.ok ? "" : x.c.why}</li>)}</ul> : <Badge tone="ok">every action is in the closed vocabulary</Badge>}
      {dry ? <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="au01-plan">{dry.sentence} · audit would record {auditEntry(dry, 0).action}</div> : null}
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>There is no run-script, run-shell or call-URL action: the vocabulary is closed, so a shared routine cannot add a capability.</div>
    </Section>
  );
}

// ── SM-07 Amazon Music ──────────────────────────────────────────────────────
export function AmazonMusicPanel() {
  const [url, setUrl] = useState("https://music.amazon.com/albums/B000000001?tag=affiliate-20&utm_source=x");
  const s = summarise(url);
  return (
    <Section icon="link" title="Amazon Music links (SM-07)" right={<Badge tone={s.confidence === "refused" ? "bad" : "warn"} data-testid="sm07-tone">{s.confidence}</Badge>}>
      <input className="fs-input" value={url} aria-label="Amazon Music address" onChange={(e) => setUrl(e.target.value)} />
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="sm07-sentence">{s.sentence}</div>
      <Rows pairs={[["storefronts", `${STOREFRONTS.length}`], ["stripped", s.stripped.join(", ") || "nothing"], ["embed", s.embedUrl ?? "—"]]} />
    </Section>
  );
}

// ── LN-05 upscale ───────────────────────────────────────────────────────────
export function UpscalePanel() {
  const [scale, setScale] = useState(2);
  const [photo, setPhoto] = useState(true);
  const kernel = chooseKernel(photo, scale);
  const p = planUpscale({ w: 1600, h: 1200, scale, kernel });
  const diff = useMemo(() => {
    const src = [0, 40, 120, 240, 200, 90];
    const a = resampleRow(src, 2, "nearest"), b = resampleRow(src, 2, "lanczos3");
    return maxDiff(a, b).toFixed(1);
  }, []);
  return (
    <Section icon="crop" title="Upscale (LN-05)" right={<Badge tone="ok" data-testid="ln05-kernel">{kernel}</Badge>}>
      <div className="fs-row" style={{ gap: 6 }}>
        <input className="fs-input" style={{ width: fz(70) }} type="number" min={2} max={4} value={scale} aria-label="Upscale factor" onChange={(e) => setScale(Math.max(2, Math.min(4, Number(e.target.value) || 2)))} />
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11) }}><input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} />photograph</label>
      </div>
      <div className="fs-mono" style={{ fontSize: fz(10.5) }} data-testid="ln05-sentence">{p.sentence}</div>
      <Rows pairs={[["output", `${p.out.w}×${p.out.h}`], ["kernel vs bilinear on a test row", `${diff} levels at the edges`], ["lanczos(0)", lanczos(0).toFixed(3)], ["lanczos(3)", lanczos(3).toFixed(3)]]} />
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Interpolation redistributes detail; it never invents it. There is no learned upscaler here and the label says so.</div>
    </Section>
  );
}
