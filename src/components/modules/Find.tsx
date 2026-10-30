"use client";
import OrbitTarget from "../OrbitTarget";
import { appForFile } from "@/lib/open-with";
import { baseName, parentPath } from "@/lib/files/model";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";
import { compileFind, findInText } from "@/lib/find-core";
import { loadSavedSearches, storeSavedSearches, type SavedSearch } from "@/lib/saved-searches";
import { loadRecents, storeRecents, pushRecent, type RecentSearch } from "@/lib/recent-searches";
import { sourceSummary } from "@/lib/result-groups";
import { askText } from "@/lib/ask";

interface Hit { source: string; ref: string; title: string; snippet: string; how: string; rank: number; matchedFields?: {field:string;value:string}[] }

/** SR-02/SR-08: search with coverage, provenance and a why-missing explainer. */
export default function FindModule(_: ModuleProps) {
  const shell = useShell();
  const [q, setQ] = useState("");
  const [mode,setMode]=useState('text'),[field,setField]=useState(''),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[queryUsed,setQueryUsed]=useState('');
  const request=useRef<AbortController|null>(null);
  useEffect(()=>()=>request.current?.abort(),[]);
  const invalidate=()=>{request.current?.abort();setBusy(false);setCursor(null);setHits([]);setExplain(null);setTook(null);setQueryUsed('');setError('');};
  const [scope, setScope] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [coverage, setCoverage] = useState<{ source: string; n: number }[]>([]);
  const [explain, setExplain] = useState<Record<string, unknown> | null>(null);
  const [took, setTook] = useState<number | null>(null);
  const [privInfo, setPrivInfo] = useState<{ hostQueried: boolean; indexed: number | null; locked: boolean } | null>(null);
  // TT117 FN-01: pattern filter over the returned snippets (client-side; never re-queries the host).
  const [pattern, setPattern] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [caseSens, setCaseSens] = useState(false);
  const compiled = pattern ? compileFind(pattern, { regex: useRegex, caseSensitive: caseSens, wholeWord: false }) : null;
  const shownHits = !pattern || !compiled || "error" in compiled ? hits : hits.filter((h) => findInText(`${h.title} ${h.snippet}`, compiled.pattern).matches.length > 0);
  const [saved, setSaved] = useState<SavedSearch[]>(() => { try { return loadSavedSearches(localStorage); } catch { return []; } });
  const persistSaved = (l: SavedSearch[]) => { setSaved(l); try { storeSavedSearches(localStorage, l); } catch (e) { shell.toast(String((e as Error).message), "warn"); } };
  const [recents, setRecents] = useState<RecentSearch[]>(() => { try { return loadRecents(localStorage); } catch { return []; } });
  const persistRecents = (l: RecentSearch[]) => { setRecents(l); try { storeRecents(localStorage, l); } catch { /* private mode */ } };

  useEffect(()=>{
    const clear=()=>{request.current?.abort();setBusy(false);setQ('');setField('');setScope('');setHits([]);setCursor(null);setExplain(null);setTook(null);setQueryUsed('');setError('');setPrivInfo(null);};
    window.addEventListener('fusion:privacy-locked',clear);
    return()=>window.removeEventListener('fusion:privacy-locked',clear);
  },[]);

  const loadCoverage = () => api<{ coverage: { source: string; n: number }[] }>("/api/search")
    .then((r) => setCoverage(r.coverage ?? []))
    .catch(() => undefined);

  useEffect(() => { void loadCoverage(); }, [shell.refreshTick]);

  const search = async (next='') => {
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setBusy(true);setError('');const started=performance.now();
    try{
      const params=new URLSearchParams({q,scope,explain:'1'});if(mode==='metadata'){params.set('mode',mode);params.set('field',field);if(next)params.set('cursor',next);}
      const r=await api<{hits:Hit[];tookMs?:number;explain?:Record<string,unknown>;hostQueried?:boolean;locked?:boolean;private?:{indexed:number}|null;nextCursor?:string;coverageNotice?:string;scanned?:number;truncatedFiles?:number;warnings?:unknown;storage?:string;enumerationTruncated?:boolean}>(`/api/search?${params}`,{signal:controller.signal});
      if(controller.signal.aborted)return;
      setPrivInfo(r.hostQueried===undefined?null:{hostQueried:r.hostQueried,indexed:r.private?.indexed??null,locked:!!r.locked});
      setHits(previous=>next?[...previous,...r.hits.filter(h=>!previous.some(old=>old.source===h.source&&old.ref===h.ref))]:r.hits);
      setQueryUsed(q);setCursor(r.nextCursor??null);setTook(r.tookMs??Math.round(performance.now()-started));
      setExplain(mode==='metadata'?{coverage:r.coverageNotice,scanned:r.scanned,truncatedFiles:r.truncatedFiles,storage:r.storage,enumerationTruncated:r.enumerationTruncated,warnings:r.warnings}:r.explain??null);
    }catch(e){if(!controller.signal.aborted){setError(e instanceof Error?e.message:String(e));setCursor(null);setHits([]);}}
    finally{if(request.current===controller)setBusy(false);}
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
      <div className="fs-row" style={{flexWrap:'wrap'}}>
        <label>Search mode <select aria-label="Search mode" className="fs-input" value={mode} onChange={e=>{invalidate();setMode(e.target.value);}}><option value="text">Fast text index</option><option value="metadata">Live metadata / transcripts / lyrics</option></select></label>
        {mode==='metadata'?<label>Metadata field (optional)<input className="fs-input" aria-label="Metadata field" placeholder="artist, lyrics, content.transcript…" value={field} onChange={e=>{invalidate();setField(e.target.value);}}/></label>:null}
        <input className="fs-input" placeholder="Search the index" value={q} aria-label="Search query"
          onChange={(e) => {invalidate();setQ(e.target.value);}} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} />
        <input className="fs-input" style={{ width: fz(160) }} placeholder="Scope (path prefix)" value={scope}
          onChange={(e) => {invalidate();setScope(e.target.value);}} aria-label="Scope" />
        <Btn variant="ghost" style={{ whiteSpace: "nowrap" }} onClick={() => {invalidate();setScope(scope==="/Private"||scope.startsWith("/Private/") ? "" : "/Private");}} title="Search only Persistent Storage, inside this tab — the query is not sent to the host">{scope==="/Private"||scope.startsWith("/Private/") ? "All" : "/Private only"}</Btn>
        <Btn variant="primary" disabled={busy} onClick={() => { if (q.trim()) persistRecents(pushRecent(recents, { q, scope, mode: mode === "metadata" ? "metadata" : "text", at: Date.now() })); void search(); }}>Search</Btn>
        <Btn variant="ghost" disabled={!q} onClick={async () => { const name = await askText("Saved search name", "", { okLabel: "Save search" }); if (!name) return; persistSaved([{ id: `s${Date.now().toString(36)}`, name, q, scope, mode: mode === "metadata" ? "metadata" : "text", savedAt: Date.now() }, ...saved]); }}>Save<span className="sr-only"> this search</span></Btn>
      </div>

      {recents.length ? <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }} data-testid="find-recents"><span className="fs-dim" style={{ fontSize: fz(11) }}>Recent:</span>{recents.slice(0, 8).map((r, i) => (
        <Btn key={i} variant="ghost" onClick={() => { setQ(r.q); setScope(r.scope); setMode(r.mode); }}>{r.q}</Btn>
      ))}</div> : null}
      {saved.length ? <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>{saved.map((sv) => (
        <span key={sv.id} className="fs-row" style={{ gap: 3 }}>
          <Btn variant="ghost" onClick={() => { setMode(sv.mode); setScope(sv.scope); setQ(sv.q); }}>{sv.name}</Btn>
          <Btn variant="ghost" aria-label={`Delete saved search ${sv.name}`} onClick={() => persistSaved(saved.filter((x) => x.id !== sv.id))}>✕</Btn>
        </span>))}</div> : null}
      {error?<div role="alert">{error}</div>:null}
      {busy?<div role="status">Searching…</div>:null}
      {mode==='metadata'?<p>Live pages search stored file fields, nested JSON/JSONL values, CSV/TSV cells, text transcripts (VTT/SRT), LRC lyrics and supported image/audio headers. No speech recognition or inferred lyrics. 32 files/page; 262,144 stored string units/file (not bytes), 4096 scalar fields, depth 24. Skipped/unsupported content is reported. Host and /Private scans are separate; amnesic scans search RAM only.</p>:null}
      {queryUsed?<div>Results for: {queryUsed}</div>:null}
      <Section title="Index health" right={<Btn variant="ghost" onClick={() => void loadCoverage()}>Refresh</Btn>}>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {coverage.map((c) => <Badge key={c.source} tone="info">{c.source}: {c.n}</Badge>)}
          {coverage.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(11.5) }}>No documents indexed yet.</span> : null}
        </div>
        <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>
          {mode==='metadata'?'Live metadata uses NFKC + lowercase literal matching over bounded pages. The counts above describe the fast text index, not complete metadata coverage.':<>Ranking uses Postgres <span className="fs-mono">websearch_to_tsquery + ts_rank</span> with a substring
          fallback. No <span className="fs-mono">pg_trgm</span> dependency: the extension is not guaranteed here, so
          correctness comes first and speed is a measured property, not an assumption.</>}
        </div>
      </Section>

      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <input className="fs-input" style={{ flex: 1, minWidth: fz(160) }} placeholder="Filter these results by pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Filter results by pattern" />
        <label className="fs-row" style={{ gap: 4 }}><input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} /> regex</label>
        <label className="fs-row" style={{ gap: 4 }}><input type="checkbox" checked={caseSens} onChange={(e) => setCaseSens(e.target.checked)} /> case</label>
        {compiled && "error" in compiled ? <Badge tone="bad">{compiled.error}</Badge> : pattern ? <Badge tone="info">{shownHits.length} of {hits.length} results match</Badge> : null}
      </div>

      {took !== null ? (
        <div className="fs-row" style={{ gap: 6 }}>
          <Badge tone="ok">{hits.length} hits</Badge><Badge tone="info">{took} ms</Badge><Badge>no cloud service</Badge>
          {hits.length ? <span className="fs-dim" style={{ fontSize: fz(11.5) }} data-testid="find-source-summary">{sourceSummary(hits)}</span> : null}
          {privInfo ? <span data-testid="private-search-info" style={{ display: "contents" }}>
            {privInfo.locked ? <Badge tone="warn">Persistent Storage locked</Badge> : privInfo.indexed !== null ? <Badge tone="ok">/Private: {privInfo.indexed} files indexed in this tab</Badge> : null}
            <Badge tone={privInfo.hostQueried ? "warn" : "ok"}>{privInfo.hostQueried ? "host saw the query text" : "query never left this tab"}</Badge>
          </span> : null}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 2 }}>
        {shownHits.map((h) => (
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
              {h.matchedFields?<div aria-label="Matched metadata fields">{h.matchedFields.map((m,i)=><div key={i}><strong>{m.field}</strong>: {m.value}</div>)}</div>:null}
            </span>
            <Badge tone={h.how === "fts" || h.how === "private-local" ? "ok" : "warn"}>{h.how === "private-local" ? "encrypted · " : ""}{h.source} · {h.how}</Badge>
          </button>
          </OrbitTarget>
        ))}
        {q && hits.length === 0 && took !== null ? <Empty title="No matches in returned results (check coverage/pages)" icon="🔎" /> : null}
      </div>

      {cursor?<Btn disabled={busy} onClick={()=>void search(cursor)}>Search next metadata page</Btn>:null}
      {explain ? (
        <Section title="Diagnostics — why might something be missing?">
          <pre className="fs-mono" style={{ fontSize: fz(11), margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(explain, null, 2)}</pre>
        </Section>
      ) : null}

      <Section title="Not searchable here (and why)">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          Other sites&apos; and other apps&apos; content cannot be indexed: the browser&apos;s origin isolation
          forbids reading them, and there is no AppSearch-style opt-in API on the web. Fast-index binary bodies are indexed by name only; live metadata mode separately scans supported headers and stored transcripts/lyrics. It does not extract arbitrary audio speech, encrypted content, compressed metadata or every binary format. Anything under <span className="fs-mono">{shell.settings["search.excludes"] ?? "/System/Cache"}</span> is excluded by setting.
        </div>
      </Section>
    </div>
  );
}
