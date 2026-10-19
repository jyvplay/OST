/**
 * TT44 unit tests — TD-03 SSH/SFTP client (src/lib/server/ssh/*) against INDEPENDENT implementations:
 *   - a live asyncssh 2.24 server (scripts/oracle/ssh-server.py; test-only, not shipped) over real TCP,
 *   - OpenSSH's ssh-keygen (key files, fingerprints, hashed known_hosts),
 *   - python `bcrypt.kdf` and `cryptography`'s Poly1305.
 * Plus hostile shapes from a TCP man-in-the-middle in this file (Terrapin-style injection, MAC tampering) and a fake
 * server that sends an all-zero curve25519 point.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, readlinkSync, existsSync, statSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { SshClient, KEX_ALGS, type SshClientOptions } from "../src/lib/server/ssh/transport.ts";
import { poly1305, CIPHERS, MACS } from "../src/lib/server/ssh/crypto.ts";
import { piWords, bcryptPbkdf, parsePrivateKey, publicLine, generateEd25519, type SshPrivateKey } from "../src/lib/server/ssh/keys.ts";
import { SftpClient, SftpError, FX } from "../src/lib/server/ssh/sftp.ts";
import { checkHostKey, addHostKey, forgetHost, parseKnownHosts, hostFieldMatches } from "../src/lib/server/ssh/known-hosts.ts";
import { SshWriter } from "../src/lib/server/ssh/wire.ts";

const { test, finish } = makeHarness("tt44-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python";
const D = "/tmp/tt44-keys", ROOT = "/tmp/tt44-sftproot";
rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true });
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true });
const kg = (...a: string[]) => execFileSync("ssh-keygen", ["-q", ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
kg("-t", "ed25519", "-N", "", "-f", `${D}/hk_ed25519`); kg("-t", "ecdsa", "-N", "", "-f", `${D}/hk_ecdsa`); kg("-t", "rsa", "-b", "3072", "-N", "", "-f", `${D}/hk_rsa`);
kg("-t", "ed25519", "-N", "pa ss", "-C", "ed-enc", "-f", `${D}/ked`); kg("-t", "ecdsa", "-b", "384", "-N", "", "-C", "ec384", "-f", `${D}/kec`);
kg("-t", "rsa", "-b", "3072", "-N", "rsapw", "-Z", "aes256-gcm@openssh.com", "-C", "rsa-gcm", "-f", `${D}/krsa`); kg("-t", "ecdsa", "-b", "521", "-N", "", "-m", "PEM", "-f", `${D}/kpem`);
kg("-t", "ed25519", "-N", "", "-f", `${D}/kstranger`);
writeFileSync(`${D}/authkeys`, ["ked", "kec", "krsa", "kpem"].map((k) => readFileSync(`${D}/${k}.pub`, "utf8")).join(""));
const HOSTKEYS = ["hk_ed25519", "hk_ecdsa", "hk_rsa"].map((k) => `${D}/${k}`).join(",");

const servers: ChildProcess[] = [];
async function startServer(env: Record<string, string> = {}): Promise<number> {
  const p = spawn(PY, ["scripts/oracle/ssh-server.py"], { env: { ...process.env, HOSTKEYS, AUTHKEYS: `${D}/authkeys`, SFTP_ROOT: ROOT, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  servers.push(p);
  let err = ""; p.stderr!.on("data", (d) => { err += d; });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`oracle server did not start: ${err}`)), 15000);
    p.stdout!.on("data", (d) => { const m = /READY (\d+)/.exec(String(d)); if (m) { clearTimeout(t); res(+m[1]); } });
  });
}
const port = await startServer();
const portRekey = await startServer({ REKEY_BYTES: String(1 << 20) });

const keys: Record<string, SshPrivateKey> = {
  ed: parsePrivateKey(readFileSync(`${D}/ked`, "utf8"), "pa ss"), ec: parsePrivateKey(readFileSync(`${D}/kec`, "utf8")),
  rsa: parsePrivateKey(readFileSync(`${D}/krsa`, "utf8"), "rsapw"), pem: parsePrivateKey(readFileSync(`${D}/kpem`, "utf8")),
};
async function dial(p: number, o: Partial<SshClientOptions> = {}, sock?: Socket): Promise<SshClient> {
  const c = new SshClient(sock ?? connect(p, "127.0.0.1"), { username: "alice", verifyHostKey: async () => true, auth: { password: async () => "pw1" }, timeoutMs: 20000, ...o });
  await c.connect();
  return c;
}
async function run(c: SshClient, cmd: string, stdin?: Buffer): Promise<{ out: Buffer; err: Buffer; exit: unknown }> {
  const ch = await c.openSession();
  const out: Buffer[] = [], err: Buffer[] = [];
  ch.on("data", (d: Buffer) => out.push(d)); ch.on("stderr", (d: Buffer) => err.push(d));
  const ex = new Promise((r) => ch.on("exit", r)); const closed = new Promise((r) => ch.on("close", r));
  ok(await ch.exec(cmd), `exec refused: ${cmd}`);
  if (stdin) ch.write(stdin);
  if (stdin !== undefined) ch.eof();
  const exit = await ex; await closed;
  return { out: Buffer.concat(out), err: Buffer.concat(err), exit };
}
const fail = async (f: () => Promise<unknown>): Promise<{ message: string; code?: string }> => { try { await f(); } catch (e) { return e as { message: string; code?: string }; } throw new Error("expected a failure, got success"); };

// ------------------------------------------------------------------------------------------- keys / crypto
await test("Blowfish constants computed from π match the published first/last words; bcrypt_pbkdf == python bcrypt.kdf", { "TD-03": "partial" }, async () => {
  const w = piWords();
  ok(w[0] === 0x243f6a88 && w[1] === 0x85a308d3 && w[17] === 0x8979fb1b && w[18] === 0xd1310ba6 && w[1041] === 0x3ac372e6, `pi words ${w[0].toString(16)} ${w[17].toString(16)} ${w[18].toString(16)} ${w[1041].toString(16)}`);
  for (const [pw, salt, len, rounds] of [["pw", "saltsalt", 48, 4], ["", "s", 32, 1], ["pässwörd ✓", "0123456789abcdef", 44, 16], ["x".repeat(100), "y".repeat(40), 80, 2]] as const) {
    const ours = bcryptPbkdf(Buffer.from(pw, "utf8"), Buffer.from(salt, "utf8"), len, rounds).toString("hex");
    if (pw === "") { ok(ours.length === len * 2, "empty-pass length"); continue; } // python bcrypt rejects an empty password; OpenBSD's allows it
    const theirs = execFileSync(PY, ["-W", "ignore", "-c", "import bcrypt,sys; print(bcrypt.kdf(sys.argv[1].encode(), sys.argv[2].encode(), int(sys.argv[3]), int(sys.argv[4]), ignore_few_rounds=True).hex())", pw || "", salt, String(len), String(rounds)], { encoding: "utf8" }).trim();
    ok(ours === theirs, `bcrypt_pbkdf(${JSON.stringify(pw)}, ${salt}, ${len}, ${rounds}): ${ours} vs ${theirs}`);
  }
});

await test("Poly1305 (13-bit limbs) == cryptography's Poly1305 on 40 random (key, message) pairs incl. block edges", { "TD-03": "partial" }, async () => {
  const cases = Array.from({ length: 40 }, (_, i) => ({ k: randomBytes(32), m: randomBytes([0, 1, 15, 16, 17, 31, 32, 33, 64, 1000][i % 10] + (i >= 10 ? (i * 37) % 300 : 0)) }));
  cases.push({ k: Buffer.alloc(32, 0xff), m: Buffer.alloc(64, 0xff) }); // carries everywhere
  const py = execFileSync(PY, ["-c", "import sys,json\nfrom cryptography.hazmat.primitives.poly1305 import Poly1305\nfor l in sys.stdin:\n k,m=l.split()\n print(Poly1305.generate_tag(bytes.fromhex(k), bytes.fromhex(m if m!='-' else '')).hex())"], { input: cases.map((c) => `${c.k.toString("hex")} ${c.m.toString("hex") || "-"}`).join("\n") + "\n", encoding: "utf8" }).trim().split("\n");
  cases.forEach((c, i) => ok(poly1305(c.k, c.m).toString("hex") === py[i], `case ${i} (len ${c.m.length})`));
});

await test("OpenSSH key files written by ssh-keygen: encrypted ed25519 (bcrypt+aes256-ctr), RSA-3072 (aes256-gcm), ECDSA-384, PEM P-521", { "TD-03": "partial" }, async () => {
  for (const [f, k] of [["ked", keys.ed], ["kec", keys.ec], ["krsa", keys.rsa], ["kpem", keys.pem]] as const) {
    const pub = readFileSync(`${D}/${f}.pub`, "utf8").trim().split(" ");
    ok(publicLine(k.publicBlob) === `${pub[0]} ${pub[1]}`, `${f}: public blob differs from ssh-keygen's .pub`);
  }
  ok(keys.ed.comment === "ed-enc" && keys.rsa.comment === "rsa-gcm", "comments");
  const e1 = await fail(async () => parsePrivateKey(readFileSync(`${D}/ked`, "utf8")));
  const e2 = await fail(async () => parsePrivateKey(readFileSync(`${D}/ked`, "utf8"), "wrong"));
  const e3 = await fail(async () => parsePrivateKey(readFileSync(`${D}/krsa`, "utf8"), "wrong"));
  ok(e1.code === "passphrase-needed" && e2.code === "bad-passphrase" && e3.code === "bad-passphrase", `codes ${e1.code} ${e2.code} ${e3.code}`);
  // a tampered file: flip a byte inside the public section → refused, never a key that differs from what it claims
  const txt = readFileSync(`${D}/kec`, "utf8");
  const b = Buffer.from(txt.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"); b[80] ^= 1;
  const e4 = await fail(async () => parsePrivateKey(`-----BEGIN OPENSSH PRIVATE KEY-----\n${b.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----`));
  ok(e4.code === "malformed", `tampered key: ${e4.code} ${e4.message}`);
  ok((await fail(async () => parsePrivateKey("PuTTY-User-Key-File-3: ssh-ed25519\n"))).code === "unsupported", "ppk");
});

await test("generated ed25519 keys (plain and passphrase-encrypted) are read by ssh-keygen and sign for real logins", { "TD-03": "partial" }, async () => {
  for (const pw of ["", "gen pass ✓"]) {
    const g = generateEd25519("gen@fusion", pw || undefined);
    writeFileSync(`${D}/gen`, g.privateKey, { mode: 0o600 });
    const y = execFileSync("ssh-keygen", ["-y", "-P", pw, "-f", `${D}/gen`], { encoding: "utf8" }).trim();
    ok(y.split(" ").slice(0, 2).join(" ") === g.publicKey.trim().split(" ").slice(0, 2).join(" "), `ssh-keygen -y disagrees (pw=${!!pw})`);
    ok(parsePrivateKey(g.privateKey, pw || undefined).comment === "gen@fusion", "round trip");
  }
});

// ------------------------------------------------------------------------------------------- transport matrix
await test("every KEX × cipher × MAC × host-key algorithm negotiates with asyncssh and runs a command", { "TD-03": "partial" }, async () => {
  const hk = ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256"];
  const combos: { kex: string; cipher: string; mac?: string; hk: string }[] = [];
  KEX_ALGS.forEach((kex, i) => combos.push({ kex, cipher: CIPHERS[i % CIPHERS.length].name, hk: hk[i % hk.length], mac: MACS[i % MACS.length].name }));
  for (const c of CIPHERS) for (const m of c.aead ? [undefined] : MACS.map((x) => x.name)) combos.push({ kex: "curve25519-sha256", cipher: c.name, mac: m, hk: "ssh-ed25519" });
  const fps: Record<string, string> = {};
  for (const f of ["hk_ed25519", "hk_ecdsa", "hk_rsa"]) fps[f] = kg("-l", "-E", "sha256", "-f", `${D}/${f}.pub`).split(" ")[1];
  const seen: string[] = [];
  for (const k of combos) {
    let fp = "";
    const c = await dial(port, { kex: [k.kex], ciphers: [k.cipher], macs: k.mac ? [k.mac] : undefined, hostKeyAlgs: [k.hk], verifyHostKey: async (h) => { fp = h.fingerprint; return true; } });
    const n = c.negotiated!;
    ok(n.kex === k.kex && n.c2s === k.cipher && n.s2c === k.cipher && n.hostKey === k.hk && n.strict, `negotiated ${JSON.stringify(n)} for ${JSON.stringify(k)}`);
    if (k.mac && !CIPHERS.find((x) => x.name === k.cipher)!.aead) ok(n.macC2s === k.mac, `mac ${n.macC2s} != ${k.mac}`);
    const want = fps[k.hk === "ssh-ed25519" ? "hk_ed25519" : k.hk.startsWith("ecdsa") ? "hk_ecdsa" : "hk_rsa"];
    ok(fp === want, `fingerprint ${fp} != ssh-keygen ${want}`);
    const r = await run(c, `echo ${k.kex}/${k.cipher}`);
    ok(r.out.toString() === `${k.kex}/${k.cipher}\n` && (r.exit as { code: number }).code === 0, `output ${JSON.stringify(r.out.toString())}`);
    c.end(); seen.push(`${k.kex}|${k.cipher}|${k.mac ?? "aead"}|${k.hk}`);
  }
  ok(seen.length === combos.length && combos.length === 10 + 3 + 2 * 4, `${seen.length} combos`); // 10 KEX methods (TT45 added the 3 ML-KEM hybrids)
});

// ------------------------------------------------------------------------------------------- authentication
await test("auth: password (retry after a wrong one), banner, every public key type, keyboard-interactive, all-fail", { "TD-03": "partial" }, async () => {
  let tries = 0, banner = "";
  const c1 = await dial(port, { auth: { password: async ({ attempt }) => { tries = attempt; return attempt === 1 ? "nope" : "pw1"; }, banner: (t) => { banner = t; } } });
  ok(c1.authMethod === "password" && tries === 2 && banner === "Authorized use only\n", `password: ${c1.authMethod} tries=${tries} banner=${JSON.stringify(banner)}`); c1.end();
  for (const [name, k] of Object.entries(keys)) {
    const c = await dial(port, { username: "bob", auth: { keys: [k] } });
    ok(c.authMethod === "publickey", `${name}: ${c.authMethod}`);
    ok((await run(c, "echo k")).out.toString() === "k\n", `${name}: session`); c.end();
  }
  // a key the server does not know, then the right one: the second is used
  const stranger = parsePrivateKey(readFileSync(`${D}/kstranger`, "utf8"));
  const c2 = await dial(port, { username: "bob", auth: { keys: [stranger, keys.ec] } }); ok(c2.authMethod === "publickey", "second key"); c2.end();
  let prompts: string[] = [];
  const c3 = await dial(port, { username: "kbd", auth: { keyboardInteractive: async (r) => { prompts = r.prompts.map((p) => `${p.prompt}|${p.echo}`); return ["4242", "7"]; } } });
  ok(c3.authMethod === "keyboard-interactive" && prompts.join(",") === "code: |true,pin: |false", `kbd: ${c3.authMethod} ${prompts}`); c3.end();
  const e = await fail(() => dial(port, { username: "bob", auth: { keys: [stranger], password: async () => "x" } }));
  ok(e.code === "auth-failed", `all-fail code ${e.code}: ${e.message}`);
  const e2 = await fail(() => dial(port, { auth: { password: async () => null } }));
  ok(e2.code === "auth-cancelled", `cancel code ${e2.code}`);
});

await test("host key: a rejection (unknown / changed) aborts BEFORE authentication; nothing is sent after", { "TD-03": "partial" }, async () => {
  let pwAsked = false;
  const e = await fail(() => dial(port, { verifyHostKey: async () => false, auth: { password: async () => { pwAsked = true; return "pw1"; } } }));
  ok(e.code === "hostkey-rejected" && !pwAsked, `${e.code} pwAsked=${pwAsked}`);
});

// ------------------------------------------------------------------------------------------- sessions
await test("pty shell: TERM/size/env reach the server, typed lines echo, window-change resizes, exit status 3", { "TD-03": "partial" }, async () => {
  const c = await dial(port);
  const ch = await c.openSession();
  let out = ""; ch.on("data", (d: Buffer) => { out += d.toString(); });
  const ex = new Promise<{ code: number }>((r) => ch.on("exit", r as (x: unknown) => void));
  ok(await ch.env("LANG", "en_US.UTF-8"), "env refused");
  ok(await ch.pty("xterm-256color", 100, 30), "pty refused"); ok(await ch.shell(), "shell refused");
  const until = async (s: string) => { const t = Date.now(); while (!out.includes(s)) { if (Date.now() - t > 5000) throw new Error(`timeout waiting for ${s}: ${JSON.stringify(out)}`); await new Promise((r) => setTimeout(r, 20)); } };
  await until("WELCOME TERM=xterm-256color COLS=100 ROWS=30 ENV=en_US.UTF-8");
  ch.write("héllo wörld\r"); await until("YOU SAID [héllo wörld]");
  ch.resize(120, 40); await until("RESIZED 120x40");
  ch.write("size\r"); await until("SIZE 120x40");
  ch.write("exit\r");
  ok((await ex).code === 3, "exit status");
  c.end();
});

await test("exec: exit codes, stderr, signals (exit-signal), unknown command 127, several channels at once", { "TD-03": "partial" }, async () => {
  const c = await dial(port);
  const [a, b, e] = await Promise.all([run(c, "exit 42"), run(c, "big-stderr 100000"), run(c, "nosuch")]);
  ok((a.exit as { code: number }).code === 42, "exit 42");
  ok(b.err.length === 100000 && b.err.every((x) => x === 69), `stderr ${b.err.length}`);
  ok((e.exit as { code: number }).code === 127 && e.err.toString().includes("unknown"), "127");
  const ch = await c.openSession(); let out = "";
  ch.on("data", (d: Buffer) => { out += d; });
  const ex = new Promise<{ signal: string }>((r) => ch.on("exit", r as (x: unknown) => void));
  await ch.exec("sigwait");
  for (let i = 0; i < 100 && !out.includes("waiting"); i++) await new Promise((r) => setTimeout(r, 20));
  ch.signal("SIGTERM");
  ok((await ex).signal === "TERM" && out.includes("GOT TERM"), `signal: ${out}`);
  c.end();
});

await test("10 MiB each way with flow control: download hash == server's, upload hash == server's; stats count it", { "TD-03": "partial" }, async () => {
  const c = await dial(port);
  const N = 10 * 1024 * 1024;
  const t0 = Date.now();
  const d = await run(c, `gen ${N}`);
  ok(d.out.length === N && createHash("sha256").update(d.out).digest("hex") === d.err.toString().trim(), `download ${d.out.length}`);
  const up = randomBytes(N);
  const u = await run(c, "sink", up);
  ok(u.out.toString().trim() === `${N} ${createHash("sha256").update(up).digest("hex")}`, `upload: ${u.out}`);
  ok(c.stats.bytesIn > N && c.stats.bytesOut > N, "stats");
  console.log(`    20 MiB round trip in ${Date.now() - t0} ms`);
  c.end();
});

await test("rekeying: server-initiated (every 1 MiB) and client-initiated (every 512 KiB) during 10 MiB transfers, strict KEX", { "TD-03": "partial" }, async () => {
  const c = await dial(portRekey);
  const N = 10 * 1024 * 1024;
  const d = await run(c, `gen ${N}`);
  ok(createHash("sha256").update(d.out).digest("hex") === d.err.toString().trim(), "data intact across server rekeys");
  ok(c.stats.kexCount >= 5, `server-initiated rekeys: ${c.stats.kexCount}`); c.end();
  const c2 = await dial(port, { rekeyBytes: 512 * 1024 });
  const up = randomBytes(N);
  const u = await run(c2, "sink", up);
  ok(u.out.toString().trim() === `${N} ${createHash("sha256").update(up).digest("hex")}`, "upload intact across client rekeys");
  console.log(`    rekeys: server-initiated ${c.stats.kexCount}, client-initiated ${c2.stats.kexCount}`);
  // bound: a rekey starts once ≥ rekeyBytes went out under the current keys; data already queued keeps flowing meanwhile
  // (≤ one 2 MiB channel window), so ≥ N / (rekeyBytes + window) exchanges — measured ~1 per MiB here
  ok(c2.stats.kexCount >= Math.floor(N / (512 * 1024 + 2 * 1024 * 1024)) + 1 && c2.stats.kexCount >= 8 && c2.negotiated!.strict, `client-initiated rekeys: ${c2.stats.kexCount}`);
  c2.end();
});

// ------------------------------------------------------------------------------------------- SFTP
await test("SFTP v3: realpath, mkdir, 3 MiB pipelined upload/download byte-identical, stat, list, rename, symlink, errors", { "TD-03": "partial" }, async () => {
  const c = await dial(port);
  const s = await SftpClient.open(c);
  ok(s.version === 3, `version ${s.version}`);
  ok((await s.realpath(".")) === "/", "realpath");
  await s.mkdir("/dir1");
  const data = randomBytes(3 * 1024 * 1024 + 12345);
  const n = await s.upload("/dir1/blob.bin", (async function* () { for (let i = 0; i < data.length; i += 100000) yield data.subarray(i, i + 100000); })());
  ok(n === data.length && readFileSync(`${ROOT}/dir1/blob.bin`).equals(data), "upload bytes on disk");
  const parts: Buffer[] = [];
  const m = await s.download("/dir1/blob.bin", (b) => { parts.push(b); });
  ok(m === data.length && Buffer.concat(parts).equals(data), "download bytes");
  ok((await s.stat("/dir1/blob.bin")).size === data.length && (await s.stat("/dir1")).isDir, "stat");
  writeFileSync(`${ROOT}/dir1/empty`, "");
  const e0: Buffer[] = []; ok((await s.download("/dir1/empty", (b) => { e0.push(b); })) === 0, "empty file");
  await s.rename("/dir1/blob.bin", "/dir1/moved.bin");
  ok(existsSync(`${ROOT}/dir1/moved.bin`) && !existsSync(`${ROOT}/dir1/blob.bin`), "rename");
  // argument order checked on disk (a relative target): the link is /dir1/link and points at moved.bin
  await s.symlink("moved.bin", "/dir1/link");
  ok(readlinkSync(`${ROOT}/dir1/link`) === "moved.bin", `symlink on disk -> ${readlinkSync(`${ROOT}/dir1/link`)}`);
  ok((await s.lstat("/dir1/link")).isLink && (await s.stat("/dir1/link")).size === data.length, "lstat sees a link, stat follows it");
  // READLINK round trip with an absolute in-root target (asyncssh's chroot cannot reverse-map RELATIVE targets — an
  // oracle quirk: it realpath()s them against its own cwd)
  await s.symlink("/dir1/moved.bin", "/dir1/abs");
  ok((await s.readlink("/dir1/abs")) === "/dir1/moved.bin", "readlink");
  const names = (await s.list("/dir1")).map((e) => e.name).sort();
  ok(names.join(",") === "abs,empty,link,moved.bin", `list ${names}`);
  await s.chmod("/dir1/moved.bin", 0o600);
  ok((statSync(`${ROOT}/dir1/moved.bin`).mode & 0o777) === 0o600, "chmod");
  const big: Buffer[] = [];
  const lim = await fail(() => s.download("/dir1/moved.bin", (b) => { big.push(b); }, 1024 * 1024));
  ok(/limit/.test(lim.message) && Buffer.concat(big).length <= 1024 * 1024, "limit enforced");
  const nf = await fail(() => s.stat("/nope"));
  ok(nf instanceof SftpError && (nf as SftpError).code === FX.NO_SUCH_FILE, `no such file: ${nf.message} ${(nf as SftpError).code} ${nf instanceof SftpError}`);
  const ne = await fail(() => s.rmdir("/dir1"));
  ok(ne instanceof SftpError, "rmdir non-empty fails");
  for (const f of ["abs", "empty", "link", "moved.bin"]) await s.remove(`/dir1/${f}`);
  await s.rmdir("/dir1"); ok(!existsSync(`${ROOT}/dir1`), "rmdir");
  // the session still works alongside SFTP
  ok((await run(c, "echo still")).out.toString() === "still\n", "shell after sftp");
  s.close(); c.end();
});

// ------------------------------------------------------------------------------------------- hostile network
/** a TCP man-in-the-middle between client and server; `tamper` may rewrite server→client chunks */
async function mitm(target: number, tamper: (chunk: Buffer, total: number) => Buffer): Promise<{ port: number; close: () => void }> {
  const srv = createServer((cs) => {
    const ss = connect(target, "127.0.0.1"); let total = 0;
    ss.on("data", (d: Buffer) => { const out = tamper(d, total); total += d.length; cs.write(out); });
    cs.on("data", (d) => ss.write(d));
    const end = () => { cs.destroy(); ss.destroy(); }; cs.on("close", end); ss.on("close", end); cs.on("error", end); ss.on("error", end);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as { port: number }).port, close: () => srv.close() };
}
/** an unencrypted binary packet (RFC 4253 §6): block 8, at least 4 padding bytes */
const plainPkt = (payload: Buffer) => { let pad = 8 - ((5 + payload.length) % 8); if (pad < 4) pad += 8; const b = Buffer.alloc(5 + payload.length + pad); b.writeUInt32BE(b.length - 4); b[4] = pad; payload.copy(b, 5); return b; };
const IGNORE_PKT = plainPkt(new SshWriter().byte(2).string("").build());

await test("Terrapin-style injection: an IGNORE before the server's KEXINIT aborts a strict-KEX session (accepted only when strict is off)", { "TD-03": "partial" }, async () => {
  let injected = false;
  const m = await mitm(port, (d) => {
    if (injected) return d;
    const i = d.indexOf("\r\n"); if (i < 0) return d;
    injected = true;
    return Buffer.concat([d.subarray(0, i + 2), IGNORE_PKT, d.subarray(i + 2)]);
  });
  const e = await fail(() => dial(m.port));
  ok(e.code === "strict-kex", `strict: ${e.code} ${e.message}`);
  injected = false;
  const c = await dial(m.port, { offerStrict: false });
  ok(!c.negotiated!.strict && injected, "non-strict accepted the injected IGNORE (the gap strict KEX closes)");
  c.end(); m.close();
});

await test("strict KEX: an IGNORE injected AFTER the server's KEXINIT (inside the initial key exchange) aborts with strict-kex", { "TD-03": "partial" }, async () => {
  // hold server bytes until the identification line and the whole first (KEXINIT) packet are buffered, then inject
  let acc = Buffer.alloc(0), done = false;
  const m = await mitm(port, (d) => {
    if (done) return d;
    acc = Buffer.concat([acc, d]);
    const i = acc.indexOf("\r\n"); if (i < 0 || acc.length < i + 6) return Buffer.alloc(0);
    const end = i + 2 + 4 + acc.readUInt32BE(i + 2); if (acc.length < end) return Buffer.alloc(0);
    ok(acc[i + 2 + 5] === 20, "the first server packet is KEXINIT"); done = true;
    return Buffer.concat([acc.subarray(0, end), IGNORE_PKT, acc.subarray(end)]);
  });
  const e = await fail(() => dial(m.port));
  ok(done && e.code === "strict-kex", `strict: ${e.code} ${e.message}`);
  m.close();
});

await test("a different host key presented at a REKEY aborts the session (hostkey-changed), even though that key belongs to the same server", { "TD-03": "partial" }, async () => {
  // the oracle holds ed25519 + ecdsa + rsa keys; the client prefers ed25519 at first contact and only ecdsa on rekeys
  const c = await dial(port, { hostKeyAlgs: ["ssh-ed25519"], rekeyHostKeyAlgs: ["ecdsa-sha2-nistp256"], rekeyBytes: 256 * 1024 });
  ok(c.hostKey!.alg === "ssh-ed25519", `first key ${c.hostKey!.alg}`);
  const closed = new Promise<{ code?: string } | null>((r) => c.once("close", r));
  void run(c, "sink", randomBytes(4 * 1024 * 1024)).catch(() => undefined); // uploads drive client-initiated rekeys
  const err = await Promise.race([closed, new Promise<{ code: string }>((r) => setTimeout(() => r({ code: "no-close-in-20s" }), 20000))]);
  ok(err?.code === "hostkey-changed", `close code ${err?.code}`);
  const c2 = await dial(port, { hostKeyAlgs: ["ssh-ed25519"], rekeyBytes: 256 * 1024 });
  const up = randomBytes(1024 * 1024); const r2 = await run(c2, "sink", up);
  ok(r2.out.toString().trim() === `${up.length} ${createHash("sha256").update(up).digest("hex")}` && c2.stats.kexCount >= 2, `control: the same key on rekey works (${c2.stats.kexCount} kex)`); c2.end();
});

await test("MAC / AEAD tampering: one flipped bit after the handshake kills the connection for every cipher+MAC mode; no corrupted byte is delivered", { "TD-03": "partial" }, async () => {
  const modes: { ciphers: string[]; macs?: string[] }[] = [
    { ciphers: ["aes128-gcm@openssh.com"] }, { ciphers: ["aes256-gcm@openssh.com"] }, { ciphers: ["chacha20-poly1305@openssh.com"] },
    { ciphers: ["aes128-ctr"], macs: ["hmac-sha2-256-etm@openssh.com"] }, { ciphers: ["aes256-ctr"], macs: ["hmac-sha2-512"] },
  ];
  for (const md of modes) {
    let armed = false, flipped = false;
    const m = await mitm(port, (d) => { if (armed && !flipped && d.length > 40) { flipped = true; const x = Buffer.from(d); x[x.length - 20] ^= 0x04; return x; } return d; });
    const c = await dial(m.port, md);
    const ch = await c.openSession(); const got: Buffer[] = [];
    ch.on("data", (b: Buffer) => got.push(b));
    const closed = new Promise<{ code?: string } | null>((r) => c.once("close", r));
    armed = true;
    await ch.exec("gen 2000000");
    const err = await closed;
    ok(flipped && err?.code === "mac", `${md.ciphers[0]}: close code ${err?.code} flipped=${flipped}`);
    // whatever was delivered is a prefix of the true stream (the server's generator is deterministic)
    const all = Buffer.concat(got);
    const truth: Buffer[] = []; let n = all.length, i = 0;
    while (n > 0) { const ch2 = Buffer.concat(Array(1024).fill(createHash("sha256").update(String(i)).digest())); truth.push(ch2.subarray(0, Math.min(n, ch2.length))); n -= ch2.length; i++; }
    ok(Buffer.concat(truth).equals(all), `${md.ciphers[0]}: delivered bytes are not a clean prefix`);
    m.close();
  }
});

await test("a server sending an all-zero curve25519 point is refused (RFC 8731 §3), before any signature work", { "TD-03": "partial" }, async () => {
  // fake server: version + KEXINIT, then answers KEX_ECDH_INIT with Q_S = 0^32
  const srv = createServer((s) => {
    s.write("SSH-2.0-Evil_1.0\r\n");
    const ki = new SshWriter().byte(20).raw(randomBytes(16)).nameList(["curve25519-sha256"]).nameList(["ssh-ed25519"]).nameList(["aes128-ctr"]).nameList(["aes128-ctr"]).nameList(["hmac-sha2-256"]).nameList(["hmac-sha2-256"]).nameList(["none"]).nameList(["none"]).nameList([]).nameList([]).bool(false).u32(0).build();
    const pkt = (payload: Buffer) => { let pad = 8 - ((5 + payload.length) % 8); if (pad < 4) pad += 8; const b = Buffer.alloc(5 + payload.length + pad); b.writeUInt32BE(b.length - 4); b[4] = pad; payload.copy(b, 5); return b; };
    let buf = Buffer.alloc(0), sawVersion = false, n = 0;
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!sawVersion) { const i = buf.indexOf("\n"); if (i < 0) return; sawVersion = true; buf = buf.subarray(i + 1); s.write(pkt(ki)); }
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0); const type = buf[5]; buf = buf.subarray(4 + len); n++;
        if (type === 30) {
          const hostBlob = new SshWriter().string("ssh-ed25519").string(randomBytes(32)).build();
          s.write(pkt(new SshWriter().byte(31).string(hostBlob).string(Buffer.alloc(32)).string(new SshWriter().string("ssh-ed25519").string(randomBytes(64)).build()).build()));
        }
      }
    });
    s.on("error", () => undefined);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  let asked = false;
  const e = await fail(() => dial((srv.address() as { port: number }).port, { verifyHostKey: async () => { asked = true; return true; } }));
  ok(e.code === "kex" && /zero|low.order|invalid/i.test(e.message) && !asked, `${e.code}: ${e.message} asked=${asked}`);
  srv.close();
});

// ------------------------------------------------------------------------------------------- known_hosts
await test("known_hosts: plain, [host]:port, wildcard/negation, @revoked, @cert-authority ignored; hashed by ssh-keygen -H is matched", { "TD-03": "partial" }, async () => {
  const ed = readFileSync(`${D}/hk_ed25519.pub`, "utf8").trim().split(" "), ec = readFileSync(`${D}/hk_ecdsa.pub`, "utf8").trim().split(" ");
  const edBlob = Buffer.from(ed[1], "base64"), ecBlob = Buffer.from(ec[1], "base64"), strangerBlob = Buffer.from(readFileSync(`${D}/kstranger.pub`, "utf8").split(" ")[1], "base64");
  let kh = addHostKey("", "Example.COM", 22, edBlob);
  kh = addHostKey(kh, "10.0.0.5", 2222, ecBlob, "lab box");
  kh += `*.corp.test,!bad.corp.test ${ed[0]} ${ed[1]}\n@cert-authority *.corp.test ${ec[0]} ${ec[1]}\n`;
  ok(parseKnownHosts(`${kh}garbage line\n`).bad.length === 1, "a malformed line is reported");
  ok(parseKnownHosts(kh).entries.length === 4 && parseKnownHosts(kh).bad.length === 0, `parse ${JSON.stringify(parseKnownHosts(kh).bad)}`);
  ok(checkHostKey(kh, "example.com", 22, edBlob).status === "known", "plain known (case-insensitive)");
  ok(checkHostKey(kh, "example.com", 2200, edBlob).status === "unknown", "port matters");
  ok(checkHostKey(kh, "10.0.0.5", 2222, ecBlob).status === "known", "[host]:port");
  ok(checkHostKey(kh, "example.com", 22, strangerBlob).status === "changed", "same type, different key = changed");
  const other = checkHostKey(kh, "example.com", 22, ecBlob);
  ok(other.status === "unknown" && other.knownTypes.join() === "ssh-ed25519", "other key type = unknown with knownTypes");
  ok(checkHostKey(kh, "a.corp.test", 22, edBlob).status === "known" && checkHostKey(kh, "bad.corp.test", 22, edBlob).status === "unknown", "wildcard + negation");
  ok(checkHostKey(kh, "z.corp.test", 22, ecBlob).status === "unknown", "@cert-authority is not a host key");
  ok(checkHostKey(`${kh}@revoked * ${ed[0]} ${ed[1]}\n`, "example.com", 22, edBlob).status === "revoked", "revoked wins");
  const f = forgetHost(kh, "example.com", 22); ok(f.removed === 1 && checkHostKey(f.text, "example.com", 22, edBlob).status === "unknown" && checkHostKey(f.text, "a.corp.test", 22, edBlob).status === "known", "forget");
  writeFileSync(`${D}/kh`, kh.split("\n").filter((l) => !l.startsWith("@") && !l.startsWith("*")).join("\n")); execFileSync("ssh-keygen", ["-H", "-f", `${D}/kh`], { stdio: "pipe" });
  const hashed = readFileSync(`${D}/kh`, "utf8");
  ok(hashed.includes("|1|") && !hashed.includes("example.com"), "ssh-keygen hashed it");
  ok(checkHostKey(hashed, "example.com", 22, edBlob).status === "known" && checkHostKey(hashed, "10.0.0.5", 2222, ecBlob).status === "known" && checkHostKey(hashed, "10.0.0.5", 22, ecBlob).status === "unknown", "hashed entries");
  ok(hostFieldMatches("|1|AAAA|BBBB", "x", 22) === false, "junk hash");
});

for (const p of servers) p.kill();
await finish();
process.exit(0);
