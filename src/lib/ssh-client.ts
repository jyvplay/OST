/**
 * TT44 (TD-03) — the browser half of the SSH bridge, DOM-free so it is testable against the live server.
 *
 * Wire (see src/lib/server/ssh/bridge.ts):
 *   GET  /api/ssh/{id}  → a long-lived octet stream of frames  [type u8][len u32 BE][payload]
 *                          0 keepalive · 1 event JSON · 2 stdout · 3 stderr
 *   POST /api/ssh/{id}  ← a batch of frames                    1 control JSON · 2 terminal input
 * Next.js has no WebSocket upgrade, so the two halves are a streaming fetch and ordered POSTs. Ordering: every
 * input byte and control message goes through ONE queue and at most one POST is in flight, so keystrokes, pastes
 * and resizes reach the server exactly in the order the user produced them.
 */
export interface SshEvent { t: "status" | "prompt" | "banner" | "hostkey-refused" | "ready" | "exit" | "error" | "closed"; [k: string]: unknown }
export interface SshInit { host: string; port?: number; username: string; privateKey?: string; passphrase?: string; cols?: number; rows?: number; term?: string; direct?: boolean; lang?: string }

export const MAX_POST = 1024 * 1024;
const HDR = 5;

/** encodes one frame */
export function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HDR + payload.length);
  out[0] = type; new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, HDR);
  return out;
}

/** incremental frame decoder: frames may be split across (or packed into) arbitrary stream chunks */
export class FrameParser {
  private buf: Uint8Array = new Uint8Array(0);
  /** a frame larger than this is a protocol error (the server never sends more than 64 KiB of output per frame) */
  private readonly maxFrame: number;
  constructor(maxFrame = 4 * 1024 * 1024) { this.maxFrame = maxFrame; }
  push(chunk: Uint8Array): { type: number; payload: Uint8Array }[] {
    if (this.buf.length) { const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b; }
    else this.buf = chunk;
    const out: { type: number; payload: Uint8Array }[] = [];
    let off = 0;
    while (this.buf.length - off >= HDR) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset + off + 1, 4).getUint32(0);
      if (len > this.maxFrame) throw new Error(`frame of ${len} bytes exceeds the limit`);
      if (this.buf.length - off < HDR + len) break;
      out.push({ type: this.buf[off], payload: this.buf.slice(off + HDR, off + HDR + len) });
      off += HDR + len;
    }
    this.buf = off ? this.buf.slice(off) : this.buf;
    return out;
  }
  get pending(): number { return this.buf.length; }
}

type Fetch = typeof fetch;
export interface ConnHandlers { onEvent: (e: SshEvent) => void; onData: (d: Uint8Array, stderr: boolean) => void; onDetach?: (why: string) => void }

export async function createSession(init: SshInit, f: Fetch = fetch, base = ""): Promise<string> {
  const r = await f(`${base}/api/ssh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init), cache: "no-store" });
  const j = await r.json().catch(() => ({})) as { id?: string; error?: string };
  if (!r.ok || !j.id) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j.id;
}

export class SshConnection {
  private queue: Uint8Array[] = [];
  private queued = 0;
  private flushing = false;
  private closed = false;
  private attachAbort: AbortController | null = null;
  private reattaches = 0;
  /** POST errors the server reported (e.g. "no host-key question is pending") — surfaced, never swallowed */
  lastErrors: string[] = [];
  readonly enc = new TextEncoder();

  readonly id: string;
  private readonly h: ConnHandlers;
  private readonly f: Fetch;
  private readonly base: string;
  constructor(id: string, h: ConnHandlers, f: Fetch = fetch, base = "") { this.id = id; this.h = h; this.f = f; this.base = base; }

  /** opens (or re-opens) the frame stream; the server replays the session's event log on every attach */
  async attach(): Promise<void> {
    while (!this.closed) {
      const ac = new AbortController(); this.attachAbort = ac;
      let why = "stream ended";
      try {
        const r = await this.f(`${this.base}/api/ssh/${this.id}`, { signal: ac.signal, cache: "no-store" });
        if (r.status === 404) { this.closed = true; this.h.onEvent({ t: "closed", why: "the session no longer exists" }); return; }
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader(); const p = new FrameParser();
        this.reattaches = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const fr of p.push(value)) {
            if (fr.type === 1) {
              let e: SshEvent; try { e = JSON.parse(new TextDecoder().decode(fr.payload)) as SshEvent; } catch { continue; }
              if (e.t === "closed") this.closed = true;
              this.h.onEvent(e);
            } else if (fr.type === 2 || fr.type === 3) this.h.onData(fr.payload, fr.type === 3);
          }
        }
      } catch (e) { why = (e as Error).name === "AbortError" ? "detached" : (e as Error).message; }
      if (this.closed || ac.signal.aborted) return;
      // the stream dropped while the session lives (proxy timeout, sleep): re-attach with backoff
      this.h.onDetach?.(why);
      if (++this.reattaches > 8) { this.h.onEvent({ t: "error", code: "detached", message: `lost the stream: ${why}` }); return; }
      await new Promise((res) => setTimeout(res, Math.min(4000, 250 * 2 ** this.reattaches)));
    }
  }

  send(data: string | Uint8Array): void {
    if (this.closed) return;
    const b = typeof data === "string" ? this.enc.encode(data) : data;
    // split so no single POST exceeds the server's 1 MiB limit
    for (let i = 0; i < b.length; i += 256 * 1024) this.push(frame(2, b.subarray(i, i + 256 * 1024)));
  }
  control(m: Record<string, unknown>): void { if (!this.closed) this.push(frame(1, this.enc.encode(JSON.stringify(m)))); }
  private push(fr: Uint8Array): void { this.queue.push(fr); this.queued += fr.length; void this.flush(); }

  /** one POST in flight; everything queued meanwhile goes in the next one (ordered, ≤ MAX_POST) */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length && !this.closed) {
        const batch: Uint8Array[] = []; let n = 0;
        while (this.queue.length && (n === 0 || n + this.queue[0].length <= MAX_POST)) { const q = this.queue.shift()!; batch.push(q); n += q.length; }
        this.queued -= n;
        const body = new Uint8Array(n); let o = 0; for (const b of batch) { body.set(b, o); o += b.length; }
        const r = await this.f(`${this.base}/api/ssh/${this.id}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body, cache: "no-store" });
        const j = await r.json().catch(() => ({})) as { errors?: string[]; error?: string };
        this.lastErrors = j.errors?.length ? j.errors : j.error ? [j.error] : [];
        if (r.status === 404) { this.closed = true; this.h.onEvent({ t: "closed", why: "the session no longer exists" }); }
      }
    } catch (e) { this.lastErrors = [(e as Error).message]; }
    finally { this.flushing = false; }
  }
  /** resolves once everything queued so far has been POSTed */
  async drained(): Promise<void> { while (this.flushing || this.queue.length) await new Promise((r) => setTimeout(r, 5)); }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.drained().catch(() => undefined);
    this.closed = true;
    this.attachAbort?.abort();
    await this.f(`${this.base}/api/ssh/${this.id}`, { method: "DELETE", cache: "no-store" }).catch(() => undefined);
  }
  /** stop reading without closing the session (window unmount): the server keeps it for its grace period */
  detach(): void { this.attachAbort?.abort(); this.closed = true; }
  get isClosed(): boolean { return this.closed; }
}

/** bracketed paste (DECSET 2004): the payload is wrapped and any embedded end marker is removed (paste injection) */
export function pasteBytes(text: string, bracketed: boolean): string {
  const t = text.replace(/\r?\n/g, "\r");
  if (!bracketed) return t;
  return `\x1b[200~${t.replace(/\x1b\[20[01]~/g, "")}\x1b[201~`;
}

/** SFTP upload: begin → PUT chunks in order (each ≤ the server's chunk size) → end. Progress via callback. */
export async function sftpUpload(id: string, path: string, data: Blob | Uint8Array, onProgress?: (done: number, total: number) => void, f: Fetch = fetch, base = ""): Promise<number> {
  const total = data instanceof Blob ? data.size : data.length;
  const b = await f(`${base}/api/ssh/${id}/sftp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "upload-begin", path }), cache: "no-store" });
  const bj = await b.json() as { ok: boolean; upload?: string; chunk?: number; error?: string };
  if (!bj.ok || !bj.upload) throw new Error(bj.error ?? `HTTP ${b.status}`);
  const chunk = Math.min(bj.chunk ?? 4 * 1024 * 1024, 4 * 1024 * 1024);
  for (let off = 0; off < total; off += chunk) {
    const part: Uint8Array<ArrayBuffer> = data instanceof Blob ? new Uint8Array(await data.slice(off, off + chunk).arrayBuffer()) : new Uint8Array(data.subarray(off, off + chunk));
    const r = await f(`${base}/api/ssh/${id}/sftp?upload=${bj.upload}&offset=${off}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: part, cache: "no-store" });
    if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? `HTTP ${r.status}`); }
    onProgress?.(Math.min(total, off + part.length), total);
  }
  const e = await f(`${base}/api/ssh/${id}/sftp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "upload-end", upload: bj.upload }), cache: "no-store" });
  const ej = await e.json() as { ok: boolean; bytes?: number; error?: string };
  if (!ej.ok) throw new Error(ej.error ?? `HTTP ${e.status}`);
  return ej.bytes ?? total;
}

/** parses `ssh` style targets: user@host, user@host:port, user@[v6]:port, ssh://user@host:port, plus -p PORT */
export function parseTarget(args: string[]): { username: string; host: string; port: number } | string {
  let port: number | undefined; const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p") { port = Number(args[++i]); continue; }
    if (/^-p\d+$/.test(args[i])) { port = Number(args[i].slice(2)); continue; }
    rest.push(args[i]);
  }
  if (rest.length !== 1) return "usage: ssh user@host[:port] [-p port]";
  const m = /^(?:ssh:\/\/)?([^@\s/:]+)@(\[[0-9a-fA-F:.]+\]|[^:\s/@]+)(?::(\d+))?\/?$/.exec(rest[0]);
  if (!m) return "usage: ssh user@host[:port] [-p port]";
  const p = port ?? (m[3] ? Number(m[3]) : 22);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "port must be 1–65535";
  return { username: m[1], host: m[2], port: p };
}
