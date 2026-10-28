"use client";
import OrbitTarget from "../OrbitTarget";
import { appForFile } from "@/lib/open-with";
import { baseName, parentPath } from "@/lib/files/model";
import { fz } from "@/lib/uiscale";

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
  const [privInfo, setPrivInfo] = useState<{ hostQueried: boolean; indexed: number | null; locked: boolean } | null>(null);

  const loadCoverage = () => api<{ coverage: { source: string; n: number }[] }>("/api/search")
    .then((r) => setCoverage(r.coverage ?? []))
    .catch(() => undefined);

  useEffect(() => { void loadCoverage(); }, [shell.refreshTick]);

  const search = async () => {
    const r = await api<{ hits: Hit[]; tookMs: number; explain?: Record<string, unknown>; hostQueried?: boolean; locked?: boolean; private?: { indexed: number } | null }>(
      `/api/search?q=${encodeURIComponent(q)}&explain=1${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`,
    );
    // fields present only when the privacy layer answered (TT19): private index size, whether the host saw the query
    setPrivInfo(r.hostQueried === undefined ? null : { hostQueried: r.hostQueried, indexed: r.private?.indexed ?? null, locked: !!r.locked });
    setHits(r.hits);
    setTook(r.tookMs);
    setExplain(r.explain ?? null);
  };

  const openHit = async (h: Hit) => {
    if (h.source === "file") {
      const r = await api<{ node: { mime: string; kind: string; trashed?: boolean } | null }>(`/api/fs?op=stat&path=${encodeURIComponent(h.ref)}`);
      if (!r.node || r.node.trashed) throw new Error("This search result no longer exists");
      shell.open(appForFile(baseName(h.ref), r.node.mime, r.node.kind), { path: h.ref, title: h.title });
    }
    else if (h.source === "note") shell.open("notes", { noteId: Number(h.ref) });
    else if (h.source === "spec") shell.open("spec", { focus: h.ref });
    else shell.open("settings", { focus: h.ref });
  };

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row">
        <input className="fs-input" placeholder="Search the index" value={q} aria-label="Search query"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} />
        <input className="fs-input" style={{ width: fz(160) }} placeholder="Scope (path prefix)" value={scope}
          onChange={(e) => setScope(e.target.value)} aria-label="Scope" />
        <Btn variant="ghost" style={{ whiteSpace: "nowrap" }} onClick={() => setScope(scope.startsWith("/Private") ? "" : "/Private")} title="Search only Persistent Storage, inside this tab — the query is not sent to the host">{scope.startsWith("/Private") ? "All" : "/Private only"}</Btn>
        <Btn variant="primary" onClick={() => void search()}>Search</Btn>
      </div>

      <Section title="Index health" right={<Btn variant="ghost" onClick={() => void loadCoverage()}>Refresh</Btn>}>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {coverage.map((c) => <Badge key={c.source} tone="info">{c.source}: {c.n}</Badge>)}
          {coverage.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(11.5) }}>No documents indexed yet.</span> : null}
        </div>
        <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>
          Ranking uses Postgres <span className="fs-mono">websearch_to_tsquery + ts_rank</span> with a substring
          fallback. No <span className="fs-mono">pg_trgm</span> dependency: the extension is not guaranteed here, so
          correctness comes first and speed is a measured property, not an assumption.
        </div>
      </Section>

      {took !== null ? (
        <div className="fs-row" style={{ gap: 6 }}>
          <Badge tone="ok">{hits.length} hits</Badge><Badge tone="info">{took} ms</Badge><Badge>no cloud service</Badge>
          {privInfo ? <span data-testid="private-search-info" style={{ display: "contents" }}>
            {privInfo.locked ? <Badge tone="warn">Persistent Storage locked</Badge> : privInfo.indexed !== null ? <Badge tone="ok">/Private: {privInfo.indexed} files indexed in this tab</Badge> : null}
            <Badge tone={privInfo.hostQueried ? "warn" : "ok"}>{privInfo.hostQueried ? "host saw the query text" : "query never left this tab"}</Badge>
          </span> : null}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 2 }}>
        {hits.map((h) => (
          <OrbitTarget key={`${h.source}:${h.ref}`} label={`Search result: ${h.title}`} actions={[
            { label: "Open result", run: () => openHit(h) },
            ...(h.source === "file" ? [{ label: "Open containing folder", run: () => shell.open("files", { path: parentPath(h.ref) }) }] : []),
            { label: "Copy reference", run: () => shell.copy(h.ref, "find") },
            { label: "Copy excerpt", run: () => shell.copy(h.snippet, "find") },
          ]}>
          <button className="fs-list-item" style={{ textAlign: "left", border: 0, background: "none", color: "inherit", width: "100%" }}
            onClick={() => { void openHit(h).catch(e => shell.toast(String(e instanceof Error ? e.message : e), "bad")); }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fz(12.5) }}>{h.title}</div>
              <div className="fs-dim fs-mono" style={{ fontSize: fz(10.5), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.ref} — {h.snippet}</div>
            </span>
            <Badge tone={h.how === "fts" || h.how === "private-local" ? "ok" : "warn"}>{h.how === "private-local" ? "encrypted · " : ""}{h.source} · {h.how}</Badge>
          </button>
          </OrbitTarget>
        ))}
        {q && hits.length === 0 && took !== null ? <Empty title="No matches" icon="🔎" /> : null}
      </div>

      {explain ? (
        <Section title="Diagnostics — why might something be missing?">
          <pre className="fs-mono" style={{ fontSize: fz(11), margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(explain, null, 2)}</pre>
        </Section>
      ) : null}

      <Section title="Not searchable here (and why)">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          Other sites&apos; and other apps&apos; content cannot be indexed: the browser&apos;s origin isolation
          forbids reading them, and there is no AppSearch-style opt-in API on the web. Binary file bodies are
          indexed by name only. Anything under <span className="fs-mono">{shell.settings["search.excludes"] ?? "/System/Cache"}</span> is excluded by setting.
        </div>
      </Section>
    </div>
  );
}
