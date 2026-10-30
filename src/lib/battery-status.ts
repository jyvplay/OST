/** DV-01: battery presentation for Devices. Input mirrors the
 *  BatteryManager shape; everything is formatted, nothing is polled here.
 *  Unknown times (Infinity, common on desktop) are stated as such. */
export interface BatteryLike { level: number; charging: boolean; chargingTime: number; dischargingTime: number }
export const batteryPercent = (b: BatteryLike): number => Math.round(Math.min(1, Math.max(0, b.level)) * 100);
export function batteryTimeLabel(b: BatteryLike): string {
  const t = b.charging ? b.chargingTime : b.dischargingTime;
  if (!Number.isFinite(t)) return b.charging ? "charging (time unknown)" : "on battery (time unknown)";
  const mins = Math.round(t / 60);
  if (mins < 60) return `${b.charging ? "full" : "left"} ~${mins} min`;
  return `${b.charging ? "full" : "left"} ~${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}
export const batteryLabel = (b: BatteryLike): string => `${batteryPercent(b)}% · ${batteryTimeLabel(b)}`;
