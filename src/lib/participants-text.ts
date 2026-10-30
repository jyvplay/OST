/** TT125 TG-03: the room roster as text, hosts first, then by name. */
export interface PeerLike { name: string; host?: boolean; }
export function participantsText(peers: ReadonlyArray<PeerLike>): string {
  if (!peers.length) return "nobody else is in the room";
  return [...peers]
    .sort((a, b) => Number(!!b.host) - Number(!!a.host) || a.name.localeCompare(b.name))
    .map((p) => `${p.name}${p.host ? " (host)" : ""}`).join("\n");
}
