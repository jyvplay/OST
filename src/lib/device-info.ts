/** DV-02: a copyable summary of what the browser exposes about this
 *  device. Every field is stated as reported; unavailable APIs render
 *  as "not exposed" rather than being omitted (absence is information
 *  the user asked for). */
export interface DeviceInfoLike { ua: string; platform: string; cores: number | undefined; memory: number | undefined; touch: boolean; online: boolean }
export function deviceInfoText(d: DeviceInfoLike): string {
  return [
    `Browser: ${d.ua}`,
    `Platform: ${d.platform || "not exposed"}`,
    `CPU cores: ${d.cores ?? "not exposed"}`,
    `Device memory: ${d.memory ? `~${d.memory} GB (capped by the browser)` : "not exposed"}`,
    `Touch: ${d.touch ? "yes" : "no"} · Network: ${d.online ? "online" : "offline"}`,
  ].join("\n");
}
