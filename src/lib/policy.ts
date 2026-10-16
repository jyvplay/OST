import type { CapabilityReport } from "./capabilities";

/**
 * BK-04 new-device checklist. On the web, capability varies by BROWSER as much
 * as by device, so "moving" means diffing two probe reports: what the new
 * environment loses, what it gains, and which Fusion features each loss degrades.
 */
export interface CapDiff { lost: { id: string; label: string; degrade: string }[]; gained: { id: string; label: string }[]; unchanged: number }

export function diffCapabilities(oldR: Pick<CapabilityReport, "capabilities">, newR: Pick<CapabilityReport, "capabilities">): CapDiff {
  const prev = new Map(oldR.capabilities.map((c) => [c.id, c]));
  const lost: CapDiff["lost"] = [];
  const gained: CapDiff["gained"] = [];
  let unchanged = 0;
  for (const c of newR.capabilities) {
    const p = prev.get(c.id);
    if (!p) continue;
    if (p.available && !c.available) lost.push({ id: c.id, label: c.label, degrade: c.degrade });
    else if (!p.available && c.available) gained.push({ id: c.id, label: c.label });
    else unchanged += 1;
  }
  return { lost, gained, unchanged };
}

/**
 * RG-06 low-memory policy. navigator.deviceMemory is coarse (0.25…8, capped
 * at 8 for privacy) and absent in Firefox/Safari — absence must NOT be
 * treated as low memory, or every Safari user gets a crippled shell.
 */
export interface MemoryPolicy { tier: "low" | "normal" | "unknown"; maxWindows: number; liveIframes: number; effects: boolean; reason: string }

export function memoryPolicy(deviceMemoryGb: number | null | undefined): MemoryPolicy {
  if (deviceMemoryGb === null || deviceMemoryGb === undefined || !Number.isFinite(deviceMemoryGb)) {
    return { tier: "unknown", maxWindows: 24, liveIframes: 8, effects: true, reason: "deviceMemory not reported — using normal limits (absence is not evidence of low memory)" };
  }
  if (deviceMemoryGb <= 2) {
    return { tier: "low", maxWindows: 6, liveIframes: 2, effects: false, reason: `deviceMemory ${deviceMemoryGb} GB ≤ 2 — window cap 6, effects off` };
  }
  if (deviceMemoryGb <= 4) {
    return { tier: "normal", maxWindows: 12, liveIframes: 4, effects: true, reason: `deviceMemory ${deviceMemoryGb} GB — window cap 12` };
  }
  return { tier: "normal", maxWindows: 24, liveIframes: 8, effects: true, reason: `deviceMemory ${deviceMemoryGb} GB — window cap 24` };
}
