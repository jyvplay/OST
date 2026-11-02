"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { privateSearchScope } from "@/lib/search-query";
import { privacy } from "@/lib/privacy/session";
import WorkflowDialog from "../../WorkflowDialog";
interface Preview { title: string; source: string; ref: string; body: string; size: number | string; mime: string; updated_at: string; textual: boolean; truncated: boolean; notice: string; revision?: number }
export default function ResultPreview({ hit, onClose }: { hit: { source: string; ref: string; title: string }; onClose: () => void }) {
  const [data, setData] = useState<Preview | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        if (privacy.status().amnesic || privateSearchScope(hit.ref)) throw new Error("Preview supports persisted public results only. Open RAM or Private content in its app.");
        const result = await api<Preview>(`/api/search/preview?${new URLSearchParams({ source: hit.source, ref: hit.ref })}`, { signal: controller.signal });
        if (!controller.signal.aborted) setData(result);
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    })();
    return () => controller.abort();
  }, [hit]);
  return <WorkflowDialog title={`Preview: ${hit.title}`} onClose={onClose}>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">Reading current public snapshot…</p> : <>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: 6, margin: 0 }}>
        <dt>Reference</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{data.ref}</dd><dt>Type</dt><dd style={{ margin: 0 }}>{data.mime}</dd>
        <dt>Content bytes</dt><dd style={{ margin: 0 }}>{data.size}</dd><dt>Modified</dt><dd style={{ margin: 0 }}>{data.updated_at}</dd>
        {data.revision ? <><dt>Saved revision</dt><dd style={{ margin: 0 }}>{data.revision}</dd></> : null}
      </dl>
      <p>{data.notice}{data.truncated && data.textual ? " Content is truncated; open the app for the rest." : ""}</p>
      {data.textual ? <pre data-testid="find-preview-body" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "45vh", overflow: "auto" }}>{data.body}</pre> : null}
    </>}
  </WorkflowDialog>;
}
