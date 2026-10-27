import type { SpecRow } from "./row";

/** Honest bounded photo and offline-queue evidence; no canonical Class A promotion. */
export function patchTT94(row: SpecRow): SpecRow {
  if (row.code === "MD-03") return {
    ...row,
    nuance: `${row.nuance} Current public Photos saves and clears can supply an expected owner path/id/version/digest; cooperating VFS operations check the live owner and stored content in the mutation transaction, returning a conflict for a stale editor. This is optional for older callers and does not provide equivalent Private/RAM or cross-provider guarantees. Queue replay can be rejected and requires user attention.`,
    test: `${row.test}; e2e-tt93-photos-clear.mts injects DB purge/write faults and selected UI overlap; tt94-photo-guard*.mts and e2e-tt94-photo-stale.mts cover public owner conflicts and forced move/save orderings; e2e-tt94-photos-offline.mts tests replay, conflicts and storage faults.`,
  };
  if (row.code === "SH-14") return {
    ...row, status: "partial",
    route: "Web-only extension: service-worker shell cache + localStorage offline queue, with Web Locks coordination where available",
    nuance: "The queue reports quota/corruption instead of claiming a write was saved. Participating same-origin tabs use Web Locks to serialize replay and short storage mutations; replay re-reads the queue after each server response, retains rejections and warns if dequeue fails after a possible commit. Browsers without Web Locks, older tabs and direct storage edits do not share that coordination. Browser storage can be cleared, a lost acknowledgement can cause duplicate work, and complete cold-start offline operation is not established. This web register row is not an additional canonical Class A promotion.",
    test: "e2e-tt55-files.mts checks a Files queued ghost and replay; e2e-tt94-photos-offline.mts tests guarded Photos replay, stale conflict, quota/corruption and dequeue faults; e2e-tt94-offline-race.mts forces a blocked real replay while another tab queues work and two tabs attempt replay. These selected Chromium/PostgreSQL schedules do not prove all crashes or storage-eviction behavior.",
  };
  return row;
}
