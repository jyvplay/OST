/** MS-06: the loaded conversation as text — timestamped, sender-first
 *  lines in the order shown (which honours MS-05's active filter, so
 *  copying a filtered view copies exactly what the user can see). */
export interface MsgLike { from: string; text: string; ts: number }
export function conversationText(msgs: readonly MsgLike[]): string {
  if (!msgs.length) return "(no messages loaded)";
  return msgs.map((m) => `${new Date(m.ts).toLocaleTimeString()} ${m.from}: ${m.text}`).join("\n");
}
