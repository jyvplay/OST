"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtBytes, fmtTime, post } from "@/lib/api";
import { cleanVfsFile } from "@/lib/privacy/cleanfile";
import { appForFile } from "@/lib/open-with";
import { formatFor } from "@/lib/forge";
import { fromB64, open, seal, toB64, type Envelope } from "@/lib/crypto";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { FileIcon, UiGlyph } from "../AppIcon";

interface Node {
  path: string; name: string; kind: string; mime: string; size: number; sha256: string;
  tags: string; trashed: boolean; version: number; updatedAt: string;
}
interface Job { id: number; op: string; src: string; dst: string; state: string; error: string }

type View = "list" | "grid" | "column";

export default function FilesModule({ win }: ModuleProps) {
  const shell = useShell();
  const [cwd, setCwd] = useState<string>((win.props.path as string) ?? "/");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<View>("list");
  const [showTrash, setShowTrash] = useState(win.props.trash === true); // TT25: the Art dock's Trash opens Files on the trash view
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(["/"]);
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = showTrash
        ? await api<{ nodes: Node[] }>("/api/fs?op=trash")
        : await api<{ nodes: Node[] }>(`/api/fs?op=list&path=${encodeURIComponent(cwd)}`);
      setNodes(r.nodes);
      const j = await api<{ ops: Job[] }>("/api/jobs?limit=8");
      setJobs(j.ops);
    } catch (e) {
      shell.toast(String((e as Error).message), "bad");
    }
  }, [cwd, showTrash, shell]);

  useEffect(() => { void load(); }, [load, shell.refreshTick]);

  const go = (path: string) => {
    setCwd(path);
    setSel([]);
    setShowTrash(false);
    setHistory((h) => [...h, path].slice(-40));
  };
  const back = () => {
    setHistory((h) => {
      if (h.length < 2) return h;
      const next = h.slice(0, -1);
      setCwd(next[next.length - 1]);
      return next;
    });
  };
  const up = () => go(cwd === "/" ? "/" : cwd.slice(0, cwd.lastIndexOf("/")) || "/");

  const shown = useMemo(
    () => nodes.filter((n) => !filter || n.name.toLowerCase().includes(filter.toLowerCase())),
    [nodes, filter],
  );
  const selectedBytes = shown.filter((n) => sel.includes(n.path)).reduce((a, b) => a + b.size, 0);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); await load(); shell.bumpRefresh(); }
    catch (e) { shell.toast(`${label}: ${String((e as Error).message)}`, "bad"); }
    finally { setBusy(null); }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      const buf = await f.arrayBuffer();
      const b64 = toB64(new Uint8Array(buf)); // FIX: spread overflowed the stack on files > ~100 KB
      await run(`upload ${f.name}`, () => post("/api/fs", {
        op: "upload", path: `${cwd === "/" ? "" : cwd}/${f.name}`, content: b64, mime: f.type || undefined,
      }));
    }
  };

  const openNode = (n: (typeof shown)[number]) => {
    if (showTrash) return;
    if (n.kind === "dir") go(n.path);
    else shell.open(appForFile(n.name, n.mime, n.kind), { path: n.path, title: n.name });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
      onClick={() => setMenu(null)}>
      {/* toolbar */}
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={back} title="Back (mouse button 4 also works)">←</Btn>
        <Btn variant="ghost" onClick={up} title="Up" aria-label="Up one folder"><UiGlyph name="up" /></Btn>
        <input className="fs-input fs-mono" style={{ flex: 1, minWidth: fz(160) }} value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(cwd); }} aria-label="Path" />
        <input className="fs-input" style={{ width: fz(130) }} placeholder="Filter" value={filter}
          onChange={(e) => setFilter(e.target.value)} aria-label="Quick filter" />
        {(["list", "grid", "column"] as View[]).map((v) => (
          <Btn key={v} variant={view === v ? "primary" : "ghost"} aria-pressed={view === v} title={`${v} view`} onClick={() => setView(v)}>{v === "list" ? "List" : v === "grid" ? "Grid" : "Columns"}</Btn>
        ))}
        <Btn variant={showTrash ? "primary" : "ghost"} aria-pressed={showTrash} title="Show trash" onClick={() => { setShowTrash((t) => !t); setSel([]); }}>Trash</Btn>
      </div>

      <div className="fs-row" style={{ padding: "4px 6px", gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={() => {
          const name = prompt("New folder name", "New folder");
          if (name) void run("mkdir", () => post("/api/fs", { op: "mkdir", path: `${cwd === "/" ? "" : cwd}/${name}` }));
        }}>New folder</Btn>
        <Btn variant="ghost" onClick={() => {
          const name = prompt("New file name", "untitled.md");
          if (name) void run("write", () => post("/api/fs", { op: "write", path: `${cwd === "/" ? "" : cwd}/${name}`, content: "" }));
        }}>New file</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>
          Upload<input type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
        </label>
        <Btn variant="ghost" onClick={() => {
          const pattern = prompt("Batch rename pattern — tokens {n} {name} {ext}", "{n}-{name}.{ext}");
          if (pattern) void run("batchRename", () => post("/api/fs", { op: "batchRename", path: cwd, pattern, start: 1 }));
        }}>Batch rename</Btn>
        <Btn variant="ghost" onClick={() => shell.open("terminal", { cwd })}>Terminal here</Btn>
        <div style={{ flex: 1 }} />
        {busy ? <Badge tone="warn">{busy}…</Badge> : null}
        {sel.length ? <Badge tone="info">{sel.length} selected · {fmtBytes(selectedBytes)}</Badge> : null}
      </div>

      {/* listing */}
      <div className="fs-scroll" style={{ flex: 1, minHeight: 0, padding: 6 }}>
        {shown.length === 0 ? <Empty title={showTrash ? "Trash is empty" : "Empty folder"} icon="🗂"
          hint={showTrash ? undefined : "Create a file, upload one, or run `write` in the terminal."} /> : null}

        <div role="listbox" aria-label={`${showTrash ? "Trash" : cwd} — Enter opens, Space selects`} aria-multiselectable="true" style={view === "grid"
          ? { display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${fz(118)},1fr))`, gap: 6 }
          : { display: "grid", gap: 1 }}>
          {shown.map((n) => {
            const fmt = formatFor(n.name);
            const focusPath = shown.find((x) => sel.includes(x.path))?.path ?? shown[0]?.path;
            const selected = sel.includes(n.path);
            return (
              <div key={n.path} className="fs-list-item" data-selected={selected}
                role="option" aria-selected={selected} tabIndex={n.path === focusPath ? 0 : -1}
                style={view === "grid" ? { flexDirection: "column", minHeight: fz(96), textAlign: "center" } : undefined}
                onClick={(e) => setSel(e.ctrlKey || e.metaKey ? (selected ? sel.filter((p) => p !== n.path) : [...sel, n.path]) : [n.path])}
                onDoubleClick={() => openNode(n)}
                onKeyDown={(e) => {
                  // TT24 (WCAG 2.1.1): rows were mouse-only. Enter opens, Space selects (Ctrl+Space toggles),
                  // arrows / Home / End move, and the Menu key or Shift+F10 opens the context menu at the row.
                  const rows = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
                  const i = rows.indexOf(e.currentTarget);
                  const to = (j: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; r?.focus(); };
                  if (e.key === "Enter") { e.preventDefault(); openNode(n); }
                  else if (e.key === " ") { e.preventDefault(); setSel(e.ctrlKey || e.metaKey ? (selected ? sel.filter((p) => p !== n.path) : [...sel, n.path]) : [n.path]); }
                  else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); to(i + 1); }
                  else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); to(i - 1); }
                  else if (e.key === "Home") { e.preventDefault(); to(0); }
                  else if (e.key === "End") { e.preventDefault(); to(rows.length - 1); }
                  else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                    e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setSel([n.path]); setMenu({ x: r.left + 24, y: r.bottom, node: n });
                  }
                }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel([n.path]); setMenu({ x: e.clientX, y: e.clientY, node: n }); }}
              >
                <FileIcon name={n.name} kind={n.kind === "dir" ? "dir" : "file"} size={view === "grid" ? 34 : 18} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fz(12) }}>{n.name}</span>
                {view !== "grid" ? (
                  <>
                    {fmt ? <Badge tone={fmt.grade === "A" ? "ok" : fmt.grade === "X" ? "bad" : "info"} title={fmt.boundary}>grade {fmt.grade}</Badge> : null}
                    {n.tags ? <Badge>{n.tags}</Badge> : null}
                    <span className="fs-dim" style={{ fontSize: fz(11), width: fz(70), textAlign: "right" }}>{n.kind === "dir" ? "—" : fmtBytes(n.size)}</span>
                    <span className="fs-dim" style={{ fontSize: fz(11), width: fz(112), textAlign: "right" }}>{fmtTime(n.updatedAt)}</span>
                    <Badge title="Where the bytes live (DP-03)">server</Badge>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* journal strip — the same rows the ops engine writes (FM-03 / NC-05) */}
      <div className="fs-row" style={{ gap: 6, padding: "4px 8px", borderTop: "1px solid var(--fs-border)", overflowX: "auto" }}>
        <span className="fs-dim" style={{ fontSize: fz(10.5) }}>journal:</span>
        {jobs.slice(0, 5).map((j) => (
          <Badge key={j.id} tone={j.state === "COMPLETE" ? "ok" : j.state === "FAILED" ? "bad" : "warn"}
            title={`${j.op} ${j.src} → ${j.dst} ${j.error}`}>
            {j.op} {j.state}
          </Badge>
        ))}
        {jobs.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(10.5) }}>no operations yet</span> : null}
      </div>

      {menu ? (
        <div className="fs-panel" role="menu" style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 9999, padding: 4, minWidth: 190 }}>
          {[
            { label: "Open", run: () => (menu.node.kind === "dir" ? go(menu.node.path) : shell.open("peek", { path: menu.node.path, title: menu.node.name })) },
            { label: "Edit", run: () => shell.open("editor", { path: menu.node.path, title: menu.node.name }) },
            { label: "Rename…", run: () => { const name = prompt("New name", menu.node.name); if (name) void run("rename", () => post("/api/fs", { op: "rename", path: menu.node.path, name })); } },
            { label: "Duplicate", run: () => void run("copy", () => post("/api/fs", { op: "copy", src: menu.node.path, dst: `${menu.node.path}.copy` })) },
            { label: "Move to…", run: () => { const dst = prompt("Destination path", menu.node.path); if (dst) void run("move", () => post("/api/fs", { op: "move", src: menu.node.path, dst })); } },
            { label: "Tag…", run: () => { const tags = prompt("Tags (comma separated)", menu.node.tags); if (tags !== null) void run("tag", () => post("/api/fs", { op: "tag", path: menu.node.path, tags })); } },
            { label: "Copy path", run: () => void shell.copy(menu.node.path, "files") },
            { label: "Compress to .zip", run: () => void run("compress", async () => {
                const r = await post<{ entries: number; path: string }>("/api/fs", { op: "compress", path: menu.node.path });
                shell.toast(`Archived ${r.entries} file(s) → ${r.path}`, "ok");
              }) },
            ...(menu.node.name.toLowerCase().endsWith(".zip") ? [{ label: "Extract here", run: () => void run("extract", async () => {
                const r = await post<{ written: number; dest: string }>("/api/fs", { op: "extract", path: menu.node.path });
                shell.toast(`Extracted ${r.written} file(s) → ${r.dest} (CRC verified)`, "ok");
              }) }] : []),
            ...(menu.node.kind === "file" && /\.(jpe?g|png|webp|gif|svg|docx|xlsx|pptx)$/i.test(menu.node.name) ? [{ label: "Remove metadata (copy)", run: () => void run("metadata", async () => {
                const r = await cleanVfsFile(menu.node.path);
                if (!r.written) shell.toast(r.report.supported ? "No metadata found — nothing written" : "Not supported — file unchanged", "info");
                else shell.toast(`Removed ${r.report.removed.length} items → ${r.written.split("/").pop()}`, "ok");
              }) }] : []),
            ...(menu.node.kind === "file" && !menu.node.name.endsWith(".fvault") ? [{ label: "Encrypt (SC-07)…", run: () => void run("encrypt", async () => {
                const pass = prompt("Passphrase (≥ 8 chars). There is no recovery if you lose it.");
                if (!pass || pass.length < 8) throw new Error("passphrase too short");
                const r = await api<{ node: { content: string; encoding: string; mime: string } }>(`/api/fs?op=read&path=${encodeURIComponent(menu.node.path)}`);
                const bytes = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
                const env = await seal(bytes, pass);
                await post("/api/fs", { op: "write", path: `${menu.node.path}.fvault`, content: JSON.stringify({ ...env, mime: r.node.mime, encoding: r.node.encoding }), reason: "encrypt" });
                shell.toast(`Encrypted copy written: ${menu.node.name}.fvault (original untouched)`, "ok");
              }) }] : []),
            ...(menu.node.name.endsWith(".fvault") ? [{ label: "Decrypt…", run: () => void run("decrypt", async () => {
                const pass = prompt("Passphrase");
                if (!pass) return;
                const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(menu.node.path)}`);
                const env = JSON.parse(r.node.content) as Envelope & { encoding?: string; mime?: string };
                const plain = await open(env, pass);
                const out = menu.node.path.replace(/\.fvault$/, "");
                await post("/api/fs", env.encoding === "base64"
                  ? { op: "upload", path: out, content: toB64(plain), mime: env.mime }
                  : { op: "write", path: out, content: new TextDecoder().decode(plain), reason: "decrypt" });
                shell.toast(`Decrypted → ${out}`, "ok");
              }) }] : []),
            showTrash
              ? { label: "Restore", run: () => void run("restore", () => post("/api/fs", { op: "restore", path: menu.node.path })) }
              : { label: "Move to trash", run: () => void run("trash", () => post("/api/fs", { op: "trash", path: menu.node.path })) },
            ...(showTrash ? [{ label: "Delete permanently", run: () => { if (confirm(`Permanently delete ${menu.node.name}? This cannot be undone.`)) void run("purge", () => post("/api/fs", { op: "purge", path: menu.node.path })); } }] : []),
          ].map((item) => (
            <button key={item.label} role="menuitem" className="fs-btn" data-variant="ghost"
              style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={() => { setMenu(null); void item.run(); }}>{item.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
