/** CK-05: named timer presets. Durations in seconds; the anchor-based
 *  timer consumes them unchanged, so a preset is data, not a new clock. */
export interface TimerPreset { label: string; seconds: number }
export const TIMER_PRESETS: TimerPreset[] = [
  { label: "1m", seconds: 60 }, { label: "5m", seconds: 300 }, { label: "10m", seconds: 600 },
  { label: "25m", seconds: 1500 }, { label: "45m", seconds: 2700 }, { label: "1h", seconds: 3600 },
];
export const presetBySeconds = (s: number): TimerPreset | null => TIMER_PRESETS.find((p) => p.seconds === s) ?? null;
