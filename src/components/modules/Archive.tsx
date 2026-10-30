"use client";
/**
 * TT79 FF-71 — Archive: a first-party ZIP manager over src/lib/archive (no server round trip for reading).
 * Browse folders without extracting, preview text / images / hex, open an entry in its app, extract a selection or
 * everything (to Files or, where the browser allows, to a folder on this device), add files and folders, delete,
 * rename, test (CRC / AES MAC of every entry), create new archives, save encrypted copies (WinZip AES-256 or legacy
 * ZipCrypto), undo. Encrypted entries ask for the password once per archive. Editing copies untouched entries' raw
 * bytes, so deleting or renaming inside an encrypted archive never needs the password.
 * Opening from this device bypasses the 8 MB Files store limit (memory is the limit); extraction into Files keeps it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fz } from "@/lib/uiscale";
import { api, fmtBytes, post } from "@/lib/api";
import { toB64, fromB64 } from "@/lib/crypto";
import { askText, askForm, askConfirm } from "@/lib/ask";
import { appForFile } from "@/lib/open-with";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { filterEntries } from "@/lib/archive-filter";
import { readArchive, readEntry, writeArchive, editArchive, extractable, PasswordError, type Archive, type ArchiveEntry, type EditOp, type NameMode, type WriteItem } from "@/lib/archive/zip";
import { listFolder, namesUnder, parentFolder, crumbs, looksText, IMAGE_EXT, MIME_BY_EXT, type Row } from "@/lib/archive/tree";

type Preview = { name: string; kind: "text" | "image" | "hex" | "locked" | "error" | "folder" | "blocked"; text?: string; url?: string; note?: string };
const UNDO_MAX = 12;
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const hexDump = (b: Uint8Array) => { const lines: string[] = []; for (let o = 0; o < Math.min(b.length, 512); o += 16) { const s = b.subarray(o, o + 16); lines.push(o.toString(16).padStart(6, "0") + "  " + Array.from(s, (v) => v.toString(16).padStart(2, "0")).join(" ").padEnd(48) + "  " + Array.from(s, (v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : ".")).join("")); } return lines.join("\n"); };
const ENC_NAMES: Record<ArchiveEntry["nameEncoding"], string> = { utf8: "UTF-8", cp437: "IBM PC (CP437)", "unicode-path": "UTF-8 (Info-ZIP extra field)", "utf8-unflagged": "UTF-8 (unmarked, made on Unix/macOS)" };
const encLabel = (e: ArchiveEntry) => e.encryption === "aes" ? `AES-${64 * (e.aesStrength! + 1)}` : e.encryption === "zipcrypto" ? "ZipCrypto" : e.encryption === "strong" ? "PKWARE strong" : "";

export default function ArchiveModule({ win }: ModuleProps) {
  const shell = useShell();
  const [path, setPath] = useState<string>((win.props.path as string) ?? "");
  const [name, setName] = useState<string>(base((win.props.path as string) ?? "") || "");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [nameMode, setNameMode] = useState<NameMode>("auto");
  const [folder, setFolder] = useState("");
  const [entryQ, setEntryQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [undo, setUndo] = useState<Uint8Array[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null), addIn = useRef<HTMLInputElement>(null);
  const pwRef = useRef<string | undefined>(undefined);

  const parsed = useMemo<{ a?: Archive; e?: string }>(() => {
    if (!bytes) return {};
    try { return { a: readArchive(bytes, undefined, nameMode) }; } catch (e) { return { e: (e as Error).message }; }
  }, [bytes, nameMode]);
  const arc = parsed.a;
  const rows = useMemo<Row[]>(() => (arc ? filterEntries(listFolder(arc.entries, folder).map((r) => ({ ...r, name: r.path })), entryQ) : []), [arc, folder, entryQ]);
  const selRows = useMemo(() => rows.filter((r) => sel.includes(r.path)), [rows, sel]);

  // load from Files
  useEffect(() => {
    if (!path || bytes) return; let live = true;
    void (async () => {
      try {
        const r = await api<{ node: { content: string; encoding?: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
        const b = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
        if (live) { setBytes(b); setName(base(path)); }
      } catch (e) { if (live) setLoadErr(`Could not open ${path}: ${(e as Error).message}`); }
    })();
    return () => { live = false; };
  }, [path, bytes]);

  /** run fn with the archive password, asking when an entry needs one (once per archive) */
  const withPassword = useCallback(async <T,>(fn: (pw: string | undefined) => Promise<T>): Promise<T | null> => {
    let pw = pwRef.current; let retry = false;
    for (;;) {
      try { const r = await fn(pw); if (pw !== pwRef.current) { pwRef.current = pw; setPassword(pw); } return r; }
      catch (e) {
        if (!(e instanceof PasswordError)) throw e;
        const v = await askText("Password", "", { secret: true, title: `“${name || "archive"}” is encrypted`, okLabel: "Unlock", detail: retry ? "That password did not work — try again." : "Enter the archive password. It stays in memory for this window only." });
        if (v === null) return null; pw = v; retry = true;
      }
    }
  }, [name]);

  const commit = (next: Uint8Array, msg: string) => { if (bytes) setUndo((u) => [...u.slice(-(UNDO_MAX - 1)), bytes]); setBytes(next); setDirty(true); setStatus(msg); setSel([]); };
  const act = async (label: string, fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { shell.toast(`${label}: ${(e as Error).message}`, "bad"); setStatus(`${label} failed: ${(e as Error).message}`); } finally { setBusy(false); } };
  const encryptedArc = !!arc?.entries.some((e) => e.encryption !== "none");
  const newEntryEnc = (): { password?: string; encryption?: "aes256" | "zipcrypto" } => {
    if (!encryptedArc || pwRef.current === undefined) return {};
    return { password: pwRef.current, encryption: arc!.entries.some((e) => e.encryption === "aes") ? "aes256" : "zipcrypto" };
  };

  /* ---------------------------------------------------------------- preview */
  // synchronous cases are derived during render; only reading an entry is asynchronous (state keyed by entry + bytes)
  const previewKey = selRows.length === 1 && selRows[0].kind === "file" ? `${selRows[0].entry.index}:${selRows[0].entry.name}:${bytes?.length}:${password ?? ""}` : "";
  const syncPreview = useMemo<Preview | "load" | null>(() => {
    if (!arc || selRows.length !== 1) return null;
    const r = selRows[0];
    if (r.kind === "folder") return { name: r.name, kind: "folder", note: `${r.files} file(s) · ${fmtBytes(r.size)} (${fmtBytes(r.packed)} packed)` };
    const e = r.entry;
    if (e.symlink || !e.safePath || e.duplicate) return { name: r.name, kind: "blocked", note: e.symlink ? "Symbolic link — listed, never extracted." : e.duplicate ? "Duplicate name — listed, not extracted (ambiguous archive)." : "Unsafe path (absolute or climbs out of the folder) — blocked." };
    if (e.encryption !== "none" && password === undefined) return { name: r.name, kind: "locked", note: `${encLabel(e)} encrypted` };
    return "load";
  }, [arc, selRows, password]);
  const [loaded, setLoaded] = useState<{ key: string; p: Preview } | null>(null);
  useEffect(() => {
    if (syncPreview !== "load" || !bytes || selRows[0]?.kind !== "file") return;
    const r = selRows[0], e = r.entry, key = previewKey; let live = true; let url = "";
    void (async () => {
      let p: Preview;
      try {
        const d = await readEntry(bytes, e, { password: pwRef.current });
        if (IMAGE_EXT.test(e.name)) { url = URL.createObjectURL(new Blob([d as BlobPart], { type: MIME_BY_EXT[e.name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" })); p = { name: r.name, kind: "image", url }; }
        else if (looksText(d)) p = { name: r.name, kind: "text", text: new TextDecoder().decode(d.subarray(0, 200_000)) + (d.length > 200_000 ? "\n…" : "") };
        else p = { name: r.name, kind: "hex", text: hexDump(d) };
      } catch (err) {
        p = err instanceof PasswordError ? { name: r.name, kind: "locked", note: "The stored password did not open this entry." } : { name: r.name, kind: "error", note: (err as Error).message };
      }
      if (live) setLoaded({ key, p }); else if (url) URL.revokeObjectURL(url);
    })();
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [syncPreview, bytes, selRows, previewKey]);
  const preview: Preview | null = syncPreview === "load" ? (loaded?.key === previewKey ? loaded.p : { name: selRows[0]?.name ?? "", kind: "text", note: "Reading…" }) : syncPreview;

  /* ---------------------------------------------------------------- actions */
  const openDevice = async (f: File) => {
    const b = new Uint8Array(await f.arrayBuffer());
    setBytes(b); setPath(""); setName(f.name); setFolder(""); setSel([]); setUndo([]); setDirty(false); pwRef.current = undefined; setPassword(undefined); setLoadErr(""); setStatus(`Opened ${f.name} from this device (${fmtBytes(b.length)})`);
  };
  const newArchive = () => act("New archive", async () => {
    if (dirty && !(await askConfirm({ title: "Discard unsaved changes?", okLabel: "Discard" }))) return;
    const b = await writeArchive([]); setBytes(b); setPath(""); setName("New archive.zip"); setFolder(""); setSel([]); setUndo([]); setDirty(true); pwRef.current = undefined; setPassword(undefined); setLoadErr(""); setStatus("New empty archive — add files, then Save");
  });
  const addDeviceFiles = (files: FileList) => act("Add", async () => {
    if (!bytes) return;
    const items: WriteItem[] = [];
    for (const f of Array.from(files)) items.push({ name: folder + ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name), data: new Uint8Array(await f.arrayBuffer()), mtime: new Date(f.lastModified) });
    const next = await editArchive(bytes, items.map((item) => ({ op: "add", item }) as EditOp), newEntryEnc());
    commit(next, `Added ${items.length} file(s)${newEntryEnc().password ? " (encrypted with the archive password)" : ""}`);
  });
  const addFromFiles = () => act("Add from Files", async () => {
    if (!bytes) return;
    const p = await askText("Add a file from Files (path)", "/Documents/", { okLabel: "Add" }); if (!p) return;
    const r = await api<{ node: { content: string; encoding?: string; kind?: string } }>(`/api/fs?op=read&path=${encodeURIComponent(p)}`);
    if (r.node.kind === "dir") throw new Error("pick a file (folders: compress them from Files)");
    const data = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
    commit(await editArchive(bytes, [{ op: "add", item: { name: folder + base(p), data } }], newEntryEnc()), `Added ${base(p)}`);
  });
  const newFolder = () => act("New folder", async () => {
    if (!bytes) return;
    const n = await askText("New folder name", "New folder", { okLabel: "Create", validate: (v) => (!v || /[\\/]/.test(v) || v === "." || v === ".." ? "Use a plain name without slashes." : rows.some((r) => r.name === v) ? "That name exists here." : null) }); if (!n) return;
    commit(await editArchive(bytes, [{ op: "add", item: { name: folder + n + "/", dir: true } }]), `Created folder ${n}`);
  });
  const deleteSel = () => act("Delete", async () => {
    if (!bytes || !selRows.length) return;
    const names = namesUnder(arc!.entries, selRows);
    if (!(await askConfirm({ title: `Delete ${selRows.length} item(s) from the archive?`, detail: `${names.length} entr${names.length === 1 ? "y" : "ies"} will be removed. Undo is available until you close the window.`, okLabel: "Delete" }))) return;
    commit(await editArchive(bytes, selRows.map((r) => ({ op: "delete", name: r.kind === "folder" ? r.path : r.entry.name }))), `Deleted ${names.length} entr${names.length === 1 ? "y" : "ies"}`);
  });
  const renameSel = () => act("Rename", async () => {
    if (!bytes || selRows.length !== 1) return;
    const r = selRows[0];
    const n = await askText("Rename", r.name, { okLabel: "Rename", validate: (v) => (!v || /[\\/]/.test(v) || v === "." || v === ".." ? "Use a plain name without slashes." : v !== r.name && rows.some((x) => x.name === v) ? "That name exists here." : null) });
    if (!n || n === r.name) return;
    const from = r.kind === "folder" ? r.path : r.entry.name, to = folder + n + (r.kind === "folder" ? "/" : "");
    commit(await editArchive(bytes, [{ op: "rename", from, to }]), `Renamed ${r.name} to ${n}`);
  });
  const entriesFor = (all: boolean) => { const names = new Set(all ? arc!.entries.map((e) => e.name) : namesUnder(arc!.entries, selRows)); return arc!.entries.filter((e) => names.has(e.name) && !e.dir); };
  const extractToFiles = (all: boolean) => act("Extract", async () => {
    if (!arc || !bytes) return;
    const list = entriesFor(all); if (!list.length) return;
    const dir = path ? path.slice(0, path.lastIndexOf("/")) || "/" : "/Documents";
    const dest = await askText(`Extract ${list.length} file(s) to folder`, `${dir === "/" ? "" : dir}/${name.replace(/\.zip$/i, "") || "Extracted"}`, { okLabel: "Extract" }); if (!dest) return;
    const ok = list.filter(extractable), blocked = list.length - ok.length;
    const res = await withPassword(async (pw) => { const out: { p: string; d: Uint8Array }[] = []; for (const e of ok) out.push({ p: `${dest.replace(/\/$/, "")}/${e.safePath}`, d: await readEntry(bytes, e, { password: pw }) }); return out; });
    if (!res) return;
    let n = 0; const fails: string[] = [];
    for (const f of res) { try { await post("/api/fs", { op: "write", path: f.p, content: toB64(f.d), encoding: "base64", reason: "extract" }); n++; } catch (e) { fails.push(`${base(f.p)}: ${(e as Error).message}`); } }
    shell.bumpRefresh();
    const msg = `Extracted ${n} file(s) to ${dest} (verified)${blocked ? ` · ${blocked} blocked (unsafe path, symlink or duplicate)` : ""}${fails.length ? ` · ${fails.length} failed: ${fails[0]}` : ""}`;
    setStatus(msg); shell.toast(msg, fails.length || blocked ? "warn" : "ok");
  });
  const extractToDevice = () => act("Extract to device", async () => {
    if (!arc || !bytes) return;
    const list = entriesFor(!selRows.length).filter(extractable); if (!list.length) return;
    const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    const res = await withPassword(async (pw) => { const out: { e: ArchiveEntry; d: Uint8Array }[] = []; for (const e of list) out.push({ e, d: await readEntry(bytes, e, { password: pw }) }); return out; });
    if (!res) return;
    if (!picker) {
      if (res.length !== 1) throw new Error("this browser cannot write folders — extract to Files, or select one file to download it");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([res[0].d as BlobPart])); a.download = base(res[0].e.safePath!); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); return;
    }
    const root = await picker({ mode: "readwrite" });
    for (const { e, d } of res) {
      const parts = e.safePath!.split("/"); let h = root;
      for (const p of parts.slice(0, -1)) h = await h.getDirectoryHandle(p, { create: true });
      const fh = await h.getFileHandle(parts[parts.length - 1], { create: true }); const w = await fh.createWritable(); await w.write(d as BlobPart); await w.close();
    }
    setStatus(`Wrote ${res.length} file(s) to the chosen folder`);
  });
  const openEntry = (e: ArchiveEntry) => act("Open", async () => {
    if (!bytes) return;
    if (!extractable(e)) throw new Error("this entry is blocked (unsafe path, symlink or duplicate)");
    const d = await withPassword((pw) => readEntry(bytes, e, { password: pw })); if (!d) return;
    const p = `/Temp/Archive/${(name || "archive").replace(/[\\/]/g, "_")}/${e.safePath}`;
    await post("/api/fs", { op: "write", path: p, content: toB64(d), encoding: "base64", reason: "archive-open" });
    shell.bumpRefresh(); const app = appForFile(base(p), MIME_BY_EXT[base(p).split(".").pop()!.toLowerCase()] ?? "");
    shell.open(app === "archive" ? "archive" : app, { path: p, title: base(p) }); setStatus(`Opened a copy: ${p}`);
  });
  const testAll = () => act("Test", async () => {
    if (!arc || !bytes) return;
    const files = arc.entries.filter((e) => !e.dir && !e.symlink);
    const res = await withPassword(async (pw) => { let ok = 0; const bad: string[] = []; for (const e of files) { try { await readEntry(bytes, e, { password: pw }); ok++; } catch (x) { if (x instanceof PasswordError) throw x; bad.push(`${e.name}: ${(x as Error).message}`); } } return { ok, bad }; });
    if (!res) return;
    const msg = res.bad.length ? `Test: ${res.ok} OK, ${res.bad.length} damaged — ${res.bad[0]}` : `Test: all ${res.ok} file(s) OK (CRC-32${encryptedArc ? " / AES authentication" : ""} verified)`;
    setStatus(msg); shell.toast(msg, res.bad.length ? "bad" : "ok");
  });
  const saveTo = async (p: string, b: Uint8Array) => {
    await post("/api/fs", { op: "write", path: p, content: toB64(b), encoding: "base64", mime: "application/zip", reason: "archive-save" });
    shell.bumpRefresh();
  };
  const save = (as: boolean) => act("Save", async () => {
    if (!bytes) return;
    let p = path;
    if (as || !p) { const v = await askText("Save archive as", path || `/Documents/${name || "Archive.zip"}`, { okLabel: "Save", validate: (x) => (/\.zip$/i.test(x) ? null : "End the name with .zip") }); if (!v) return; p = v; }
    await saveTo(p, bytes); setPath(p); setName(base(p)); setDirty(false); setStatus(`Saved ${p} (${fmtBytes(bytes.length)})`); shell.toast(`Saved ${base(p)}`, "ok");
  });
  const download = () => { if (!bytes) return; const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" })); a.download = name || "archive.zip"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  const encryptCopy = () => act("Encrypt", async () => {
    if (!arc || !bytes) return;
    const v = await askForm({ title: "Save an encrypted copy", detail: "Every file is re-written with the new password. AES-256 (WinZip format) is strong and opens in 7-Zip, WinZip and macOS; ZipCrypto is weak and only for very old tools. Names stay visible.", okLabel: "Encrypt",
      fields: [{ name: "pw", label: "New password", def: "", secret: true }, { name: "pw2", label: "Repeat password", def: "", secret: true }, { name: "method", label: "Method (aes256 or zipcrypto)", def: "aes256" }, { name: "path", label: "Save as", def: (path || `/Documents/${name}`).replace(/\.zip$/i, "") + " (encrypted).zip" }],
      validate: (x) => (!x.pw ? "Enter a password." : x.pw !== x.pw2 ? "The passwords differ." : !["aes256", "zipcrypto"].includes(x.method) ? "Method: aes256 or zipcrypto" : !/\.zip$/i.test(x.path) ? "End the name with .zip" : null) });
    if (!v) return;
    const items = await withPassword(async (pw) => { const out: WriteItem[] = []; for (const e of arc.entries) { if (e.symlink || e.duplicate || !e.safePath) continue; out.push(e.dir ? { name: e.safePath, dir: true, mtime: e.mtime } : { name: e.safePath, data: await readEntry(bytes, e, { password: pw }), mtime: e.mtime, unixMode: e.unixMode ?? undefined }); } return out; });
    if (!items) return;
    const out = await writeArchive(items, { password: v.pw, encryption: v.method as "aes256" | "zipcrypto", comment: arc.comment });
    await saveTo(v.path, out); setStatus(`Saved encrypted copy ${v.path} (${items.length} entries, ${v.method === "aes256" ? "AES-256" : "ZipCrypto"})`); shell.toast(`Encrypted copy saved: ${base(v.path)}`, "ok");
  });
  const doUndo = () => { if (!undo.length) return; const prev = undo[undo.length - 1]; setUndo(undo.slice(0, -1)); setBytes(prev); setDirty(true); setSel([]); setStatus("Undone"); };
  const unlock = () => act("Unlock", async () => { const e = arc?.entries.find((x) => x.encryption !== "none" && !x.dir); if (!e || !bytes) return; pwRef.current = undefined; const r = await withPassword((pw) => readEntry(bytes, e, { password: pw })); if (r) setStatus("Unlocked"); });

  /* ---------------------------------------------------------------- selection + keyboard */
  const clickRow = (r: Row, ev: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (ev.shiftKey && anchor) { const i = rows.findIndex((x) => x.path === anchor), j = rows.findIndex((x) => x.path === r.path); const [a, b] = i < j ? [i, j] : [j, i]; setSel(rows.slice(a, b + 1).map((x) => x.path)); return; }
    if (ev.ctrlKey || ev.metaKey) { setSel((s) => (s.includes(r.path) ? s.filter((x) => x !== r.path) : [...s, r.path])); setAnchor(r.path); return; }
    setSel([r.path]); setAnchor(r.path);
  };
  const activate = (r: Row) => { if (r.kind === "folder") { setFolder(r.path); setSel([]); } else void openEntry(r.entry); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement; if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || busy) return;
    if (e.key === "Delete") { e.preventDefault(); void deleteSel(); }
    else if (e.key === "F2") { e.preventDefault(); void renameSel(); }
    else if (e.key === "Enter" && selRows.length === 1) { e.preventDefault(); activate(selRows[0]); }
    else if (e.key === "Backspace" && folder) { e.preventDefault(); setFolder(parentFolder(folder)); setSel([]); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(rows.map((r) => r.path)); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); const i = rows.findIndex((r) => r.path === sel[sel.length - 1]); const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      if (rows[j]) { setSel([rows[j].path]); setAnchor(rows[j].path); }
    }
  };

  const totals = arc ? arc.entries.reduce((t, e) => ({ u: t.u + e.usize, c: t.c + e.csize, f: t.f + (e.dir ? 0 : 1) }), { u: 0, c: 0, f: 0 }) : null;
  const th = { textAlign: "start" as const, padding: "4px 8px", fontSize: fz(12), fontWeight: 600, color: "var(--fs-muted)" };
  const td = { padding: "4px 8px", fontSize: fz(13), whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" };

  return (
    <div data-testid="archive-app" style={{ display: "grid", gridTemplateRows: "auto auto 1fr auto", height: "100%", minHeight: 0 }} onKeyDown={onKey}>
      <input ref={fileIn} type="file" accept=".zip,application/zip" hidden data-testid="archive-file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void openDevice(f); e.target.value = ""; }} />
      <input ref={addIn} type="file" multiple hidden data-testid="archive-add-input" onChange={(e) => { if (e.target.files?.length) void addDeviceFiles(e.target.files); e.target.value = ""; }} />
      <div className="fs-row" role="toolbar" aria-label="Archive actions" style={{ gap: 4, padding: 6, flexWrap: "wrap", borderBottom: "1px solid var(--fs-line)" }}>
        <Btn variant="ghost" onClick={() => fileIn.current?.click()}>Open from device…</Btn>
        <Btn variant="ghost" onClick={() => void newArchive()}>New</Btn>
        <Btn variant="primary" disabled={!bytes || busy || !dirty} onClick={() => void save(false)} data-testid="archive-save">Save</Btn>
        <Btn variant="ghost" disabled={!bytes || busy} onClick={() => void save(true)}>Save as…</Btn>
        <Btn variant="ghost" disabled={!bytes} onClick={download}>Download</Btn>
        <span aria-hidden style={{ width: 8 }} />
        <Btn variant="ghost" disabled={!arc || busy} onClick={() => addIn.current?.click()}>Add files…</Btn>
        <Btn variant="ghost" disabled={!arc || busy} onClick={() => void addFromFiles()}>Add from Files…</Btn>
        <Btn variant="ghost" disabled={!arc || busy} onClick={() => void newFolder()}>New folder</Btn>
        <Btn variant="ghost" disabled={!selRows.length || busy} onClick={() => void deleteSel()}>Delete</Btn>
        <Btn variant="ghost" disabled={selRows.length !== 1 || busy} onClick={() => void renameSel()}>Rename</Btn>
        <Btn variant="ghost" disabled={!undo.length || busy} onClick={doUndo}>Undo</Btn>
        <span aria-hidden style={{ width: 8 }} />
        <Btn variant="ghost" disabled={!selRows.length || busy} onClick={() => void extractToFiles(false)}>Extract selected…</Btn>
        <Btn variant="ghost" disabled={!arc?.entries.length || busy} onClick={() => void extractToFiles(true)}>Extract all…</Btn>
        <Btn variant="ghost" disabled={!arc?.entries.length || busy} onClick={() => void extractToDevice()}>Extract to device…</Btn>
        <Btn variant="ghost" disabled={!arc?.entries.length || busy} onClick={() => void testAll()}>Test</Btn>
        <Btn variant="ghost" disabled={!arc?.entries.length || busy} onClick={() => void encryptCopy()}>Encrypted copy…</Btn>
        {encryptedArc ? <Btn variant="ghost" onClick={() => void unlock()}>{password !== undefined ? "Change password" : "Enter password"}</Btn> : null}
      </div>
      <div className="fs-row" style={{ gap: 6, padding: "4px 8px", flexWrap: "wrap", alignItems: "center" }}>
        <nav aria-label="Folder path" className="fs-row" style={{ gap: 2, flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={() => { setFolder(""); setSel([]); }} data-testid="archive-crumb-root">{name || "Archive"}{dirty ? " •" : ""}</Btn>
          {crumbs(folder).map((c) => <Btn key={c.path} variant="ghost" onClick={() => { setFolder(c.path); setSel([]); }}>/ {c.name}</Btn>)}
        </nav>
        {totals ? <Badge data-testid="archive-count">{totals.f} files · {fmtBytes(totals.u)} ({fmtBytes(totals.c)} packed)</Badge> : null}
        {arc?.zip64 ? <Badge tone="info">ZIP64</Badge> : null}
        {encryptedArc ? <Badge tone="warn" data-testid="archive-encrypted">{[...new Set(arc!.entries.filter((e) => e.encryption !== "none").map(encLabel))].join(" + ")}{password !== undefined ? " · unlocked" : ""}</Badge> : null}
        <label className="fs-row" style={{ gap: 4, fontSize: fz(12) }}>Names
          <select className="fs-input" value={nameMode} onChange={(e) => setNameMode(e.target.value as NameMode)} aria-label="Name encoding" style={{ fontSize: fz(12) }}>
            <option value="auto">Auto</option><option value="cp437">IBM PC (CP437)</option><option value="utf8">UTF-8</option>
          </select>
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(220px, 34%)", minHeight: 0 }}>
        <div className="fs-scroll" style={{ minHeight: 0, borderRight: "1px solid var(--fs-line)" }}>
          {loadErr ? <div role="alert" style={{ padding: 12, color: "var(--fs-bad)" }}>{loadErr}</div> : null}
          {parsed.e ? <div role="alert" data-testid="archive-error" style={{ padding: 12, color: "var(--fs-bad)", fontSize: fz(13) }}>This archive was refused: {parsed.e}</div> : null}
          {!bytes && !loadErr ? <Empty glyph="emptyZip" title={path ? "Opening…" : "No archive open"} hint="Open a .zip from Files or from this device, or start a new one." /> : null}
          {arc?.issues.length ? <ul data-testid="archive-issues" style={{ margin: "6px 8px", padding: "4px 18px", fontSize: fz(12), color: "var(--fs-warn)" }}>{arc.issues.map((s) => <li key={s}>{s}</li>)}</ul> : null}
          {arc ? (
            <><input className="fs-input" type="search" placeholder="Filter entries in this folder" aria-label="Filter archive entries" value={entryQ} onChange={(e) => setEntryQ(e.target.value)} data-testid="archive-filter" style={{ margin: "6px 8px", width: "calc(100% - 16px)" }} />
            <table role="grid" aria-label="Archive contents" aria-multiselectable="true" data-testid="archive-list" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <thead><tr><th style={{ ...th, width: "44%" }}>Name</th><th style={th}>Size</th><th style={th}>Packed</th><th style={th}>Method</th><th style={th}>Modified</th></tr></thead>
              <tbody>
                {folder ? <tr onDoubleClick={() => { setFolder(parentFolder(folder)); setSel([]); }}><td style={td} colSpan={5}><button className="fs-btn ghost" onClick={() => { setFolder(parentFolder(folder)); setSel([]); }}>Up one folder</button></td></tr> : null}
                {rows.map((r) => {
                  const on = sel.includes(r.path); const e = r.kind === "file" ? r.entry : r.explicit;
                  const blocked = r.kind === "file" && !extractable(r.entry);
                  return (
                    <tr key={r.path} role="row" aria-selected={on} tabIndex={on ? 0 : -1} data-testid="archive-row" data-name={r.name} data-kind={r.kind}
                      onClick={(ev) => clickRow(r, ev)} onDoubleClick={() => activate(r)}
                      style={{ background: on ? "var(--fs-accent-soft, rgba(80,160,255,.18))" : undefined, cursor: "default" }}>
                      <td style={td} title={r.path}>
                        <span aria-hidden style={{ display: "inline-block", width: fz(12), height: fz(12), marginInlineEnd: 6, borderRadius: r.kind === "folder" ? 3 : 2, background: r.kind === "folder" ? "var(--fs-warn)" : "var(--fs-muted)", opacity: 0.7, verticalAlign: "middle" }} />
                        {r.name}{r.kind === "folder" ? "/" : ""}
                        {r.kind === "file" && r.entry.encryption !== "none" ? <span style={{ marginInlineStart: 6 }}><Badge tone="warn">{encLabel(r.entry)}</Badge></span> : null}
                        {blocked ? <span style={{ marginInlineStart: 6 }} /> : null}{blocked ? <Badge tone="bad">{r.entry.symlink ? "symlink" : r.entry.duplicate ? "duplicate" : "unsafe"}</Badge> : null}
                      </td>
                      <td style={td}>{r.kind === "folder" ? `${r.files} file(s)` : fmtBytes(r.entry.usize)}</td>
                      <td style={td}>{fmtBytes(r.kind === "folder" ? r.packed : r.entry.csize)}</td>
                      <td style={td}>{r.kind === "file" ? r.entry.methodName : ""}</td>
                      <td style={td} title={e ? e.mtime.toLocaleString() : undefined}>{e ? e.mtime.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></>
          ) : null}
          {arc && !rows.length ? <Empty glyph="folder" title="This folder is empty" hint="Add files or a folder." /> : null}
        </div>
        <aside aria-label="Preview" data-testid="archive-preview" className="fs-scroll" style={{ minHeight: 0, padding: 8, display: "grid", alignContent: "start", gap: 6 }}>
          {!preview ? <div className="fs-dim" style={{ fontSize: fz(12) }}>{arc?.comment ? <>Archive comment: <q>{arc.comment}</q></> : "Select a file to preview it."}</div> : null}
          {preview ? <strong style={{ fontSize: fz(13), wordBreak: "break-all" }}>{preview.name}</strong> : null}
          {preview?.note ? <div data-testid="archive-preview-note" style={{ fontSize: fz(12), color: preview.kind === "error" || preview.kind === "blocked" ? "var(--fs-bad)" : "var(--fs-muted)" }}>{preview.note}</div> : null}
          {preview?.kind === "locked" ? <Btn variant="primary" onClick={() => void unlock()}>Enter password</Btn> : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- blob: preview of an archive entry, nothing to optimise */}
          {preview?.kind === "image" && preview.url ? <img src={preview.url} alt={`Preview of ${preview.name}`} data-testid="archive-preview-image" style={{ width: "100%", height: "auto", maxHeight: 360, objectFit: "contain", imageRendering: "pixelated", background: "repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 16px 16px" }} /> : null}
          {(preview?.kind === "text" || preview?.kind === "hex") && preview.text !== undefined ? <pre data-testid="archive-preview-text" style={{ margin: 0, fontSize: fz(12), whiteSpace: preview.kind === "hex" ? "pre" : "pre-wrap", wordBreak: "break-word", maxHeight: 420, overflow: "auto" }}>{preview.text}</pre> : null}
          {selRows.length === 1 && selRows[0].kind === "file" ? (() => { const e = (selRows[0] as Extract<Row, { kind: "file" }>).entry; return (
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px", fontSize: fz(12), margin: 0 }}>
              <dt>Size</dt><dd style={{ margin: 0 }}>{fmtBytes(e.usize)} ({e.usize.toLocaleString()} bytes)</dd>
              <dt>Packed</dt><dd style={{ margin: 0 }}>{fmtBytes(e.csize)} · {e.methodName}</dd>
              <dt>CRC-32</dt><dd style={{ margin: 0 }}>{e.crc ? e.crc.toString(16).padStart(8, "0") : "— (AE-2: authenticated by HMAC)"}</dd>
              <dt>Name</dt><dd style={{ margin: 0 }}>{e.rawName.every((v) => v < 128) ? "ASCII" : ENC_NAMES[e.nameEncoding]}</dd>
              {e.unixMode !== null ? <><dt>Mode</dt><dd style={{ margin: 0 }}>{(e.unixMode & 0o7777).toString(8)}</dd></> : null}
              {e.comment ? <><dt>Comment</dt><dd style={{ margin: 0 }}>{e.comment}</dd></> : null}
              <dd style={{ margin: 0, gridColumn: "1 / -1" }}><Btn variant="ghost" onClick={() => void openEntry(e)} disabled={!extractable(e)}>Open in its app</Btn></dd>
            </dl>); })() : null}
        </aside>
      </div>
      <div role="status" aria-live="polite" data-testid="archive-status" style={{ padding: "4px 8px", fontSize: fz(12), borderTop: "1px solid var(--fs-line)", color: "var(--fs-muted)", minHeight: fz(22) }}>{busy ? "Working…" : status}</div>
    </div>
  );
}
