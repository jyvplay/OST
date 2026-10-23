"use client";
/**
 * TT69 FF-15: the React side of the document lifecycle, shared by Writer, Spreadsheet and Editor.
 *  useDocLifecycle — registers the window's document with the shell (close / Quit / Close all / beforeunload ask
 *    first), drafts exactly what the app would save (debounced, newest wins), and clears drafts after a save.
 *  useRecoveryOffer + RecoveryBanner — when a document opens and a draft of it exists, offer Restore / Discard
 *    (flagged when the file changed since the draft was taken). Discard deletes the draft; nothing is silent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import {
  draftOffer, draftPathFor, encodeDraft, registerDocGuard, type DocKind, type DraftRecord,
} from "@/lib/doc-lifecycle";
import { fileSha, fsDraftIo, newDraftWriter, readDraft, untitledDrafts, untitledId } from "@/lib/doc-drafts";

export interface DraftPayload { encoding: "base64" | "utf8"; payload: string }

export interface LifecycleOpts {
  winId: string;
  kind: DocKind;
  path: string;
  title: string;
  dirty: boolean;
  /** changes whenever the document content changes (a revision counter) */
  version: unknown;
  /** false: no draft is written (password-protected documents — a draft would be plaintext) */
  recoverable: boolean;
  save: () => Promise<boolean>;
  makeDraft: () => Promise<DraftPayload | null>;
}

export function useDocLifecycle(o: LifecycleOpts) {
  const writer = useRef<ReturnType<typeof newDraftWriter> | null>(null);
  const untitled = useRef("");
  // created on first use (never during render)
  const W = useCallback(() => (writer.current ??= newDraftWriter()), []);
  const U = useCallback(() => (untitled.current ||= untitledId()), []);
  const cur = useRef(o);
  useEffect(() => { cur.current = o; });
  const baseSha = useRef<string | null>(null);
  // set by saved(): the module's dirty state reaches this hook only on its next render, but the shell asks dirty()
  // right after save() resolves — without this a successful Save would look unsaved and cancel the close
  // it is bound to the version saved: any later edit bumps the version and ends it (never hides real changes)
  const justSaved = useRef<{ version: unknown } | null>(null);
  useEffect(() => { if (!o.dirty) justSaved.current = null; }, [o.dirty]);
  const draftNote = o.dirty && !o.recoverable ? "no recovery draft (password-protected)" : "";

  const draftPath = useCallback(() => draftPathFor(cur.current.kind, cur.current.path, U()), [U]);
  const schedule = useCallback(() => {
    W().schedule(async () => {
      const c = cur.current;
      if (!c.recoverable || !c.dirty) return null;
      const d = await c.makeDraft(); if (!d) return null;
      const rec: DraftRecord = { v: 1, kind: c.kind, path: c.path, title: c.title, savedAt: Date.now(), baseSha: c.path ? baseSha.current : null, ...d };
      return { path: draftPathFor(c.kind, c.path, U()), text: encodeDraft(rec) };
    });
  }, [U, W]);

  useEffect(() => registerDocGuard({
    winId: o.winId, kind: o.kind,
    title: () => cur.current.title || "Untitled",
    dirty: () => cur.current.dirty && !(justSaved.current !== null && Object.is(justSaved.current.version, cur.current.version)),
    save: () => cur.current.save(),
    flushDraft: async () => { if (cur.current.dirty && cur.current.recoverable) { schedule(); await W().flush(); } },
    recoverable: () => cur.current.recoverable,
    draftKey: () => (cur.current.path ? "" : U()),
  }), [o.winId, o.kind, schedule, U, W]);

  useEffect(() => { if (o.dirty && o.recoverable) schedule(); }, [o.version, o.dirty, o.recoverable, schedule]);
  useEffect(() => {
    let live = true;
    if (o.path) void fileSha(o.path).then((s) => { if (live) baseSha.current = s; });
    else baseSha.current = null;
    return () => { live = false; };
  }, [o.path]);
  useEffect(() => () => writer.current?.dispose(), []);

  /** call after a successful save to `savedPath`: drafts of the old path / the untitled draft / the new path go */
  const saved = useCallback(async (savedPath: string) => {
    justSaved.current = { version: cur.current.version };
    const k = cur.current.kind;
    const paths = new Set([draftPathFor(k, "", U()), draftPathFor(k, savedPath)]);
    if (cur.current.path) paths.add(draftPathFor(k, cur.current.path));
    await W().clear(...paths);
    baseSha.current = await fileSha(savedPath);
  }, [U, W]);

  /** a NEW untitled document in the same window gets a fresh draft id (the discarded one's draft must survive) */
  const rotateUntitled = useCallback(() => { writer.current?.dispose(); writer.current = newDraftWriter(); untitled.current = untitledId(); }, []);

  return { saved, draftPath, draftNote, rotateUntitled };
}

export interface Offer { draft: DraftRecord; stale: boolean; at: string; draftFile: string }

/** look once per opened document: a draft of this path (or, untitled, the newest orphaned untitled draft) */
export function useRecoveryOffer(kind: DocKind, path: string, ready: boolean) {
  const [offer, setOffer] = useState<Offer | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    (async () => {
      if (path) {
        const [d, sha] = await Promise.all([readDraft(kind, path), fileSha(path)]);
        const o = draftOffer(d, path, sha);
        if (live && o.offer && d) setOffer({ draft: d, stale: o.stale, at: new Date(d.savedAt).toLocaleString(), draftFile: draftPathFor(kind, path) });
      } else {
        const list = await untitledDrafts(kind);
        const top = list[0];
        if (live && top) setOffer({ draft: top.draft, stale: false, at: new Date(top.draft.savedAt).toLocaleString(), draftFile: top.path });
      }
    })().catch(() => undefined);
    return () => { live = false; };
  }, [kind, path, ready]);
  const discard = useCallback(async () => { const o = offer; setOffer(null); if (o) await fsDraftIo.remove(o.draftFile); }, [offer]);
  const take = useCallback(() => { const o = offer; setOffer(null); return o; }, [offer]);
  return { offer, discard, take };
}

export function RecoveryBanner({ offer, onRestore, onDiscard }: { offer: Offer | null; onRestore: () => void; onDiscard: () => void }) {
  if (!offer) return null;
  return (
    <div role="status" data-testid="recover-banner" className="fs-row"
      style={{ gap: 10, padding: "6px 10px", alignItems: "center", flexWrap: "wrap", fontSize: fz(13),
        background: "color-mix(in srgb, var(--fs-warn, #f0b429) 18%, transparent)", borderBottom: "1px solid var(--fs-border, #ccd)" }}>
      <span>
        <b>Unsaved changes found</b> — a recovery draft{offer.draft.path ? "" : ` of an untitled document (“${offer.draft.title || "Untitled"}”)`} from {offer.at}.
        {offer.stale ? " The file has changed since this draft was taken — restoring replaces those changes in the editor (nothing is saved until you save)." : ""}
      </span>
      <button type="button" className="fs-btn" data-variant="primary" data-testid="recover-restore" onClick={onRestore}>Restore</button>
      <button type="button" className="fs-btn" data-variant="ghost" data-testid="recover-discard" onClick={onDiscard}>Discard draft</button>
    </div>
  );
}
