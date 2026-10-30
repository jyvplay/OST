"use client";
import { suggest } from "@/lib/suggest";
import { pushCommand, historyText } from "@/lib/cmd-history";
import { parseAlias, expandAlias } from "@/lib/alias-map";
import { wc, formatWc } from "@/lib/wc-core";
import { headLines, tailLines, parseCountArg } from "@/lib/text-slice";
import { sortText, uniqText } from "@/lib/text-sort";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtBytes, post } from "@/lib/api";
import { MODULES } from "@/lib/registry";
import { parseTarget } from "@/lib/ssh-client";
import { useShell, type ModuleProps } from "../shell-context";

interface Line { text: string; tone?: "out" | "err" | "cmd" | "info" }

/**
 * TD-01/TD-02. A real shell over the same API and the same journal the GUI
 * uses: `mv` here and drag-and-drop in Files produce identical file_ops rows.
 * No xterm.js — the renderer is a virtualised DOM list, which keeps the bundle
 * small and lets commands be first-class objects the palette can also call.
 */
const COMMAND_NAMES = ["cast", "cat", "cd", "clear", "cp", "df", "echo", "find", "grep", "help", "jobs", "ls", "mkdir", "mv", "open", "uniq", "probe", "pwd", "restore", "rm", "sha256", "sort", "spec", "ssh", "stat", "write", "wc", "du", "head", "tail"];

export default function TerminalModule({ win }: ModuleProps) {
  const shell = useShell();
  const [cwd, setCwd] = useState<string>((win.props.cwd as string) ?? "/");
  // TT55 (FM-02): docked under Files, the terminal follows the active pane — derive from the prop during render
  // (React's "adjust state when a prop changes" pattern) so the history survives and the cd is visible
  const propCwd = (win.props.cwd as string | undefined) ?? "/";
  const [seenCwd, setSeenCwd] = useState(propCwd);
  const [lines, setLines] = useState<Line[]>([
    { text: "Fusion shell — type `help`. Commands run against the Postgres VFS.", tone: "info" },
  ]);
  if (win.props.embedded === true && propCwd !== seenCwd) {
    setSeenCwd(propCwd); setCwd(propCwd);
    setLines((l) => [...l, { text: `cd ${propCwd}   (following the Files pane)`, tone: "info" as const }].slice(-500));
  }
  const [input, setInput] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [lines]);

  const out = (text: string, tone: Line["tone"] = "out") => setLines((l) => [...l, { text, tone }].slice(-500));

  const resolve = useCallback((p: string) => {
    if (!p) return cwd;
    const base = p.startsWith("/") ? p : `${cwd === "/" ? "" : cwd}/${p}`;
    const parts: string[] = [];
    for (const seg of base.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join("/")}`;
  }, [cwd]);

  const histRef = useRef<string[]>([]);
  const aliasRef = useRef<Record<string, string>>({});
  const exec = useCallback(async (raw: string) => {
    histRef.current = pushCommand(histRef.current, raw);
    const line = raw.trim();
    if (!line) return;
    const al = parseAlias(line);
    if (al) { aliasRef.current = { ...aliasRef.current, [al.name]: al.cmd }; out(`alias ${al.name} -> ${al.cmd}`); return; }
    const line2 = expandAlias(line, aliasRef.current);
    out(`${cwd} $ ${line2}`, "cmd");
    const [cmd, ...args] = line2.split(/\s+/);
    const rest = line.slice(cmd.length).trim();
    try {
      switch (cmd) {
      case "history": historyText(histRef.current).split("\n").forEach((ln) => out(ln)); break;
        case "alias": { const e = Object.entries(aliasRef.current); if (!e.length) out("no aliases"); else e.forEach(([k, v]) => out(`${k} -> ${v}`)); break; }
        case "help":
          out([
            "ls [path]              list a directory",
            "wc <file> [file…]      lines · words · UTF-8 bytes",
            "head [-n N] <file>     first N lines (default 10)",
            "tail [-n N] <file>     last N lines (default 10)",
            "du [path]              immediate-entry size rollup",
            "cd <path>              change directory",
            "pwd                    print working directory",
            "cat <file>             print a file",
            "write <file> <text>    write a file (journaled, versioned)",
            "mkdir <path>           create a directory",
            "mv <src> <dst>         journaled move (verify before publish)",
            "cp <src> <dst>         journaled copy",
            "rm <path>              move to trash (restore with `restore`)",
            "restore <path>         restore from trash",
            "find <query>           search the index",
            "grep <text> <file>     search inside a file",
            "stat <path>            size, digest, version",
            "df                     store usage",
            "sha256 <path>          stored digest",
            "jobs                   recent journal entries",
            "open <module> [path]   open a Fusion window",
            "ssh user@host[:port]   open the SSH window for that server (-p PORT works too)",
            "cast                   list Beam transports",
            "probe                  capability summary",
            "spec [filter]          query the feature register",
            "clear                  clear the screen",
          ].join("\n"));
          break;
        case "pwd": out(cwd); break;
        case "clear": setLines([]); break;
        case "cd": {
          const target = resolve(args[0] ?? "/");
          const r = await api<{ node: { kind: string } | null }>(`/api/fs?op=stat&path=${encodeURIComponent(target)}`);
          if (!r.node) { out(`cd: no such path: ${target}`, "err"); break; }
          if (r.node.kind !== "dir") { out(`cd: not a directory: ${target}`, "err"); break; }
          setCwd(target);
          break;
        }
        case "ls": {
          // TT54: Unix convention — dotfiles (photo edit sidecars) only with -a / -A
          const all = args.some((a) => /^-[a-zA-Z]*[aA]/.test(a)); const pos = args.filter((a) => !a.startsWith("-"));
          const target = resolve(pos[0] ?? "");
          const r0 = await api<{ nodes: { name: string; kind: string; size: number; version: number }[] }>(`/api/fs?op=list&path=${encodeURIComponent(target)}`);
          const r = { nodes: all ? r0.nodes : r0.nodes.filter((n) => !n.name.startsWith(".")) };
          if (r.nodes.length === 0) out("(empty)");
          else out(r.nodes.map((n) => `${n.kind === "dir" ? "d" : "-"} ${String(fmtBytes(n.size)).padStart(8)}  v${n.version}  ${n.name}`).join("\n"));
          break;
        }
        case "wc": {
          const paths = args.length ? args : [];
          if (!paths.length) { out("usage: wc <file> [file…]"); break; }
          const totals = { lines: 0, words: 0, bytes: 0, chars: 0 };
          for (const f of paths) {
            const r = await api<{ node: { content: string; encoding: string } }>(`/api/fs?op=read&path=${encodeURIComponent(resolve(f))}`);
            if (r.node.encoding === "base64") { out(`${f}: (binary — counts would mislead)`); continue; }
            const c = wc(r.node.content);
            totals.lines += c.lines; totals.words += c.words; totals.bytes += c.bytes; totals.chars += c.chars;
            out(formatWc(f, c));
          }
          if (paths.length > 1) out(formatWc("total", totals));
          break;
        }
        case "du": {
          const target = resolve(args[0] ?? ".");
          const r = await api<{ nodes: { name: string; kind: string; size: number }[] }>(`/api/fs?op=list&path=${encodeURIComponent(target)}`);
          const bytes = r.nodes.reduce((sum, n) => sum + (n.size ?? 0), 0);
          out(`${fmtBytes(bytes)}\t${target} (${r.nodes.length} immediate entries — sizes are stored entry sizes)`);
          break;
        }
        case "head":
        case "tail": {
          const { n, file } = parseCountArg(args.slice(0), "");
          const target = file || args[args.length - 1] || "";
          const r = await api<{ node: { content: string; encoding: string } }>(`/api/fs?op=read&path=${encodeURIComponent(resolve(target))}`);
          if (r.node.encoding === "base64") { out("(binary — use Peek)"); break; }
          out((cmd === "head" ? headLines(r.node.content, n) : tailLines(r.node.content, n)).join("\n"));
          break;
        }
        case "sort":
        case "uniq": {
          const flags = args.filter((a) => a.startsWith("-"));
          const fileArg = args.find((a) => !a.startsWith("-")) ?? "";
          if (!fileArg) { out(`usage: ${cmd} [-n] [-r] [-u] <file>`); break; }
          const r = await api<{ node: { content: string; encoding: string } }>(`/api/fs?op=read&path=${encodeURIComponent(resolve(fileArg))}`);
          if (r.node.encoding === "base64") { out("(binary — use Peek)"); break; }
          out(cmd === "sort"
            ? sortText(r.node.content, { numeric: flags.includes("-n"), desc: flags.includes("-r"), unique: flags.includes("-u") })
            : uniqText(r.node.content, flags.includes("-g")));
          break;
        }
        case "cat": {
          const r = await api<{ node: { content: string; encoding: string } }>(`/api/fs?op=read&path=${encodeURIComponent(resolve(args[0] ?? ""))}`);
          out(r.node.encoding === "base64" ? "(binary — use Peek)" : r.node.content);
          break;
        }
        case "write": {
          const path = resolve(args[0] ?? "");
          const content = rest.slice(args[0]?.length ?? 0).trim();
          const r = await post<{ sha256: string; size: number }>("/api/fs", { op: "write", path, content, reason: "terminal" });
          out(`wrote ${r.size} B · sha256 ${r.sha256.slice(0, 16)}…`);
          shell.bumpRefresh();
          break;
        }
        case "mkdir": {
          await post("/api/fs", { op: "mkdir", path: resolve(args[0] ?? "") });
          out("ok"); shell.bumpRefresh(); break;
        }
        case "mv": case "cp": {
          const r = await post<{ opId: number }>("/api/fs", { op: cmd === "mv" ? "move" : "copy", src: resolve(args[0]), dst: resolve(args[1]) });
          out(`journal op #${r.opId} COMPLETE (temp → verify → publish${cmd === "mv" ? " → retire source" : ""})`);
          shell.bumpRefresh(); break;
        }
        case "rm": {
          await post("/api/fs", { op: "trash", path: resolve(args[0]) });
          out("moved to trash (reversible: `restore`)"); shell.bumpRefresh(); break;
        }
        case "restore": {
          await post("/api/fs", { op: "restore", path: resolve(args[0]) });
          out("restored"); shell.bumpRefresh(); break;
        }
        case "find": {
          const r = await api<{ hits: { source: string; ref: string; title: string; how: string }[]; tookMs: number }>(`/api/search?q=${encodeURIComponent(rest)}`);
          out(r.hits.map((h) => `${h.source.padEnd(8)} ${h.how.padEnd(10)} ${h.ref}`).join("\n") || "(no hits)");
          out(`${r.hits.length} hits in ${r.tookMs} ms`, "info");
          break;
        }
        case "grep": {
          const needle = args[0] ?? "";
          const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(resolve(args[1] ?? ""))}`);
          const matches = r.node.content.split("\n").map((l, i) => ({ l, i })).filter((x) => x.l.includes(needle));
          out(matches.map((m) => `${m.i + 1}: ${m.l}`).join("\n") || "(no matches)");
          break;
        }
        case "stat": {
          const r = await api<{ node: { size: number; sha256: string; version: number; mime: string } | null; folder: { bytes: number; files: number } | null }>(`/api/fs?op=stat&path=${encodeURIComponent(resolve(args[0] ?? ""))}`);
          out(r.node ? JSON.stringify({ ...r.node, folder: r.folder }, null, 2) : "not found", r.node ? "out" : "err");
          break;
        }
        case "sha256": {
          const r = await api<{ node: { sha256: string } | null }>(`/api/fs?op=stat&path=${encodeURIComponent(resolve(args[0] ?? ""))}`);
          out(r.node?.sha256 ?? "not found");
          break;
        }
        case "df": {
          const r = await api<{ folder: { bytes: number; files: number } | null }>("/api/fs?op=stat&path=/");
          const est = await navigator.storage?.estimate?.().catch(() => null);
          out(`VFS: ${fmtBytes(r.folder?.bytes ?? 0)} in ${r.folder?.files ?? 0} files`);
          if (est) out(`browser origin quota: ${fmtBytes(est.usage ?? 0)} used of ${fmtBytes(est.quota ?? 0)}`);
          break;
        }
        case "jobs": {
          const r = await api<{ ops: { id: number; op: string; state: string; src: string; dst: string }[] }>("/api/jobs?limit=12");
          out(r.ops.map((o) => `#${o.id} ${o.op.padEnd(6)} ${o.state.padEnd(16)} ${o.src}${o.dst ? ` → ${o.dst}` : ""}`).join("\n"));
          break;
        }
        case "ssh": {
          // TT44 (TD-03): opens the SSH window prefilled; authentication and host-key questions happen there
          const t = parseTarget(args);
          if (typeof t === "string") { out(t, "err"); break; }
          shell.open("ssh", { ...t, title: `${t.username}@${t.host}` });
          out(`opened SSH for ${t.username}@${t.host}:${t.port}`);
          break;
        }
        case "open": {
          const mod = args[0];
          if (!MODULES.some((m) => m.id === mod)) { out(`unknown module. try: ${MODULES.map((m) => m.id).join(", ")}`, "err"); break; }
          shell.open(mod, args[1] ? { path: resolve(args[1]), title: args[1] } : undefined);
          out(`opened ${mod}`);
          break;
        }
        case "cast": {
          const caps = shell.caps?.capabilities.filter((c) => c.group === "Beam") ?? [];
          out(caps.map((c) => `${c.available ? "✔" : "✘"} ${c.label.padEnd(34)} ${c.available ? c.detail : `blocked — ${c.degrade}`}`).join("\n"));
          break;
        }
        case "probe": {
          const caps = shell.caps?.capabilities ?? [];
          const ok = caps.filter((c) => c.available).length;
          out(`${ok}/${caps.length} capabilities available on this browser.`);
          out(caps.filter((c) => !c.available).map((c) => `✘ ${c.label} — ${c.degrade}`).join("\n") || "(everything available)");
          break;
        }
        case "spec": {
          const r = await api<{ rows: { code: string; name: string; tier: string; status: string }[] }>("/api/features");
          const f = rest.toLowerCase();
          const rows = r.rows.filter((x) => !f || x.code.toLowerCase().includes(f) || x.name.toLowerCase().includes(f) || x.status === f);
          out(rows.slice(0, 60).map((x) => `${x.code.padEnd(8)} ${x.tier.padEnd(4)} ${x.status.padEnd(9)} ${x.name}`).join("\n"));
          out(`${rows.length} rows`, "info");
          break;
        }
        case "echo": out(rest); break;
        default: { const s = suggest(cmd, COMMAND_NAMES); out(`unknown command: ${cmd}${s.length ? ` — did you mean ${s.map((x) => `\`${x}\``).join(", ")}?` : " (try `help`)"}`, "err"); }
      }
    } catch (e) {
      out(String((e as Error).message), "err");
    }
  }, [cwd, resolve, shell]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#05080f", color: "#e6edf7", colorScheme: "dark" }} /* TT22: the terminal is always a dark surface, so its ink is fixed too (light theme drew dark text on black) */
      onClick={() => inputRef.current?.focus()}>
      <div className="fs-scroll fs-mono" style={{ flex: 1, minHeight: 0, padding: 10, fontSize: fz(12), lineHeight: 1.45 }}>
        {lines.map((l, i) => (
          <pre key={i} style={{
            margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
            color: l.tone === "err" ? "#ff9b9b" : l.tone === "cmd" ? "#8fb7ff" : l.tone === "info" ? "#8df0c0" : "inherit",
          }}>{l.text}</pre>
        ))}
        <div ref={endRef} />
      </div>
      <div className="fs-row fs-mono" style={{ padding: 8, gap: 6, borderTop: "1px solid var(--fs-border)" }}>
        <span style={{ color: "#8fb7ff", fontSize: fz(12) }}>{cwd} $</span>
        <input ref={inputRef} className="fs-input fs-mono" value={input} spellCheck={false} aria-label="Terminal input"
          style={{ border: 0, background: "transparent", color: "inherit", flex: 1 }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { const v = input; setInput(""); setHist((h) => [v, ...h].slice(0, 100)); setHistIdx(-1); void exec(v); }
            if (e.key === "ArrowUp") { e.preventDefault(); const i = Math.min(histIdx + 1, hist.length - 1); setHistIdx(i); setInput(hist[i] ?? ""); }
            if (e.key === "ArrowDown") { e.preventDefault(); const i = Math.max(histIdx - 1, -1); setHistIdx(i); setInput(i < 0 ? "" : hist[i]); }
          }} />
      </div>
    </div>
  );
}
