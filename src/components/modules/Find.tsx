"use client";
import OrbitTarget from "../OrbitTarget";
import { appForFile } from "@/lib/open-with";
import { baseName, parentPath } from "@/lib/files/model";
import { fz } from "@/lib/uiscale";
import { useEffect, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { buildQuery } from "@/lib/phrase-query";
import { exportSavedSearches, importSavedSearches, loadSavedSearches, SEARCH_EXPORT_LIMIT, storeSavedSearches, validateSavedSearches, type SavedSearch } from "@/lib/saved-searches";
import { clearRecents, loadRecents, purgePrivateRecents, storeRecents, pushRecent, type RecentSearch } from "@/lib/recent-searches";
import { sourceSummary } from "@/lib/result-groups";
import { resultsText } from "@/lib/result-filter";
import { askConfirm, askText } from "@/lib/ask";
import { diagnosticFilePath, EMPTY_SEARCH, orderSearchHits, privateSearchScope, searchInput, type SearchInput } from "@/lib/search-query";
import { useSearchFilter } from "@/lib/use-search-filter";
import { privacy } from "@/lib/privacy/session";

interface Hit { source: string; ref: string; title: string; snippet: string; how: string; rank: number; matchedFields?: { field: string; value: string }[] }
interface SearchResponse {
  hits: Hit[]; tookMs?: number; explain?: Record<string, unknown>; hostQueried?: boolean; locked?: boolean;
  private?: { indexed: number; truncated?: boolean } | null; nextCursor?: string; coverageNotice?: string;
  scanned?: number; truncatedFiles?: number; warnings?: unknown; storage?: string; enumerationTruncated?: boolean;
}
export default function FindModule(_: ModuleProps) {
  const shell = useShell();
  const toast = shell.toast;
  const [input, setInput] = useState<SearchInput>({ ...EMPTY_SEARCH });
  const [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [queryUsed, setQueryUsed] = useState("");
  const request = useRef<AbortController | null>(null);
  // Clearing history invalidates any older in-flight completion.
  const historyEpoch = useRef(0);
  const [hits, setHits] = useState<Hit[]>([]), [coverage, setCoverage] = useState<{ source: string; n: number }[]>([]);
  const [explain, setExplain] = useState<Record<string, unknown> | null>(null), [took, setTook] = useState<number | null>(null);
  const [privInfo, setPrivInfo] = useState<{ hostQueried: boolean; indexed: number | null; locked: boolean; truncated: boolean } | null>(null);
  const filtered = useSearchFilter(hits, input.filter, input.regex, input.caseSensitive);
  const shownHits = orderSearchHits(filtered.hits, input.sort);
  const [saved, setSaved] = useState<SavedSearch[]>(() => { try { return loadSavedSearches(localStorage); } catch { return []; } });
  const [recents, setRecents] = useState<RecentSearch[]>(() => { try { return loadRecents(localStorage); } catch { return []; } });
  const [amnesic] = useState(() => privacy.status().amnesic);
  useEffect(() => {
    try { purgePrivateRecents(localStorage); } catch { toast("Could not remove legacy Private-query history. Clear browser storage when possible.", "warn"); }
  }, [toast]);
  const [rebuilding, setRebuilding] = useState(false), [maintenance, setMaintenance] = useState("");
  const rebuildPending = useRef(false);
  const [checkPath, setCheckPath] = useState(""), [diagnosis, setDiagnosis] = useState<Record<string, unknown> | null>(null), [checking, setChecking] = useState(false), [checkError, setCheckError] = useState("");
  const diagnosticRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); diagnosticRequest.current?.abort(); }, []);
  const invalidate = () => { request.current?.abort(); setBusy(false); setCursor(null); setHits([]); setExplain(null); setTook(null); setQueryUsed(""); setPrivInfo(null); setError(""); };
  const update = (patch: Partial<SearchInput>) => { invalidate(); setInput(current => ({ ...current, ...patch })); };
  const replay = (record: SavedSearch | RecentSearch) => { try { const next = searchInput(record); invalidate(); setInput(next); } catch (e) { setError((e as Error).message); } };
  const persistSaved = (list: SavedSearch[]) => {
    try { const valid = validateSavedSearches(list); storeSavedSearches(localStorage, valid); setSaved(valid); setError(""); }
    catch (e) { setError((e as Error).message); }
  };
  const loadCoverage = () => api<{ coverage: { source: string; n: number }[] }>("/api/search").then(r => setCoverage(r.coverage ?? []));
  useEffect(() => { void loadCoverage().catch(() => undefined); }, [shell.refreshTick]);
  useEffect(() => {
    const clear = () => { request.current?.abort(); diagnosticRequest.current?.abort(); setBusy(false); setChecking(false); setInput({ ...EMPTY_SEARCH }); setHits([]); setCursor(null); setExplain(null); setTook(null); setQueryUsed(""); setError(""); setPrivInfo(null); setDiagnosis(null); setCheckPath(""); setCheckError(""); };
    window.addEventListener("fusion:privacy-locked", clear); return () => window.removeEventListener("fusion:privacy-locked", clear);
  }, []);
  const search = async (next = "") => {
    let current: SearchInput;
    try { current = searchInput(input); } catch (e) { setError((e as Error).message); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); const started = performance.now(), historyAtStart = historyEpoch.current;
    try {
      const params = new URLSearchParams({ q: current.mode === "text" && current.match === "ranked" ? buildQuery(current.q, current.phrase) : current.q.trim(), scope: current.scope, source: current.source, extension: current.extension, explain: "1" });
      if (current.mode === "metadata") { params.set("mode", "metadata"); params.set("field", current.field); if (next) params.set("cursor", next); }
      else params.set("match", current.match);
      const r = await api<SearchResponse>(`/api/search?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setPrivInfo(r.hostQueried === undefined ? null : { hostQueried: r.hostQueried, indexed: r.private?.indexed ?? null, locked: !!r.locked, truncated: !!r.private?.truncated });
      setHits(previous => next ? [...previous, ...r.hits.filter(hit => !previous.some(old => old.source === hit.source && old.ref === hit.ref))] : r.hits);
      setQueryUsed(current.q); setCursor(r.nextCursor ?? null); setTook(r.tookMs ?? Math.round(performance.now() - started));
      setExplain(current.mode === "metadata" ? { coverage: r.coverageNotice, scanned: r.scanned, truncatedFiles: r.truncatedFiles, storage: r.storage, enumerationTruncated: r.enumerationTruncated, warnings: r.warnings } : r.explain ?? null);
      // Enter and pointer submission share this path. A paginated continuation
      // is not a new search-history record.
      if (!next && !privateSearchScope(current.scope) && current.q.trim() && historyEpoch.current === historyAtStart) {
        const list = pushRecent(recents, { ...current, at: Date.now() });
        try { storeRecents(localStorage, list); setRecents(list); } catch { shell.toast("Search finished; history could not be stored.", "warn"); }
      }
    } catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : String(e)); setCursor(null); setHits([]); } }
    finally { if (request.current === controller) setBusy(false); }
  };
  const openHit = async (hit: Hit) => {
    if (hit.source === "file") {
      const r = await api<{ node: { mime: string; kind: string; trashed?: boolean } | null }>(`/api/fs?op=stat&path=${encodeURIComponent(hit.ref)}`);
      if (!r.node || r.node.trashed) throw new Error("This search result no longer exists");
      shell.open(appForFile(baseName(hit.ref), r.node.mime, r.node.kind), { path: hit.ref, title: hit.title });
    } else if (hit.source === "note") shell.open("notes", { noteId: Number(hit.ref) });
    else if (hit.source === "spec") shell.open("spec", { focus: hit.ref }); else shell.open("settings", { focus: hit.ref });
  };
  const saveSearch = async () => {
    try {
      const current = searchInput(input);
      if (privateSearchScope(current.scope) && !await askConfirm({ title: "Save a Private query?", detail: "Named searches are unencrypted in this browser profile and in exported JSON. Private queries are never added to automatic history. Save only if that is acceptable.", okLabel: "Save query locally" })) return;
      const name = await askText("Saved search name", "", { okLabel: "Save search" });
      if (name) persistSaved([{ ...current, id: crypto.randomUUID(), name, savedAt: Date.now() }, ...saved]);
    } catch (e) { setError((e as Error).message); }
  };
  const exportSearches = () => {
    try { const url = URL.createObjectURL(new Blob([exportSavedSearches(saved)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "fusion-searches.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
    catch (e) { setError((e as Error).message); }
  };
  const importSearches = async (file: File) => {
    try {
      if (file.size > SEARCH_EXPORT_LIMIT) throw new Error("Saved-search import is limited to 512 KiB");
      let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); } catch { throw new Error("Saved-search JSON must be valid UTF-8"); }
      const list = importSavedSearches(text);
      if (await askConfirm({ title: "Replace saved searches?", detail: `Import ${list.length} saved searches and replace the current ${saved.length}. Current results and recent history stay.${list.some(s => privateSearchScope(s.scope)) ? " This includes Private queries, stored unencrypted in this browser profile." : ""}`, okLabel: "Import searches" })) persistSaved(list);
    } catch (e) { setError((e as Error).message); }
  };
  const rebuild = async () => {
    if (rebuildPending.current) return;
    rebuildPending.current = true; setRebuilding(true); setMaintenance("");
    try {
      if (!await askConfirm({ title: "Rebuild search index?", detail: "Re-read saved public files and notes. Private, encrypted, trashed and excluded files stay out. This does not change the files.", okLabel: "Rebuild index" })) return;
      const result = await post<{ rebuilt: boolean; counts: { source: string; n: number }[] }>("/api/search", { confirm: "REBUILD" });
      if (!result.rebuilt) throw new Error("The server did not confirm a rebuild");
      invalidate(); await loadCoverage(); setMaintenance(`Rebuilt · ${result.counts.map(row => `${row.source}: ${row.n}`).join(" · ")}`);
    } catch (e) { setError((e as Error).message); }
    finally { rebuildPending.current = false; setRebuilding(false); }
  };
  const check = async () => {
    try { diagnosticFilePath(checkPath); } catch (e) { setCheckError((e as Error).message); return; }
    diagnosticRequest.current?.abort(); const controller = new AbortController(); diagnosticRequest.current = controller;
    setChecking(true); setCheckError(""); setDiagnosis(null);
    try { const result = await api<Record<string, unknown>>(`/api/search?mode=diagnose&path=${encodeURIComponent(checkPath)}`, { signal: controller.signal }); if (!controller.signal.aborted) setDiagnosis(result); }
    catch (e) { if (!controller.signal.aborted) setCheckError((e as Error).message); }
    finally { if (diagnosticRequest.current === controller) setChecking(false); }
  };
  return <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 9, alignContent: "start", height: "100%" }}>
    <form aria-label="Search" onSubmit={event => { event.preventDefault(); void search(); }} className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
      <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: fz(23), height: fz(23), flexShrink: 0 }}><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="m15 15 6 6M7 10h6M10 7v6" fill="none" stroke="currentColor" strokeWidth="1.7" /></svg>
      <input className="fs-input" style={{ flex: 1, minWidth: fz(150) }} placeholder="Search" value={input.q} maxLength={512} aria-label="Search query" onChange={event => update({ q: event.target.value })} />
      <Btn type="submit" variant="primary" disabled={busy || !input.q.trim()}>Search</Btn>
      <Btn variant="ghost" disabled={!input.q.trim()} onClick={() => void saveSearch()}>Save<span className="sr-only"> this search</span></Btn>
      <select aria-label="Search mode" className="fs-input" style={{ width: fz(140) }} value={input.mode} onChange={event => update({ mode: event.target.value as SearchInput["mode"], source: "", phrase: false })}><option value="text">Fast text index</option><option value="metadata">Live metadata</option></select>
      <select aria-label="Search source" className="fs-input" style={{ width: fz(112) }} value={input.source} onChange={event => update({ source: event.target.value as SearchInput["source"], extension: event.target.value && event.target.value !== "file" ? "" : input.extension })}><option value="">All sources</option><option value="file">Files</option>{input.mode === "text" ? <><option value="note">Notes</option><option value="spec">Spec</option><option value="setting">Settings</option></> : null}</select>
    </form>
    <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
      <input className="fs-input" style={{ width: fz(180) }} placeholder="Folder scope" value={input.scope} aria-label="Scope" onChange={event => update({ scope: event.target.value })} />
      <Btn variant="ghost" onClick={() => update({ scope: input.scope === "/Private" || input.scope.startsWith("/Private/") ? "" : "/Private" })} title="Private queries stay in the unlocked tab">{input.scope === "/Private" || input.scope.startsWith("/Private/") ? "All folders" : "/Private only"}</Btn>
      <input className="fs-input" style={{ width: fz(100) }} placeholder=".md" aria-label="File extension" maxLength={32} value={input.extension} disabled={!!input.source && input.source !== "file"} onChange={event => update({ extension: event.target.value })} />
      {input.mode === "text" ? <><select className="fs-input" aria-label="Match strategy" style={{ width: fz(140) }} value={input.match} onChange={event => update({ match: event.target.value as SearchInput["match"] })}><option value="ranked">Ranked + fuzzy</option><option value="literal">Literal text</option></select><label style={{ fontSize: fz(12) }}><input type="checkbox" checked={input.phrase} disabled={input.match === "literal"} onChange={event => update({ phrase: event.target.checked })} data-testid="find-phrase" /> Exact phrase</label></> : <input className="fs-input" aria-label="Metadata field" placeholder="artist, lyrics, content.transcript…" maxLength={256} value={input.field} onChange={event => update({ field: event.target.value })} />}
    </div>
    {recents.length ? <div className="fs-row" style={{ gap: 5, flexWrap: "wrap" }} data-testid="find-recents"><span className="fs-dim" style={{ fontSize: fz(11) }}>Recent:</span>{recents.slice(0, 8).map((record, i) => <Btn key={i} variant="ghost" onClick={() => replay(record)}>{record.q}</Btn>)}<Btn variant="ghost" aria-label="Clear recent searches" onClick={async () => { if (!await askConfirm({ title: "Clear recent searches?", detail: "Saved searches and current results stay.", okLabel: "Clear history" })) return; try { clearRecents(localStorage); historyEpoch.current++; setRecents([]); } catch (e) { setError((e as Error).message); } }}>Clear history</Btn></div> : null}
    <div className="fs-row" style={{ gap: 5, flexWrap: "wrap" }}>
      {saved.map(record => <span key={record.id} className="fs-row" style={{ gap: 3 }}><Btn variant="ghost" onClick={() => replay(record)}>{record.name}</Btn><Btn variant="ghost" aria-label={`Delete saved search ${record.name}`} onClick={() => persistSaved(saved.filter(s => s.id !== record.id))}>×</Btn></span>)}
      <details><summary style={{ fontSize: fz(11), cursor: "pointer" }}>Saved search files</summary><div className="fs-row"><Btn variant="ghost" onClick={exportSearches}>Export searches</Btn><label className="fs-btn" data-variant="ghost">Import searches<input type="file" accept=".json,application/json" aria-label="Import saved searches" style={{ display: "none" }} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importSearches(file); }} /></label></div></details>
    </div>
    {error ? <div role="alert">{error}</div> : null}
    {busy ? <div role="status">Searching…</div> : null}
    {queryUsed ? <div style={{ fontSize: fz(12) }}>Results for: {queryUsed}</div> : null}
    <div className="fs-row" style={{ gap: 5, flexWrap: "wrap" }}>
      <input className="fs-input" style={{ flex: 1, minWidth: fz(140) }} placeholder="Filter these results" aria-label="Filter results by pattern" maxLength={512} value={input.filter} onChange={event => setInput(current => ({ ...current, filter: event.target.value }))} />
      <label style={{ fontSize: fz(12) }}><input type="checkbox" checked={input.regex} onChange={event => setInput(current => ({ ...current, regex: event.target.checked }))} /> regex</label>
      <label style={{ fontSize: fz(12) }}><input type="checkbox" checked={input.caseSensitive} onChange={event => setInput(current => ({ ...current, caseSensitive: event.target.checked }))} /> case</label>
      <select className="fs-input" aria-label="Result order" style={{ width: fz(130) }} value={input.sort} onChange={event => setInput(current => ({ ...current, sort: event.target.value as SearchInput["sort"] }))}><option value="relevance">Relevance</option><option value="title">Title A–Z</option><option value="reference">Reference A–Z</option></select>
    </div>
    {filtered.error ? <div role="alert">{filtered.error}</div> : filtered.busy ? <div role="status">Filtering…</div> : input.filter ? <span className="fs-dim" style={{ fontSize: fz(11) }}>{shownHits.length} of {hits.length} results match</span> : null}
    {took !== null ? <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}><Badge tone="ok">{hits.length} hits</Badge><Badge tone="info">{took} ms</Badge><Badge>no cloud service</Badge>{hits.length ? <><span className="fs-dim" style={{ fontSize: fz(11) }} data-testid="find-source-summary">{sourceSummary(hits)}</span><Btn variant="ghost" onClick={() => void shell.copy(resultsText(shownHits), "find")} data-testid="find-copy-results">Copy results list</Btn></> : null}
      {privInfo ? <span data-testid="private-search-info" style={{ display: "contents" }}>{privInfo.locked ? <Badge tone="warn">Persistent Storage locked</Badge> : privInfo.indexed !== null ? <Badge tone="ok">/Private: {privInfo.indexed} files indexed in this tab</Badge> : null}<Badge tone={privInfo.hostQueried ? "warn" : "ok"}>{privInfo.hostQueried ? "host saw the query text" : "query never left this tab"}</Badge>{privInfo.truncated ? <Badge tone="warn">Private index is bounded</Badge> : null}</span> : null}
    </div> : null}
    <div data-testid="find-results" style={{ display: "grid", gap: 2 }}>
      {shownHits.map(hit => <OrbitTarget key={`${hit.source}:${hit.ref}`} label={`Search result: ${hit.title}`} actions={[{ label: "Open result", run: () => openHit(hit) }, ...(hit.source === "file" ? [{ label: "Open containing folder", run: () => shell.open("files", { path: parentPath(hit.ref) }) }] : []), { label: "Copy reference", run: () => shell.copy(hit.ref, "find") }, { label: "Copy excerpt", run: () => shell.copy(hit.snippet, "find") }]}>
        <button className="fs-list-item" style={{ textAlign: "left", border: 0, background: "none", color: "inherit", width: "100%" }} onClick={() => void openHit(hit).catch(e => shell.toast(e instanceof Error ? e.message : String(e), "bad"))}>
          <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", fontSize: fz(12.5) }}>{hit.title}</span><span className="fs-dim fs-mono" style={{ display: "block", fontSize: fz(10.5), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hit.ref} — {hit.snippet}</span>{hit.matchedFields ? <span aria-label="Matched metadata fields">{hit.matchedFields.map((m, i) => <span key={i} style={{ display: "block" }}><strong>{m.field}</strong>: {m.value}</span>)}</span> : null}</span>
          <Badge tone={hit.how === "fts" || hit.how === "literal" || hit.how === "private-local" ? "ok" : "warn"}>{hit.how === "private-local" ? "encrypted · " : ""}{hit.source} · {hit.how}</Badge>
        </button>
      </OrbitTarget>)}
      {input.q && hits.length === 0 && took !== null ? <Empty title="No matches in returned results (check coverage/pages)" glyph="search" /> : null}
    </div>
    {cursor ? <Btn disabled={busy} onClick={() => void search(cursor)}>Search next metadata page</Btn> : null}
    <details><summary style={{ cursor: "pointer", fontSize: fz(12) }}>Search details &amp; index health</summary>
      <div className="fs-row" style={{ gap: 5, flexWrap: "wrap", marginTop: 6 }}>{coverage.map(row => <Badge key={row.source}>{row.source}: {row.n}</Badge>)}<Btn variant="ghost" onClick={() => void loadCoverage().catch(e => setError(e.message))}>Refresh</Btn><Btn variant="ghost" disabled={amnesic || rebuilding} title={amnesic ? "Host writes are disabled in an amnesic session" : "Rebuild public file and note search entries"} onClick={() => void rebuild()}>Rebuild index</Btn></div>
      {maintenance ? <p role="status">{maintenance}</p> : null}
      <p className="fs-dim" style={{ fontSize: fz(11) }}>{input.mode === "metadata" ? "Live pages: 32 files/page, 262,144 stored string units/file; supported file fields, headers and stored transcripts/lyrics. No speech recognition or inferred lyrics. Continue pages; skipped content is reported." : "Fast index: first 50,000 Unicode code points; ranked English text + bounded fuzzy fallback, or literal substrings. At most 50 returned hits. Ordering/filtering applies to returned results, not the whole collection."}</p>
      <p className="fs-dim" style={{ fontSize: fz(11) }}>Private-scoped queries stay in this tab, outside automatic history. Fast text: up to 50 hits and the first 50,000 code points per body; no binary extraction. Excluded: {shell.settings["search.excludes"] ?? "/System/Cache"}.</p>
      {explain ? <pre className="fs-mono" style={{ fontSize: fz(11), whiteSpace: "pre-wrap" }}>{JSON.stringify(explain, null, 2)}</pre> : null}
      <form aria-label="Check missing file" onSubmit={event => { event.preventDefault(); void check(); }} className="fs-row" style={{ gap: 5, flexWrap: "wrap" }}><input className="fs-input" aria-label="Missing file path" placeholder="/Documents/file.md" value={checkPath} maxLength={4096} onChange={event => { diagnosticRequest.current?.abort(); setChecking(false); setCheckPath(event.target.value); setDiagnosis(null); setCheckError(""); }} /><Btn type="submit" disabled={checking || !checkPath}>Why missing?</Btn></form>
      {checkError ? <div role="alert">{checkError}</div> : null}{diagnosis ? <div role="status" data-testid="find-diagnosis"><strong>{String(diagnosis.status)}</strong> · {String(diagnosis.notice)}{diagnosis.truncated ? " Content after the fast-index prefix is not searched." : ""}</div> : null}
    </details>
  </div>;
}
