/** MS-05: search within loaded messages. Only messages already fetched
 *  from the user's bridge are searched — nothing new leaves the device;
 *  matching spans sender and text. */
export interface MessageLike { from: string; text: string }
export function filterMessages<T extends MessageLike>(msgs: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return msgs;
  return msgs.filter((m) => `${m.from} ${m.text}`.toLowerCase().includes(needle));
}
