import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { readJsonObject } from "@/lib/http-json";
import { fusionCaller, sessions, type BridgeSession } from "@/lib/server/ssh/bridge";
import { SftpError } from "@/lib/server/ssh/sftp";

/**
 * TT44 (TD-03) SFTP on an open SSH session (a second channel on the same connection, opened on first use).
 *   POST {op, …}  list {path} · stat {path} · realpath {path} · mkdir {path} · rmdir {path} · remove {path}
 *                 · rename {from, to} · readlink {path} · symlink {target, link} · chmod {path, mode}
 *                 · upload-begin {path, mode?} → {upload} · upload-end {upload} → {bytes}
 *   PUT  ?upload=<id>&offset=<n>   raw body ≤ 4 MiB, written at that offset (chunked so no proxy/body limit applies
 *                 and the server never holds a whole file)
 *   GET  ?op=download&path=…[&inline=1]   the remote file streamed as an attachment — no size cap
 * File content never goes into the VFS here: the browser writes what it downloads through /api/fs, so /Private is
 * encrypted in the tab and amnesic sessions stay in RAM.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { "cache-control": "no-store" } });
type Ctx = { params: Promise<{ id: string }> };
const MAX_CHUNK = 4 * 1024 * 1024;

const G = globalThis as unknown as { __fusionSftpUploads?: Map<string, { sid: string; handle: Buffer; bytes: number; path: string; next: number; at: number }> };
const uploads = (G.__fusionSftpUploads ??= new Map());

async function find(req: NextRequest, ctx: Ctx): Promise<BridgeSession | Response> {
  if (!fusionCaller(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const s = /^[0-9a-f]{32}$/.test(id) ? sessions().get(id) : undefined;
  if (!s) return json({ error: "no such session" }, 404);
  if (s.state !== "ready") return json({ error: "the session is not connected" }, 409);
  return s;
}
const fail = (e: unknown) => json({ ok: false, error: (e as Error).message, code: e instanceof SftpError ? e.code : undefined }, e instanceof SftpError ? 422 : 502);
const str = (v: unknown, name: string) => { const s = String(v ?? ""); if (!s || s.length > 4096 || s.includes("\0")) throw new Error(`${name} is required`); return s; };

export async function POST(req: NextRequest, ctx: Ctx) {
  // the body is validated first (400 for empty / malformed / non-object, like every JSON handler); the CSRF and
  // session checks in find() still run before any operation
  const b = await readJsonObject(req);
  if (b instanceof Response) return b;
  const s = await find(req, ctx);
  if (s instanceof Response) return s;
  try {
    const f = await s.sftp();
    switch (b.op) {
      case "list": {
        const path = str(b.path, "path");
        const entries = await f.list(path);
        return json({ ok: true, path, entries: entries.map((e) => ({ name: e.name, size: e.attrs.size ?? 0, mode: e.attrs.mode ?? 0, mtime: e.attrs.mtime ?? 0, dir: e.attrs.isDir, link: e.attrs.isLink, longname: e.longname })) });
      }
      case "stat": { const a = await f.stat(str(b.path, "path")); return json({ ok: true, ...a }); }
      case "realpath": return json({ ok: true, path: await f.realpath(String(b.path ?? ".") || ".") });
      case "mkdir": await f.mkdir(str(b.path, "path")); return json({ ok: true });
      case "rmdir": await f.rmdir(str(b.path, "path")); return json({ ok: true });
      case "remove": await f.remove(str(b.path, "path")); return json({ ok: true });
      case "rename": await f.rename(str(b.from, "from"), str(b.to, "to")); return json({ ok: true });
      case "readlink": return json({ ok: true, target: await f.readlink(str(b.path, "path")) });
      case "symlink": await f.symlink(str(b.target, "target"), str(b.link, "link")); return json({ ok: true });
      case "chmod": { const mode = Number(b.mode); if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error("mode must be 0–07777"); await f.chmod(str(b.path, "path"), mode); return json({ ok: true }); }
      case "upload-begin": {
        for (const [k, u] of uploads) if (Date.now() - u.at > 10 * 60_000) uploads.delete(k);
        const path = str(b.path, "path");
        const mode = b.mode === undefined ? 0o644 : Number(b.mode);
        const handle = await f.openWrite(path, Number.isInteger(mode) ? mode : 0o644);
        const id = randomBytes(12).toString("hex");
        uploads.set(id, { sid: s.id, handle, bytes: 0, path, next: 0, at: Date.now() });
        return json({ ok: true, upload: id, chunk: MAX_CHUNK });
      }
      case "upload-end": {
        const u = uploads.get(String(b.upload ?? ""));
        if (!u || u.sid !== s.id) return json({ ok: false, error: "no such upload" }, 404);
        uploads.delete(String(b.upload));
        await f.closeFile(u.handle);
        return json({ ok: true, bytes: u.bytes, path: u.path });
      }
      default: return json({ ok: false, error: "unknown op" }, 400);
    }
  } catch (e) { return fail(e); }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const s = await find(req, ctx);
  if (s instanceof Response) return s;
  const q = new URL(req.url).searchParams;
  const u = uploads.get(q.get("upload") ?? "");
  if (!u || u.sid !== s.id) return json({ ok: false, error: "no such upload" }, 404);
  const offset = Number(q.get("offset"));
  // chunks arrive in order (the browser awaits each), so a gap or replay is refused rather than leaving a hole
  if (!Number.isSafeInteger(offset) || offset !== u.next) return json({ ok: false, error: `expected offset ${u.next}` }, 409);
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > MAX_CHUNK) return json({ ok: false, error: "chunk too large" }, 413);
  try {
    const f = await s.sftp();
    await f.writeAt(u.handle, offset, body);
    u.bytes += body.length; u.next = offset + body.length; u.at = Date.now();
    return json({ ok: true, bytes: u.bytes });
  } catch (e) { uploads.delete(q.get("upload")!); return fail(e); }
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await find(req, ctx);
  if (s instanceof Response) return s;
  const q = new URL(req.url).searchParams;
  if (q.get("op") !== "download") return json({ error: "unknown op" }, 400);
  let path: string;
  try { path = str(q.get("path"), "path"); } catch (e) { return json({ error: (e as Error).message }, 400); }
  let f;
  try { f = await s.sftp(); const st = await f.stat(path); if (st.isDir) return json({ ok: false, error: "that is a directory" }, 422); }
  catch (e) { return fail(e); }
  const name = path.split("/").filter(Boolean).pop() ?? "download";
  const sftp = f;
  let waiter: (() => void) | null = null;
  let ctl: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      // the SFTP download awaits the sink, so a slow browser slows the remote reads (bounded memory)
      sftp.download(path, async (chunk) => {
        if (cancelled) throw new Error("download cancelled");
        ctl.enqueue(new Uint8Array(chunk));
        while ((ctl.desiredSize ?? 1) <= 0 && !cancelled) await new Promise<void>((r) => { waiter = r; });
      }).then(() => { try { ctl.close(); } catch { /* */ } }, (e) => { try { ctl.error(e); } catch { /* */ } });
    },
    pull() { const w = waiter; waiter = null; w?.(); },
    cancel() { cancelled = true; const w = waiter; waiter = null; w?.(); },
  }, { highWaterMark: 1024 * 1024, size: (c) => c.byteLength });
  const disp = q.get("inline") === "1" ? "inline" : "attachment";
  return new Response(stream, { headers: { "content-type": "application/octet-stream", "content-disposition": `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
