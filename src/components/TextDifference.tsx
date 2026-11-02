"use client";
import { useMemo } from "react";
import { textDifference } from "@/lib/text-difference";
export default function TextDifference({ original, edited }: { original: string; edited: string }) {
  const diff = useMemo(() => textDifference(original, edited), [original, edited]);
  if (diff.equal) return <p role="status">No differences</p>;
  return <div data-testid="text-difference">
    <p role="status">{diff.removed.length} removed · {diff.added.length} added lines. One changed region; not a minimal diff.</p>
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "55vh", overflow: "auto" }}>
      {diff.before.slice(-3).map((line, i) => <span key={`b${i}`} style={{ display: "block" }}>  {line}</span>)}
      {diff.removed.slice(0, 200).map((line, i) => <span key={`r${i}`} style={{ display: "block", borderLeft: "3px solid #d85a65", paddingLeft: 6 }}>− {line}</span>)}
      {diff.removed.length > 200 ? <span>… {diff.removed.length - 200} more removed lines (not rendered){"\n"}</span> : null}
      {diff.added.slice(0, 200).map((line, i) => <span key={`a${i}`} style={{ display: "block", borderLeft: "3px solid #339975", paddingLeft: 6 }}>+ {line}</span>)}
      {diff.added.length > 200 ? <span>… {diff.added.length - 200} more added lines (not rendered){"\n"}</span> : null}
      {diff.after.slice(0, 3).map((line, i) => <span key={`z${i}`} style={{ display: "block" }}>  {line}</span>)}
    </pre>
  </div>;
}
