/** LN-16: Lens camera facing. The constraint object is built here so the
 *  getUserMedia call site cannot drift from what the UI claims; "auto"
 *  omits facingMode entirely rather than passing an ideal that silently
 *  pins the default camera. */
export type Facing = "user" | "environment" | "auto";
export function facingConstraint(f: Facing): MediaTrackConstraints {
  return f === "auto" ? {} : { facingMode: { ideal: f } };
}
export const facingLabel = (f: Facing): string => f === "user" ? "front camera" : f === "environment" ? "rear camera" : "browser default";
