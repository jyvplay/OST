"use client";
import { useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { Btn } from "../ui";

/**
 * TT37 — Browser → Network route: how Fusion's SERVER reaches the web for Private proxy tabs (and the reader /
 * embed probe). Direct, Tor (SOCKS5, names resolved by Tor — no DNS leak, .onion works), or any SOCKS5 / HTTP
 * proxy. "Test" fetches through the candidate route before it is used; with Tor, the Tor Project's check service
 * says whether the exit really is Tor. Kept in server memory only (until restart) — FUSION_WP_UPSTREAM makes it
 * permanent.
 */
export interface RouteInfo { mode: "direct" | "socks5" | "http"; host: string; port: number; auth: boolean; isolate: boolean; label: string }
interface Preset { id: string; label: string; spec: string }
/** TT38: the computer's own proxy settings (https_proxy / http_proxy / all_proxy / no_proxy), read as curl reads them */
interface SystemInfo { available: boolean; active: boolean; source?: string[]; noProxy?: string; https?: RouteInfo | null; http?: RouteInfo | null; errors?: string[] }
interface TestResult { ok: boolean; status?: number; ms: number; via?: string; isTor?: boolean | null; exitIp?: string | null; kind?: string; message?: string; url: string; bytes?: number }

export function useRoute(): [RouteInfo | null, (r: RouteInfo) => void] {
  const [route, setRoute] = useState<RouteInfo | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/wp-route").then((r) => r.json()).then((j: { route: RouteInfo }) => { if (live) setRoute(j.route); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return [route, setRoute];
}

export default function NetworkRoute({ route, onRoute }: { route: RouteInfo | null; onRoute: (r: RouteInfo) => void }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [envError, setEnvError] = useState<string | null>(null);
  const [choice, setChoice] = useState("direct");
  const [custom, setCustom] = useState("");
  const [isolate, setIsolate] = useState(true);
  const [testUrl, setTestUrl] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const touchedRef = useRef(false); // once the user picks, the initial load must not override the choice
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/wp-route").then((r) => r.json()).then((j: { presets: Preset[]; envError: string | null; route: RouteInfo; system?: SystemInfo }) => {
      if (!live) return;
      setPresets(j.presets); setEnvError(j.envError); setSystem(j.system ?? null);
      if (touchedRef.current) return;
      setIsolate(j.route.isolate);
      if (j.system?.active) { setChoice("system"); return; }
      const p = j.presets.find((x) => x.spec === (j.route.mode === "direct" ? "direct" : `${j.route.mode}://${j.route.host}:${j.route.port}`));
      if (p) setChoice(p.id); else { setChoice("custom"); setCustom(`${j.route.mode}://${j.route.host}:${j.route.port}`); }
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const spec = choice === "custom" ? custom.trim() : presets.find((p) => p.id === choice)?.spec ?? "direct";
  const call = async (method: "POST" | "PUT") => {
    setBusy(true); setError(""); if (method === "POST") setResult(null);
    try {
      const r = await fetch("/api/wp-route", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ spec, isolate, ...(method === "POST" && testUrl.trim() ? { url: testUrl.trim() } : {}) }) });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? `HTTP ${r.status}`); return; }
      if (method === "POST") setResult(j as TestResult); else onRoute((j as { route: RouteInfo }).route);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div data-testid="route-panel" role="group" aria-label="Network route" style={{ display: "grid", gap: 6, padding: "6px 8px", fontSize: fz(11.5), borderBottom: "1px solid var(--fs-border)" }}>
      <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <b>Network route</b>
        <span data-testid="route-current">Now: {route?.label ?? "…"}{route && route.mode === "socks5" && route.isolate ? " · circuits isolated per tab / profile" : ""}</span>
        <label className="fs-row" style={{ gap: 4 }}>Route
          <select className="fs-input" data-testid="route-choice" data-touched={touched ? "1" : "0"} data-ready={presets.length ? "1" : "0"} aria-label="Route" value={choice} onChange={(e) => { touchedRef.current = true; setTouched(true); setChoice(e.target.value); setResult(null); }}>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="custom">Custom proxy…</option>
          </select>
        </label>
        {choice === "custom" ? <input className="fs-input" data-testid="route-custom" aria-label="Proxy address" placeholder="socks5://host:port or http://host:port" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ minWidth: 260 }} /> : null}
        <label className="fs-row" style={{ gap: 4 }} title="Tor gives each distinct SOCKS login its own circuit: every tab (or named profile) then exits from a different relay, so sites cannot link them by address">
          <input type="checkbox" data-testid="route-isolate" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />Isolate tabs / profiles
        </label>
      </div>
      <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="fs-input" data-testid="route-test-url" aria-label="Test address" placeholder="Test address (default: Tor Project check)" value={testUrl} onChange={(e) => setTestUrl(e.target.value)} style={{ minWidth: 280 }} />
        <Btn variant="ghost" data-testid="route-test" disabled={busy} onClick={() => call("POST")}>Test route</Btn>
        <Btn variant="primary" data-testid="route-apply" disabled={busy} onClick={() => call("PUT")}>Use this route</Btn>
        <span data-testid="route-result" role="status" aria-live="polite">
          {error ? `Not applied: ${error}` : result ? (result.ok ? `Reached ${new URL(result.url).host} — HTTP ${result.status} in ${result.ms} ms ${result.via ?? ""}${result.isTor === true ? " · Tor: yes" : result.isTor === false ? " · Tor: NO" : ""}${result.exitIp ? ` · exit ${result.exitIp}` : ""}` : `Failed (${result.kind}): ${result.message}`) : busy ? "Working…" : ""}
        </span>
      </div>
      {choice === "system" && system?.available ? (
        <span data-testid="route-system" className="fs-dim">
          From {system.source?.join(", ") || "the environment"}: HTTPS via {system.https?.label ?? "direct"}, HTTP via {system.http?.label ?? "direct"}{system.noProxy ? ` · direct for: ${system.noProxy}` : ""}{system.errors?.length ? ` · ignored: ${system.errors.join("; ")}` : ""}
        </span>
      ) : null}
      <span className="fs-dim">Kept in server memory until restart (set FUSION_WP_UPSTREAM to make it permanent). With a proxy, the server resolves no names itself — the proxy does.{envError ? ` FUSION_WP_UPSTREAM was ignored: ${envError}` : ""}</span>
    </div>
  );
}
