"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useState } from "react";
import { api, fmtBytes, post } from "@/lib/api";
import { capAvailable } from "@/lib/capabilities";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Section } from "../ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type DirHandle = any;

/**
 * FM-08 local folders via File System Access, WS-12 handle persistence, and
 * BK-02 folder sync with a conflict inbox.
 *
 * Nuances:
 *  - Handles are structured-cloneable, so they persist in IndexedDB — but the
 *    PERMISSION does not. After reload the mount shows "needs re-grant" and
 *    requestPermission() must run inside a click. Silently failing writes is the
 *    usual bug.
 *  - Sync never auto-merges and has no "last writer wins": with no shared base
 *    version, a file that differs on both sides goes to the conflict inbox.
 *  - Sync is restricted to UTF-8 text ≤ 1 MB so both sides hash identical bytes.
 */
const DB = "fusion-handles";
const idb = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("h");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("h", mode);
      const req = fn(tx.objectStore("h"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });

const sha = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

interface Entry { name: string; kind: string; size: number }
interface Conflict { name: string; localSha: string; vfsSha: string }

export default function LocalDiskModule(_: ModuleProps) {
  const shell = useShell();
  const [handle, setHandle] = useState<DirHandle | null>(null);
  const [perm, setPerm] = useState<string>("none");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [report, setReport] = useState("");

  const target = handle ? `/Sync/${handle.name}` : "";

  const list = useCallback(async (h: DirHandle) => {
    const out: Entry[] = [];
    for await (const [name, e] of h.entries()) {
      out.push({ name, kind: e.kind, size: e.kind === "file" ? (await e.getFile()).size : 0 });
      if (out.length > 500) break;
    }
    setEntries(out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
  }, []);

  useEffect(() => {
    if (!capAvailable(shell.caps, "fsAccess")) return;
    idb<DirHandle>("readonly", (s) => s.get("mount")).then(async (h) => {
      if (!h) return;
      setHandle(h);
      const p = await h.queryPermission({ mode: "readwrite" });
      setPerm(p);
      if (p === "granted") await list(h);
    }).catch(() => undefined);
  }, [shell.caps, list]);

  const mount = async () => {
    const h = await (window as any).showDirectoryPicker({ mode: "readwrite" });
    await idb("readwrite", (s) => s.put(h, "mount"));
    setHandle(h); setPerm("granted"); await list(h);
  };

  const sync = async () => {
    if (!handle) return;
    await post("/api/fs", { op: "mkdir", path: target });
    const vfs = await api<{ nodes: { name: string; kind: string; sha256: string; encoding: string; size: number }[] }>(`/api/fs?op=list&path=${encodeURIComponent(target)}`);
    const vmap = new Map(vfs.nodes.filter((n) => n.kind === "file" && n.encoding === "utf8").map((n) => [n.name, n]));
    let pushed = 0, pulled = 0, same = 0, skipped = 0;
    const found: Conflict[] = [];
    const localNames = new Set<string>();
    for await (const [name, e] of handle.entries()) {
      if (e.kind !== "file") continue;
      const f: File = await e.getFile();
      if (f.size > 1024 * 1024 || !/\.(md|txt|csv|json|ya?ml|log|ini|html|css|js|ts|svg)$/i.test(name)) { skipped += 1; continue; }
      localNames.add(name);
      const text = await f.text();
      const localSha = await sha(text);
      const v = vmap.get(name);
      if (!v) { await post("/api/fs", { op: "write", path: `${target}/${name}`, content: text, reason: "sync-push" }); pushed += 1; }
      else if (v.sha256 === localSha) same += 1;
      else found.push({ name, localSha, vfsSha: v.sha256 });
    }
    for (const [name] of vmap) {
      if (localNames.has(name)) continue;
      const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(`${target}/${name}`)}`);
      const fh = await handle.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(r.node.content); await w.close(); // createWritable is atomic-on-close
      pulled += 1;
    }
    setConflicts(found);
    setReport(`pushed ${pushed} · pulled ${pulled} · identical ${same} · conflicts ${found.length} · skipped ${skipped} (binary or >1 MB)`);
    shell.bumpRefresh(); await list(handle);
  };

  const resolve = async (c: Conflict, keep: "local" | "vfs") => {
    if (!handle) return;
    if (keep === "local") {
      const text = await (await (await handle.getFileHandle(c.name)).getFile()).text();
      await post("/api/fs", { op: "write", path: `${target}/${c.name}`, content: text, reason: "conflict-keep-local" }); // previous VFS copy kept as a version
    } else {
      const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(`${target}/${c.name}`)}`);
      const w = await (await handle.getFileHandle(c.name)).createWritable(); await w.write(r.node.content); await w.close();
    }
    setConflicts((cs) => cs.filter((x) => x.name !== c.name));
  };

  if (!capAvailable(shell.caps, "fsAccess")) {
    return <div style={{ padding: 12 }}><Blocked what="Mount a local folder" missing="showDirectoryPicker (File System Access API)" workaround="Upload/download in Files; Chromium desktop browsers implement this API." /></div>;
  }

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={() => void mount().catch((e) => shell.toast(String(e.message), "warn"))}>{handle ? "Mount a different folder" : "Mount local folder…"}</Btn>
        {handle ? <Badge tone={perm === "granted" ? "ok" : "warn"}>{handle.name} · permission {perm}</Badge> : null}
        {handle && perm !== "granted" ? (
          <Btn onClick={async () => { const p = await handle.requestPermission({ mode: "readwrite" }); setPerm(p); if (p === "granted") await list(handle); }}>Re-grant access</Btn>
        ) : null}
        {handle && perm === "granted" ? <Btn onClick={() => void sync().catch((e) => shell.toast(String(e.message), "bad"))}>Sync ⇄ {target}</Btn> : null}
        {handle ? <Btn variant="ghost" onClick={async () => { await idb("readwrite", (s) => s.delete("mount")); setHandle(null); setEntries([]); setPerm("none"); }}>Unmount</Btn> : null}
      </div>
      {report ? <Badge tone="info">{report}</Badge> : null}

      {conflicts.length ? (
        <Section title={`Conflict inbox (${conflicts.length}) — nothing was overwritten`}>
          {conflicts.map((c) => (
            <div key={c.name} className="fs-row" style={{ justifyContent: "space-between" }}>
              <span className="fs-mono" style={{ fontSize: fz(11.5) }}>{c.name} <span className="fs-dim">local {c.localSha.slice(0, 8)} ≠ vfs {c.vfsSha.slice(0, 8)}</span></span>
              <span className="fs-row" style={{ gap: 4 }}>
                <Btn variant="ghost" onClick={() => void resolve(c, "local")}>Keep local</Btn>
                <Btn variant="ghost" onClick={() => void resolve(c, "vfs")}>Keep Fusion copy</Btn>
              </span>
            </div>
          ))}
        </Section>
      ) : null}

      {perm === "granted" ? (
        <Section title={`Contents of ${handle?.name}`}>
          {entries.map((e) => (
            <div key={e.name} className="fs-row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: fz(12) }}>{e.kind === "directory" ? "🗂" : "📄"} {e.name}</span>
              <span className="fs-row" style={{ gap: 6 }}>
                <span className="fs-dim" style={{ fontSize: fz(11) }}>{e.kind === "file" ? fmtBytes(e.size) : ""}</span>
                {e.kind === "file" ? <Btn variant="ghost" onClick={async () => {
                  const f: File = await (await handle.getFileHandle(e.name)).getFile();
                  if (f.size > 8 * 1024 * 1024) { shell.toast("Over the 8 MB VFS limit", "warn"); return; }
                  const bytes = new Uint8Array(await f.arrayBuffer()); let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
                  await post("/api/fs", { op: "upload", path: `/Documents/${e.name}`, content: btoa(bin), mime: f.type || undefined });
                  shell.toast(`Imported ${e.name} into /Documents (journaled)`, "ok"); shell.bumpRefresh();
                }}>Import</Btn> : null}
              </span>
            </div>
          ))}
        </Section>
      ) : null}

      <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
        The folder handle survives reloads (stored in IndexedDB); the permission does not — browsers require a fresh
        click each session, so the mount says “needs re-grant” instead of failing writes. Sync never auto-merges.
      </div>
    </div>
  );
}
