"use client";
import { Fragment, createElement } from "react";
import { noteInline, NOTE_PREVIEW_LINES, type NoteMarkdownDoc } from "@/lib/note-markdown";
import { fz } from "@/lib/uiscale";

function Inline({ text }: { text: string }) {
  return <>{noteInline(text).map((part, i) => {
    if (part.kind === "link") return part.href ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.text}</a> : <span key={i}>{part.text}</span>;
    if (part.kind === "text") return <Fragment key={i}>{part.text}</Fragment>;
    const tag = part.kind === "strike" ? "del" : part.kind;
    return createElement(tag, { key: i }, part.text);
  })}</>;
}
export default function MarkdownView({ parsed, disabled, onTask }: { parsed: NoteMarkdownDoc; disabled: boolean; onTask: (line: number) => void }) {
  return <article className="fs-scroll" aria-label="Markdown preview" data-testid="note-preview" style={{ flex: 1, minHeight: 0, overflowWrap: "anywhere", padding: 14, fontSize: fz(13) }}>
    {parsed.truncated ? <p role="status">Preview: first {NOTE_PREVIEW_LINES} lines. Editing and export keep the full note.</p> : null}
    {parsed.blocks.map(block => {
      const content = <Inline text={block.text} />;
      const props = { "data-note-line": block.line };
      if (block.kind === "heading") return createElement(`h${block.level}`, { ...props, key: block.line }, content);
      if (block.kind === "code") return <pre key={block.line} {...props} style={{ whiteSpace: "pre-wrap", background: "var(--fs-surface)", padding: 10 }}><code>{block.text}</code></pre>;
      if (block.kind === "task") return <label key={block.line} {...props} style={{ display: "flex", gap: 8, margin: "6px 0" }}><input type="checkbox" aria-label={`Complete task: ${block.text}`} checked={block.checked} disabled={disabled} onChange={() => onTask(block.line)} /><span>{content}</span></label>;
      if (block.kind === "table") return <div key={block.line} {...props} style={{ overflowX: "auto" }}><table aria-label="Markdown table" style={{ borderCollapse: "collapse", minWidth: "100%" }}><thead><tr>{block.header.map((cell, i) => <th key={i} scope="col" style={{ textAlign: block.align[i], border: "1px solid var(--fs-border)", padding: 5 }}><Inline text={cell} /></th>)}</tr></thead><tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} style={{ textAlign: block.align[c], border: "1px solid var(--fs-border)", padding: 5 }}><Inline text={cell} /></td>)}</tr>)}</tbody></table></div>;
      if (block.kind === "rule") return <hr key={block.line} {...props} />;
      if (block.kind === "quote") return <blockquote key={block.line} {...props}>{content}</blockquote>;
      if (block.kind === "item") return <div key={block.line} {...props} style={{ paddingLeft: 12 }}>• {content}</div>;
      return <p key={block.line} {...props} style={{ whiteSpace: "pre-wrap", margin: "6px 0", minHeight: block.text ? undefined : "0.5em" }}>{content}</p>;
    })}
  </article>;
}
