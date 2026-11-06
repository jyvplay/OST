/**
 * TT137 (RC-02…RC-33) — Recall visual memory engine.
 *
 * Pure state machine for a visual memory system: publications, receipts,
 * timelines, replay, integrity, crop, export, paste/drop, and exclusions.
 * No DOM, no network, no Date.now(). All timestamps are injected.
 */

// ── Types ────────────────────────────────────────────────────────────────────
export interface Memory {
  id: string;
  /** Absolute path in the VFS where bytes live. */
  path: string;
  /** SHA-256 of the bytes, lowercase hex. */
  sha256: string;
  bytes: number;
  /** Epoch ms when published. */
  createdAt: number;
  /** Whether the memory is in the trash (paired trash). */
  trashed?: boolean;
  /** Region crop, if any. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Whether this memory was produced from a sensitive source. */
  sensitive?: boolean;
  /** Width/height of the decoded surface. */
  width: number;
  height: number;
}

export interface Receipt {
  /** id of the memory this receipt proves publication of. */
  memoryId: string;
  /** SHA-256 of the memory bytes, redundant with Memory but kept for verification. */
  sha256: string;
  bytes: number;
  /** Epoch ms when the receipt was issued. */
  issuedAt: number;
  /** Sequence number for ordering. */
  seq: number;
}

export interface MemoryState {
  memories: Memory[];
  receipts: Receipt[];
  /** Paired trash: memories that were trashed together stay paired. */
  trashPairs: Map<string, string>;
  /** Current seq counter. */
  seq: number;
  /** Undo stack for trash operations. */
  undoStack: { memory: Memory; pairId?: string }[];
}

export const RECALL_LIMIT = 10_000;
export const RECEIPT_LIMIT = 10_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
const isHex = (v: string, len: number) => typeof v === "string" && /^[0-9a-f]+$/i.test(v) && v.length === len;

function validateMemory(m: Memory): void {
  if (typeof m.id !== "string" || !/^m-[a-z0-9-]{1,40}$/.test(m.id)) throw new Error("Memory id must be m-<1…40>");
  if (typeof m.path !== "string" || !m.path.startsWith("/") || m.path.includes("\u0000")) throw new Error("Memory needs an absolute path");
  if (!isHex(m.sha256, 64)) throw new Error("SHA-256 must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(m.bytes) || m.bytes < 0) throw new Error("Bytes must be a safe non-negative integer");
  if (!Number.isFinite(m.createdAt) || m.createdAt < 0) throw new Error("createdAt must be finite");
  if (!Number.isInteger(m.width) || m.width < 1 || m.width > 100_000) throw new Error("Width out of range");
  if (!Number.isInteger(m.height) || m.height < 1 || m.height > 100_000) throw new Error("Height out of range");
  if (m.crop) {
    if (!Number.isInteger(m.crop.x) || m.crop.x < 0 || m.crop.x >= m.width) throw new Error("Crop x out of range");
    if (!Number.isInteger(m.crop.y) || m.crop.y < 0 || m.crop.y >= m.height) throw new Error("Crop y out of range");
    if (!Number.isInteger(m.crop.w) || m.crop.w < 1 || m.crop.w > m.width - m.crop.x) throw new Error("Crop w out of range");
    if (!Number.isInteger(m.crop.h) || m.crop.h < 1 || m.crop.h > m.height - m.crop.y) throw new Error("Crop h out of range");
  }
}

function validateReceipt(r: Receipt): void {
  if (typeof r.memoryId !== "string" || !/^m-[a-z0-9-]{1,40}$/.test(r.memoryId)) throw new Error("Receipt needs a valid memory id");
  if (!isHex(r.sha256, 64)) throw new Error("Receipt SHA-256 must be 64 hex chars");
  if (!Number.isSafeInteger(r.bytes) || r.bytes < 0) throw new Error("Receipt bytes invalid");
  if (!Number.isFinite(r.issuedAt) || r.issuedAt < 0) throw new Error("Receipt issuedAt invalid");
  if (!Number.isInteger(r.seq) || r.seq < 1) throw new Error("Receipt seq must be a positive integer");
}

// ── Engine ────────────────────────────────────────────────────────────────────

export function createState(): MemoryState {
  return { memories: [], receipts: [], trashPairs: new Map(), seq: 0, undoStack: [] };
}

/** RC-22: Atomic memory and receipt publication — memory and receipt are published together. */
export function publish(state: MemoryState, memory: Memory, now: number): { ok: true; receipt: Receipt } | { ok: false; reason: string } {
  try { validateMemory(memory); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (state.memories.length >= RECALL_LIMIT) return { ok: false, reason: `Memory limit (${RECALL_LIMIT}) reached` };
  if (state.memories.some((m) => m.id === memory.id)) return { ok: false, reason: `Memory ${memory.id} already exists` };
  if (memory.sensitive === true && memory.path.startsWith("/Public")) return { ok: false, reason: "Sensitive memories cannot be stored in Public" };

  state.seq += 1;
  const receipt: Receipt = { memoryId: memory.id, sha256: memory.sha256, bytes: memory.bytes, issuedAt: now, seq: state.seq };
  validateReceipt(receipt);
  state.memories.push({ ...memory });
  state.receipts.push(receipt);
  return { ok: true, receipt };
}

/** RC-24: Single-snapshot pair inspection — compare two memories for differences. */
export interface PairDiff {
  identical: boolean;
  sizeDelta: number;
  shaMatch: boolean;
  resolutionSame: boolean;
  cropSame: boolean;
}

export function inspectPair(a: Memory, b: Memory): PairDiff {
  validateMemory(a); validateMemory(b);
  return {
    identical: a.sha256 === b.sha256 && a.bytes === b.bytes && a.width === b.width && a.height === b.height,
    sizeDelta: a.bytes - b.bytes,
    shaMatch: a.sha256 === b.sha256,
    resolutionSame: a.width === b.width && a.height === b.height,
    cropSame: JSON.stringify(a.crop) === JSON.stringify(b.crop),
  };
}

/** RC-25: Guarded paired trash and undo — trash a memory, pair it, and undo. */
export function trashMemory(state: MemoryState, id: string, now: number, pairId?: string): { ok: true; undone?: Memory } | { ok: false; reason: string } {
  const m = state.memories.find((x) => x.id === id);
  if (!m) return { ok: false, reason: `Memory ${id} not found` };
  if (m.trashed === true) return { ok: false, reason: `Memory ${id} is already trashed` };

  m.trashed = true;
  state.undoStack.push({ memory: { ...m }, pairId });
  if (pairId) {
    const p = state.memories.find((x) => x.id === pairId);
    if (!p) return { ok: false, reason: `Pair ${pairId} not found` };
    if (p.trashed !== true) { p.trashed = true; state.undoStack.push({ memory: { ...p }, pairId: id }); }
    state.trashPairs.set(id, pairId);
    state.trashPairs.set(pairId, id);
  }
  return { ok: true };
}

export function undoTrash(state: MemoryState, id: string): { ok: true } | { ok: false; reason: string } {
  const entry = state.undoStack.find((u) => u.memory.id === id);
  if (!entry) return { ok: false, reason: `No undo entry for ${id}` };
  const m = state.memories.find((x) => x.id === id);
  if (!m) return { ok: false, reason: `Memory ${id} not found` };
  m.trashed = false;
  // Restore pair
  if (entry.pairId) {
    const pair = state.memories.find((x) => x.id === entry.pairId);
    if (pair) { pair.trashed = false; state.trashPairs.delete(id); state.trashPairs.delete(entry.pairId); }
  }
  state.undoStack = state.undoStack.filter((u) => u.memory.id !== id);
  return { ok: true };
}

/** RC-31: Counted batch save of already-loaded visuals. */
export interface BatchSavePlan {
  total: number;
  toSave: Memory[];
  alreadySaved: Memory[];
  skipped: { id: string; reason: string }[];
}

export function planBatchSave(state: MemoryState, ids: readonly string[]): BatchSavePlan {
  const toSave: Memory[] = [];
  const alreadySaved: Memory[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const m = state.memories.find((x) => x.id === id);
    if (!m) { skipped.push({ id, reason: "not found" }); continue; }
    if (m.trashed) { skipped.push({ id, reason: "trashed" }); continue; }
    // A memory is "saved" if it has a receipt with matching sha and bytes
    const r = state.receipts.find((r) => r.memoryId === id);
    if (r && r.sha256 === m.sha256 && r.bytes === m.bytes) {
      alreadySaved.push(m);
    } else {
      toSave.push(m);
    }
  }
  return { total: ids.length, toSave, alreadySaved, skipped };
}

/** RC-32: Day-grouped saving timeline. */
export interface DayGroup {
  date: string;
  memories: Memory[];
  totalBytes: number;
}

export function groupByDay(state: MemoryState): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const m of state.memories) {
    if (m.trashed) continue;
    const d = new Date(m.createdAt).toISOString().slice(0, 10);
    if (!map.has(d)) map.set(d, { date: d, memories: [], totalBytes: 0 });
    const g = map.get(d)!;
    g.memories.push(m);
    g.totalBytes += m.bytes;
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** RC-33: Region crop of an already-decoded preview, with provenance. */
export function applyCrop(memory: Memory, x: number, y: number, w: number, h: number): Memory {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) throw new Error("Crop coordinates must be integers");
  if (x < 0 || y < 0) throw new Error("Crop coordinates must be non-negative");
  if (w < 1 || h < 1) throw new Error("Crop dimensions must be positive");
  if (x + w > memory.width) throw new Error(`Crop width ${x + w} exceeds image width ${memory.width}`);
  if (y + h > memory.height) throw new Error(`Crop height ${y + h} exceeds image height ${memory.height}`);
  return { ...memory, crop: { x, y, w, h } };
}

/** RC-19: Saved-byte integrity inspection. */
export interface IntegrityReport {
  ok: boolean;
  verified: string[];
  mismatched: { id: string; expected: string; actual: string }[];
  missing: string[];
}

export function inspectIntegrity(state: MemoryState, actualSha: (id: string) => string): IntegrityReport {
  const verified: string[] = [];
  const mismatched: { id: string; expected: string; actual: string }[] = [];
  const missing: string[] = [];
  for (const m of state.memories) {
    if (m.trashed) continue;
    const r = state.receipts.find((r) => r.memoryId === m.id);
    if (!r) { missing.push(m.id); continue; }
    const actual = actualSha(m.id);
    if (actual === m.sha256 && actual === r.sha256) verified.push(m.id);
    else mismatched.push({ id: m.id, expected: m.sha256, actual });
  }
  return { ok: verified.length === state.memories.filter((m) => !m.trashed).length && mismatched.length === 0 && missing.length === 0, verified, mismatched, missing };
}

/** RC-20: Local export of open memory — serialize a memory for download. */
export interface ExportPayload {
  memory: Memory;
  receipt: Receipt | null;
  format: "json";
  version: 1;
}

export function exportMemory(state: MemoryState, id: string): ExportPayload | { error: string } {
  const m = state.memories.find((x) => x.id === id);
  if (!m) return { error: `Memory ${id} not found` };
  const r = state.receipts.find((r) => r.memoryId === id) ?? null;
  return { memory: { ...m }, receipt: r ? { ...r } : null, format: "json", version: 1 };
}

/** RC-21: Streaming decoded-surface discovery. */
export interface SurfaceInfo {
  id: string;
  width: number;
  height: number;
  bytes: number;
  decodedAt: number;
}

export function discoverSurfaces(state: MemoryState): SurfaceInfo[] {
  return state.memories.filter((m) => !m.trashed).map((m) => ({ id: m.id, width: m.width, height: m.height, bytes: m.bytes, decodedAt: m.createdAt }));
}

/** RC-07: Saved memory timeline. */
export function timeline(state: MemoryState): Memory[] {
  return [...state.memories].filter((m) => !m.trashed).sort((a, b) => a.createdAt - b.createdAt);
}

/** RC-08: Saved memory replay — replay memories in chronological order. */
export function replay(state: MemoryState): Memory[] {
  return timeline(state);
}

/** RC-02: Clipboard image memories — track what came from the clipboard. */
export function addClipboardMemory(state: MemoryState, memory: Memory, now: number): { ok: true } | { ok: false; reason: string } {
  memory.sensitive = memory.sensitive ?? false;
  const r = publish(state, memory, now);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/** RC-03: Already-decoded visual recall — find a memory by visual properties. */
export function recallByVisual(state: MemoryState, width: number, height: number): Memory[] {
  return state.memories.filter((m) => !m.trashed && m.width === width && m.height === height);
}

/** RC-15: Sensitive-content exclusions. */
export interface ExclusionResult {
  visible: Memory[];
  excluded: Memory[];
  count: number;
}

export function applyExclusions(state: MemoryState, showSensitive: boolean): ExclusionResult {
  const visible = state.memories.filter((m) => !m.trashed && (showSensitive || !m.sensitive));
  const excluded = state.memories.filter((m) => !m.trashed && !showSensitive && m.sensitive);
  return { visible, excluded, count: visible.length };
}

/** RC-16: Resident media paste. */
export interface PasteResult {
  ok: boolean;
  memory?: Memory;
  reason: string;
}

export function pasteMedia(state: MemoryState, bytes: number, width: number, height: number, now: number): PasteResult {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, reason: "Invalid byte count" };
  if (bytes > 8 * 1024 * 1024) return { ok: false, reason: "Media exceeds 8 MiB VFS limit" };
  const id = `m-paste-${Math.random().toString(36).slice(2, 9)}`;
  const memory: Memory = { id, path: `/Resident/${id}.bin`, sha256: "0".repeat(64), bytes, createdAt: now, width, height, sensitive: false };
  const r = publish(state, memory, now);
  return r.ok ? { ok: true, memory: state.memories[state.memories.length - 1], reason: "pasted" } : { ok: false, reason: r.reason };
}

/** RC-17: Resident media drop. */
export function dropMedia(state: MemoryState, bytes: number, width: number, height: number, now: number, source: string): PasteResult {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, reason: "Invalid byte count" };
  if (bytes > 8 * 1024 * 1024) return { ok: false, reason: "Media exceeds 8 MiB VFS limit" };
  if (!/^m-drop-[a-z0-9-]{1,40}$/.test(source) && !source.startsWith("/")) return { ok: false, reason: "Invalid drop source" };
  const id = `m-drop-${Math.random().toString(36).slice(2, 9)}`;
  const memory: Memory = { id, path: `/Resident/${id}.bin`, sha256: "0".repeat(64), bytes, createdAt: now, width, height, sensitive: false };
  const r = publish(state, memory, now);
  return r.ok ? { ok: true, memory: state.memories[state.memories.length - 1], reason: `dropped from ${source}` } : { ok: false, reason: r.reason };
}

/** RC-29: Crash-interrupted publication leaves no half pair. */
export interface HalfPairCheck {
  hasHalfPair: boolean;
  pairs: { id: string; pairId: string; bothPublished: boolean; isHalf: boolean }[];
}

export function checkHalfPairs(state: MemoryState): HalfPairCheck {
  const pairs: { id: string; pairId: string; bothPublished: boolean; isHalf: boolean }[] = [];
  for (const [a, b] of state.trashPairs.entries()) {
    const ma = state.memories.find((m) => m.id === a);
    const mb = state.memories.find((m) => m.id === b);
    if (!ma || !mb) continue;
    // A half pair is one trashed and one not — both trashed is a consistent pair
    const isHalf = (ma.trashed === true && mb.trashed !== true) || (ma.trashed !== true && mb.trashed === true);
    pairs.push({ id: a, pairId: b, bothPublished: !ma.trashed && !mb.trashed, isHalf });
  }
  return { hasHalfPair: pairs.some((p) => p.isHalf), pairs };
}

/** RC-30: Engine-crash durability of a published memory. */
export function checkDurability(state: MemoryState, id: string): { ok: boolean; reason: string } {
  const m = state.memories.find((x) => x.id === id);
  if (!m) return { ok: false, reason: "Memory not found" };
  const r = state.receipts.find((r) => r.memoryId === id);
  if (!r) return { ok: false, reason: "No receipt — publication was not durable" };
  if (r.sha256 !== m.sha256 || r.bytes !== m.bytes) return { ok: false, reason: "Receipt does not match memory" };
  return { ok: true, reason: "Durable: receipt matches memory" };
}
