/**
 * TT44 — the SSH bridge over REAL HTTP: the shipped browser half (src/lib/ssh-client.ts) drives the running Fusion
 * server's /api/ssh routes, which dial a live asyncssh server (scripts/oracle/ssh-server.py; test-only). Covers the
 * host-key decision flow against ssh-keygen's fingerprint, every prompt kind, the frame stream, resize / signals,
 * known_hosts persistence in the VFS (and a changed key refused before authentication), SFTP over HTTP including
 * chunked uploads, and ≥15 hostile request shapes. BASE defaults to http://localhost:3999.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { makeHarness } from "./harness.mts";
import { createSession, SshConnection, sftpUpload, frame, FrameParser, pasteBytes, parseTarget, type SshEvent } from "../src/lib/ssh-client.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("tt44-bridge");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const COV = { "TD-03": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const D = "/tmp/tt44b-keys", ROOT = "/tmp/tt44b-root";
rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true });
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true });
const kg = (...a: string[]) => execFileSync("ssh-keygen", ["-q", ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
kg("-t", "ed25519", "-N", "", "-f", `${D}/hk1`); kg("-t", "ed25519", "-N", "", "-f", `${D}/hk2`);
kg("-t", "ed25519", "-N", "pa ss", "-C", "bridge", "-f", `${D}/user`);
writeFileSync(`${D}/authkeys`, readFileSync(`${D}/user.pub`, "utf8"));
const fpOf = (pub: string) => execFileSync("ssh-keygen", ["-lf", pub], { encoding: "utf8" }).split(" ")[1];

const servers: ChildProcess[] = [];
async function freePort(): Promise<number> { return new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); }); }
async function startServer(hostkey: string, port: number): Promise<ChildProcess> {
  const p = spawn(PY, ["scripts/oracle/ssh-server.py"], { env: { ...process.env, HOSTKEYS: `${D}/${hostkey}`, AUTHKEYS: `${D}/authkeys`, SFTP_ROOT: ROOT, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  servers.push(p); let err = ""; p.stderr!.on("data", (d) => { err += d; });
  await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error(`oracle did not start: ${err}`)), 15000); p.stdout!.on("data", (d) => { if (/READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  return p;
}
const PORT = await freePort();
let srv = await startServer("hk1", PORT);

/** a live session with an event log and decoded output */
class Live {
  events: SshEvent[] = []; out = ""; conn!: SshConnection; private waiters: (() => void)[] = [];
  static async open(init: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Live> {
    const l = new Live();
    const f: typeof fetch = (u, i) => fetch(u, { ...i, headers: { ...(i?.headers as Record<string, string> ?? {}), ...headers } });
    const id = await createSession({ host: "127.0.0.1", port: PORT, username: "alice", cols: 80, rows: 24, direct: true, ...init } as never, f, BASE);
    l.conn = new SshConnection(id, { onEvent: (e) => { l.events.push(e); l.poke(); }, onData: (d) => { l.out += new TextDecoder().decode(d); l.poke(); } }, f, BASE);
    void l.conn.attach();
    return l;
  }
  private poke() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  async until<T>(pred: () => T | undefined | false, what: string, ms = 15000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = pred(); if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(this.events).slice(0, 600)}; out: ${JSON.stringify(this.out.slice(-200))}`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 200); });
    }
  }
  ev(t: string, kind?: string) { return this.events.find((e) => e.t === t && (!kind || e.kind === kind)); }
}
const http = (path: string, init?: RequestInit) => fetch(`${BASE}${path}`, { cache: "no-store", ...init });
const readVfs = async (p: string) => ((await (await http(`/api/fs?op=read&path=${encodeURIComponent(p)}`)).json()) as { node: { content: string } | null }).node?.content ?? null;
const forget = (port: number) => http("/api/ssh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "forget", host: "127.0.0.1", port }) });
await forget(PORT);

// ------------------------------------------------------------------------------------------------ happy paths
await test("first contact: host-key prompt shows ssh-keygen's fingerprint → trust once → password prompt → ready → shell I/O, resize, exit, closed", COV, async () => {
  const l = await Live.open({});
  const hk = await l.until(() => l.ev("prompt", "hostkey"), "host-key prompt");
  ok(hk.fingerprint === fpOf(`${D}/hk1.pub`), `fingerprint ${String(hk.fingerprint)} ≠ ssh-keygen ${fpOf(`${D}/hk1.pub`)}`);
  ok(hk.canSave === true && hk.alg === "ssh-ed25519", "canSave / alg");
  ok(!l.ev("prompt", "auth") && !l.ev("banner"), "nothing about authentication may happen before the host key is accepted");
  l.conn.control({ t: "hostkey", accept: true, save: false });
  const pw = await l.until(() => l.ev("prompt", "auth"), "password prompt");
  ok(pw.method === "password" && Array.isArray(pw.prompts), "password prompt shape");
  ok(l.ev("banner")?.text === "Authorized use only\n", "the pre-auth banner arrives as an event");
  l.conn.control({ t: "auth", answers: ["wrong"] });
  const pw2 = await l.until(() => l.events.filter((e) => e.t === "prompt" && e.kind === "auth").length >= 2 && l.events.filter((e) => e.kind === "auth")[1], "re-prompt after a wrong password");
  ok(pw2.method === "password", "re-prompt is a password prompt");
  l.conn.control({ t: "auth", answers: ["pw1"] });
  const ready = await l.until(() => l.ev("ready"), "ready");
  ok((ready.negotiated as Record<string, string>).kex && ready.authMethod === "password" && ready.fingerprint === hk.fingerprint && ready.route === "Direct", `ready: ${JSON.stringify(ready)}`);
  await l.until(() => l.out.includes("WELCOME"), "shell banner");
  ok(/COLS=80 ROWS=24/.test(l.out) && /TERM=xterm-256color/.test(l.out), "pty TERM and size reached the server");
  l.conn.send("hello wörld\n"); await l.until(() => l.out.includes("YOU SAID [hello wörld]"), "echo (UTF-8 round trip)");
  l.conn.control({ t: "resize", cols: 132, rows: 40 }); await l.until(() => /RESIZED 132x40/.test(l.out), "window-change");
  l.conn.send("exit\n");
  const ex = await l.until(() => l.ev("exit"), "exit"); ok(ex.code === 3 && ex.signal === null, `exit: ${JSON.stringify(ex)}`);
  await l.until(() => l.ev("closed"), "closed");
  ok((await readVfs("/System/ssh/known_hosts") ?? "").indexOf(`[127.0.0.1]:${PORT}`) < 0, "\"trust once\" must not write known_hosts");
});

await test("trust & remember writes known_hosts in the VFS; the next connection skips the prompt; a CHANGED key is refused before auth; forget re-prompts", COV, async () => {
  await forget(PORT);
  const a = await Live.open({ username: "kbd" });
  await a.until(() => a.ev("prompt", "hostkey"), "host-key prompt");
  a.conn.control({ t: "hostkey", accept: true, save: true });
  const ki = await a.until(() => a.ev("prompt", "auth"), "keyboard-interactive");
  ok(ki.method === "keyboard-interactive" && (ki.prompts as unknown[]).length === 2, `kbd prompt: ${JSON.stringify(ki)}`);
  a.conn.control({ t: "auth", answers: ["4242", "7"] });
  ok((await a.until(() => a.ev("ready"), "ready")).authMethod === "keyboard-interactive", "auth method");
  await a.conn.close();
  const kh = await readVfs("/System/ssh/known_hosts");
  ok(kh && kh.includes(`[127.0.0.1]:${PORT} ssh-ed25519 `), `known_hosts line missing: ${kh}`);
  writeFileSync(`${D}/kh-check`, kh!);
  ok(execFileSync("ssh-keygen", ["-F", `[127.0.0.1]:${PORT}`, "-f", `${D}/kh-check`], { encoding: "utf8" }).includes("ssh-ed25519"), "ssh-keygen -F finds our known_hosts line (OpenSSH-compatible format)");
  const b = await Live.open({});
  await b.until(() => b.ev("prompt", "auth"), "password prompt (no host-key prompt this time)");
  ok(!b.ev("prompt", "hostkey"), "remembered key must not prompt");
  b.conn.control({ t: "auth", answers: null }); // cancel
  const err = await b.until(() => b.ev("error"), "auth-cancelled"); ok(err.code === "auth-cancelled", `cancel → ${String(err.code)}`);
  await b.until(() => b.ev("closed"), "closed after cancel");
  // the server is "re-installed" with another host key on the same port
  srv.kill(); await new Promise((r) => srv.once("exit", r)); srv = await startServer("hk2", PORT);
  const c = await Live.open({});
  const ref = await c.until(() => c.ev("hostkey-refused"), "changed-key refusal");
  ok(ref.why === "changed" && ref.fingerprint === fpOf(`${D}/hk2.pub`) && typeof ref.line === "number", `refusal: ${JSON.stringify(ref)}`);
  await c.until(() => c.ev("closed"), "closed");
  ok(!c.ev("prompt") && !c.ev("banner"), "a changed key must stop everything before authentication");
  const fr = await (await forget(PORT)).json() as { removed: number };
  ok(fr.removed >= 1, "forget removed the line");
  const d = await Live.open({});
  ok((await d.until(() => d.ev("prompt", "hostkey"), "prompt after forget")).fingerprint === fpOf(`${D}/hk2.pub`), "new key offered");
  d.conn.control({ t: "hostkey", accept: false, save: false });
  await d.until(() => d.ev("closed"), "closed after declining");
  ok((await d.until(() => d.ev("error"), "hostkey-rejected error")).code === "hostkey-rejected", "declining is reported as hostkey-rejected");
});

await test("public-key auth with an encrypted key: passphrase prompt, wrong passphrase re-prompts, right one logs in; the key is never echoed back", COV, async () => {
  const key = readFileSync(`${D}/user`, "utf8"); await forget(PORT);
  const l = await Live.open({ username: "bob", privateKey: key });
  await l.until(() => l.ev("prompt", "hostkey"), "host-key prompt"); l.conn.control({ t: "hostkey", accept: true, save: false });
  const p1 = await l.until(() => l.ev("prompt", "auth"), "passphrase prompt"); ok(p1.method === "passphrase", `method ${String(p1.method)}`);
  ok(l.events.findIndex((e) => e.kind === "hostkey") < l.events.findIndex((e) => e.kind === "auth"), "the passphrase is asked only AFTER the host key was accepted");
  l.conn.control({ t: "auth", answers: ["nope"] });
  const p2 = await l.until(() => l.events.filter((e) => e.kind === "auth")[1], "second passphrase prompt");
  ok(/Wrong passphrase/.test(String(p2.instruction)), "wrong passphrase is explained");
  l.conn.control({ t: "auth", answers: ["pa ss"] });
  ok((await l.until(() => l.ev("ready"), "ready")).authMethod === "publickey", "publickey");
  const sum = await (await http("/api/ssh")).text();
  ok(!sum.includes("OPENSSH PRIVATE KEY") && !sum.includes("pa ss"), "session listing must not contain key material or passphrases");
  await l.conn.close();
});

await test("SFTP over HTTP: list/mkdir/rename/remove, a 9 MiB chunked upload and a streamed download are byte-identical with the server's disk", COV, async () => {
  await forget(PORT);
  const l = await Live.open({});
  await l.until(() => l.ev("prompt", "hostkey"), "hk"); l.conn.control({ t: "hostkey", accept: true, save: false });
  await l.until(() => l.ev("prompt", "auth"), "pw"); l.conn.control({ t: "auth", answers: ["pw1"] });
  await l.until(() => l.ev("ready"), "ready");
  const S = (b: Record<string, unknown>) => http(`/api/ssh/${l.conn.id}/sftp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, j: await r.json() as Record<string, unknown> }));
  const home = (await S({ op: "realpath", path: "." })).j.path as string;
  ok((await S({ op: "mkdir", path: `${home}/up` })).j.ok, "mkdir");
  const data = randomBytes(9 * 1024 * 1024 + 123); let chunks = 0;
  const n = await sftpUpload(l.conn.id, `${home}/up/blob.bin`, new Uint8Array(data), () => { chunks++; }, fetch, BASE);
  ok(n === data.length && chunks === 3, `uploaded ${n} in ${chunks} chunks`);
  const disk = readFileSync(`${ROOT}/up/blob.bin`);
  ok(createHash("sha256").update(disk).digest("hex") === createHash("sha256").update(data).digest("hex"), "the server's file equals what was uploaded");
  const dl = await http(`/api/ssh/${l.conn.id}/sftp?op=download&path=${encodeURIComponent(`${home}/up/blob.bin`)}`);
  ok(dl.ok && /attachment/.test(dl.headers.get("content-disposition") ?? ""), "download is an attachment");
  ok(createHash("sha256").update(Buffer.from(await dl.arrayBuffer())).digest("hex") === createHash("sha256").update(data).digest("hex"), "downloaded bytes equal");
  const ls = (await S({ op: "list", path: `${home}/up` })).j.entries as { name: string; size: number }[];
  ok(ls.some((e) => e.name === "blob.bin" && e.size === data.length), "list shows the size");
  ok((await S({ op: "rename", from: `${home}/up/blob.bin`, to: `${home}/up/b2.bin` })).j.ok && existsSync(`${ROOT}/up/b2.bin`), "rename");
  ok((await S({ op: "rmdir", path: `${home}/up` })).status >= 400, "rmdir of a non-empty folder fails honestly");
  ok((await S({ op: "remove", path: `${home}/up/b2.bin` })).j.ok && (await S({ op: "rmdir", path: `${home}/up` })).j.ok && !existsSync(`${ROOT}/up`), "remove + rmdir");
  // upload protocol misuse
  const begin = (await S({ op: "upload-begin", path: `${home}/x.bin` })).j.upload as string;
  ok((await http(`/api/ssh/${l.conn.id}/sftp?upload=${begin}&offset=5`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(4) })).status === 409, "out-of-order offset → 409");
  ok((await http(`/api/ssh/${l.conn.id}/sftp?upload=${begin}&offset=0`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(4 * 1024 * 1024 + 1) })).status === 413, "oversized chunk → 413");
  ok((await http(`/api/ssh/${l.conn.id}/sftp?upload=${"0".repeat(24)}&offset=0`, { method: "PUT", body: new Uint8Array(1) })).status === 404, "unknown upload → 404");
  await l.conn.close();
});

// ------------------------------------------------------------------------------------------------ hostile shapes
await test("D: ≥15 hostile request shapes are refused with the right status and nothing is dialled", COV, async () => {
  const P = (b: unknown, h: Record<string, string> = {}) => http("/api/ssh", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
  const shapes: [string, () => Promise<Response>, number][] = [
    ["no host", () => P({ username: "a" }), 400],
    ["host with a slash", () => P({ host: "a/b", username: "a" }), 400],
    ["host with whitespace", () => P({ host: "a b", username: "a" }), 400],
    ["user@ smuggled in host", () => P({ host: "x@y", username: "a" }), 400],
    ["port 0", () => P({ host: "h", port: 0, username: "a" }), 400],
    ["port 70000", () => P({ host: "h", port: 70000, username: "a" }), 400],
    ["port 22.5", () => P({ host: "h", port: 22.5, username: "a" }), 400],
    ["empty user", () => P({ host: "h", username: "" }), 400],
    ["user with a colon", () => P({ host: "h", username: "a:b" }), 400],
    ["65 KiB private key", () => P({ host: "h", username: "a", privateKey: "k".repeat(65 * 1024) }), 400],
    ["malformed JSON", () => http("/api/ssh", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), 400],
    ["cross-site POST", () => P({ host: "h", username: "a" }, { "sec-fetch-site": "cross-site" }), 403],
    ["opaque-origin POST", () => P({ host: "h", username: "a" }, { origin: "null" }), 403],
    ["cross-site GET of the session list", () => http("/api/ssh", { headers: { "sec-fetch-site": "cross-site" } }), 403],
    ["non-hex session id", () => http("/api/ssh/zzzz"), 404],
    ["unknown session id", () => http(`/api/ssh/${"a".repeat(32)}`), 404],
    ["SFTP on an unknown session", () => http(`/api/ssh/${"b".repeat(32)}/sftp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"op\":\"list\"}" }), 404],
    ["amnesic forget", () => P({ op: "forget", host: "127.0.0.1", port: PORT }, { "x-fusion-amnesic": "1" }), 423],
  ];
  const bad: string[] = [];
  for (const [name, f, want] of shapes) { const r = await f(); if (r.status !== want) bad.push(`${name}: ${r.status} (want ${want})`); }
  ok(shapes.length >= 15, "shape count");
  ok(!bad.length, bad.join(" | "));
});

await test("D: frame-level abuse on a live session (truncated / trailing / unknown frames, bad control JSON, stray answers, bad signals, > 1 MiB, SFTP before ready)", COV, async () => {
  await forget(PORT);
  const l = await Live.open({});
  await l.until(() => l.ev("prompt", "hostkey"), "hk");
  const raw = (body: Uint8Array) => http(`/api/ssh/${l.conn.id}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body }).then(async (r) => ({ status: r.status, j: await r.json() as { errors?: string[]; error?: string } }));
  const enc = new TextEncoder();
  ok((await raw(frame(2, enc.encode("abc")).subarray(0, 6))).status === 400, "truncated frame → 400");
  ok((await raw(new Uint8Array([...frame(2, enc.encode("a")), 9]))).status === 400, "trailing bytes → 400");
  ok((await raw(frame(7, enc.encode("x")))).j.errors?.[0] === "unknown frame type 7", "unknown frame type reported");
  ok((await raw(frame(1, enc.encode("{nope")))).j.errors?.[0] === "bad control JSON", "bad control JSON reported");
  ok((await raw(frame(1, enc.encode(JSON.stringify({ t: "auth", answers: ["x"] }))))).j.errors?.[0] === "no authentication question is pending", "auth answer while the HOST-KEY question is pending is refused");
  ok((await raw(frame(1, enc.encode(JSON.stringify({ t: "signal", name: "SEGV" }))))).j.errors?.[0] === "unknown signal", "signal allow-list");
  ok((await raw(new Uint8Array(1024 * 1024 + 10))).status === 413, "> 1 MiB → 413");
  const sf = await http(`/api/ssh/${l.conn.id}/sftp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"op\":\"list\",\"path\":\"/\"}" });
  ok(sf.status === 409, `SFTP before ready → ${sf.status}`);
  l.conn.control({ t: "hostkey", accept: true, save: false });
  await l.until(() => l.ev("prompt", "auth"), "pw");
  ok((await raw(frame(1, enc.encode(JSON.stringify({ t: "hostkey", accept: true }))))).j.errors?.[0] === "no host-key question is pending", "a second host-key answer is refused");
  await l.conn.close(); // close() also stops reading the stream, so the session's end is checked server-side
  let st = 0; for (let i = 0; i < 40 && st !== 404; i++) { st = (await http(`/api/ssh/${l.conn.id}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(0) })).status; if (st !== 404) await new Promise((r) => setTimeout(r, 100)); }
  ok(st === 404, `a closed session must be gone (got ${st})`);
});

await test("D: dial failures are honest — closed port, unresolvable name, .onion without Tor; amnesic sessions cannot save host keys", COV, async () => {
  const closed = await freePort();
  const a = await Live.open({ port: closed });
  ok(((await a.until(() => a.ev("error"), "dial error")).code) === "dial" || /ECONNREFUSED|refused/i.test(String(a.ev("error")?.message)), `closed port: ${JSON.stringify(a.ev("error"))}`);
  const b = await Live.open({ host: "no-such-host.invalid" });
  ok(/ENOTFOUND|resolve|EAI_AGAIN/i.test(String((await b.until(() => b.ev("error"), "dns error")).message)), `dns: ${JSON.stringify(b.ev("error"))}`);
  const c = await Live.open({ host: "abcdefghijklmnop.onion" });
  ok(/Tor/.test(String((await c.until(() => c.ev("error"), "onion error")).message)), "onion hint");
  await forget(PORT);
  const d = await Live.open({}, { "x-fusion-amnesic": "1" });
  const hk = await d.until(() => d.ev("prompt", "hostkey"), "hk (amnesic)");
  ok(hk.canSave === false, "amnesic: canSave false");
  d.conn.control({ t: "hostkey", accept: true, save: true }); // a forged "save" must still not write
  await d.until(() => d.ev("prompt", "auth"), "pw"); await d.conn.close();
  ok(!(await readVfs("/System/ssh/known_hosts") ?? "").includes(`[127.0.0.1]:${PORT}`), "amnesic session wrote known_hosts");
});

await test("client helpers: frame parser across arbitrary splits, paste-injection stripping, ssh target parsing", COV, () => {
  const frames = [frame(1, new TextEncoder().encode("{\"t\":\"status\"}")), frame(2, randomBytes(70000)), frame(0, new Uint8Array(0)), frame(3, new Uint8Array([1, 2, 3]))];
  const all = Buffer.concat(frames.map((f) => Buffer.from(f)));
  for (let trial = 0; trial < 50; trial++) {
    const p = new FrameParser(); const got: { type: number; payload: Uint8Array }[] = [];
    for (let i = 0; i < all.length;) { const n = 1 + Math.floor(Math.random() * 9000); got.push(...p.push(new Uint8Array(all.subarray(i, i + n)))); i += n; }
    ok(got.length === 4 && got[1].payload.length === 70000 && got[3].payload[2] === 3 && p.pending === 0, `trial ${trial}`);
  }
  let threw = false; try { new FrameParser(1000).push(frame(2, new Uint8Array(2000))); } catch { threw = true; } ok(threw, "oversized frame refused");
  ok(pasteBytes("a\nb\x1b[201~rm -rf ~\n", true) === "\x1b[200~a\rbrm -rf ~\r\x1b[201~", "embedded end-of-paste marker is stripped (paste injection)");
  ok(pasteBytes("x\ny", false) === "x\ry", "unbracketed paste");
  ok(JSON.stringify(parseTarget(["ann@example.org"])) === JSON.stringify({ username: "ann", host: "example.org", port: 22 }), "user@host");
  ok(JSON.stringify(parseTarget(["ann@[fe80::1]:2200"])) === JSON.stringify({ username: "ann", host: "[fe80::1]", port: 2200 }), "v6 with port");
  ok((parseTarget(["-p", "2222", "ssh://bo@h"]) as { port: number }).port === 2222, "-p");
  ok(typeof parseTarget(["h"]) === "string" && typeof parseTarget(["a@h:99999"]) === "string" && typeof parseTarget(["a@h", "b@h"]) === "string", "rejects bad targets");
});

await forget(PORT);
for (const s of servers) s.kill();
await finish();
process.exit(0);
