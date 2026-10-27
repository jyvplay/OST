"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useState } from "react";
import { fmtBytes } from "@/lib/api";
import { capAvailable } from "@/lib/capabilities";
import { importLocalFile, resolveLocalConflict, syncLocalFolder, syncTarget, type Directory, type SyncConflict, type SyncSkipped } from "@/lib/local-folder-sync";
import { privacy } from "@/lib/privacy/session";
import { usePrivacyStatus } from "../chrome-bits";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Section } from "../ui";

/** Directory handles persist; permission must be queried and may require a user-gesture re-grant. */
type DirHandle = Directory & {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};
const DB = "fusion-handles";
const idb = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("h")) open.result.createObjectStore("h"); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("h", mode);
      let value: T;
      try {
        const req = fn(tx.objectStore("h"));
        req.onsuccess = () => { value = req.result; };
        req.onerror = () => reject(req.error);
      } catch (e) { db.close(); reject(e); return; }
      // A successful request can still be rolled back; only a completed transaction is durable.
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Handle storage failed")); };
    };
  });

interface Entry { name: string; kind: string; size: number }

export default function LocalDiskModule(_: ModuleProps) {
  const shell = useShell();
  const privacyStatus = usePrivacyStatus();
  // api.ts installs the guard before modules run; consult it even before the subscription emits.
  const amnesic = privacyStatus?.amnesic ?? privacy.layer?.amnesic ?? false;
  const [handle, setHandle] = useState<DirHandle | null>(null);
  const [perm, setPerm] = useState<string>("none");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [skipped, setSkipped] = useState<SyncSkipped[]>([]);
  const [report, setReport] = useState("");
  const [busy, setBusy] = useState(false);
  let target = "";
  if (handle) { try { target = syncTarget(handle.name); } catch { /* invalid name is shown below */ } }

  const list = useCallback(async (h: DirHandle) => {
    const out: Entry[] = [];
    for await (const [name, e] of h.entries()) {
      out.push({ name, kind: e.kind, size: e.kind === "file" ? (await (e as FileSystemFileHandle).getFile()).size : 0 });
      if (out.length >= 500) break;
    }
    setEntries(out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
  }, []);

  useEffect(() => {
    if (amnesic || !capAvailable(shell.caps, "fsAccess")) return;
    let active = true;
    idb<DirHandle>("readonly", (s) => s.get("mount")).then(async (h) => {
      if (!h || !active) return;
      setHandle(h);
      const p = await h.queryPermission({ mode: "readwrite" });
      if (!active) return;
      setPerm(p);
      if (p === "granted") await list(h);
    }).catch((e) => { if (active) setReport(`Unable to restore folder handle: ${String((e as Error).message)}`); });
    return () => { active = false; };
  }, [amnesic, shell.caps, list]);

  const mount = async () => {
    if (privacy.layer?.amnesic) throw new Error("Local folders are unavailable in amnesic mode.");
    const picker = (window as unknown as { showDirectoryPicker: (options: { mode: "readwrite" }) => Promise<DirHandle> }).showDirectoryPicker;
    const h = await picker.call(window, { mode: "readwrite" });
    syncTarget(h.name);
    await idb("readwrite", (s) => s.put(h, "mount"));
    setHandle(h); setPerm("granted"); setConflicts([]); setSkipped([]); setReport(""); await list(h);
  };

  const sync = async () => {
    if (!handle || !target || busy) return;
    setBusy(true); setReport(""); setConflicts([]); setSkipped([]);
    try {
      const result = await syncLocalFolder(handle, target);
      setConflicts(result.conflicts); setSkipped(result.skipped);
      setReport(`pushed ${result.pushed} · pulled ${result.pulled} · identical ${result.same} · conflicts ${result.conflicts.length} · skipped ${result.skipped.length}`);
      shell.bumpRefresh(); await list(handle);
    } catch (e) {
      setReport(`Sync stopped: ${String((e as Error).message)}. Earlier files may have completed; review before retrying.`);
      shell.bumpRefresh(); await list(handle).catch(() => undefined);
    } finally { setBusy(false); }
  };

  const resolve = async (c: SyncConflict, keep: "local" | "vfs") => {
    if (!handle || !target || busy) return;
    if (keep === "vfs" && !window.confirm(`Replace the local file “${c.name}” with the Fusion copy? Pause other apps editing it first.`)) return;
    setBusy(true);
    try {
      await resolveLocalConflict(handle, target, c, keep);
      setConflicts((cs) => cs.filter((x) => x.name !== c.name));
      setReport(`Kept ${keep === "local" ? "local" : "Fusion"} copy for ${c.name}.`);
      shell.bumpRefresh(); await list(handle);
    } catch (e) { setReport(`Conflict not resolved: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  };

  if (amnesic) {
    return <div style={{ padding: 12 }} role="status">Local folders are unavailable in amnesic mode: mounting or syncing could persist data on this device. Restart a normal session to use Local Disk.</div>;
  }
  if (!capAvailable(shell.caps, "fsAccess")) {
    return <div style={{ padding: 12 }}><Blocked what="Mount a local folder" missing="showDirectoryPicker (File System Access API)" workaround="Upload/download in Files; Chromium desktop browsers implement this API." /></div>;
  }

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="primary" disabled={busy} onClick={() => void mount().catch((e) => shell.toast(String(e.message), "warn"))}>{handle ? "Mount a different folder" : "Mount local folder…"}</Btn>
        {handle ? <Badge tone={perm === "granted" ? "ok" : "warn"}>{handle.name} · permission {perm}</Badge> : null}
        {handle && perm !== "granted" ? (
          <Btn disabled={busy} onClick={() => void handle.requestPermission({ mode: "readwrite" }).then(async (p) => { setPerm(p); if (p === "granted") await list(handle); }).catch((e) => setReport(`Permission failed: ${String(e.message)}`))}>Re-grant access</Btn>
        ) : null}
        {handle && perm === "granted" && target ? <Btn disabled={busy} onClick={() => void sync()}>Sync ⇄ {target}</Btn> : null}
        {handle ? <Btn variant="ghost" disabled={busy} onClick={() => void idb("readwrite", (s) => s.delete("mount")).then(() => {
          setHandle(null); setEntries([]); setConflicts([]); setSkipped([]); setPerm("none"); setReport("");
        }).catch((e) => setReport(`Unmount failed: ${String(e.message)}`))}>Unmount</Btn> : null}
      </div>
      {handle && !target ? <div role="alert">This folder name cannot be represented in Fusion. Mount another folder.</div> : null}
      {report ? <div role="status" data-testid="localdisk-report"><Badge tone="info">{report}</Badge></div> : null}

      {conflicts.length ? (
        <Section title={`Conflict inbox (${conflicts.length}) — review before replacing`}>
          {conflicts.map((c) => (
            <div key={c.name} className="fs-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span className="fs-mono" style={{ fontSize: fz(11.5) }}>{c.name} <span className="fs-dim">local {c.localSha.slice(0, 8)} ≠ Fusion {c.vfsSha.slice(0, 8)}</span></span>
              <span className="fs-row" style={{ gap: 4 }}>
                <Btn variant="ghost" disabled={busy} onClick={() => void resolve(c, "local")}>Keep local</Btn>
                <Btn variant="ghost" disabled={busy} onClick={() => void resolve(c, "vfs")}>Keep Fusion copy</Btn>
              </span>
            </div>
          ))}
        </Section>
      ) : null}

      {skipped.length ? <Section title={`Skipped (${skipped.length})`}>
        {skipped.slice(0, 50).map((s, i) => <div key={`${s.name}-${i}`} style={{ fontSize: fz(11.5) }}>{s.name}: {s.reason}</div>)}
        {skipped.length > 50 ? <div>Showing the first 50 skipped items.</div> : null}
      </Section> : null}

      {perm === "granted" ? (
        <Section title={`Contents of ${handle?.name} (first 500)`}>
          {entries.map((e) => (
            <div key={e.name} className="fs-row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: fz(12) }}>{e.kind === "directory" ? "🗂" : "📄"} {e.name}</span>
              <span className="fs-row" style={{ gap: 6 }}>
                <span className="fs-dim" style={{ fontSize: fz(11) }}>{e.kind === "file" ? fmtBytes(e.size) : ""}</span>
                {e.kind === "file" && handle ? <Btn variant="ghost" disabled={busy} aria-label={`Import ${e.name}`} onClick={() => {
                  setBusy(true);
                  void importLocalFile(handle, e.name).then((name) => {
                    shell.toast(`Imported as /Documents/${name} (no existing document overwritten)`, "ok"); shell.bumpRefresh();
                  }).catch((err) => setReport(`Import failed: ${String(err.message)}`)).finally(() => setBusy(false));
                }}>Import</Btn> : null}
              </span>
            </div>
          ))}
        </Section>
      ) : null}

      <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
        Sync covers direct-child UTF-8 text files up to 1 MiB, not folders or deletions. Unsupported files are skipped, never treated as absent.
        Folder names determine the Fusion target, so two local folders with the same name share that target.
        The browser cannot atomically create or compare-and-swap a user-visible local file against other native apps: pause other editors during sync and resolution.
        Some browsers may require a fresh permission grant after reload. Sync is not queued offline.
      </div>
    </div>
  );
}
