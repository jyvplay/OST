"use client";

import { useEffect, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";

type Style = "Normal" | "Title" | "Subtitle" | "Heading1" | "Heading2" | "Heading3" | "Quote" | "Code" | "ListBullet";
interface Run { text: string; bold?: boolean; italic?: boolean; underline?: boolean }
interface Paragraph { kind: "paragraph"; style: Style; runs: Run[] }
interface TableBlock { kind: "table"; rows: string[][] }
type Block = Paragraph | TableBlock;
interface DocModel { title: string; blocks: Block[] }
const blank = (): DocModel => ({ title: "Untitled document", blocks: [{ kind: "paragraph", style: "Normal", runs: [{ text: "" }] }] });
const textOf = (b: Paragraph) => b.runs.map((r) => r.text).join("");

/**
 * Writer — a testable Word-processing subset, not a misleading office viewer.
 * Native `.fdoc` preserves the structured model exactly; `.docx` import/export
 * handles paragraphs/headings/simple tables/bold/italic/underline. There is no
 * pagination engine, so the UI says grade C and enumerates losses before export.
 */
export default function WriterModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [doc, setDoc] = useState<DocModel>(blank);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      let next = blank();
      if (path.toLowerCase().endsWith(".docx")) {
        try {
          const r = await post<{ document: DocModel; losses: string[] }>("/api/office", { op: "importDocx", path });
          next = r.document;
          if (r.losses.length) setStatus(`Imported grade C; not retained: ${r.losses.join(", ")}`);
        } catch (e) { shell.toast(`DOCX import failed: ${String((e as Error).message)}`, "bad"); }
      } else if (path) {
        try {
          const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
          const parsed = JSON.parse(r.node.content) as DocModel;
          if (parsed.title && Array.isArray(parsed.blocks)) next = parsed;
        } catch { /* new file */ }
      } else {
        next = { title: "Fusion Writer", blocks: [
          { kind: "paragraph", style: "Title", runs: [{ text: "A working document" }] },
          { kind: "paragraph", style: "Subtitle", runs: [{ text: "A first-party Word-processing subset" }] },
          { kind: "paragraph", style: "Heading1", runs: [{ text: "Start writing" }] },
          { kind: "paragraph", style: "Normal", runs: [{ text: "This document is structured as paragraphs and runs. Select a block style below; the DOCX export is a new package, not a promise of lossless round-trip." }] },
          { kind: "paragraph", style: "ListBullet", runs: [{ text: "Edit text and structure" }] },
          { kind: "paragraph", style: "ListBullet", runs: [{ text: "Save a native .fdoc or export .docx" }] },
          { kind: "table", rows: [["Feature", "Scope"], ["Paragraphs", "Supported"], ["Pagination", "Not implemented"]] },
        ] };
      }
      if (live) { setDoc(next); setLoaded(true); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const update = (next: DocModel) => { setDoc(next); setDirty(true); };
  const updateParagraph = (i: number, patch: Partial<Paragraph>) => {
    const blocks = [...doc.blocks]; const b = blocks[i];
    if (b?.kind !== "paragraph") return;
    blocks[i] = { ...b, ...patch };
    update({ ...doc, blocks });
  };

  const saveNative = async () => {
    const dest = path && path.endsWith(".fdoc") ? path : `/Documents/${(doc.title || "document").replace(/[^a-z0-9-_ ]/gi, "").trim() || "document"}.fdoc`;
    await post("/api/fs", { op: "write", path: dest, content: JSON.stringify(doc), reason: "writer-save" });
    setDirty(false); setStatus(`saved ${dest}`); shell.bumpRefresh();
    if (!path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest, title: doc.title } });
  };

  const exportDocx = async () => {
    const r = await post<{ base64: string; bytes: number }>("/api/office", { op: "exportDocx", document: doc });
    const dest = `/Documents/${(doc.title || "document").replace(/[^a-z0-9-_ ]/gi, "").trim() || "document"}.docx`;
    await post("/api/fs", { op: "upload", path: dest, content: r.base64, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    setStatus(`exported ${r.bytes} B → ${dest} (grade C: only supported subset retained)`); shell.bumpRefresh();
  };

  const importFile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const b64 = toB64(bytes);
    const r = await post<{ document: DocModel; losses: string[] }>("/api/office", { op: "importDocx", base64: b64 });
    setDoc(r.document); setDirty(true); setStatus(`imported grade C; not retained: ${r.losses.join(", ")}`);
    shell.toast(`Imported ${file.name}: ${r.document.blocks.length} blocks, grade C. Losses are listed above.`, "warn");
  };

  if (!loaded) return <div style={{ padding: 16 }}>Opening document…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div className="fs-row" style={{ padding: 6, gap: 5, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <input className="fs-input" style={{ width: 210 }} aria-label="Document title" value={doc.title} onChange={(e) => update({ ...doc, title: e.target.value })} />
        <Btn variant="primary" onClick={() => void saveNative()}>Save .fdoc</Btn>
        <Btn variant="ghost" onClick={() => void exportDocx()}>Export .docx</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import .docx<input type="file" accept=".docx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f).catch((x) => shell.toast(String((x as Error).message), "bad")); }} /></label>
        <Badge tone="warn">DOCX subset · grade C</Badge>
        {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
      </div>
      {status ? <div className="fs-dim" style={{ padding: "4px 8px", fontSize: 11 }}>{status}</div> : null}
      <div className="fs-row" style={{ padding: 6, gap: 5, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <span className="fs-dim" style={{ fontSize: 11 }}>Block style</span>
        <select className="fs-select" style={{ width: 150 }} value={doc.blocks[selected]?.kind === "paragraph" ? doc.blocks[selected].style : "Normal"}
          onChange={(e) => updateParagraph(selected, { style: e.target.value as Style })}>
          {["Normal", "Title", "Subtitle", "Heading1", "Heading2", "Heading3", "Quote", "Code", "ListBullet"].map((x) => <option key={x}>{x}</option>)}
        </select>
        <Btn variant="ghost" onClick={() => updateParagraph(selected, { runs: [{ text: textOf(doc.blocks[selected] as Paragraph), bold: true }] })}>Bold</Btn>
        <Btn variant="ghost" onClick={() => updateParagraph(selected, { runs: [{ text: textOf(doc.blocks[selected] as Paragraph), italic: true }] })}>Italic</Btn>
        <Btn variant="ghost" onClick={() => { const blocks = [...doc.blocks]; blocks.splice(selected + 1, 0, { kind: "paragraph", style: "Normal", runs: [{ text: "" }] }); update({ ...doc, blocks }); setSelected(selected + 1); }}>+ Paragraph</Btn>
        <Btn variant="ghost" onClick={() => { const blocks = [...doc.blocks]; blocks.splice(selected + 1, 0, { kind: "table", rows: [["Cell 1", "Cell 2"], ["", ""]] }); update({ ...doc, blocks }); setSelected(selected + 1); }}>+ Table</Btn>
      </div>
      <div className="fs-scroll" style={{ flex: 1, minHeight: 0, padding: "20px max(20px, 8%)", display: "grid", gap: 6, alignContent: "start" }}>
        {doc.blocks.map((b, i) => (
          <div key={i} onClick={() => setSelected(i)} style={{ border: selected === i ? "1px solid rgba(91,140,255,.35)" : "1px solid transparent", borderRadius: 6, padding: 3 }}>
            {b.kind === "paragraph" ? (
              <textarea aria-label={`Document paragraph ${i + 1}`} value={textOf(b)} onChange={(e) => updateParagraph(i, { runs: [{ ...b.runs[0], text: e.target.value }] })}
                style={{ width: "100%", minHeight: b.style.startsWith("Heading") || b.style === "Title" ? 42 : 62, resize: "vertical", border: 0, outline: 0, color: "var(--fs-text)", background: "transparent", fontFamily: b.style === "Code" ? "monospace" : "inherit", fontSize: b.style === "Title" ? 28 : b.style.startsWith("Heading") ? 20 : 14, fontWeight: b.style === "Title" || b.style.startsWith("Heading") || b.runs.some((r) => r.bold) ? 700 : 400, fontStyle: b.style === "Quote" || b.runs.some((r) => r.italic) ? "italic" : "normal" }} />
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%" }}><tbody>{b.rows.map((row, ri) => <tr key={ri}>{row.map((v, ci) => <td key={ci} style={{ border: "1px solid var(--fs-border)", padding: 4 }}><input className="fs-input" aria-label={`Table ${i + 1} row ${ri + 1} cell ${ci + 1}`} value={v} onChange={(e) => { const blocks = [...doc.blocks]; const tbl = blocks[i] as TableBlock; const rows = tbl.rows.map((r) => [...r]); rows[ri][ci] = e.target.value; blocks[i] = { ...tbl, rows }; update({ ...doc, blocks }); }} /></td>)}</tr>)}</tbody></table>
            )}
          </div>
        ))}
        {doc.blocks.length === 0 ? <Empty title="Empty document" /> : null}
      </div>
      <div className="fs-dim" style={{ padding: "4px 8px", borderTop: "1px solid var(--fs-border)", fontSize: 10.5 }}>
        Subset: paragraphs, heading styles, bold/italic/underline, simple tables. Export creates a new DOCX package.
        Pagination, images, headers/footers, tracked changes, comments and macros are not preserved.
      </div>
    </div>
  );
}

function toB64(bytes: Uint8Array): string { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
