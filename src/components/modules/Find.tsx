"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";

interface Hit { source: string; ref: string; title: string; snippet: string; how: string; rank: number }

/** SR-02/SR-08: search with coverage, provenance and a why-missing explainer. */
export default function FindModule(_: ModuleProps) {
  const shell = useShell();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [coverage, setCoverage] = useState<{ source: string; n: number }[]>([]);
  const [explain, setExplain] = useState<Record<string, unknown> | null>(null);
  const [took, setTook] = useState<number | null>(null);

  const loadCoverage = () => api<{ coverage: { source: string; n: number }[] }>("/api/search")
    .then((r) => setCoverage(r.coverage ?? []))
    .catch(() => undefined);

  useEffect(() => { void loadCoverage(); }, [shell.refreshTick]);

  const search = async () => {
    const r = await api<{ hits: Hit[]; tookMs: number; explain?: Record<string, unknown> }>(
      `/api/search?q=${encodeURIComponent(q)}&explain=1${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`,
    );
    setHits(r.hits);
    setTook(r.tookMs);
    setExplain(r.explain ?? null);
  };

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row">
        <input className="fs-input" placeholder="Search the index" value={q} aria-label="Search query"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} />
        <input className="fs-input" style={{ width: 160 }} placeholder="Scope (path prefix)" value={scope}
          onChange={(e) => setScope(e.target.value)} aria-label="Scope" />
        <Btn variant="primary" onClick={() => void search()}>Search</Btn>
      </div>

      <Section title="Index health" right={<Btn variant="ghost" onClick={() => void loadCoverage()}>Refresh</Btn>}>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {coverage.map((c) => <Badge key={c.source} tone="info">{c.source}: {c.n}</Badge>)}
          {coverage.length === 0 ? <span className="fs-dim" style={{ fontSize: 11.5 }}>No documents indexed yet.</span> : null}
        </div>
        <div className="fs-dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
          Ranking uses Postgres <span className="fs-mono">websearch_to_tsquery + ts_rank</span> with a substring
          fallback. No <span className="fs-mono">pg_trgm</span> dependency: the extension is not guaranteed here, so
          correctness comes first and speed is a measured property, not an assumption.
        </div>
      </Section>

      {took !== null ? (
        <div className="fs-row" style={{ gap: 6 }}>
          <Badge tone="ok">{hits.length} hits</Badge><Badge tone="info">{took} ms</Badge><Badge>local only</Badge>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 2 }}>
        {hits.map((h) => (
          <button key={`${h.source}:${h.ref}`} className="fs-list-item" style={{ textAlign: "left", border: 0, background: "none", color: "inherit", width: "100%" }}
            onClick={() => {
              if (h.source === "file") shell.open("editor", { path: h.ref, title: h.title });
              else if (h.source === "note") shell.open("notes", { noteId: Number(h.ref) });
              else if (h.source === "spec") shell.open("spec", { focus: h.ref });
              else shell.open("settings", { focus: h.ref });
            }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5 }}>{h.title}</div>
              <div className="fs-dim fs-mono" style={{ fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.ref} — {h.snippet}</div>
            </span>
            <Badge tone={h.how === "fts" ? "ok" : "warn"}>{h.source} · {h.how}</Badge>
          </button>
        ))}
        {q && hits.length === 0 && took !== null ? <Empty title="No matches" icon="🔎" /> : null}
      </div>

      {explain ? (
        <Section title="Diagnostics — why might something be missing?">
          <pre className="fs-mono" style={{ fontSize: 11, margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(explain, null, 2)}</pre>
        </Section>
      ) : null}

      <Section title="Not searchable here (and why)">
        <div className="fs-dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          Other sites&apos; and other apps&apos; content cannot be indexed: the browser&apos;s origin isolation
          forbids reading them, and there is no AppSearch-style opt-in API on the web. Binary file bodies are
          indexed by name only. Anything under <span className="fs-mono">{shell.settings["search.excludes"] ?? "/System/Cache"}</span> is excluded by setting.
        </div>
      </Section>
    </div>
  );
}
