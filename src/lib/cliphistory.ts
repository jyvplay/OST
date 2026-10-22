/**
 * TT57 — PR-12 clipboard history operations (pure; the Shell holds the list in memory only).
 *
 * Rules (modelled on the OS clipboard managers people know — Windows Win+V, macOS Maccy/Raycast, KDE Klipper):
 *  - newest first; copying text that is already in the history MOVES it to the top (no duplicates);
 *  - pinned entries are never evicted by the size cap and survive "Clear";
 *  - sensitive entries (Vault) are stored masked — the history never holds the secret — and cannot be pinned or
 *    re-copied; the system clipboard itself is cleared after SENSITIVE_CLEAR_MS if it still holds the secret;
 *  - search is a case-insensitive substring match over text and source.
 */
import type { ClipEntry } from "@/components/shell-context";

export const CLIP_MAX = 50;
export const SENSITIVE_CLEAR_MS = 30_000;

/** Add an entry: dedupe by text (non-sensitive), keep pinned ones beyond the cap. */
export function addClip(list: ClipEntry[], e: ClipEntry, max = CLIP_MAX): ClipEntry[] {
  const prev = !e.sensitive ? list.find((c) => !c.sensitive && c.text === e.text) : undefined;
  const rest = prev ? list.filter((c) => c !== prev) : list;
  const next = [{ ...e, pinned: prev?.pinned }, ...rest];
  const pinned = next.filter((c) => c.pinned).length;
  let unpinnedLeft = Math.max(0, max - pinned);
  return next.filter((c) => c.pinned || unpinnedLeft-- > 0);
}
export const removeClip = (list: ClipEntry[], at: number) => list.filter((c) => c.at !== at);
export const togglePin = (list: ClipEntry[], at: number) => list.map((c) => (c.at === at && !c.sensitive ? { ...c, pinned: !c.pinned } : c));
export const clearUnpinned = (list: ClipEntry[]) => list.filter((c) => c.pinned);
export function filterClips(list: ClipEntry[], q: string): ClipEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return list;
  return list.filter((c) => c.text.toLowerCase().includes(s) || c.from.toLowerCase().includes(s));
}
/** Display order: pinned first (newest first within each group). */
export const ordered = (list: ClipEntry[]) => [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];
