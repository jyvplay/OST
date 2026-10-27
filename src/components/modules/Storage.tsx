"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, fmtBytes, post } from "@/lib/api";
import {
  clearBrowserStorage,
  inspectBrowserStorage,
  type BrowserBucketReport,
  type BucketStat,
  type ServerBucketId,
  type UninstallPreview,
} from "@/lib/storage-core";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, KV, Section } from "../ui";

interface Data {
  categories: { category: string; files: number; bytes: number }[];
  large: { path: string; size: number; mime: string }[];
  duplicates: { sha256: string; copies: number; size: number; reclaimable: number; paths: string[] }[];
  trash: { files: number; bytes: number };
  versions: { versions: number; bytes: number };
  buckets?: BucketStat[];
}

/** FM-07: logical VFS usage AND the browser's real origin quota, plus AP-02 per-bucket uninstall assistant. */
export default function StorageModule(_: ModuleProps) {
  const shell = useShell();
  const [d, setD] = useState<Data | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [browserLocal, setBrowserLocal] = useState<BrowserBucketReport>({ keys: [], rows: 0, bytes: 0, samples: [] });
  const [selected, setSelected] = useState<Set<ServerBucketId>>(new Set());
  const [includeBrowser, setIncludeBrowser] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<UninstallPreview | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string>("");
  const previewBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmInputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLElement | null>(null);

  const refreshBrowserStorage = useCallback(() => {
    if (typeof window === "undefined") return;
    const loc = inspectBrowserStorage(window.localStorage);
    const ses = inspectBrowserStorage(window.sessionStorage);
    const keys = [...loc.keys.map((k) => `local:${k}`), ...ses.keys.map((k) => `session:${k}`)];
    setBrowserLocal({
      keys,
      rows: loc.rows + ses.rows,
      bytes: loc.bytes + ses.bytes,
      samples: keys.slice(0, 5),
    });
  }, []);

  const load = useCallback(() => {
    refreshBrowserStorage();
    return api<Data>("/api/storage").then(setD).catch(() => undefined);
  }, [refreshBrowserStorage]);

  useEffect(() => {
    void load();
    navigator.storage?.estimate?.().then((e) => setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 })).catch(() => undefined);
    navigator.storage?.persisted?.().then(setPersisted).catch(() => undefined);
  }, [shell.refreshTick, load]);

  const total = d?.categories.reduce((a, c) => a + Number(c.bytes), 0) ?? 0;
  const buckets = d?.buckets ?? [];

  const toggleBucket = (id: ServerBucketId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectNonEmpty = () => {
    const next = new Set<ServerBucketId>();
    for (const b of buckets) if (b.rows > 0) next.add(b.id);
    setSelected(next);
    setIncludeBrowser(browserLocal.rows > 0);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setIncludeBrowser(false);
  };

  const openPreview = async () => {
    if (selected.size === 0 && !includeBrowser) return;
    setBusy(true);
    try {
      let serverPreview: UninstallPreview = { buckets: [], totalRows: 0, totalBytes: 0, samples: [] };
      if (selected.size > 0) {
        const res = await post<{ ok: boolean; preview: UninstallPreview }>("/api/storage", {
          op: "preview",
          buckets: [...selected],
        });
        serverPreview = res.preview;
      }
      refreshBrowserStorage();
      setPreviewData(serverPreview);
      setConfirmText("");
      setPreviewOpen(true);
      requestAnimationFrame(() => confirmInputRef.current?.focus());
    } catch (e) {
      shell.toast(`Could not build preview: ${(e as Error).message}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const closePreview = () => {
    setPreviewOpen(false);
    setConfirmText("");
    requestAnimationFrame(() => previewBtnRef.current?.focus());
  };

  const executePurge = async () => {
    if (confirmText !== "DELETE" || busy) return;
    setBusy(true);
    try {
      let rowsRemoved = 0;
      let bytesRemoved = 0;
      if (selected.size > 0) {
        const res = await post<{ ok: boolean; purged: UninstallPreview; buckets: BucketStat[] }>("/api/storage", {
          op: "purge",
          buckets: [...selected],
          confirm: "DELETE",
        });
        rowsRemoved += res.purged.totalRows;
        bytesRemoved += res.purged.totalBytes;
      }
      if (includeBrowser && typeof window !== "undefined") {
        const l = clearBrowserStorage(window.localStorage);
        const s = clearBrowserStorage(window.sessionStorage);
        rowsRemoved += l.removed + s.removed;
        bytesRemoved += l.bytesFreed + s.bytesFreed;
      }
      setPreviewOpen(false);
      setConfirmText("");
      setSelected(new Set());
      setIncludeBrowser(false);
      setLastResult(`Purged ${rowsRemoved} item(s) (${fmtBytes(bytesRemoved)}) across selected buckets.`);
      await load();
      shell.bumpRefresh();
      requestAnimationFrame(() => previewBtnRef.current?.focus());
    } catch (e) {
      shell.toast(`Purge failed: ${(e as Error).message}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const previewTotalRows = (previewData?.totalRows ?? 0) + (includeBrowser ? browserLocal.rows : 0);
  const previewTotalBytes = (previewData?.totalBytes ?? 0) + (includeBrowser ? browserLocal.bytes : 0);

  return (
    <div className="fs-scroll" data-testid="storage-app" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Where the bytes are" right={<Btn variant="ghost" aria-label="Refresh storage overview" onClick={() => void load()}>Refresh</Btn>}>
        <KV k="VFS files (server, Postgres)" v={fmtBytes(total)} />
        <KV k="Trash" v={`${d?.trash.files ?? 0} files · ${fmtBytes(Number(d?.trash.bytes ?? 0))}`} />
        <KV k="Version history" v={`${d?.versions.versions ?? 0} snapshots · ${fmtBytes(Number(d?.versions.bytes ?? 0))}`} />
        <KV k="Browser origin storage" v={quota ? `${fmtBytes(quota.usage)} of ${fmtBytes(quota.quota)}` : "unavailable"} />
        <KV k="Eviction protection" v={persisted === null ? "unknown" : persisted ? <Badge tone="ok">persisted</Badge> : (
          <Btn variant="ghost" onClick={async () => setPersisted(await navigator.storage.persist())}>not persisted — request</Btn>
        )} />
        <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "rgba(255,255,255,.06)" }}>
          {d?.categories.map((c, i) => (
            <div key={c.category} title={`${c.category} ${fmtBytes(Number(c.bytes))}`}
              style={{ width: `${(Number(c.bytes) / Math.max(total, 1)) * 100}%`, background: ["#5b8cff", "#b14bff", "#39d98a", "#ffc453", "#ff6b6b", "#3cc", "#999"][i % 7] }} />
          ))}
        </div>
        <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }} data-testid="storage-categories">
          {d?.categories.map((c) => <Badge key={c.category}>{c.category}: {c.files} · {fmtBytes(Number(c.bytes))}</Badge>)}
        </div>
      </Section>

      <Section title="Duplicates (by content digest)">
        {d?.duplicates.length ? d.duplicates.map((g) => (
          <div key={g.sha256} className="fs-panel" data-testid="storage-duplicate-group" style={{ padding: 8, display: "grid", gap: 3 }}>
            <div className="fs-row" style={{ justifyContent: "space-between" }}>
              <span className="fs-mono" style={{ fontSize: fz(11) }}>{g.sha256.slice(0, 12)} · {g.copies} copies</span>
              <Badge tone="warn">reclaim {fmtBytes(Number(g.reclaimable))}</Badge>
            </div>
            {g.paths.map((p, i) => (
              <div key={p} className="fs-row" style={{ justifyContent: "space-between" }}>
                <span className="fs-mono" style={{ fontSize: fz(11) }}>{p}</span>
                {i > 0 ? <Btn variant="ghost" onClick={async () => { await post("/api/fs", { op: "trash", path: p }); shell.bumpRefresh(); }}>Trash</Btn> : <Badge tone="ok">keep</Badge>}
              </div>
            ))}
          </div>
        )) : <div className="fs-dim" style={{ fontSize: fz(11.5) }}>No duplicate content.</div>}
      </Section>

      <Section title="Largest files">
        {d?.large.map((f) => (
          <div key={f.path} className="fs-row" style={{ justifyContent: "space-between" }}>
            <button className="fs-mono" style={{ fontSize: fz(11), background: "none", border: 0, color: "inherit", cursor: "pointer", textAlign: "left" }}
              onClick={() => shell.open("peek", { path: f.path, title: f.path })}>{f.path}</button>
            <span className="fs-dim" style={{ fontSize: fz(11) }}>{fmtBytes(Number(f.size))}</span>
          </div>
        ))}
      </Section>

      <Section
        title="Uninstall & data assistant (AP-02)"
        right={
          <div className="fs-row" style={{ gap: 6 }}>
            <Btn variant="ghost" data-testid="storage-select-nonempty" onClick={selectNonEmpty}>Select non-empty</Btn>
            <Btn variant="ghost" data-testid="storage-clear-selection" onClick={clearSelection}>Clear selection</Btn>
          </div>
        }
      >
        <div className="fs-dim" style={{ fontSize: fz(11.5) }}>
          Choose which Fusion data buckets to remove. Nothing is deleted until you inspect the live row-count preview and confirm. System specifications and templates in /System are protected.
        </div>
        <div style={{ display: "grid", gap: 6 }} data-testid="storage-buckets">
          {buckets.map((b) => (
            <label
              key={b.id}
              data-testid={`storage-bucket-row-${b.id}`}
              className="fs-panel"
              style={{ padding: "6px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, cursor: "pointer" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  data-testid={`storage-bucket-${b.id}`}
                  checked={selected.has(b.id)}
                  onChange={() => toggleBucket(b.id)}
                />
                <span>
                  <strong style={{ fontSize: fz(12) }}>{b.label}</strong>
                  <span className="fs-dim" style={{ display: "block", fontSize: fz(11) }}>{b.description}</span>
                </span>
              </span>
              <span className="fs-mono" data-testid={`storage-bucket-stat-${b.id}`} style={{ fontSize: fz(11), whiteSpace: "nowrap" }}>
                {b.rows} rows · {fmtBytes(b.bytes)}
              </span>
            </label>
          ))}
          <label
            data-testid="storage-bucket-row-browser"
            className="fs-panel"
            style={{ padding: "6px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, cursor: "pointer" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                data-testid="storage-bucket-browser"
                checked={includeBrowser}
                onChange={(e) => setIncludeBrowser(e.target.checked)}
              />
              <span>
                <strong style={{ fontSize: fz(12) }}>Browser local &amp; session storage</strong>
                <span className="fs-dim" style={{ display: "block", fontSize: fz(11) }}>Client-side drafts, user dictionary words and UI caches stored in this browser</span>
              </span>
            </span>
            <span className="fs-mono" data-testid="storage-bucket-stat-browser" style={{ fontSize: fz(11), whiteSpace: "nowrap" }}>
              {browserLocal.rows} keys · {fmtBytes(browserLocal.bytes)}
            </span>
          </label>
        </div>
        <div className="fs-row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <span style={{ fontSize: fz(11.5) }} data-testid="storage-uninstall-status">{lastResult}</span>
          <Btn
            ref={previewBtnRef}
            variant="danger"
            data-testid="storage-uninstall-preview"
            disabled={(selected.size === 0 && !includeBrowser) || busy}
            onClick={() => void openPreview()}
          >
            Preview what will be deleted…
          </Btn>
        </div>
      </Section>

      {previewOpen && typeof document !== "undefined" && createPortal(
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", padding: 16 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) closePreview(); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              closePreview();
              return;
            }
            if (e.key === "Tab" && modalRef.current) {
              const focusables = [...modalRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled])')];
              if (focusables.length === 0) return;
              const idx = focusables.indexOf(document.activeElement as HTMLElement);
              const next = e.shiftKey
                ? (idx <= 0 ? focusables.length - 1 : idx - 1)
                : (idx < 0 || idx >= focusables.length - 1 ? 0 : idx + 1);
              e.preventDefault();
              focusables[next]?.focus();
            }
          }}
        >
          <section
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Uninstall data preview"
            data-testid="storage-uninstall-modal"
            style={{ width: "min(460px, 100%)", padding: 18, borderRadius: 12, color: "var(--fs-text, #eef2ff)", background: "var(--fs-panel-solid, #121a2e)", border: "1px solid var(--fs-border)", boxShadow: "0 12px 48px rgba(0,0,0,.4)", display: "grid", gap: 12 }}
          >
            <div className="fs-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: fz(16) }}>What will be deleted</h2>
              <Btn variant="ghost" data-testid="storage-uninstall-cancel" onClick={closePreview}>Cancel</Btn>
            </div>
            <div style={{ fontSize: fz(12) }}>
              Live count across selected buckets: <strong data-testid="storage-preview-rows">{previewTotalRows}</strong> item(s) totaling <strong data-testid="storage-preview-bytes">{fmtBytes(previewTotalBytes)}</strong>.
            </div>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 12px", fontSize: fz(12) }}>
              {previewData?.buckets.map((b) => (
                <div key={b.id} style={{ display: "contents" }}>
                  <dt style={{ fontWeight: 600 }}>{b.label}</dt>
                  <dd data-testid={`storage-preview-bucket-${b.id}`} style={{ margin: 0, textAlign: "right" }}>{b.rows} rows · {fmtBytes(b.bytes)}</dd>
                </div>
              ))}
              {includeBrowser && (
                <div style={{ display: "contents" }}>
                  <dt style={{ fontWeight: 600 }}>Browser local &amp; session storage</dt>
                  <dd data-testid="storage-preview-bucket-browser" style={{ margin: 0, textAlign: "right" }}>{browserLocal.rows} keys · {fmtBytes(browserLocal.bytes)}</dd>
                </div>
              )}
            </dl>
            {(previewData?.samples.length || (includeBrowser && browserLocal.samples.length)) ? (
              <div className="fs-panel" style={{ padding: 8, fontSize: fz(11) }} data-testid="storage-preview-samples">
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Sample items to be removed:</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {previewData?.samples.slice(0, 6).map((s, i) => <li key={i} className="fs-mono">{s}</li>)}
                  {includeBrowser && browserLocal.samples.slice(0, 3).map((s, i) => <li key={`b-${i}`} className="fs-mono">Browser: {s}</li>)}
                </ul>
              </div>
            ) : null}
            <label style={{ display: "grid", gap: 4, fontSize: fz(12) }}>
              <span>Type <strong>DELETE</strong> to confirm permanent removal:</span>
              <input
                ref={confirmInputRef}
                type="text"
                className="fs-input"
                data-testid="storage-uninstall-confirm"
                aria-label="Type DELETE to confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && confirmText === "DELETE") { e.preventDefault(); void executePurge(); } }}
              />
            </label>
            <div className="fs-row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <Btn
                variant="danger"
                data-testid="storage-uninstall-execute"
                disabled={confirmText !== "DELETE" || busy}
                onClick={() => void executePurge()}
              >
                Permanently delete selected data
              </Btn>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
