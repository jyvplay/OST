/**
 * TT44 (TD-03): SSH wire encoding — RFC 4251 §5 data types. Original code.
 *
 *   byte, boolean (any non-zero reads as TRUE, written as 1), uint32 / uint64 (network order), string (uint32 length +
 *   bytes, may hold NULs), mpint (two's complement, big-endian, minimal length, positive values with the high bit set
 *   get a leading 0x00, zero is the empty string), name-list (comma-separated US-ASCII, no empty names).
 *
 * Readers throw SshWireError on any truncation or malformed value — a packet parser must never index past its end.
 */
export class SshWireError extends Error {}

export class SshWriter {
  private parts: Buffer[] = [];
  private len = 0;
  private push(b: Buffer): this { this.parts.push(b); this.len += b.length; return this; }
  byte(n: number): this { return this.push(Buffer.from([n & 0xff])); }
  bool(v: boolean): this { return this.byte(v ? 1 : 0); }
  u32(n: number): this { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return this.push(b); }
  u64(n: number | bigint): this { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return this.push(b); }
  string(s: Buffer | Uint8Array | string): this {
    const b = typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
    return this.u32(b.length).push(b);
  }
  /** an unsigned big-endian magnitude, encoded as an mpint */
  mpint(mag: Buffer | Uint8Array): this { return this.string(mpintBytes(Buffer.from(mag))); }
  nameList(names: string[]): this {
    for (const n of names) if (!n || /[,\x00-\x1f\x7f-\uffff]/.test(n)) throw new SshWireError(`bad name in name-list: ${JSON.stringify(n)}`);
    return this.string(names.join(","));
  }
  raw(b: Buffer | Uint8Array): this { return this.push(Buffer.from(b)); }
  get length(): number { return this.len; }
  build(): Buffer { return Buffer.concat(this.parts, this.len); }
}

/** the mpint payload for an unsigned magnitude: leading zeros stripped, 0x00 prepended when the high bit is set */
export function mpintBytes(mag: Buffer): Buffer {
  let i = 0;
  while (i < mag.length && mag[i] === 0) i++;
  const m = mag.subarray(i);
  if (m.length === 0) return Buffer.alloc(0);
  return m[0] & 0x80 ? Buffer.concat([Buffer.from([0]), m]) : Buffer.from(m);
}

export class SshReader {
  private off = 0;
  private buf: Buffer;
  constructor(buf: Buffer) { this.buf = buf; }
  private need(n: number): void { if (n < 0 || this.off + n > this.buf.length) throw new SshWireError(`truncated: need ${n} at ${this.off}/${this.buf.length}`); }
  byte(): number { this.need(1); return this.buf[this.off++]; }
  bool(): boolean { return this.byte() !== 0; }
  u32(): number { this.need(4); const v = this.buf.readUInt32BE(this.off); this.off += 4; return v; }
  u64(): bigint { this.need(8); const v = this.buf.readBigUInt64BE(this.off); this.off += 8; return v; }
  string(max = 1 << 24): Buffer {
    const n = this.u32();
    if (n > max) throw new SshWireError(`string too long: ${n}`);
    this.need(n); const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v;
  }
  utf8(max?: number): string { return this.string(max).toString("utf8"); }
  /** an mpint that must be non-negative; returns the unsigned magnitude (no leading zeros) */
  mpint(): Buffer {
    const b = this.string(1 << 16);
    if (b.length && b[0] & 0x80) throw new SshWireError("negative mpint");
    if (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) throw new SshWireError("non-minimal mpint");
    let i = 0; while (i < b.length && b[i] === 0) i++;
    return b.subarray(i);
  }
  nameList(): string[] { const s = this.string(1 << 16).toString("latin1"); return s ? s.split(",") : []; }
  raw(n: number): Buffer { this.need(n); const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v; }
  rest(): Buffer { const v = this.buf.subarray(this.off); this.off = this.buf.length; return v; }
  get remaining(): number { return this.buf.length - this.off; }
  get offset(): number { return this.off; }
  /** the protocol forbids trailing garbage in fixed-shape messages */
  end(): void { if (this.off !== this.buf.length) throw new SshWireError(`${this.buf.length - this.off} trailing byte(s)`); }
}

export const MSG = {
  DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
  KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31, // = KEXDH_INIT / KEXDH_REPLY for modp groups
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53,
  USERAUTH_60: 60, USERAUTH_INFO_RESPONSE: 61, // 60 = PK_OK / PASSWD_CHANGEREQ / INFO_REQUEST, by context
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100, PING: 192, PONG: 193,
} as const;

/** RFC 4253 §11.1 reason codes (the ones a client sends or reports) */
export const DISCONNECT_REASON: Record<number, string> = {
  1: "host not allowed to connect", 2: "protocol error", 3: "key exchange failed", 4: "reserved", 5: "MAC error",
  6: "compression error", 7: "service not available", 8: "protocol version not supported", 9: "host key not verifiable",
  10: "connection lost", 11: "by application", 12: "too many connections", 13: "auth cancelled by user",
  14: "no more auth methods available", 15: "illegal user name",
};
