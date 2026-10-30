/** CP-02: capture resolution preference. Expressed as ideal width and
 *  height in the getUserMedia constraints — a preference, not a demand,
 *  so a camera without that mode still opens at its nearest one. */
export type ResPick = "640" | "1280" | "1920" | "max";
export const RES_OPTIONS: ResPick[] = ["640", "1280", "1920", "max"];
export function resConstraint(pick: ResPick): Record<string, unknown> {
  if (pick === "max") return {};
  const w = Number(pick);
  return { width: { ideal: w }, height: { ideal: Math.round((w * 9) / 16) } };
}
