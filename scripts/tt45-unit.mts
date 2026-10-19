/**
 * TT45 — ML-KEM (FIPS 203) and the post-quantum hybrid SSH key exchanges, against INDEPENDENT oracles:
 *   - NIST ACVP vectors (usnistgov/ACVP-Server gen-val/json-files/ML-KEM-*-FIPS203/internalProjection.json), fetched
 *     from api.github.com into TOOLS_DIR/acvp when missing: keyGen, encapsulation, decapsulation (incl. modified
 *     ciphertexts → implicit rejection), ek / dk input checks;
 *   - OpenSSL's ML-KEM through python `cryptography` (scripts/oracle/mlkem_oracle.py): keys from the same seed,
 *     encapsulation in one implementation and decapsulation in the other, both directions;
 *   - asyncssh (its hybrid KEX uses that same OpenSSL ML-KEM) as the SSH server: mlkem768x25519-sha256,
 *     mlkem768nistp256-sha256, mlkem1024nistp384-sha384 end to end, plus hostile replies from a man in the middle.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { makeHarness } from "./harness.mts";
import * as K from "../src/lib/server/ssh/mlkem.ts";
import { connect, createServer, type Socket } from "node:net";
import { execFileSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { SshClient, type SshClientOptions } from "../src/lib/server/ssh/transport.ts";
import { SshReader, SshWriter } from "../src/lib/server/ssh/wire.ts";

const { test, finish } = makeHarness("tt45-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const COV = { "TD-03": "full" } as const;
const TOOLS = process.env.TOOLS_DIR ?? "/home/user/tools";
const PY = `${TOOLS}/venv/bin/python`;
const hex = (s: string) => Buffer.from(s, "hex");
const SETS: Record<string, K.MlKemParams> = { "ML-KEM-512": K.ML_KEM_512, "ML-KEM-768": K.ML_KEM_768, "ML-KEM-1024": K.ML_KEM_1024 };

function acvp(name: string): { testGroups: { tgId: number; parameterSet: string; function?: string; tests: Record<string, unknown>[] }[] } {
  const dir = `${TOOLS}/acvp`, f = `${dir}/${name}.json`;
  if (!existsSync(f)) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("curl", ["-sSf", "-H", "Accept: application/vnd.github.raw", "-o", f, `https://api.github.com/repos/usnistgov/ACVP-Server/contents/gen-val/json-files/${name}/internalProjection.json`]);
    if (r.status !== 0) throw new Error(`could not fetch ACVP ${name}: ${r.stderr}`);
  }
  return JSON.parse(readFileSync(f, "utf8"));
}
function oracle(ops: Record<string, unknown>[]): Record<string, string>[] {
  const r = spawnSync(PY, ["scripts/oracle/mlkem_oracle.py"], { input: JSON.stringify(ops), maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return JSON.parse(String(r.stdout));
}

await test("constants: ζ = 17 has order 256 mod 3329; 20 random ML-KEM-768 key / encaps / decaps round trips agree", COV, () => {
  let x = 1, order = 0; do { x = (x * 17) % 3329; order++; } while (x !== 1);
  ok(order === 256, `order of 17 is ${order}`);
  // round trip through the public API: decrypting our own encryption recovers m for many random messages
  for (let i = 0; i < 20; i++) {
    const { ek, dk } = K.keyGen(K.ML_KEM_768); const { ss, ct } = K.encaps(K.ML_KEM_768, ek);
    ok(K.decaps(K.ML_KEM_768, dk, ct).equals(ss), "self round trip");
  }
});

await test("ACVP keyGen: all 75 (d, z) → (ek, dk) vectors for ML-KEM-512/768/1024 are byte-identical", COV, () => {
  let n = 0;
  for (const g of acvp("ML-KEM-keyGen-FIPS203").testGroups) for (const t of g.tests) {
    const r = K.keyGenInternal(SETS[g.parameterSet], hex(t.d as string), hex(t.z as string));
    ok(r.ek.equals(hex(t.ek as string)) && r.dk.equals(hex(t.dk as string)), `${g.parameterSet} tc ${t.tcId}`); n++;
  }
  ok(n === 75, `${n} vectors`);
});

await test("ACVP encapsulation (75: ek, m → c, K), decapsulation (30, incl. modified ciphertexts → implicit rejection K̄), key checks (60)", COV, () => {
  const c = { enc: 0, dec: 0, rej: 0, ek: 0, dk: 0 };
  for (const g of acvp("ML-KEM-encapDecap-FIPS203").testGroups) {
    const p = SETS[g.parameterSet];
    for (const t of g.tests) {
      if (g.function === "encapsulation") {
        const r = K.encapsInternal(p, hex(t.ek as string), hex(t.m as string));
        ok(r.ct.equals(hex(t.c as string)) && r.ss.equals(hex(t.k as string)), `encap ${g.parameterSet} tc ${t.tcId}`); c.enc++;
      } else if (g.function === "decapsulation") {
        const ss = K.decaps(p, hex(t.dk as string), hex(t.c as string));
        ok(ss.equals(hex(t.k as string)), `decap ${g.parameterSet} tc ${t.tcId} (${t.reason})`); c.dec++;
        if (String(t.reason ?? "").toLowerCase().includes("modif")) c.rej++;
      } else if (g.function === "encapsulationKeyCheck") {
        ok(K.checkEncapsulationKey(p, hex(t.ek as string)) === t.testPassed, `ek check ${g.parameterSet} tc ${t.tcId} (${t.reason})`); c.ek++;
      } else if (g.function === "decapsulationKeyCheck") {
        ok(K.checkDecapsulationKey(p, hex(t.dk as string)) === t.testPassed, `dk check ${g.parameterSet} tc ${t.tcId} (${t.reason})`); c.dk++;
      }
    }
  }
  console.log(`   encap ${c.enc}, decap ${c.dec} (modified-ciphertext cases ${c.rej}), ek checks ${c.ek}, dk checks ${c.dk}`);
  ok(c.enc === 75 && c.dec === 30 && c.ek === 30 && c.dk === 30, JSON.stringify(c));
});

await test("OpenSSL ML-KEM (python cryptography) agrees: same seed → same ek; encaps in one, decaps in the other, both directions (768 and 1024, 40 runs each)", COV, () => {
  for (const [set, p] of [[768, K.ML_KEM_768], [1024, K.ML_KEM_1024]] as const) {
    const seeds = Array.from({ length: 40 }, () => randomBytes(64));
    const ours = seeds.map((s) => K.keyGenInternal(p, s.subarray(0, 32), s.subarray(32)));
    const pubs = oracle(seeds.map((s) => ({ op: "pub", set, seed: s.toString("hex") })));
    pubs.forEach((r, i) => ok(r.ek === ours[i].ek.toString("hex"), `${set}: ek from seed ${i}`));
    const theirEnc = oracle(ours.map((o) => ({ op: "encap", set, ek: o.ek.toString("hex") })));
    theirEnc.forEach((r, i) => ok(K.decaps(p, ours[i].dk, hex(r.ct)).equals(hex(r.ss)), `${set}: OpenSSL encaps → our decaps ${i}`));
    const ourEnc = ours.map((o) => K.encaps(p, o.ek));
    const theirDec = oracle(ourEnc.map((e, i) => ({ op: "decap", set, seed: seeds[i].toString("hex"), ct: e.ct.toString("hex") })));
    theirDec.forEach((r, i) => ok(r.ss === ourEnc[i].ss.toString("hex"), `${set}: our encaps → OpenSSL decaps ${i}`));
    // a tampered ciphertext: both implementations return the SAME implicit-rejection key (J(z‖c)), not an error
    const bad = Buffer.from(ourEnc[0].ct); bad[7] ^= 1;
    const tr = oracle([{ op: "decap", set, seed: seeds[0].toString("hex"), ct: bad.toString("hex") }])[0];
    const mine = K.decaps(p, ours[0].dk, bad);
    ok(tr.ss === mine.toString("hex") && !mine.equals(ourEnc[0].ss), `${set}: implicit rejection agrees`);
  }
});

await test("D: inputs outside the contract are refused — wrong lengths, an ek coefficient ≥ q, a dk with a broken H(ek), d/z of the wrong size", COV, () => {
  const p = K.ML_KEM_768; const { ek, dk } = K.keyGen(p);
  const throws = (f: () => unknown, re: RegExp, m: string) => { try { f(); } catch (e) { ok(re.test((e as Error).message), `${m}: ${(e as Error).message}`); return; } throw new Error(`${m}: accepted`); };
  throws(() => K.encaps(p, ek.subarray(1)), /§7\.2/, "short ek");
  const big = Buffer.from(ek); big[0] = 0xff; big[1] |= 0x0f; // first coefficient = 4095 ≥ q
  ok(!K.checkEncapsulationKey(p, big), "coefficient ≥ q passes the modulus check"); throws(() => K.encaps(p, big), /§7\.2/, "ek with 4095");
  const { ct } = K.encaps(p, ek);
  throws(() => K.decaps(p, dk, ct.subarray(1)), /wrong length/, "short ciphertext");
  const dkBad = Buffer.from(dk); dkBad[768 * 3 + 40] ^= 1; throws(() => K.decaps(p, dkBad, ct), /§7\.3/, "dk with a broken hash");
  throws(() => K.keyGenInternal(p, randomBytes(31), randomBytes(32)), /32 bytes/, "31-byte d");
  ok(createHash("sha256").update(K.keyGenInternal(p, Buffer.alloc(32), Buffer.alloc(32)).ek).digest("hex") === createHash("sha256").update(K.keyGenInternal(p, Buffer.alloc(32), Buffer.alloc(32)).ek).digest("hex"), "deterministic from seeds");
});

// ------------------------------------------------------------------------------------- SSH hybrid key exchange
const D = "/tmp/tt45-keys", ROOT = "/tmp/tt45-sftproot";
rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true }); mkdirSync(ROOT, { recursive: true });
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${D}/hk`]);
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${D}/user`]);
writeFileSync(`${D}/authkeys`, readFileSync(`${D}/user.pub`));
const servers: ChildProcess[] = [];
async function startServer(env: Record<string, string>): Promise<number> {
  const p = spawn(PY, ["scripts/oracle/ssh-server.py"], { env: { ...process.env, HOSTKEYS: `${D}/hk`, AUTHKEYS: `${D}/authkeys`, SFTP_ROOT: ROOT, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  servers.push(p); let err = ""; p.stderr!.on("data", (d) => { err += d; });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`oracle server did not start: ${err}`)), 15000);
    p.stdout!.on("data", (d) => { const m = /READY (\d+)/.exec(String(d)); if (m) { clearTimeout(t); res(+m[1]); } });
  });
}
async function dial(p: number, o: Partial<SshClientOptions> = {}): Promise<SshClient> {
  const c = new SshClient(connect(p, "127.0.0.1"), { username: "alice", verifyHostKey: async () => true, auth: { password: async () => "pw1" }, timeoutMs: 20000, ...o });
  await c.connect(); return c;
}
async function fail(f: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await f(); } catch (e) { return e as { code: string; message: string }; }
  throw new Error("expected a failure, but the session was established");
}
async function run(c: SshClient, cmd: string, stdin?: Buffer): Promise<Buffer> {
  const ch = await c.openSession(); const out: Buffer[] = [];
  ch.on("data", (d: Buffer) => out.push(d)); const closed = new Promise((r) => ch.on("close", r));
  ok(await ch.exec(cmd), `exec refused: ${cmd}`);
  if (stdin) { ch.write(stdin); ch.eof(); }
  await closed; return Buffer.concat(out);
}
const plainPkt = (payload: Buffer) => { let pad = 8 - ((5 + payload.length) % 8); if (pad < 4) pad += 8; const b = Buffer.alloc(5 + payload.length + pad); b.writeUInt32BE(b.length - 4); b[4] = pad; payload.copy(b, 5); return b; };
/** a man in the middle that parses the cleartext packets before NEWKEYS and lets a test rewrite one of them */
type Edit = { dir: "s2c" | "c2s"; nth: number; f: (payload: Buffer) => Buffer };
async function mitm(target: number, edit1: Edit | Edit[]): Promise<{ port: number; close: () => void; seen: Buffer[] }> {
  const seen: Buffer[] = []; const edits = Array.isArray(edit1) ? edit1 : [edit1];
  const srv = createServer((cs: Socket) => {
    const ss = connect(target, "127.0.0.1");
    const pipe = (dir: "s2c" | "c2s", out: Socket) => {
      let acc = Buffer.alloc(0), idDone = false, n = 0, done = false;
      return (d: Buffer) => {
        if (done) { out.write(d); return; }
        acc = Buffer.concat([acc, d]);
        let emit = Buffer.alloc(0);
        for (;;) {
          if (!idDone) { const i = acc.indexOf("\r\n"); if (i < 0) break; emit = Buffer.concat([emit, acc.subarray(0, i + 2)]); acc = acc.subarray(i + 2); idDone = true; continue; }
          if (acc.length < 5) break;
          const end = 4 + acc.readUInt32BE(0); if (acc.length < end) break;
          const pkt = acc.subarray(0, end); acc = acc.subarray(end); n++;
          const payload = pkt.subarray(5, end - pkt[4]);
          if (dir === "c2s") seen.push(Buffer.from(payload));
          const ed = edits.find((e) => e.dir === dir && e.nth === n);
          emit = Buffer.concat([emit, ed ? plainPkt(ed.f(Buffer.from(payload))) : pkt]);
          if (payload[0] === 21) { done = true; emit = Buffer.concat([emit, acc]); acc = Buffer.alloc(0); break; } // NEWKEYS: encrypted from here on
        }
        if (emit.length) out.write(emit);
      };
    };
    ss.on("data", pipe("s2c", cs)); cs.on("data", pipe("c2s", ss));
    const end = () => { cs.destroy(); ss.destroy(); }; cs.on("close", end); ss.on("close", end); cs.on("error", end); ss.on("error", end);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as { port: number }).port, close: () => srv.close(), seen };
}
/** rewrite S_REPLY inside SSH_MSG_KEX_HYBRID_REPLY (31): string K_S, string S_REPLY, string sig */
const editReply = (f: (sr: Buffer) => Buffer) => (p: Buffer) => {
  ok(p[0] === 31, `second server packet is ${p[0]}, not KEX_HYBRID_REPLY`);
  const r = new SshReader(p.subarray(1)); const ks = r.string(1 << 16), sr = r.string(1 << 16), sig = r.string(1 << 16);
  return new SshWriter().byte(31).string(ks).string(f(Buffer.from(sr))).string(sig).build();
};
const HYB = [["mlkem768x25519-sha256", 1184, 32, 1088], ["mlkem768nistp256-sha256", 1184, 65, 1088], ["mlkem1024nistp384-sha384", 1568, 97, 1568]] as const;
const ports: Record<string, number> = {};
for (const [alg] of HYB) ports[alg] = await startServer({ KEX: alg });

await test("SSH: each hybrid (mlkem768x25519 / mlkem768nistp256 / mlkem1024nistp384) negotiates with asyncssh + OpenSSL ML-KEM, C_INIT / S_REPLY have the draft's exact sizes, a 1 MiB echo round-trips", COV, async () => {
  for (const [alg, ek, pk, ct] of HYB) {
    const m = await mitm(ports[alg], { dir: "s2c", nth: 2, f: editReply((sr) => { ok(sr.length === ct + pk, `${alg}: S_REPLY ${sr.length} ≠ ${ct}+${pk}`); return sr; }) });
    const c = await dial(m.port);
    ok(c.negotiated!.kex === alg, `negotiated ${c.negotiated!.kex}`);
    const init = m.seen.find((p) => p[0] === 30)!; const cinit = new SshReader(init.subarray(1)).string(1 << 16);
    ok(cinit.length === ek + pk, `${alg}: C_INIT ${cinit.length} ≠ ${ek}+${pk}`);
    ok(K.checkEncapsulationKey(alg.startsWith("mlkem1024") ? K.ML_KEM_1024 : K.ML_KEM_768, cinit.subarray(0, ek)), `${alg}: our ek passes §7.2`);
    const blob = randomBytes(1 << 20); const back = await run(c, "cat", blob);
    ok(back.equals(blob), `${alg}: echo mismatch (${back.length})`);
    c.end(); m.close();
  }
});

await test("SSH: repeated key exchanges under mlkem768x25519 (server rekeys every 256 KiB; K is a string in the KDF every time) keep a 3 MiB transfer intact", COV, async () => {
  const p = await startServer({ KEX: "mlkem768x25519-sha256", REKEY_BYTES: String(1 << 18) });
  const c = await dial(p); let kex = 0; c.on("kex", () => kex++);
  const blob = randomBytes(3 << 20); const back = await run(c, "cat", blob);
  ok(back.equals(blob), "rekeyed transfer mismatch"); ok(kex >= 4, `only ${kex} re-exchanges`);
  console.log(`   ${kex} hybrid re-exchanges during 3 MiB each way`); c.end();
});

await test("D/G: a man in the middle flips one ML-KEM ciphertext bit → implicit rejection gives an unrelated K_PQ → the host signature over H fails (hostkey-signature), never a silent session", COV, async () => {
  for (const [alg] of HYB) {
    const m = await mitm(ports[alg], { dir: "s2c", nth: 2, f: editReply((sr) => { sr[100] ^= 0x10; return sr; }) });
    const e = await fail(() => dial(m.port)); m.close();
    ok(e.code === "hostkey-signature", `${alg}: ${e.code} ${e.message}`);
  }
});

await test("D: S_REPLY one byte short / one byte long / classical half missing → refused as kex before any ML-KEM work; X25519 half replaced by a low-order point → refused", COV, async () => {
  const alg = "mlkem768x25519-sha256";
  const cases: [string, (sr: Buffer) => Buffer, RegExp][] = [
    ["short", (sr) => sr.subarray(0, sr.length - 1), /wrong length/],
    ["long", (sr) => Buffer.concat([sr, Buffer.of(0)]), /wrong length/],
    ["ct only", (sr) => sr.subarray(0, 1088), /wrong length/],
    ["low-order X25519", (sr) => Buffer.concat([sr.subarray(0, 1088), Buffer.alloc(32)]), /low-order|all-zero/],
  ];
  for (const [name, f, re] of cases) {
    const m = await mitm(ports[alg], { dir: "s2c", nth: 2, f: editReply(f) });
    const e = await fail(() => dial(m.port)); m.close();
    ok(e.code === "kex" && re.test(e.message), `${name}: ${e.code} ${e.message}`);
  }
  // NIST hybrid: an off-curve point in the classical half
  const m = await mitm(ports["mlkem768nistp256-sha256"], { dir: "s2c", nth: 2, f: editReply((sr) => { const b = Buffer.from(sr); b[1088 + 40] ^= 1; return b; }) });
  const e = await fail(() => dial(m.port)); m.close();
  ok(e.code === "kex" && /curve point/.test(e.message), `off-curve: ${e.code} ${e.message}`);
});

await test("G: downgrade adversary strips the mlkem* names from BOTH KEXINITs → both sides agree on curve25519, but I_C / I_S are inside H, so the signature check fails; stripping one side only → the server's own DISCONNECT reason is shown", COV, async () => {
  const strip = (p: Buffer) => {
    ok(p[0] === 20, "first packet is KEXINIT");
    const r = new SshReader(p.subarray(17)); const kex = r.string(1 << 16).toString();
    const kept = kex.split(",").filter((a) => !a.startsWith("mlkem")).join(",");
    return Buffer.concat([p.subarray(0, 17), new SshWriter().string(kept).build(), p.subarray(17 + 4 + kex.length)]);
  };
  const p = await startServer({}); // asyncssh defaults (includes the ML-KEM hybrids)
  const direct = await dial(p); ok(direct.negotiated!.kex === "mlkem768x25519-sha256", `default negotiation picked ${direct.negotiated!.kex}`); direct.end();
  const m = await mitm(p, [{ dir: "s2c", nth: 1, f: strip }, { dir: "c2s", nth: 1, f: strip }]);
  const e = await fail(() => dial(m.port)); m.close();
  ok(e.code === "hostkey-signature", `downgrade: ${e.code} ${e.message}`);
  // one-sided strip: the peers pick different methods; asyncssh hangs up and its DISCONNECT text reaches the user
  const m1 = await mitm(p, { dir: "s2c", nth: 1, f: strip });
  const e1 = await fail(() => dial(m1.port)); m1.close();
  ok(e1.code === "disconnect" && /server disconnected: \S/.test(e1.message), `one-sided: ${e1.code} ${e1.message}`);
  console.log(`   one-sided strip → ${e1.message}`);
});

for (const s of servers) s.kill();

await finish();
process.exit(0);
