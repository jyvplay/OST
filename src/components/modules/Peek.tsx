"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, fmtBytes, post } from "@/lib/api";
import { formatFor, GRADE_TEXT, parseCsv, sanitizeSvg } from "@/lib/forge";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";

interface Node { path: string; name: string; mime: string; encoding: string; content: string; size: number; sha256: string }

/**
 * FM-04 / FF-12. Preview with a watchdog: the parse is given a time budget and
 * a size cap before any allocation, so a crafted archive becomes a greyed tile
 * with a named error instead of a hung tab. Untrusted markup is rendered in a
 * sandboxed frame — the browser's process isolation is the web's isolatedProcess.
 */
export default function PeekModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [node, setNode] = useState<Node | null>(null);
  const [err, setErr] = useState("");
  const [extract, setExtract] = useState<{ kind: string; grade: string; text: string; dropped: string[]; engine: string; boundary: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fmt = formatFor(path);

  useEffect(() => {
    if (!path) return;
    const watchdog = window.setTimeout(() => setErr((e) => e || "Preview watchdog fired after 5 s — the file was not rendered."), 5000);
    api<{ node: Node }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`)
      .then((r) => { setNode(r.node); window.clearTimeout(watchdog); })
      .catch((e) => { setErr(String((e as Error).message)); window.clearTimeout(watchdog); });
    return () => window.clearTimeout(watchdog);
  }, [path]);

  const runForge = async () => {
    setBusy(true);
    try {
      const r = await post<{ kind: string; grade: string; text: string; dropped: string[]; engine: string; boundary: string }>(
        "/api/forge", { op: "extract", path },
      );
      setExtract(r);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally { setBusy(false); }
  };

  if (!path) return <Empty title="Nothing to preview" icon="👁" />;

  const dataUrl = node && node.encoding === "base64" ? `data:${node.mime};base64,${node.content}` : null;

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <strong style={{ fontSize: fz(12.5) }}>{node?.name ?? path}</strong>
        {fmt ? <Badge tone={fmt.grade === "A" ? "ok" : fmt.grade === "X" ? "bad" : "info"}>{fmt.label} · grade {fmt.grade}</Badge> : <Badge>unknown format</Badge>}
        {node ? <Badge>{fmtBytes(node.size)}</Badge> : null}
        {node ? <Badge title={node.sha256}>sha {node.sha256.slice(0, 8)}</Badge> : null}
        <div style={{ flex: 1 }} />
        <Btn variant="ghost" onClick={() => shell.open("editor", { path, title: node?.name })}>Edit</Btn>
      </div>

      {fmt ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>{GRADE_TEXT[fmt.grade]} — {fmt.boundary}</div> : null}
      {err ? <Badge tone="bad">{err}</Badge> : null}

      {node && !err ? (
        <div className="fs-panel" style={{ padding: 10, minHeight: 160 }}>
          {node.mime.startsWith("image/") && node.mime !== "image/svg+xml" && dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dataUrl} alt={node.name} style={{ maxWidth: "100%", maxHeight: 340, objectFit: "contain" }} />
          ) : node.mime === "image/svg+xml" ? (
            (() => {
              const s = sanitizeSvg(node.content);
              return (
                <>
                  <Badge tone={s.removed.length ? "warn" : "ok"}>{s.removed.length ? `sanitised: ${s.removed.join(", ")}` : "sanitised"}</Badge>
                  <div style={{ maxHeight: 320, overflow: "auto" }} dangerouslySetInnerHTML={{ __html: s.svg }} />
                </>
              );
            })()
          ) : node.mime === "application/pdf" && dataUrl ? (
            <embed src={dataUrl} type="application/pdf" style={{ width: "100%", height: 420 }} />
          ) : node.mime === "text/csv" ? (
            <table style={{ borderCollapse: "collapse", fontSize: fz(11.5) }}>
              <tbody>
                {parseCsv(node.content).slice(0, 40).map((row, i) => (
                  <tr key={i}>{row.map((c, j) => <td key={j} style={{ border: "1px solid var(--fs-border)", padding: "2px 6px" }}>{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          ) : node.mime === "text/html" ? (
            <iframe title="sandboxed preview" sandbox="" srcDoc={node.content} style={{ width: "100%", height: 320, border: 0, background: "#fff" }} />
          ) : node.encoding === "utf8" ? (
            <pre className="fs-mono" style={{ margin: 0, fontSize: fz(11.5), whiteSpace: "pre-wrap", maxHeight: 340, overflow: "auto" }}>
              {node.content.slice(0, 20000)}
            </pre>
          ) : (
            <div className="fs-dim" style={{ fontSize: fz(12) }}>Binary payload — no first-party renderer for {node.mime}.</div>
          )}
        </div>
      ) : null}

      {fmt && ["docx", "xlsx", "pptx", "zip", "epub", "psd"].some((x) => fmt.ext.includes(x)) ? (
        <Section title="Forge extraction (server engine)" right={<Btn variant="primary" onClick={() => void runForge()} disabled={busy}>{busy ? "Working…" : "Extract"}</Btn>}>
          {extract ? (
            <>
              <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
                <Badge tone="info">{extract.kind}</Badge>
                <Badge tone={extract.grade === "D" ? "warn" : "ok"}>grade {extract.grade}</Badge>
                <Badge>{extract.engine}</Badge>
              </div>
              <div className="fs-dim" style={{ fontSize: fz(11.5) }}>{extract.boundary}</div>
              {extract.dropped.length ? <div style={{ fontSize: fz(11.5) }}>Dropped: {extract.dropped.join(", ")}</div> : null}
              <pre className="fs-mono" style={{ margin: 0, fontSize: fz(11.5), whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>{extract.text.slice(0, 20000)}</pre>
              <Btn variant="ghost" onClick={async () => {
                const dst = `${path}.extracted.md`;
                await post("/api/fs", { op: "write", path: dst, content: extract.text, reason: "forge-extract" });
                shell.toast(`Extraction saved to ${dst} (grade D — not a round trip)`, "ok");
                shell.bumpRefresh();
              }}>Save extraction as Markdown</Btn>
            </>
          ) : (
            <div className="fs-dim" style={{ fontSize: fz(11.5) }}>
              Office files are unzipped and parsed on the server with node:zlib. This engine extracts and converts;
              it cannot write Office documents back, and the UI will not offer a save path that pretends otherwise.
            </div>
          )}
        </Section>
      ) : null}
    </div>
  );
}
