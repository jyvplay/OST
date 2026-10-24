/**
 * TT69 FF-15 browser glue for recovery drafts: every byte goes through /api/fs, so the privacy layer routes it
 * (/Private → encrypted names + content, amnesic session → this tab's RAM). Drafts deliberately use api(), not
 * post(): post() parks failed writes in the localStorage offline queue, and a draft every few seconds of a whole
 * document would pile up there as plaintext. An offline draft simply fails and says so.
 */
import { api } from "./api";
import {
  DraftWriter, UNTITLED_RE, decodeDraft, draftPathFor, liveDraftKeys, recoveryRoot,
  type DocKind, type DraftIo, type DraftRecord,
} from "./doc-lifecycle";

const POST = (body: unknown) => api("/api/fs", { method: "POST", body: JSON.stringify(body) });

export const fsDraftIo: DraftIo = {
  async write(path, content) { await POST({ op: "write", path, content, reason: "recovery-draft" }); },
  async remove(path) {
    try { await POST({ op: "trash", path }); } catch { return; }
    await POST({ op: "purge", path }).catch(() => undefined);
  },
};

export function newDraftWriter(): DraftWriter { return new DraftWriter(fsDraftIo); }

export function untitledId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 16);
  const a = new Uint8Array(8); c?.getRandomValues?.(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("") || String(Date.now());
}

export async function readDraftAt(path: string, kind: DocKind): Promise<DraftRecord | null> {
  try {
    const r = await api<{ node: { content: string; encoding?: string } | null }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
    if (!r.node || r.node.encoding === "base64") return null;
    return decodeDraft(r.node.content, kind);
  } catch { return null; }
}

export function readDraft(kind: DocKind, docPath: string): Promise<DraftRecord | null> {
  return readDraftAt(draftPathFor(kind, docPath), kind);
}

export async function fileSha(path: string): Promise<string | null> {
  try {
    const r = await api<{ node: { sha256?: string } | null }>(`/api/fs?op=stat&path=${encodeURIComponent(path)}`);
    return r.node?.sha256 ?? null;
  } catch { return null; }
}

/** untitled drafts of `kind` left by earlier sessions (not by a window open in this tab), newest first */
export async function untitledDrafts(kind: DocKind): Promise<{ path: string; id: string; draft: DraftRecord }[]> {
  const root = recoveryRoot("");
  let names: string[] = [];
  try {
    const r = await api<{ nodes: { name: string; kind: string }[] }>(`/api/fs?path=${encodeURIComponent(root)}`);
    names = (r.nodes ?? []).filter((n) => n.kind === "file").map((n) => n.name);
  } catch { return []; }
  const live = liveDraftKeys();
  const out: { path: string; id: string; draft: DraftRecord }[] = [];
  for (const name of names) {
    const m = UNTITLED_RE.exec(name);
    if (!m || m[1] !== kind || live.has(m[2])) continue;
    const draft = await readDraftAt(`${root}/${name}`, kind);
    if (draft && draft.path === "") out.push({ path: `${root}/${name}`, id: m[2], draft });
  }
  return out.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
}
