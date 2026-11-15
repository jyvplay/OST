/** Availability is only reported by the Remote Playback monitor, not by all transports. */
export function remoteAvailabilityLabel(available: boolean | null): string {
  return available === null ? "unknown" : available ? "at least one" : "none reported";
}
