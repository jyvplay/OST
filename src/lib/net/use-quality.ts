"use client";

/**
 * TT146 (HW-09) — the live, browser-bound half of the network policy.
 *
 * The engine in `quality.ts` is pure. This hook is the only place that touches
 * `navigator.connection`, timers and `fetch`, so the policy can be tested
 * exhaustively and the browser-facing part stays small enough to read.
 *
 * Measurement is opt-in by default: downloading a probe on every module mount
 * would be exactly the waste the policy exists to prevent. One probe is taken
 * when a caller asks for it (the Runtime pane, or the first gallery that needs a
 * size), and the estimate is remembered for the session.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ThroughputEstimator, TierStabilizer, planQuality, readNetworkFacts,
  type Confidence, type NetworkFacts, type PlanOptions, type QualityDecision, type Surface,
} from "./quality";

type Connection = EventTarget & { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };

function connection(): Connection | undefined {
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { connection?: Connection });
  return nav?.connection;
}

const shared = new ThroughputEstimator({ alpha: 0.4, minBytes: 16 * 1024 });
let lastProbe = 0;

/**
 * The estimate is one fact about the machine, not one fact per window: a probe
 * taken in the Runtime pane must re-plan the gallery that is already painted.
 * Components subscribe to this set; the pure engine stays unaware of React.
 */
const listeners = new Set<(s: { bps: number | null; confidence: Confidence }) => void>();
function publish() {
  const snap = currentThroughput();
  for (const l of listeners) {
    try { l(snap); } catch { /* a broken subscriber must not stop the others */ }
  }
}

/**
 * Measure the link once per `minIntervalMs`, using a same-origin response whose
 * size we can observe. The probe is a real request the server already answers
 * cheaply; nothing is invented when it fails, and a failure leaves the estimate
 * exactly as it was.
 */
export async function measureThroughput(url = "/api/features?probe=1", minIntervalMs = 30_000): Promise<{ bps: number | null; confidence: Confidence; note: string }> {
  const now = Date.now();
  if (now - lastProbe < minIntervalMs && shared.bps(now) !== null) {
    return { bps: shared.bps(now), confidence: shared.confidence(now), note: "reused the session estimate" };
  }
  lastProbe = now;
  const t0 = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return { bps: shared.bps(now), confidence: shared.confidence(now), note: `probe answered ${res.status}; keeping the previous estimate` };
    const bytes = (await res.arrayBuffer()).byteLength;
    const ms = performance.now() - t0;
    const verdict = shared.add({ bytes, ms }, Date.now());
    if (verdict.accepted) publish();
    return {
      bps: shared.bps(),
      confidence: shared.confidence(),
      note: verdict.accepted ? `measured ${(bytes / 1024).toFixed(0)} KiB in ${ms.toFixed(0)} ms` : verdict.reason,
    };
  } catch {
    return { bps: shared.bps(now), confidence: shared.confidence(now), note: "probe failed; keeping the previous estimate" };
  }
}

export function currentThroughput(): { bps: number | null; confidence: Confidence } {
  return { bps: shared.bps(Date.now()), confidence: shared.confidence(Date.now()) };
}

export interface QualityState {
  facts: NetworkFacts;
  bps: number | null;
  confidence: Confidence;
  decision: QualityDecision;
  note: string;
  measure: () => Promise<void>;
}

export function useQuality(surface: Surface, opts: PlanOptions = {}): QualityState {
  const [facts, setFacts] = useState<NetworkFacts>(() =>
    readNetworkFacts(connection(), typeof navigator === "undefined" ? true : navigator.onLine));
  const [measured, setMeasured] = useState(() => currentThroughput());
  const [note, setNote] = useState("the browser's estimate is used until something is measured");
  const planOptions = useRef(opts);
  planOptions.current = opts;

  useEffect(() => {
    const conn = connection();
    const sync = () => setFacts(readNetworkFacts(conn, navigator.onLine));
    sync();
    conn?.addEventListener?.("change", sync);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      conn?.removeEventListener?.("change", sync);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    const onShared = (s: { bps: number | null; confidence: Confidence }) => {
      setMeasured(s);
      setNote(`measured elsewhere in this session: ${s.bps ? `${(s.bps / 1_000_000).toFixed(1)} Mbit/s` : "no usable sample"}`);
    };
    listeners.add(onShared);
    return () => { listeners.delete(onShared); };
  }, []);

  const measure = useMemo(() => async () => {
    const r = await measureThroughput();
    setMeasured({ bps: r.bps, confidence: r.confidence });
    setNote(r.note);
  }, []);

  const decision = useMemo(
    () => planQuality(facts, measured.bps, measured.confidence, surface, planOptions.current),
    [facts, measured, surface],
  );

  return { facts, bps: measured.bps, confidence: measured.confidence, decision, note, measure };
}

/**
 * Stabilised rung for surfaces that change behind the user (a video, a gallery
 * that is already painted). Down moves are immediate; up moves need evidence.
 */
export function useStableTier(surface: Surface, opts: PlanOptions = {}): { tier: number; decision: QualityDecision } {
  const q = useQuality(surface, opts);
  const stab = useRef(new TierStabilizer(2));
  const [tier, setTier] = useState<number>(2);
  useEffect(() => {
    const r = stab.current.update(q.decision.tier, Date.now());
    if (r.moved) setTier(r.tier);
  }, [q.decision.tier]);
  return { tier, decision: q.decision };
}
