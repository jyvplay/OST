/**
 * TT42: the DHCP half of WPAD — DHCP option 252 ("auto-proxy-config", draft-ietf-wrec-wpad-01 §4.3, a string URL),
 * tried BEFORE the DNS names (the draft's order; WinHTTP's too). Original implementation, two sources:
 *
 *  1. Lease files the operating system's DHCP client already wrote — no privilege, no network traffic:
 *       dhclient (Debian / Ubuntu / RHEL / NetworkManager+dhclient / BSD): `option wpad "…";` when dhclient.conf names
 *         code 252, else `option unknown-252 "…";` or colon-hex bytes; the LAST lease block in a file is the newest
 *       systemd-networkd (/run/systemd/netif/leases/<ifindex>) and NetworkManager's internal client
 *         (/var/lib/NetworkManager/internal-*.lease): private options 224–254 are stored as `OPTION_252=<hex>`
 *     newest file first.
 *  2. DHCPINFORM (RFC 2131 §3.4): "I already have an address — tell me the other parameters". Sent from UDP port 68
 *     on each IPv4 interface's address to that subnet's broadcast address, parameter request list = {252}; the
 *     server's DHCPACK is unicast back to the address. Port 68 is privileged: without root / CAP_NET_BIND_SERVICE the
 *     bind fails and this source is skipped silently (lease files still apply).
 * Only http(s) URLs count; trailing NULs (some servers count the terminator) are dropped.
 */
import * as dgram from "node:dgram";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

const cleanUrl = (s: string): string | null => {
  const v = s.replace(/[\0\s]+$/g, "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(v)) return null;
  try { return new URL(v).href; } catch { return null; }
};
const hexToText = (h: string) => Buffer.from(h.replace(/[^0-9a-f]/gi, ""), "hex").toString("latin1");

/** dhclient's lease syntax: string (with dhclient's \ooo / \" escapes) or colon-separated hex bytes */
export function parseDhclientLeases(text: string): string | null {
  const blocks = text.split(/\blease\s*\{/).slice(1);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const m = /option\s+(?:wpad|unknown-252)\s+(?:"((?:[^"\\]|\\.)*)"|([0-9a-f]{1,2}(?::[0-9a-f]{1,2})*))\s*;/i.exec(blocks[i]);
    if (!m) continue;
    const raw = m[1] !== undefined ? m[1].replace(/\\([0-7]{3}|.)/g, (_a, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e)) : m[2].split(":").map((b) => String.fromCharCode(parseInt(b, 16))).join("");
    const u = cleanUrl(raw);
    if (u) return u;
  }
  return null;
}
/** systemd-networkd / NetworkManager-internal lease: `OPTION_252=<hex>` */
export function parseNetworkdLease(text: string): string | null {
  const m = /^OPTION_252=([0-9A-Fa-f]+)\s*$/m.exec(text);
  return m ? cleanUrl(hexToText(m[1])) : null;
}

export const LEASE_DIRS: { dir: string; match: RegExp; kind: "dhclient" | "networkd" }[] = [
  { dir: "/var/lib/dhcp", match: /^dhclient.*\.leases?$/, kind: "dhclient" },
  { dir: "/var/lib/dhclient", match: /\.leases?$/, kind: "dhclient" },
  { dir: "/var/lib/NetworkManager", match: /^dhclient.*\.lease$/, kind: "dhclient" },
  { dir: "/var/db", match: /^dhclient\.leases/, kind: "dhclient" },
  { dir: "/var/lib/NetworkManager", match: /^internal-.*\.lease$/, kind: "networkd" },
  { dir: "/run/systemd/netif/leases", match: /^\d+$/, kind: "networkd" },
];
/** option 252 from the lease files present on this machine, newest file first: [{ url, file }] */
export function leaseWpadUrls(dirs = LEASE_DIRS): { url: string; file: string }[] {
  const files: { file: string; kind: "dhclient" | "networkd"; mtime: number }[] = [];
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(d.dir); } catch { continue; }
    for (const n of names) if (d.match.test(n)) { const file = `${d.dir}/${n}`; try { files.push({ file, kind: d.kind, mtime: statSync(file).mtimeMs }); } catch { /* vanished */ } }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: { url: string; file: string }[] = [];
  for (const f of files) {
    let t: string;
    try { t = readFileSync(f.file, "latin1"); } catch { continue; }
    const u = f.kind === "dhclient" ? parseDhclientLeases(t) : parseNetworkdLease(t);
    if (u && !out.some((x) => x.url === u)) out.push({ url: u, file: f.file });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ DHCPINFORM
const MAGIC = Buffer.from([99, 130, 83, 99]);
/** RFC 2131 message: BOOTREQUEST, ciaddr = our address, options 53 = INFORM (8), 55 = {252}, 61 client id, end */
export function buildInform(o: { xid: number; ciaddr: string; mac: Buffer }): Buffer {
  const h = Buffer.alloc(236);
  h[0] = 1; h[1] = 1; h[2] = 6; h[3] = 0; // op BOOTREQUEST, htype ethernet, hlen 6, hops
  h.writeUInt32BE(o.xid >>> 0, 4);
  // secs 0; flags 0 (unicast reply: we have an address)
  o.ciaddr.split(".").forEach((b, i) => { h[12 + i] = Number(b); });
  o.mac.copy(h, 28, 0, 6);
  const opts = Buffer.from([53, 1, 8, 55, 1, 252, 61, 7, 1, ...o.mac.subarray(0, 6), 255]);
  return Buffer.concat([h, MAGIC, opts]);
}
/** a reply to `xid`: message type and option 252 (null when absent / not a URL) */
export function parseDhcpReply(b: Buffer, xid: number): { type: number; wpad: string | null } | null {
  if (b.length < 240 || b[0] !== 2 || b.readUInt32BE(4) !== (xid >>> 0) || !b.subarray(236, 240).equals(MAGIC)) return null;
  let type = 0, wpad: string | null = null;
  for (let i = 240; i < b.length;) {
    const code = b[i];
    if (code === 255) break;
    if (code === 0) { i++; continue; }
    const len = b[i + 1]; if (i + 2 + len > b.length) break;
    const v = b.subarray(i + 2, i + 2 + len);
    if (code === 53 && len === 1) type = v[0];
    else if (code === 252) wpad = cleanUrl(v.toString("latin1"));
    i += 2 + len;
  }
  return { type, wpad };
}
const bcastOf = (addr: string, mask: string) => addr.split(".").map((b, i) => (Number(b) | (~Number(mask.split(".")[i]) & 255)) & 255).join(".");
/** DHCPINFORM on every non-internal IPv4 interface at once; the first DHCPACK carrying option 252 wins */
export async function informWpad(timeoutMs = 2500): Promise<{ url: string; iface: string } | null> {
  const ifs = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, a })));
  if (!ifs.length) return null;
  return new Promise((resolve) => {
    let left = ifs.length, done = false;
    const socks: dgram.Socket[] = [];
    const finish = (r: { url: string; iface: string } | null) => { if (done) return; done = true; clearTimeout(t); for (const s of socks) try { s.close(); } catch { /* closed */ } resolve(r); };
    const t = setTimeout(() => finish(null), timeoutMs);
    for (const { name, a } of ifs) {
      const xid = randomBytes(4).readUInt32BE(0);
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socks.push(s);
      s.on("error", () => { s.close(); if (--left === 0) finish(null); }); // EACCES (port 68 is privileged), EADDRINUSE …
      s.on("message", (m) => { const r = parseDhcpReply(m, xid); if (r && r.type === 5 && r.wpad) finish({ url: r.wpad, iface: name }); });
      s.bind(68, a.address, () => {
        try {
          s.setBroadcast(true);
          const mac = Buffer.from(a.mac.split(":").map((x) => parseInt(x, 16)));
          s.send(buildInform({ xid, ciaddr: a.address, mac }), 67, bcastOf(a.address, a.netmask));
        } catch { /* interface without broadcast */ }
      });
    }
  });
}
/** every DHCP-provided PAC URL, in order: lease files (newest first), then a live DHCPINFORM (unless disabled) */
export async function dhcpWpadUrls(o: { inform?: boolean; leases?: typeof LEASE_DIRS } = {}): Promise<{ url: string; source: string }[]> {
  const out = leaseWpadUrls(o.leases).map((l) => ({ url: l.url, source: `DHCP lease ${l.file}` }));
  if (o.inform !== false) { const r = await informWpad(); if (r && !out.some((x) => x.url === r.url)) out.push({ url: r.url, source: `DHCPINFORM on ${r.iface}` }); }
  return out;
}
