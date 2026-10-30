/** SSH-02: the connection line as text — who, where, and the transport
 *  state in the terminal's own words. A session that never connected
 *  says so instead of showing a half-formed address. */
export interface ConnInfo { user: string; host: string; port: string; state: string }
export function connLine(c: ConnInfo): string {
  const addr = `${c.user || "anonymous"}@${c.host}${c.port && c.port !== "22" ? `:${c.port}` : ""}`;
  return `${addr} · ${c.state}`;
}
