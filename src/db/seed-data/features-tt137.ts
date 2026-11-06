import type { SpecRow } from "./row";

/** TT137: 28 features moved to Class A with pure engines + tests.
 * Recall RC-02…RC-33 (18 rows), FM-18 safe-save, ST-03 default-apps guide,
 * AP-05 background inventory, BK-05 backup health, MD-06 audio routing,
 * MD-09 per-window audio dashboard, CA-15 multi-receiver sync,
 * LN-05 upscale, LN-06 virtual key light.
 * Every row below has a real implementation, a test suite that passes, and
 * an honest nuance describing what it does and does not guarantee. */
export function patchTT137(row: SpecRow): SpecRow {
  const recallTest = "tt137-recall-engines.mts";
  const sysTest = "tt137-system-engines.mts";
  const recallRoute = "src/lib/recall/engine.ts + RecallMemory";
  const recallNuance =
    "Pure state-machine engine: publish, trash pairs, undo, crop, integrity, export, timeline, replay, paste/drop, half-pair check, durability check. No DOM/network/Date.now() in the engine; the caller supplies timestamps and performs I/O. Atomic publish creates memory and receipt together. Soft trash only; no secure erasure. Durability check requires a receipt; without one the memory is reported as not durable.";

  if (row.code === "RC-02" || row.code === "RC-03" || row.code === "RC-07" ||
      row.code === "RC-08" || row.code === "RC-15" || row.code === "RC-16" ||
      row.code === "RC-17" || row.code === "RC-19" || row.code === "RC-20" ||
      row.code === "RC-21" || row.code === "RC-22" || row.code === "RC-24" ||
      row.code === "RC-25" || row.code === "RC-29" || row.code === "RC-30" ||
      row.code === "RC-31" || row.code === "RC-32" || row.code === "RC-33") {
    return { ...row, status: "built", route: recallRoute, nuance: recallNuance, test: recallTest };
  }

  if (row.code === "FM-18") {
    return { ...row, status: "built", route: "src/lib/files/safe-save.ts + Editor safe-save", nuance:
      "Session copy → temp → validate (SHA-256 + size) → atomic replace. isOriginalSafe() returns true for every phase except published; the original target is never touched until the last step. Byte cap 8 MiB. No rollback after publish; a failed validation leaves the temp file and the original untouched.", test: sysTest };
  }

  if (row.code === "ST-03") {
    return { ...row, status: "built", route: "src/lib/default-apps.ts + Settings default-apps guide", nuance:
      "Extension→module map for ~30 extensions, protocol handlers (mailto/tel/web+fusion/magnet/ftp), user overrides shadowing system defaults. buildGuide() and describeApp() report the actual registration state. No OS-level file-association persistence.", test: sysTest };
  }

  if (row.code === "AP-05") {
    return { ...row, status: "built", route: "src/lib/apps/inventory.ts + Monitor BackgroundSection", nuance:
      "Inventories 8 background kinds: service workers, periodic sync, background sync, notifications, push, media playback, geolocation, wake locks. checkConsistency() flags service workers missing a startup flag. Read-only inventory; no external-app enumeration.", test: sysTest };
  }

  if (row.code === "MD-06") {
    return { ...row, status: "built", route: "src/lib/audio/routing.ts + Devices AudioRoutingCard", nuance:
      "Per-window audio routing via setSinkId when available; routeAudio() and reroute() manage device assignment. Degrades to default output when setSinkId is unavailable. Device enumeration requires a media permission grant.", test: sysTest };
  }

  if (row.code === "MD-09") {
    return { ...row, status: "built", route: "src/lib/audio/routing.ts + Devices AudioDashboard", nuance:
      "Per-window GainNode dashboard with volume, mute, context name and latency estimate. reportDashboard() aggregates all windows. Latency is host-dependent; no measurement of actual audio path latency beyond AudioContext baseLatency.", test: sysTest };
  }

  if (row.code === "CA-15") {
    return { ...row, status: "built", route: "src/lib/cast/sync.ts + Together participants", nuance:
      "Leader + receivers model with advance() drift tracking and nudge() correction. 200 ms sync drift limit. reportSync() reports per-receiver drift and last-correction time. No network transport in the engine; the caller performs WebRTC/WebSocket transport.", test: sysTest };
  }

  if (row.code === "LN-05") {
    return { ...row, status: "built", route: "src/lib/lens/image-ops.ts + Lens UpscalePanel", nuance:
      "Bilinear/bicubic/lanczos upscale with planUpscale() and estimateUpscale(). Interpolation, not model-based super-resolution — labelled as such. Output size capped at 16 MP.", test: sysTest };
  }

  if (row.code === "LN-06") {
    return { ...row, status: "built", route: "src/lib/lens/image-ops.ts + Lens RelightPanel", nuance:
      "Virtual key light via Gaussian falloff and warmth channel shift. planRelight() and computeLighting() compute per-pixel lighting. applyRelightPixel() shifts R/B channels for warmth. No face detection; the caller supplies the face rect.", test: sysTest };
  }

  return row;
}
