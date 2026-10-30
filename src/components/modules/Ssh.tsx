"use client";
import { askText } from "@/lib/ask";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { api, post } from "@/lib/api";
import { Vt, keyToBytes, mouseReport, A, DEFAULT, RGB, type Row } from "@/lib/vt";
import { createSession, SshConnection, pasteBytes, sftpUpload, type SshEvent } from "@/lib/ssh-client";
import { Btn, Badge } from "../ui";
import { clampTermFont, stepTermFont } from "@/lib/term-font";
import { connLine } from "@/lib/conn-line";
import type { ModuleProps } from "../shell-context";

/**
 * TT44 (TD-03) — SSH + SFTP. The protocol runs on Fusion's own server (src/lib/server/ssh: from-scratch transport,
 * KEX, ciphers, auth, channels, SFTP v3); this window is the terminal (src/lib/vt.ts — a from-scratch emulator) and
 * the file pane. Private keys are read from the VFS (normally /Private, which is client-side encrypted) or pasted,
 * sent once with the connect request and wiped server-side after authentication; they are never stored by the
 * server. Host keys are verified against /System/ssh/known_hosts (OpenSSH format) before ANY authentication.
 */
const RECENT = "/System/ssh/recent.json";
const KEY_DEFAULT = "/Private/ssh/id_ed25519";
interface Recent { host: string; port: number; username: string; keyPath?: string; at: number }
interface KnownHost { line: number; marker: string | null; hosts: string; type: string; fingerprint: string; comment: string }
interface Prompt { kind: "hostkey" | "auth"; host?: string; port?: number; fingerprint?: string; alg?: string; knownTypes?: string[]; canSave?: boolean; path?: string; method?: string; name?: string; instruction?: string; prompts?: { prompt: string; echo: boolean }[] }
interface Ready { server: string; negotiated: Record<string, string>; authMethod: string; fingerprint: string; hostKeyAlg: string; remote: string; route: string }

// ------------------------------------------------------------------------------------------------ colours
const BASE16 = ["#1b1e28", "#e0566c", "#4fc08d", "#e5b567", "#5aa6f0", "#c678dd", "#43c6d6", "#c8ccd4", "#5c6370", "#ff7a90", "#74e0a8", "#ffd48a", "#82c0ff", "#e19cf2", "#7fe3ee", "#ffffff"];
const FG = "#e6edf7", BG = "#05080f";
function palette(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) { const i = n - 16, l = [0, 95, 135, 175, 215, 255]; return `rgb(${l[Math.floor(i / 36)]},${l[Math.floor(i / 6) % 6]},${l[i % 6]})`; }
  const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`;
}
const colour = (c: number, dflt: string) => (c === DEFAULT ? dflt : c & RGB ? `#${(c & 0xffffff).toString(16).padStart(6, "0")}` : palette(c));

function runs(row: Row, cursorX: number): { text: string; style: React.CSSProperties }[] {
  const out: { text: string; style: React.CSSProperties; key: string }[] = [];
  for (let x = 0; x < row.cols; x++) {
    const at = row.at[x];
    if (at & A.WIDE_CONT) continue;
    let fg = row.fg[x], bg = row.bg[x];
    const bold = (at & A.BOLD) !== 0;
    if (bold && fg >= 0 && fg < 8) fg += 8; // bold-as-bright for the 8 base colours (xterm default)
    let f = colour(fg, FG), b = colour(bg, "transparent");
    if (at & A.INVERSE) { const t = f; f = bg === DEFAULT ? BG : b; b = t; }
    if (x === cursorX) { const t = f; f = b === "transparent" ? BG : b; b = t; }
    const deco = [at & A.UNDERLINE ? "underline" : "", at & A.STRIKE ? "line-through" : "", at & A.OVERLINE ? "overline" : ""].filter(Boolean).join(" ");
    const key = `${f}|${b}|${bold}|${at & (A.ITALIC | A.DIM | A.HIDDEN)}|${deco}|${at & A.WIDE}|${x === cursorX}`;
    const ch = at & A.HIDDEN ? " " : row.ch[x] || " ";
    const last = out[out.length - 1];
    if (last && last.key === key && !(at & A.WIDE)) { last.text += ch; continue; }
    const style: React.CSSProperties = { color: f };
    if (b !== "transparent") style.background = b;
    if (bold) style.fontWeight = 700;
    if (at & A.ITALIC) style.fontStyle = "italic";
    if (at & A.DIM) style.opacity = 0.6;
    if (deco) style.textDecoration = deco;
    if (at & A.WIDE) { style.display = "inline-block"; style.width = "2ch"; }
    out.push({ text: ch, style, key });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ terminal view
function TerminalView({ conn, vt, onTitle, focusKey }: { conn: SshConnection; vt: Vt; onTitle: (t: string) => void; focusKey: number }) {
  const [, setTick] = useState(0);
  const [scroll, setScroll] = useState(0); // rows scrolled back
  const [bell, setBell] = useState(false);
  const [font, setFont] = useState(13);
  const box = useRef<HTMLDivElement | null>(null), ta = useRef<HTMLTextAreaElement | null>(null), probe = useRef<HTMLSpanElement | null>(null);
  const cell = useRef({ w: 8, h: 17 });
  const composing = useRef(false);
  const raf = useRef(0);
  const redraw = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; setTick((t) => t + 1); }); }, []);

  useEffect(() => {
    vt.onReply = (s) => conn.send(s);
    vt.onBell = () => { setBell(true); setTimeout(() => setBell(false), 160); };
    vt.onTitle = (t) => onTitle(t);
    (vt as unknown as { redraw: () => void }).redraw = redraw;
    return () => { cancelAnimationFrame(raf.current); raf.current = 0; };
  }, [vt, conn, onTitle, redraw]);
  useEffect(() => { ta.current?.focus({ preventScroll: true }); }, [focusKey]);

  // size: measured monospace cell → cols × rows; the server is told via a control frame
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fit = () => {
      const p = probe.current; if (p) { const r = p.getBoundingClientRect(); if (r.width > 0) cell.current = { w: r.width / 10, h: r.height }; }
      const cols = Math.max(20, Math.floor((el.clientWidth - 16) / cell.current.w)), rows = Math.max(5, Math.floor((el.clientHeight - 12) / cell.current.h));
      if (cols !== vt.cols || rows !== vt.rows) {
        vt.resize(cols, rows); redraw();
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => conn.control({ t: "resize", cols, rows }), 120);
      }
    };
    const ro = new ResizeObserver(fit); ro.observe(el); fit();
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [vt, conn, redraw]);

  const send = (s: string) => { setScroll(0); conn.send(s); };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || e.nativeEvent.isComposing) return;
    if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "V")) return; // copy / paste chords stay with the browser
    if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) { e.preventDefault(); setScroll((s) => Math.max(0, Math.min(vt.scrollback.length, s + (e.key === "PageUp" ? 1 : -1) * (vt.rows - 1)))); return; }
    const b = keyToBytes(e, vt.modes);
    if (b !== null) { e.preventDefault(); send(b); }
  };
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    const t = e.currentTarget; if (t.value) { send(t.value.replace(/\n/g, "\r")); t.value = ""; }
  };
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault(); const text = e.clipboardData.getData("text/plain"); if (text) send(pasteBytes(text, vt.modes.bracketedPaste));
  };
  const at = (e: React.MouseEvent | React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(vt.cols - 1, Math.floor((e.clientX - r.left - 8) / cell.current.w))), y: Math.max(0, Math.min(vt.rows - 1, Math.floor((e.clientY - r.top - 6) / cell.current.h))) };
  };
  const mods = (e: React.MouseEvent) => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
  const held = useRef(-1);
  const mouse = (kind: "down" | "up" | "move", e: React.MouseEvent) => {
    if (!vt.modes.mouse || e.shiftKey) return false; // Shift = local selection even when the app grabs the mouse
    const p = at(e); const btn = kind === "move" ? held.current : e.button;
    if (kind === "down") held.current = e.button; else if (kind === "up") held.current = -1;
    const s = mouseReport(vt.modes, kind, btn, p.x, p.y, mods(e)); if (s) { conn.send(s); e.preventDefault(); }
    return true;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (vt.modes.mouse && !e.shiftKey) { const p = at(e); const s = mouseReport(vt.modes, "wheel", e.deltaY > 0 ? 1 : -1, p.x, p.y, mods(e)); if (s) conn.send(s); return; }
    if (vt.isAlt) { send((e.deltaY > 0 ? keyToBytes({ key: "ArrowDown", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, vt.modes) : keyToBytes({ key: "ArrowUp", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, vt.modes))!.repeat(3)); return; }
    setScroll((s) => Math.max(0, Math.min(vt.scrollback.length, s + (e.deltaY > 0 ? -3 : 3))));
  };

  const sb = vt.scrollback, view: Row[] = [];
  const top = sb.length - scroll;
  for (let i = 0; i < vt.rows; i++) { const k = top + i; view.push(k < sb.length ? sb[k] : vt.screen[k - sb.length]); }
  const cur = vt.cursor, showCursor = scroll === 0 && vt.modes.cursorVisible;
  return (
    <div ref={box} data-testid="ssh-term" className="fs-mono" onMouseDown={(e) => { if (!mouse("down", e)) return; }} onMouseUp={(e) => { mouse("up", e); if (!window.getSelection()?.toString()) ta.current?.focus({ preventScroll: true }); }}
      onMouseMove={(e) => { if (vt.modes.mouse === 1003 || (vt.modes.mouse === 1002 && held.current >= 0)) mouse("move", e); }} onWheel={onWheel}
      style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", padding: "6px 8px", background: BG, color: FG, fontSize: fz(font), lineHeight: 1.3, cursor: "text", outline: bell ? "2px solid #ffd48a" : "none", outlineOffset: -2 }}>
      <span ref={probe} aria-hidden style={{ position: "absolute", visibility: "hidden", whiteSpace: "pre" }}>WWWWWWWWWW</span>
      <div role="log" aria-live="off" aria-label="Remote terminal" style={{ whiteSpace: "pre" }}>
        {view.map((row, y) => (
          <div key={y} data-row={y} style={{ height: `${cell.current.h}px` }}>
            {runs(row, showCursor && y === cur.y ? Math.min(cur.x, vt.cols - 1) : -1).map((r, i) => <span key={i} style={r.style}>{r.text}</span>)}
          </div>
        ))}
      </div>
      <span style={{ position: "absolute", right: 10, bottom: 6, display: "flex", gap: 4, zIndex: 2 }}>
        <button type="button" className="fs-btn" data-variant="ghost" aria-label="Decrease terminal font size" onClick={() => setFont((f) => stepTermFont(f, -1))} data-testid="ssh-font-down">A−</button>
        <button type="button" className="fs-btn" data-variant="ghost" aria-label="Increase terminal font size" onClick={() => setFont((f) => stepTermFont(f, 1))} data-testid="ssh-font-up">A+</button>
      </span>
      {scroll > 0 && <div style={{ position: "absolute", right: 10, top: 6, fontSize: fz(11), background: "#ffd48a", color: "#1b1e28", padding: "1px 8px", borderRadius: 8 }}>scrollback −{scroll}</div>}
      <textarea ref={ta} aria-label="Remote terminal input" data-testid="ssh-input" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
        onKeyDown={onKeyDown} onInput={onInput} onPaste={onPaste}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={(e) => { composing.current = false; const d = e.data; e.currentTarget.value = ""; if (d) send(d); }}
        style={{ position: "absolute", left: showCursor ? 8 + cur.x * cell.current.w : 0, top: 6 + cur.y * cell.current.h, width: 2, height: cell.current.h, opacity: 0, padding: 0, border: 0, resize: "none", overflow: "hidden" }} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ SFTP pane
interface Entry { name: string; size: number; mode: number; mtime: number; dir: boolean; link: boolean }
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`);
/** tiny stroke icons (currentColor) — font-independent, unlike arrow/emoji glyphs */
const ICONS: Record<string, string> = {
  up: "M12 19V5M5 12l7-7 7 7", download: "M12 4v11M7 10l5 5 5-5M5 20h14", save: "M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7",
  rename: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4", trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  folder: "M3 6h6l2 2h10v11H3z", file: "M6 3h8l4 4v14H6zM14 3v4h4", link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
};
function Ico({ n, size = 16 }: { n: keyof typeof ICONS; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d={ICONS[n]} /></svg>;
}
const nameError = (v: string) => (!v.trim() ? "Enter a name" : /[/\0]/.test(v) ? "A name cannot contain / or NUL" : v === "." || v === ".." ? "Not a valid name" : null);

function SftpPane({ id }: { id: string }) {
  const [cwd, setCwd] = useState(""); const [entries, setEntries] = useState<Entry[]>([]); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);
  const call = useCallback(async <T,>(b: Record<string, unknown>): Promise<T> => api<T>(`/api/ssh/${id}/sftp`, { method: "POST", body: JSON.stringify(b) }), [id]);
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t); }, [armed]);
  // keepMsg: a refresh after an action must not wipe the action's result message
  const load = useCallback(async (p: string, keepMsg = false) => {
    setBusy(true); if (!keepMsg) setMsg("");
    try { const r = await call<{ path: string; entries: Entry[] }>({ op: "list", path: p }); setCwd(r.path); setEntries(r.entries.filter((e) => e.name !== "." && e.name !== "..").sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }, [call]);
  useEffect(() => { void (async () => { try { const r = await call<{ path: string }>({ op: "realpath", path: "." }); await load(r.path); } catch (e) { setMsg((e as Error).message); } })(); }, [call, load]);
  const join = (n: string) => (cwd.endsWith("/") ? cwd + n : `${cwd}/${n}`);
  const act = async (f: () => Promise<unknown>, ok: string) => { setBusy(true); try { await f(); setMsg(ok); await load(cwd, true); } catch (e) { setMsg((e as Error).message); setBusy(false); } };
  const saveToFusion = async (e: Entry) => {
    if (e.size > 8 * 1024 * 1024) { setMsg("Over 8 MiB — use Download instead (the VFS keeps files up to 8 MiB)."); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/ssh/${id}/sftp?op=download&path=${encodeURIComponent(join(e.name))}`, { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await post("/api/fs", { op: "write", path: `/Downloads/${e.name}`, content: btoa(s), encoding: "base64", reason: `sftp: ${join(e.name)}` });
      setMsg(`Saved to /Downloads/${e.name} (${fmtSize(buf.length)})`);
    } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      try { await sftpUpload(id, join(f.name), f, (d, t) => setMsg(`Uploading ${f.name}: ${Math.round((d / Math.max(1, t)) * 100)}%`)); setMsg(`Uploaded ${f.name} (${fmtSize(f.size)})`); }
      catch (e) { setMsg(`${f.name}: ${(e as Error).message}`); break; }
    }
    await load(cwd, true);
  };
  return (
    <div data-testid="sftp-pane" style={{ width: "min(46%, 440px)", minWidth: 260, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--fs-border)", fontSize: fz(13) }}>
      <div className="fs-row" style={{ padding: 8, gap: 6, flexWrap: "wrap" }}>
        <Btn onClick={() => void load(cwd.replace(/\/[^/]+\/?$/, "") || "/")} disabled={busy || cwd === "/"} title="Parent folder" aria-label="Parent folder"><Ico n="up" /></Btn>
        <input className="fs-input fs-mono" aria-label="Remote folder" value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(cwd); }} style={{ flex: 1, minWidth: 120 }} />
        <Btn onClick={() => void (async () => { const n = await askText("Folder name", "", { title: "New folder on the server", okLabel: "Create", validate: nameError }); if (n) await act(() => call({ op: "mkdir", path: join(n) }), `Created ${n}`); })()} disabled={busy}>New folder</Btn>
        <Btn variant="primary" onClick={() => file.current?.click()} disabled={busy}>Upload…</Btn>
        <input ref={file} type="file" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
      </div>
      {msg && <div role="status" style={{ padding: "4px 10px", fontSize: fz(12), opacity: 0.85 }}>{msg}</div>}
      <div className="fs-scroll" style={{ flex: 1, minHeight: 0 }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        {entries.map((e) => (
          <div key={e.name} className="fs-list-item" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", minHeight: 36 }}>
            <button className="fs-btn" data-variant="ghost" style={{ flex: 1, justifyContent: "flex-start", textAlign: "left", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
              onDoubleClick={() => { if (e.dir) void load(join(e.name)); }} onClick={() => { if (e.dir) void load(join(e.name)); }} title={e.dir ? "Open folder" : `${fmtSize(e.size)} · ${new Date(e.mtime * 1000).toLocaleString()}`}>
              <Ico n={e.dir ? "folder" : e.link ? "link" : "file"} /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
            </button>
            {!e.dir && <span style={{ fontSize: fz(11), opacity: 0.7, whiteSpace: "nowrap" }}>{fmtSize(e.size)}</span>}
            {!e.dir && <a className="fs-btn" data-variant="ghost" href={`/api/ssh/${id}/sftp?op=download&path=${encodeURIComponent(join(e.name))}`} download={e.name} title="Download to this computer" aria-label={`Download ${e.name}`}><Ico n="download" /></a>}
            {!e.dir && <Btn variant="ghost" title="Save a copy into Fusion's /Downloads" aria-label={`Save ${e.name} to Fusion`} onClick={() => void saveToFusion(e)} disabled={busy}><Ico n="save" /></Btn>}
            <Btn variant="ghost" title="Rename" aria-label={`Rename ${e.name}`} disabled={busy} onClick={() => void (async () => { const n = await askText("New name", e.name, { title: `Rename ${e.name}`, okLabel: "Rename", validate: nameError }); if (n && n !== e.name) await act(() => call({ op: "rename", from: join(e.name), to: join(n) }), `Renamed to ${n}`); })()}><Ico n="rename" /></Btn>
            {armed === e.name
              ? <Btn variant="danger" title={e.dir ? "Folder must be empty" : "Deletes on the server — no undo"} aria-label={`Confirm delete ${e.name}`} disabled={busy} onClick={() => { setArmed(null); void act(() => call({ op: e.dir ? "rmdir" : "remove", path: join(e.name) }), `Deleted ${e.name}`); }}>Delete?</Btn>
              : <Btn variant="ghost" title="Delete (asks once more)" aria-label={`Delete ${e.name}`} disabled={busy} onClick={() => setArmed(e.name)}><Ico n="trash" /></Btn>}
          </div>
        ))}
        {!entries.length && !busy && <div style={{ padding: 16, opacity: 0.7 }}>Empty folder — drop files here to upload.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ module
export default function SshModule({ win }: ModuleProps) {
  const pre = win.props as { host?: string; port?: number; username?: string };
  const [host, setHost] = useState(pre.host ?? ""); const [port, setPort] = useState(String(pre.port ?? 22)); const [user, setUser] = useState(pre.username ?? "");
  const [keyMode, setKeyMode] = useState<"vfs" | "paste" | "none">("vfs"); const [keyPath, setKeyPath] = useState(KEY_DEFAULT); const [keyText, setKeyText] = useState("");
  const [direct, setDirect] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]); const [known, setKnown] = useState<KnownHost[]>([]); const [route, setRoute] = useState("Direct");
  const [phase, setPhase] = useState<"form" | "session">("form");
  const [status, setStatus] = useState(""); const [error, setError] = useState("");
  const [prompt_, setPrompt] = useState<Prompt | null>(null); const [answers, setAnswers] = useState<string[]>([]);
  const [refused, setRefused] = useState<{ why: string; fingerprint: string; line?: number; path: string } | null>(null);
  const [ready, setReady] = useState<Ready | null>(null); const [title, setTitle] = useState(""); const [exit, setExit] = useState<string>("");
  const [showSftp, setShowSftp] = useState(false); const [focusKey, setFocusKey] = useState(0);
  const [kg, setKg] = useState<{ pub?: string; msg?: string; dl?: string } | null>(null);
  const conn = useRef<SshConnection | null>(null);
  const vt = useMemo(() => new Vt(80, 24, 5000), []);
  const dec = useRef(new TextDecoder());

  const refresh = useCallback(async () => {
    try { const r = await api<{ route: { label: string }; knownHosts: { entries: KnownHost[] } }>("/api/ssh"); setRoute(r.route.label); setKnown(r.knownHosts.entries); } catch { /* listed on next open */ }
    try { const r = await api<{ node: { content: string } | null }>(`/api/fs?op=read&path=${encodeURIComponent(RECENT)}`); setRecent(r.node ? (JSON.parse(r.node.content) as Recent[]).slice(0, 8) : []); } catch { setRecent([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { conn.current?.detach(); }, []);

  const remember = async () => {
    const r: Recent = { host, port: Number(port) || 22, username: user, keyPath: keyMode === "vfs" ? keyPath : undefined, at: Date.now() };
    const list = [r, ...recent.filter((x) => !(x.host === r.host && x.port === r.port && x.username === r.username))].slice(0, 8);
    setRecent(list);
    // no secrets here: host, port, user and the PATH of the key file only
    await post("/api/fs", { op: "write", path: RECENT, content: JSON.stringify(list, null, 2), mime: "application/json", reason: "ssh: recent connection" }).catch(() => undefined);
  };

  const onEvent = useCallback((e: SshEvent) => {
    switch (e.t) {
      case "status": setStatus(String(e.text ?? "")); break;
      case "banner": vt.write(String(e.text ?? "").replace(/\r?\n/g, "\r\n")); (vt as unknown as { redraw?: () => void }).redraw?.(); break;
      case "prompt": setPrompt(e as unknown as Prompt); setAnswers([]); break;
      case "hostkey-refused": setRefused({ why: String(e.why), fingerprint: String(e.fingerprint), line: e.line as number | undefined, path: String(e.path) }); break;
      case "ready": setReady(e as unknown as Ready); setStatus(""); setPrompt(null); setFocusKey((k) => k + 1); break;
      case "exit": setExit(typeof e.code === "number" ? `exit status ${e.code}` : e.signal ? `killed by SIG${String(e.signal)}` : "exited"); break;
      case "error": setError(`${String(e.message ?? "error")}${e.code ? ` (${String(e.code)})` : ""}`); break;
      case "closed": setStatus(`Disconnected — ${String(e.why ?? "")}`); setPrompt(null); break;
    }
  }, [vt]);

  const connect = async (override?: Partial<Recent>) => {
    const h = override?.host ?? host, p = override?.port ?? (Number(port) || 22), u = override?.username ?? user, kp = override?.keyPath ?? (keyMode === "vfs" ? keyPath : undefined);
    if (override) { setHost(h); setPort(String(p)); setUser(u); if (kp) { setKeyMode("vfs"); setKeyPath(kp); } }
    setError(""); setRefused(null); setReady(null); setExit(""); setStatus("Starting…");
    let privateKey: string | undefined;
    try {
      if (override ? kp : keyMode === "vfs") {
        const r = await api<{ node: { content: string; encoding?: string } | null }>(`/api/fs?op=read&path=${encodeURIComponent(kp!)}`).catch(() => ({ node: null }));
        if (r.node) privateKey = r.node.encoding === "base64" ? atob(r.node.content) : r.node.content;
        else if (!override) { setStatus(""); setError(`No key file at ${kp}. Generate one below, choose "Paste", or "Password only".`); return; }
      } else if (keyMode === "paste" && keyText.trim()) privateKey = keyText;
      vt.reset(); vt.write("\x1b[2J\x1b[H");
      const id = await createSession({ host: h, port: p, username: u, privateKey, cols: vt.cols, rows: vt.rows, direct, lang: navigator.language?.replace(/-/g, "_") + ".UTF-8" });
      privateKey = undefined;
      const c = new SshConnection(id, { onEvent, onData: (d) => { vt.write(d); (vt as unknown as { redraw?: () => void }).redraw?.(); }, onDetach: (why) => setStatus(`Reconnecting the stream (${why})…`) });
      conn.current = c; setPhase("session");
      void c.attach();
      void remember();
    } catch (e) { setStatus(""); setError((e as Error).message); }
  };
  const disconnect = async () => { await conn.current?.close(); conn.current = null; setPhase("form"); setShowSftp(false); setReady(null); setStatus(""); void refresh(); };

  const answerHostKey = (accept: boolean, save: boolean) => { conn.current?.control({ t: "hostkey", accept, save }); setPrompt(null); if (accept) setStatus("Host key accepted — authenticating…"); };
  const answerAuth = (cancel: boolean) => { conn.current?.control({ t: "auth", answers: cancel ? null : (prompt_?.prompts ?? []).map((_, i) => answers[i] ?? "") }); setPrompt(null); setAnswers([]); };
  const forget = async (h: string, p: number) => {
    try { await api("/api/ssh", { method: "POST", body: JSON.stringify({ op: "forget", host: h, port: p }) }); setRefused(null); setStatus(`Forgot the stored key for ${h}:${p}. Reconnect to review the new one.`); void refresh(); }
    catch (e) { setError((e as Error).message); }
  };
  const keygen = async () => {
    setKg({ msg: "Generating…" });
    try {
      const pass = (document.getElementById("ssh-kg-pass") as HTMLInputElement | null)?.value || undefined;
      const r = await api<{ privateKey: string; publicKey: string }>("/api/ssh", { method: "POST", body: JSON.stringify({ op: "keygen", comment: `${user || "fusion"}@fusion`, passphrase: pass }) });
      try {
        await post("/api/fs", { op: "write", path: KEY_DEFAULT, content: r.privateKey, mime: "text/plain", reason: "ssh: generated key" });
        await post("/api/fs", { op: "write", path: `${KEY_DEFAULT}.pub`, content: r.publicKey, mime: "text/plain", reason: "ssh: generated key" });
        setKg({ pub: r.publicKey, msg: `Saved ${KEY_DEFAULT} (+ .pub). Add the public key below to ~/.ssh/authorized_keys on the server.` });
        setKeyMode("vfs"); setKeyPath(KEY_DEFAULT);
      } catch (e) {
        // /Private locked (or amnesic): nothing was stored — offer the key as a download instead, never silently drop it
        const url = URL.createObjectURL(new Blob([r.privateKey], { type: "text/plain" }));
        setKg({ pub: r.publicKey, dl: url, msg: `Could not save into ${KEY_DEFAULT}: ${(e as Error).message}. Download the private key now — it is not kept anywhere else.` });
      }
    } catch (e) { setKg({ msg: (e as Error).message }); }
  };

  const neg = ready?.negotiated ?? {};
  return (
    <div data-testid="ssh-module" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: fz(14) }}>
      {phase === "form" ? (
        <div className="fs-scroll" style={{ padding: 18, display: "grid", gap: 16, alignContent: "start", maxWidth: 760 }}>
          <form onSubmit={(e) => { e.preventDefault(); void connect(); }} style={{ display: "grid", gap: 10 }} aria-label="Connect over SSH">
            <div className="fs-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input className="fs-input" aria-label="User" placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} style={{ width: 140 }} autoCapitalize="off" spellCheck={false} />
              <span style={{ alignSelf: "center" }}>@</span>
              <input className="fs-input" aria-label="Host" placeholder="host or address" value={host} onChange={(e) => setHost(e.target.value)} style={{ flex: 1, minWidth: 180 }} autoCapitalize="off" spellCheck={false} />
              <input className="fs-input" aria-label="Port" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} style={{ width: 80 }} inputMode="numeric" />
              <Btn type="submit" variant="primary" disabled={!host.trim() || !user.trim()}>Connect</Btn>
              <button type="button" className="fs-btn" data-variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(connLine({ user, host, port, state: (phase as string) === "session" ? (ready ? "connected" : status || "connecting") : "not connected" })); setStatus("Connection line copied."); } catch { setStatus("Clipboard unavailable."); } }} data-testid="ssh-copy-line" aria-label="Copy connection line">⧉</button>
            </div>
            <div className="fs-row" style={{ gap: 14, flexWrap: "wrap", alignItems: "center" }} role="radiogroup" aria-label="Authentication">
              {([["vfs", "Key file in Fusion"], ["paste", "Paste a key"], ["none", "Password only"]] as const).map(([id, label]) => (
                <label key={id} style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 32 }}><input type="radio" name="ssh-auth" checked={keyMode === id} onChange={() => setKeyMode(id)} />{label}</label>
              ))}
              {route !== "Direct" && <label style={{ display: "flex", gap: 6, alignItems: "center" }} title={`Fusion's network route is "${route}"; tick to dial directly instead`}><input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} />Bypass route ({route})</label>}
            </div>
            {keyMode === "vfs" && <input className="fs-input fs-mono" aria-label="Key file path" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />}
            {keyMode === "paste" && <textarea className="fs-textarea fs-mono" aria-label="Private key" rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={keyText} onChange={(e) => setKeyText(e.target.value)} />}
            <div style={{ fontSize: fz(12), opacity: 0.75 }}>Passwords, passphrases and keyboard-interactive codes are asked for when the server needs them. The host key is checked before anything is sent. Route: {route}.</div>
            {status && <div role="status">{status}</div>}
            {error && <div role="alert" style={{ color: "#e0566c" }}>{error}</div>}
          </form>
          {recent.length > 0 && (
            <section aria-label="Recent connections"><h3 style={{ fontSize: fz(14), margin: "4px 0 8px" }}>Recent</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{recent.map((r) => <Btn key={`${r.username}@${r.host}:${r.port}`} onClick={() => void connect(r)}>{r.username}@{r.host}{r.port !== 22 ? `:${r.port}` : ""}</Btn>)}</div>
            </section>
          )}
          <section aria-label="Keys"><h3 style={{ fontSize: fz(14), margin: "4px 0 8px" }}>Your key</h3>
            <div className="fs-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input id="ssh-kg-pass" className="fs-input" type="password" placeholder="optional passphrase" aria-label="New key passphrase" style={{ width: 220 }} />
              <Btn onClick={() => void keygen()}>Generate ed25519 key</Btn>
            </div>
            {kg?.msg && <div role="status" style={{ marginTop: 8, fontSize: fz(12) }}>{kg.msg}</div>}
            {kg?.dl && <a className="fs-btn" data-variant="primary" href={kg.dl} download="id_ed25519" style={{ marginTop: 6, display: "inline-flex" }}>Download private key</a>}
            {kg?.pub && <textarea readOnly className="fs-textarea fs-mono" aria-label="Public key" rows={2} value={kg.pub} style={{ marginTop: 6, width: "100%" }} onFocus={(e) => e.currentTarget.select()} />}
          </section>
          <section aria-label="Known hosts"><h3 style={{ fontSize: fz(14), margin: "4px 0 8px" }}>Trusted hosts <span style={{ fontWeight: 400, opacity: 0.7 }}>(/System/ssh/known_hosts)</span></h3>
            {known.length === 0 ? <div style={{ opacity: 0.7, fontSize: fz(12) }}>None yet — the first connection to a host asks you to confirm its fingerprint.</div> :
              known.map((k) => (
                <div key={k.line} className="fs-row" style={{ gap: 8, alignItems: "center", fontSize: fz(12), minHeight: 32 }}>
                  {k.marker && <Badge tone="bad">{k.marker}</Badge>}<span className="fs-mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{k.hosts} · {k.type} · {k.fingerprint}</span>
                  {k.hosts !== "(hashed)" && <Btn variant="ghost" onClick={() => { const [h, p] = /^\[(.+)\]:(\d+)$/.exec(k.hosts.split(",")[0])?.slice(1) ?? [k.hosts.split(",")[0], "22"]; void forget(h, Number(p)); }}>Forget</Btn>}
                </div>
              ))}
          </section>
        </div>
      ) : (
        <>
          <div className="fs-row" style={{ padding: "6px 10px", gap: 8, alignItems: "center", borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
            <strong className="fs-mono" style={{ fontSize: fz(13) }}>{user}@{host}{port !== "22" ? `:${port}` : ""}</strong>
            {ready ? <Badge tone="ok" title={`${ready.server}\n${ready.hostKeyAlg} ${ready.fingerprint}\nvia ${ready.route} (${ready.remote})`}>{neg.kex?.split("@")[0]} · {neg.c2s?.split("@")[0]} · {ready.authMethod}</Badge> : <Badge tone="info">{status || "connecting…"}</Badge>}
            {ready && (neg.kex?.startsWith("mlkem")
              ? <Badge tone="ok" title={`Hybrid key exchange (${neg.kex}): ML-KEM (FIPS 203) combined with ${neg.kex.includes("x25519") ? "X25519" : "an elliptic curve"}. A recording of this session stays confidential unless BOTH are broken — including by a future quantum computer.`}>Post-quantum</Badge>
              : <Badge tone="info" title={`Classical key exchange (${neg.kex}): this server offers no ML-KEM hybrid. Safe today, but a recording of this session could be decrypted by a future large quantum computer.`}>Classical key exchange</Badge>)}
            {title && <span style={{ opacity: 0.75, fontSize: fz(12), overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 }}>{title}</span>}
            {exit && <Badge tone="warn">{exit}</Badge>}
            <span style={{ flex: 1 }} />
            <Btn onClick={() => setShowSftp((s) => !s)} disabled={!ready} aria-pressed={showSftp} title="SFTP file browser for this server">Remote files</Btn>
            <Btn onClick={() => conn.current?.control({ t: "signal", name: "INT" })} disabled={!ready} title="Send SIGINT">Interrupt</Btn>
            <Btn variant="danger" onClick={() => void disconnect()}>Disconnect</Btn>
          </div>
          {error && <div role="alert" style={{ padding: "6px 12px", color: "#e0566c", fontSize: fz(13) }}>{error}</div>}
          {refused && (
            <div role="alert" style={{ padding: 12, background: "#3a1420", color: "#ffd9df", fontSize: fz(13) }}>
              <strong>{refused.why === "changed" ? "The host key CHANGED — refusing to connect." : "This host key is REVOKED — refusing to connect."}</strong>{" "}
              Server presented {refused.fingerprint}{refused.line ? `; ${refused.path} line ${refused.line} says otherwise` : ""}. This can mean someone is intercepting the connection.
              {refused.why === "changed" && <div style={{ marginTop: 8 }}><Btn onClick={() => void forget(host, Number(port) || 22)}>I re-installed the server — forget the stored key</Btn></div>}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {conn.current && <TerminalView conn={conn.current} vt={vt} onTitle={setTitle} focusKey={focusKey} />}
            {showSftp && ready && conn.current && <SftpPane id={conn.current.id} />}
          </div>
        </>
      )}
      {prompt_ && (
        <div className="fs-ask-backdrop" role="dialog" aria-modal="true" aria-label={prompt_.kind === "hostkey" ? "Verify host key" : "Authentication"} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(5,8,15,.55)", zIndex: 5 }}>
          <form className="fs-ask" onSubmit={(e) => { e.preventDefault(); if (prompt_.kind === "auth") answerAuth(false); }} style={{ maxWidth: 560, padding: 20, borderRadius: 14, display: "grid", gap: 10, background: "var(--fs-panel, #fff)", color: "inherit" }}>
            {prompt_.kind === "hostkey" ? (<>
              <div className="fs-ask-title" style={{ fontWeight: 700 }}>First connection to {prompt_.host}{prompt_.port !== 22 ? `:${prompt_.port}` : ""}</div>
              <div className="fs-ask-detail">The server identifies itself with this {prompt_.alg} key. Compare the fingerprint with one you got from the server&apos;s owner (on the server: <code>ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code>).</div>
              <code data-testid="ssh-fingerprint" style={{ fontSize: fz(13), wordBreak: "break-all", padding: 8, background: "rgba(127,127,127,.12)", borderRadius: 8 }}>{prompt_.fingerprint}</code>
              {!!prompt_.knownTypes?.length && <div style={{ fontSize: fz(12) }}>Note: a key of another type ({prompt_.knownTypes.join(", ")}) is already trusted for this host.</div>}
              <div className="fs-ask-actions fs-row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <Btn onClick={() => answerHostKey(false, false)}>Cancel</Btn>
                <Btn onClick={() => answerHostKey(true, false)}>Trust once</Btn>
                <Btn variant="primary" onClick={() => answerHostKey(true, true)} disabled={!prompt_.canSave} title={prompt_.canSave ? `Adds a line to ${prompt_.path}` : "Amnesic session: nothing is written"}>Trust &amp; remember</Btn>
              </div>
            </>) : (<>
              <div className="fs-ask-title" style={{ fontWeight: 700 }}>{prompt_.name || (prompt_.method === "password" ? `Password for ${user}@${host}` : "Authentication")}</div>
              {prompt_.instruction && <div className="fs-ask-detail" style={{ whiteSpace: "pre-wrap" }}>{prompt_.instruction}</div>}
              {(prompt_.prompts ?? []).map((p, i) => (
                <label key={i} className="fs-ask-field" style={{ display: "grid", gap: 4 }}><span className="fs-ask-label">{p.prompt}</span>
                  <input className="fs-input fs-ask-input" autoFocus={i === 0} type={p.echo ? "text" : "password"} value={answers[i] ?? ""} onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n; })} autoComplete="off" /></label>
              ))}
              <div className="fs-ask-actions fs-row" style={{ gap: 8, justifyContent: "flex-end" }}>
                <Btn onClick={() => answerAuth(true)}>Cancel</Btn><Btn type="submit" variant="primary">Continue</Btn>
              </div>
            </>)}
          </form>
        </div>
      )}
    </div>
  );
}
