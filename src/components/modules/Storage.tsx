"use client";

import { useEffect, useState } from "react";
import { api, fmtBytes, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, KV, Section } from "../ui";

interface Data {
  categories: { category: string; files: number; bytes: number }[];
  large: { path: string; size: number; mime: string }[];
  duplicates: { sha256: string; copies: number; size: number; reclaimable: number; paths: string[] }[];
  trash: { files: number; bytes: number };
  versions: { versions: number; bytes: number };
}

/** FM-07: logical VFS usage AND the browser's real origin quota, side by side. */
export default function StorageModule(_: ModuleProps) {
  const shell = useShell();
  const [d, setD] = useState<Data | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  const load = () => api<Data>("/api/storage").then(setD).catch(() => undefined);
  useEffect(() => {
    void load();
    navigator.storage?.estimate?.().then((e) => setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 })).catch(() => undefined);
    navigator.storage?.persisted?.().then(setPersisted).catch(() => undefined);
  }, [shell.refreshTick]);

  const total = d?.categories.reduce((a, c) => a + Number(c.bytes), 0) ?? 0;

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Where the bytes are" right={<Btn variant="ghost" onClick={() => void load()}>↻</Btn>}>
        <KV k="VFS files (server, Postgres)" v={fmtBytes(total)} />
        <KV k="Trash" v={`${d?.trash.files ?? 0} files · ${fmtBytes(Number(d?.trash.bytes ?? 0))}`} />
        <KV k="Version history" v={`${d?.versions.versions ?? 0} snapshots · ${fmtBytes(Number(d?.versions.bytes ?? 0))}`} />
        <KV k="Browser origin storage" v={quota ? `${fmtBytes(quota.usage)} of ${fmtBytes(quota.quota)}` : "unavailable"} />
        <KV k="Eviction protection" v={persisted === null ? "unknown" : persisted ? <Badge tone="ok">persisted</Badge> : (
          <Btn variant="ghost" onClick={async () => setPersisted(await navigator.storage.persist())}>not persisted — request</Btn>
        )} />
        <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "rgba(255,255,255,.06)" }}>
          {d?.categories.map((c, i) => (
            <div key={c.category} title={`${c.category} ${fmtBytes(Number(c.bytes))}`}
              style={{ width: `${(Number(c.bytes) / Math.max(total, 1)) * 100}%`, background: ["#5b8cff", "#b14bff", "#39d98a", "#ffc453", "#ff6b6b", "#3cc", "#999"][i % 7] }} />
          ))}
        </div>
        <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
          {d?.categories.map((c) => <Badge key={c.category}>{c.category}: {c.files} · {fmtBytes(Number(c.bytes))}</Badge>)}
        </div>
      </Section>

      <Section title="Duplicates (by content digest)">
        {d?.duplicates.length ? d.duplicates.map((g) => (
          <div key={g.sha256} className="fs-panel" style={{ padding: 8, display: "grid", gap: 3 }}>
            <div className="fs-row" style={{ justifyContent: "space-between" }}>
              <span className="fs-mono" style={{ fontSize: 11 }}>{g.sha256.slice(0, 12)} · {g.copies} copies</span>
              <Badge tone="warn">reclaim {fmtBytes(Number(g.reclaimable))}</Badge>
            </div>
            {g.paths.map((p, i) => (
              <div key={p} className="fs-row" style={{ justifyContent: "space-between" }}>
                <span className="fs-mono" style={{ fontSize: 11 }}>{p}</span>
                {i > 0 ? <Btn variant="ghost" onClick={async () => { await post("/api/fs", { op: "trash", path: p }); shell.bumpRefresh(); }}>Trash</Btn> : <Badge tone="ok">keep</Badge>}
              </div>
            ))}
          </div>
        )) : <div className="fs-dim" style={{ fontSize: 11.5 }}>No duplicate content.</div>}
      </Section>

      <Section title="Largest files">
        {d?.large.map((f) => (
          <div key={f.path} className="fs-row" style={{ justifyContent: "space-between" }}>
            <button className="fs-mono" style={{ fontSize: 11, background: "none", border: 0, color: "inherit", cursor: "pointer", textAlign: "left" }}
              onClick={() => shell.open("peek", { path: f.path, title: f.path })}>{f.path}</button>
            <span className="fs-dim" style={{ fontSize: 11 }}>{fmtBytes(Number(f.size))}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}
