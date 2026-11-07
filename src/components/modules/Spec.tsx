"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { detectBrowserFamily, SETTINGS_INDEX, resolveSetting } from "@/lib/settings-links";
import { Badge, Btn, Section } from "../ui";
import { familyProgress } from "@/lib/family-progress";
import { familyProgressText } from "@/lib/family-progress-text";

interface Row {
  code: string; family: string; name: string; tier: string; phase: string;
  route: string; nuance: string; status: string; test: string;
}
interface Spike { code: string; question: string; pass: string; fallback: string; status: string; result: string }

const STATUS_TONE: Record<string, "ok" | "warn" | "info" | "bad" | "default"> = {
  built: "ok", partial: "warn", probe: "info", skeleton: "default", blocked: "bad",
};

/**
 * The register is not documentation: it is a table in Postgres that the running
 * app reads. "requirements.csv" is regenerated from it, and every blocked row
 * states the missing primitive — which is what makes the capability-honesty
 * claim checkable instead of rhetorical.
 */
export default function SpecModule({ win }: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Row[]>([]);
  const [spikes, setSpikes] = useState<Spike[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [q, setQ] = useState((win.props.focus as string) ?? "");
  const [status, setStatus] = useState("");
  const [family, setFamily] = useState("");
  const [open, setOpen] = useState<string | null>((win.props.focus as string) ?? null);

  const [cov, setCov] = useState<{ generatedAt: string | null; rows: Record<string, { tested: string; tests: string[] }>; totals: { tested: Record<string, number>; tests: { total: number; passed: number } } | null } | null>(null);
  const [health, setHealth] = useState<{ total: number; issues: { kind: string; code: string; detail: string }[] } | null>(null);
  useEffect(() => { api<NonNullable<typeof health>>("/api/spec-health").then(setHealth).catch(() => undefined); }, []);
  useEffect(() => {
    api<NonNullable<typeof cov>>("/api/ledger").then(setCov).catch(() => undefined);
  }, []);
  useEffect(() => {
    api<{ rows: Row[]; counts: Record<string, number> }>("/api/features")
      .then((r) => { setRows(r.rows); setCounts(r.counts); })
      .catch(() => undefined);
    api<{ rows: Spike[] }>("/api/spikes").then((r) => setSpikes(r.rows)).catch(() => undefined);
  }, []);

  const families = useMemo(() => [...new Set(rows.map((r) => r.family))], [rows]);
  const shown = rows.filter((r) =>
    (!q || `${r.code} ${r.name} ${r.route} ${r.nuance}`.toLowerCase().includes(q.toLowerCase())) &&
    (!status || r.status === status) &&
    (!family || r.family === family));

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <strong style={{ fontSize: fz(13) }}>Feature register</strong>
        <Badge tone="info">{rows.length} rows</Badge>
        {Object.entries(counts).map(([k, v]) => (
          <button key={k} className="fs-btn" data-variant={status === k ? "primary" : "ghost"} style={{ minHeight: 22 }}
            onClick={() => setStatus(status === k ? "" : k)}>
            <Badge tone={STATUS_TONE[k] ?? "default"}>{k}</Badge> {v}
          </button>
        ))}
        {rows.length ? <span className="fs-row" style={{ gap: 6 }}><span className="fs-dim" style={{ fontSize: fz(11) }} data-testid="spec-family-progress">{familyProgress(rows).slice(0, 6).map((f) => `${f.family} ${f.pct}%`).join(" · ")}</span><Btn variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(familyProgressText(rows)); shell.toast("Family progress copied."); } catch { shell.toast("Clipboard unavailable.", "bad"); } }} data-testid="spec-copy-progress">Copy</Btn></span> : null}
        {cov?.totals ? <Badge tone="info" title={`Latest saved result per suite, from different runs; ledger generated ${cov.generatedAt}`}>recorded: {cov.totals.tested.full} full · {cov.totals.tested.partial} partial · {cov.totals.tests.passed}/{cov.totals.tests.total} tests passed</Badge> : null}
        <div style={{ flex: 1 }} />
        <Btn variant="ghost" onClick={() => window.open("/api/features?format=csv", "_blank")}>Export requirements.csv</Btn>
      </div>

      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ flex: 1, minWidth: fz(180) }} placeholder="Filter by code, name, mechanism or nuance"
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the register" />
        <select className="fs-select" style={{ width: fz(120) }} value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Family">
          <option value="">all families</option>
          {families.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      <div style={{ display: "grid", gap: 3 }}>
        {shown.map((r) => (
          <div key={r.code} data-testid="spec-row" data-code={r.code} className="fs-panel" style={{ padding: 8, display: "grid", gap: 4 }}>
            <button className="fs-row" style={{ justifyContent: "space-between", gap: 8, background: "none", border: 0, color: "inherit", textAlign: "left", cursor: "pointer" }}
              onClick={() => setOpen(open === r.code ? null : r.code)}>
              <span className="fs-row" style={{ gap: 6, minWidth: 0 }}>
                <span className="fs-mono" style={{ fontSize: fz(11), width: 62 }}>{r.code}</span>
                <span style={{ fontSize: fz(12), overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
              </span>
              <span className="fs-row" style={{ gap: 5 }}>
                <Badge>{r.tier}</Badge>
                <Badge>{r.phase}</Badge>
                <Badge tone={STATUS_TONE[r.status] ?? "default"}>{r.status}</Badge>
                <span role="img" aria-label={`Saved coverage: ${cov?.rows[r.code]?.tested ?? "none"}`} title={`Saved-suite snapshot, not one fresh run. ${(cov?.rows[r.code]?.tests ?? []).join(" · ") || "No passing automated coverage"}`}>
                  <Badge tone={cov?.rows[r.code]?.tested === "full" ? "ok" : cov?.rows[r.code]?.tested === "partial" ? "warn" : "default"}>
                    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />{cov?.rows[r.code]?.tested === "full" ? <path d="m4.5 8 2.2 2.3 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.6" /> : cov?.rows[r.code]?.tested === "partial" ? <path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor" /> : <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" />}</svg>
                  </Badge>
                </span>
              </span>
            </button>
            {open === r.code ? (
              <div style={{ display: "grid", gap: 4, paddingLeft: 68 }}>
                <div style={{ fontSize: fz(11.5) }}><span className="fs-dim">mechanism: </span><span className="fs-mono">{r.route}</span></div>
                {r.nuance ? <div style={{ fontSize: fz(11.5), lineHeight: 1.6 }}><span className="fs-dim">nuance: </span>{r.nuance}</div> : null}
                {r.test ? <div style={{ fontSize: fz(11.5) }}><span className="fs-dim">falsification test: </span>{r.test}</div> : null}
                {(cov?.rows[r.code]?.tests ?? []).length ? <div style={{ fontSize: fz(11) }}><span className="fs-dim">passing evidence: </span>{cov!.rows[r.code].tests.join(" · ")}</div> : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <Section title="Browser settings index (ST-02)" icon="outline" right={<Badge tone="info" data-testid="spec-browser-family">{detectBrowserFamily(typeof navigator === "undefined" ? "" : navigator.userAgent)}</Badge>}>
        <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>A page cannot open these, so each one copies the exact address instead.</div>
        <div style={{ display: "grid", gap: 2 }} data-testid="spec-settings-index">
          {SETTINGS_INDEX.map((entry) => {
            const resolved = resolveSetting(entry.id, typeof navigator === "undefined" ? "" : navigator.userAgent);
            if (!resolved) return null;
            const canOpen = resolved.action === "open" && resolved.url;
            return (
              <button key={entry.id} className="fs-navitem" data-testid={`spec-setting-${entry.id}`} title={resolved.instruction}
                onClick={() => { if (canOpen) { window.open(resolved.url!, "_blank", "noopener,noreferrer"); return; } void shell.copy(resolved.url ?? entry.purpose, "spec").then(() => shell.toast(resolved.action === "copy" ? "Address copied — paste it in the address bar." : resolved.instruction)); }}
                style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, textAlign: "left", padding: "3px 6px", background: "transparent", border: 0, color: "inherit", fontSize: fz(11.5) }}>
                <span>{entry.label}</span>
                <span className={`fs-dim fs-mono`} style={{ fontSize: fz(10) }}>{resolved.action === "open" ? "open" : resolved.action === "copy" ? "copy" : resolved.action === "manual" ? "menu" : "n/a"}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Register health (SP-01)">
        {health ? (health.issues.length ? (
          <div style={{ display: "grid", gap: 3 }}>
            <Badge tone="warn">{health.issues.length} issue(s) across {health.total} rows</Badge>
            {health.issues.slice(0, 40).map((i, n) => <div key={n} style={{ fontSize: fz(11.5) }}><span className="fs-mono">{i.code}</span> · {i.kind} — {i.detail}</div>)}
            {health.issues.length > 40 ? <div className="fs-dim" style={{ fontSize: fz(11) }}>…and {health.issues.length - 40} more (fix the first ones; this list is recomputed live)</div> : null}
          </div>
        ) : <Badge tone="ok">register is consistent: every built row is claimed by a module and every cited suite exists</Badge>)
        : <span className="fs-dim" style={{ fontSize: fz(11.5) }}>checking…</span>}
      </Section>

      <details data-testid="spec-spikes">
        <summary style={{ cursor: "pointer", fontSize: fz(12) }}>Questions &amp; checks ({spikes.length})</summary>
        <Section title="Spikes — open questions with pass criteria">
        <div style={{ display: "grid", gap: 4 }}>
          {spikes.map((s) => (
            <div key={s.code} data-testid="spec-spike" data-code={s.code} className="fs-panel" style={{ padding: 8, display: "grid", gap: 3 }}>
              <div className="fs-row" style={{ justifyContent: "space-between" }}>
                <span className="fs-row" style={{ gap: 6 }}>
                  <span className="fs-mono" style={{ fontSize: fz(11) }}>{s.code}</span>
                  <span style={{ fontSize: fz(12) }}>{s.question}</span>
                </span>
                <Badge tone={s.status === "passed" ? "ok" : s.status === "failed" ? "bad" : "warn"}>{s.status}</Badge>
              </div>
              <div className="fs-dim" style={{ fontSize: fz(11) }}>pass: {s.pass} · fallback: {s.fallback}</div>
              {s.result ? <div style={{ fontSize: fz(11) }}>{s.result}</div> : null}
            </div>
          ))}
        </div>
        </Section>
      </details>

      <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
        Status vocabulary: <strong>built</strong> runs end to end here · <strong>partial</strong> runs with a named
        degradation · <strong>probe</strong> ships as a runtime capability check plus honest degrade UI ·
        <strong> skeleton</strong> is a typed seam with no engine · <strong>blocked</strong> is provably impossible on
        this platform and says why. Open <Btn variant="ghost" onClick={() => shell.open("settings")}>Capabilities</Btn>
        to see the probe that justifies each blocked row.
      </div>
    </div>
  );
}
