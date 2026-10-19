import { SshReader, SshWriter } from "./wire";
import type { SshChannel, SshClient } from "./transport";

/**
 * TT44 (TD-03): SFTP version 3 client (draft-ietf-secsh-filexfer-02, the version OpenSSH speaks), original code,
 * running as the "sftp" subsystem on a session channel of our own SSH client.
 *
 * Transfers are pipelined: up to 16 outstanding 32 KiB READ/WRITE requests, written to the sink strictly in offset
 * order (short reads re-request the gap, so a server that returns less than asked never corrupts the stream).
 * SYMLINK: OpenSSH's server takes (targetpath, linkpath) — the reverse of the draft (OpenSSH PROTOCOL §4.1) — so the
 * order is chosen from the server's version string. rename uses posix-rename@openssh.com when the server offers it.
 */

const T = { INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10, OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19, SYMLINK: 20, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105, EXTENDED: 200, EXTENDED_REPLY: 201 } as const;
export const FX = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5, NO_CONNECTION: 6, CONNECTION_LOST: 7, OP_UNSUPPORTED: 8 } as const;
const FX_NAME: Record<number, string> = { 0: "ok", 1: "end of file", 2: "no such file", 3: "permission denied", 4: "failure", 5: "bad message", 6: "no connection", 7: "connection lost", 8: "operation unsupported" };
const PF = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 0x10, EXCL: 0x20 } as const;
const A = { SIZE: 1, UIDGID: 2, PERMS: 4, ACMODTIME: 8, EXTENDED: 0x80000000 } as const;
const CHUNK = 32768, MAXQ = 16, MAX_SFTP_PACKET = 256 * 1024 + 1024;

export interface SftpAttrs { size?: number; uid?: number; gid?: number; mode?: number; atime?: number; mtime?: number; isDir: boolean; isLink: boolean; isFile: boolean }
export interface SftpEntry { name: string; longname: string; attrs: SftpAttrs }
export class SftpError extends Error {
  code: number;
  constructor(code: number, msg: string) { super(msg ? `${FX_NAME[code] ?? `status ${code}`}: ${msg}` : (FX_NAME[code] ?? `status ${code}`)); this.code = code; }
}

function readAttrs(r: SshReader): SftpAttrs {
  const f = r.u32();
  const a: SftpAttrs = { isDir: false, isLink: false, isFile: false };
  if (f & A.SIZE) a.size = Number(r.u64());
  if (f & A.UIDGID) { a.uid = r.u32(); a.gid = r.u32(); }
  if (f & A.PERMS) { a.mode = r.u32(); const t = a.mode & 0o170000; a.isDir = t === 0o040000; a.isLink = t === 0o120000; a.isFile = t === 0o100000; }
  if (f & A.ACMODTIME) { a.atime = r.u32(); a.mtime = r.u32(); }
  if (f & A.EXTENDED) { const n = r.u32(); if (n > 1000) throw new SftpError(FX.BAD_MESSAGE, "absurd extended attribute count"); for (let i = 0; i < n; i++) { r.string(65536); r.string(1 << 20); } }
  return a;
}
function writeAttrs(w: SshWriter, a: { mode?: number; atime?: number; mtime?: number } = {}): SshWriter {
  let f = 0;
  if (a.mode !== undefined) f |= A.PERMS;
  if (a.atime !== undefined && a.mtime !== undefined) f |= A.ACMODTIME;
  w.u32(f);
  if (f & A.PERMS) w.u32(a.mode!);
  if (f & A.ACMODTIME) w.u32(a.atime!).u32(a.mtime!);
  return w;
}

type Reply = { type: number; r: SshReader };

export class SftpClient {
  private ch: SshChannel;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private waiting = new Map<number, (x: Reply | Error) => void>();
  private versionWaiter: ((x: Reply | Error) => void) | null = null;
  private dead: Error | null = null;
  version = 0;
  extensions: Record<string, string> = {};
  /** OpenSSH's server takes SYMLINK arguments reversed */
  private reverseSymlink: boolean;

  private constructor(ch: SshChannel, serverVersion: string) {
    this.ch = ch;
    this.reverseSymlink = /OpenSSH/i.test(serverVersion);
    ch.on("data", (d: Buffer) => this.onData(d));
    ch.on("close", () => this.kill(new SftpError(FX.CONNECTION_LOST, "SFTP channel closed")));
  }

  static async open(client: SshClient): Promise<SftpClient> {
    const ch = await client.openSession();
    if (!(await ch.subsystem("sftp"))) { ch.close(); throw new SftpError(FX.OP_UNSUPPORTED, "the server refused the sftp subsystem"); }
    const s = new SftpClient(ch, client.server);
    const v = await new Promise<Reply | Error>((res) => { s.versionWaiter = res; s.sendRaw(new SshWriter().byte(T.INIT).u32(3).build()); });
    if (v instanceof Error) throw v;
    if (v.type !== T.VERSION) throw new SftpError(FX.BAD_MESSAGE, `expected VERSION, got ${v.type}`);
    s.version = v.r.u32();
    if (s.version < 3) throw new SftpError(FX.OP_UNSUPPORTED, `server speaks SFTP v${s.version}; v3 is required`);
    while (v.r.remaining > 0) { const k = v.r.utf8(256); s.extensions[k] = v.r.utf8(4096); }
    return s;
  }

  close(): void { this.ch.close(); this.kill(new SftpError(FX.NO_CONNECTION, "SFTP closed")); }
  get closed(): boolean { return this.dead !== null; }

  private kill(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    for (const w of this.waiting.values()) w(e);
    this.waiting.clear();
    this.versionWaiter?.(e); this.versionWaiter = null;
  }
  private sendRaw(payload: Buffer): void {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    this.ch.write(Buffer.concat([len, payload]));
  }
  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n < 1 || n > MAX_SFTP_PACKET) { this.kill(new SftpError(FX.BAD_MESSAGE, `bad SFTP packet length ${n}`)); this.ch.close(); return; }
      if (this.buf.length < 4 + n) return;
      const pkt = this.buf.subarray(4, 4 + n); this.buf = this.buf.subarray(4 + n);
      const r = new SshReader(pkt); const type = r.byte();
      if (type === T.VERSION) { this.versionWaiter?.({ type, r }); this.versionWaiter = null; continue; }
      const id = r.u32();
      const w = this.waiting.get(id);
      if (!w) { this.kill(new SftpError(FX.BAD_MESSAGE, `reply to unknown request ${id}`)); this.ch.close(); return; }
      this.waiting.delete(id);
      w({ type, r });
    }
  }
  private req(type: number, f: (w: SshWriter) => void): Promise<Reply> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId; this.nextId = (this.nextId + 1) >>> 0 || 1;
    const w = new SshWriter().byte(type).u32(id); f(w);
    return new Promise<Reply>((res, rej) => { this.waiting.set(id, (x) => (x instanceof Error ? rej(x) : res(x))); this.sendRaw(w.build()); });
  }
  private static status(x: Reply): never | void {
    if (x.type !== T.STATUS) throw new SftpError(FX.BAD_MESSAGE, `unexpected reply type ${x.type}`);
    const code = x.r.u32(); const msg = x.r.remaining >= 4 ? x.r.utf8(4096) : "";
    if (code !== FX.OK) throw new SftpError(code, msg);
  }
  private async expectStatus(type: number, f: (w: SshWriter) => void): Promise<void> { SftpClient.status(await this.req(type, f)); }
  private async expect(type: number, want: number, f: (w: SshWriter) => void): Promise<SshReader> {
    const x = await this.req(type, f);
    if (x.type === want) return x.r;
    SftpClient.status(x);
    throw new SftpError(FX.BAD_MESSAGE, `expected reply ${want}, got STATUS OK`);
  }

  async realpath(p: string): Promise<string> { const r = await this.expect(T.REALPATH, T.NAME, (w) => w.string(p)); if (r.u32() < 1) throw new SftpError(FX.BAD_MESSAGE, "empty REALPATH reply"); return r.utf8(4096); }
  async stat(p: string): Promise<SftpAttrs> { return readAttrs(await this.expect(T.STAT, T.ATTRS, (w) => w.string(p))); }
  async lstat(p: string): Promise<SftpAttrs> { return readAttrs(await this.expect(T.LSTAT, T.ATTRS, (w) => w.string(p))); }
  async mkdir(p: string, mode = 0o755): Promise<void> { await this.expectStatus(T.MKDIR, (w) => writeAttrs(w.string(p), { mode })); }
  async rmdir(p: string): Promise<void> { await this.expectStatus(T.RMDIR, (w) => w.string(p)); }
  async remove(p: string): Promise<void> { await this.expectStatus(T.REMOVE, (w) => w.string(p)); }
  async chmod(p: string, mode: number): Promise<void> { await this.expectStatus(T.SETSTAT, (w) => writeAttrs(w.string(p), { mode })); }
  async rename(from: string, to: string): Promise<void> {
    if (this.extensions["posix-rename@openssh.com"] !== undefined) await this.expectStatus(T.EXTENDED, (w) => w.string("posix-rename@openssh.com").string(from).string(to));
    else await this.expectStatus(T.RENAME, (w) => w.string(from).string(to));
  }
  async readlink(p: string): Promise<string> { const r = await this.expect(T.READLINK, T.NAME, (w) => w.string(p)); if (r.u32() < 1) throw new SftpError(FX.BAD_MESSAGE, "empty READLINK reply"); return r.utf8(4096); }
  /** creates `linkPath` pointing at `target` */
  async symlink(target: string, linkPath: string): Promise<void> {
    await this.expectStatus(T.SYMLINK, (w) => (this.reverseSymlink ? w.string(target).string(linkPath) : w.string(linkPath).string(target)));
  }
  async list(dir: string, max = 20000): Promise<SftpEntry[]> {
    const h = (await this.expect(T.OPENDIR, T.HANDLE, (w) => w.string(dir))).string(256);
    const out: SftpEntry[] = [];
    try {
      for (;;) {
        const x = await this.req(T.READDIR, (w) => w.string(h));
        if (x.type === T.STATUS) { const code = x.r.u32(); if (code === FX.EOF) break; throw new SftpError(code, x.r.remaining >= 4 ? x.r.utf8(4096) : ""); }
        if (x.type !== T.NAME) throw new SftpError(FX.BAD_MESSAGE, `unexpected READDIR reply ${x.type}`);
        const n = x.r.u32();
        for (let i = 0; i < n; i++) {
          const name = x.r.utf8(4096), longname = x.r.utf8(8192), attrs = readAttrs(x.r);
          if (name !== "." && name !== "..") out.push({ name, longname, attrs });
        }
        if (out.length > max) throw new SftpError(FX.FAILURE, `directory has more than ${max} entries — listing stopped`);
      }
    } finally { await this.closeHandle(h).catch(() => undefined); }
    return out;
  }
  private async closeHandle(h: Buffer): Promise<void> { await this.expectStatus(T.CLOSE, (w) => w.string(h)); }
  private async openFile(p: string, pflags: number, mode?: number): Promise<Buffer> {
    return (await this.expect(T.OPEN, T.HANDLE, (w) => writeAttrs(w.string(p).u32(pflags), mode !== undefined ? { mode } : {}))).string(256);
  }

  /** streams a remote file to `sink` in order; resolves with the byte count. `limit` aborts when exceeded. */
  async download(p: string, sink: (b: Buffer) => Promise<void> | void, limit = Infinity): Promise<number> {
    const h = await this.openFile(p, PF.READ);
    let nextOff = 0, eof = Infinity, written = 0, failure: Error | null = null;
    const got = new Map<number, Buffer>();
    const gaps: [number, number][] = [];
    const inflight = new Set<Promise<void>>();
    const issue = (off: number, len: number) => {
      const pr = this.req(T.READ, (w) => w.string(h).u64(off).u32(len)).then((x) => {
        if (x.type === T.DATA) {
          const d = x.r.string(len + 64);
          if (d.length > len) throw new SftpError(FX.BAD_MESSAGE, "READ returned more than requested");
          if (d.length === 0) { eof = Math.min(eof, off); return; }
          got.set(off, Buffer.from(d));
          if (d.length < len) gaps.push([off + d.length, len - d.length]);
          return;
        }
        if (x.type === T.STATUS) { const code = x.r.u32(); if (code === FX.EOF) { eof = Math.min(eof, off); return; } throw new SftpError(code, x.r.remaining >= 4 ? x.r.utf8(4096) : ""); }
        throw new SftpError(FX.BAD_MESSAGE, `unexpected READ reply ${x.type}`);
      }).catch((e) => { failure = failure ?? e; }).finally(() => inflight.delete(pr));
      inflight.add(pr);
    };
    try {
      for (;;) {
        while (!failure && inflight.size < MAXQ) {
          const g = gaps.shift();
          if (g) { if (g[0] < eof) issue(g[0], g[1]); continue; }
          if (nextOff >= eof) break;
          issue(nextOff, CHUNK); nextOff += CHUNK;
        }
        if (failure) throw failure;
        if (!inflight.size) break;
        await Promise.race(inflight);
        if (failure) throw failure;
        while (got.has(written)) {
          const d = got.get(written)!; got.delete(written);
          if (written + d.length > limit) throw new SftpError(FX.FAILURE, `file is larger than the ${limit}-byte limit`);
          await sink(d); written += d.length;
        }
      }
      if (written !== eof && !(eof === Infinity && written === 0)) throw new SftpError(FX.FAILURE, `download ended at ${written} bytes but EOF was reported at ${eof}`);
      return written;
    } finally {
      await Promise.allSettled([...inflight]);
      await this.closeHandle(h).catch(() => undefined);
    }
  }

  /** chunked uploads (the browser sends ≤ 4 MiB pieces): open → writeAt… → closeFile */
  async openWrite(p: string, mode = 0o644): Promise<Buffer> { return this.openFile(p, PF.WRITE | PF.CREAT | PF.TRUNC, mode); }
  async writeAt(h: Buffer, offset: number, data: Buffer): Promise<void> {
    let failure: Error | null = null;
    const inflight = new Set<Promise<void>>();
    for (let i = 0; i < data.length; i += CHUNK) {
      while (inflight.size >= MAXQ) await Promise.race(inflight);
      if (failure) break;
      const pr = this.expectStatus(T.WRITE, (w) => w.string(h).u64(offset + i).string(data.subarray(i, i + CHUNK))).catch((e) => { failure = failure ?? e; }).finally(() => inflight.delete(pr));
      inflight.add(pr);
    }
    await Promise.allSettled([...inflight]);
    if (failure) throw failure;
  }
  async closeFile(h: Buffer): Promise<void> { await this.closeHandle(h); }

  /** writes everything from `source` to a remote file (created/truncated); resolves with the byte count */
  async upload(p: string, source: AsyncIterable<Uint8Array>, mode = 0o644): Promise<number> {
    const h = await this.openFile(p, PF.WRITE | PF.CREAT | PF.TRUNC, mode);
    let off = 0, failure: Error | null = null;
    const inflight = new Set<Promise<void>>();
    const issue = (o: number, d: Buffer) => {
      const pr = this.expectStatus(T.WRITE, (w) => w.string(h).u64(o).string(d)).catch((e) => { failure = failure ?? e; }).finally(() => inflight.delete(pr));
      inflight.add(pr);
    };
    try {
      for await (const part of source) {
        let b = Buffer.from(part);
        while (b.length) {
          if (failure) throw failure;
          while (inflight.size >= MAXQ) await Promise.race(inflight);
          const n = Math.min(b.length, CHUNK);
          issue(off, b.subarray(0, n)); off += n; b = b.subarray(n);
        }
      }
      await Promise.allSettled([...inflight]);
      if (failure) throw failure;
      await this.closeHandle(h);
      return off;
    } catch (e) {
      await Promise.allSettled([...inflight]);
      await this.closeHandle(h).catch(() => undefined);
      throw e;
    }
  }
}
