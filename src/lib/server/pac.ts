/**
 * TT39: Proxy auto-config (PAC) files — the FindProxyForURL(url, host) scripts that operating systems and
 * organisations use to pick a proxy per request. Original code written from the Netscape PAC specification (1996)
 * and Microsoft's IPv6 extensions (…Ex functions); no third-party PAC code. Tested against an independent
 * implementation (PyPAC, Apache-2.0, running PAC in the Duktape engine) in scripts/tt39-pac.mts.
 *
 * Isolation: the script runs in a node:vm context that holds NO host function or object — the helper functions are
 * evaluated INSIDE the context from source, so `dnsResolve.constructor` is the context's own Function and leads
 * nowhere. DNS answers, the local address and the clock enter as plain data. Every run has a time limit. (node:vm is
 * not a hard security boundary against hostile native exploits; a PAC file is configured by the computer's owner or
 * administrator, and this design keeps the remaining attack surface to the JS engine itself.)
 *
 * DNS without host callbacks: FindProxyForURL is a deterministic function of (url, host, clock, DNS answers), so
 * when the script asks for a name not resolved yet, dnsResolve throws a marker with the name; the host resolves it
 * asynchronously, adds the answer, and runs the script again (at most PAC_MAX_DNS_ROUNDS names per decision).
 * DNS can be switched off (privacy: no lookups leave the computer): dnsResolve then answers null for names.
 *
 * Privacy as in Chrome: for https: URLs the script sees only scheme://host:port/ — never the path or query.
 */
import * as vm from "node:vm";
import * as os from "node:os";
import { lookup } from "node:dns/promises";
import { types } from "node:util";

/** Was this a time-limit stop? Reads only Node's own error code or a native error's plain data property — never a
 *  getter or a Proxy trap a hostile script could have planted on what it threw. */
function timedOut(e: unknown): boolean {
  if (!types.isNativeError(e)) return false;
  for (const k of ["code", "message"]) {
    const d = Object.getOwnPropertyDescriptor(e, k);
    if (d && "value" in d && typeof d.value === "string" && /ERR_SCRIPT_EXECUTION_TIMEOUT|timed out/.test(d.value)) return true;
  }
  return false;
}

export const PAC_TIMEOUT_MS = 1000;
export const PAC_MAX_DNS_ROUNDS = 16;
export const PAC_MAX_BYTES = 1 << 20;
export const PAC_DNS_TTL_MS = 60_000;

const HELPERS = String.raw`
"use strict";
var __dns = Object.create(null), __dnsOn = true, __myip = "127.0.0.1", __now = 0;
function __need(h) { throw { __fusionNeedDns: String(h) }; }
function __isV4(s) { return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s); }
function dnsResolve(host) {
  host = String(host);
  if (__isV4(host)) return host;
  if (!__dnsOn) return null;
  if (host in __dns) return __dns[host] || null;
  __need(host);
}
function isResolvable(host) { return dnsResolve(host) !== null; }
function myIpAddress() { return __myip; }
function isPlainHostName(host) { return String(host).indexOf(".") < 0; }
function dnsDomainIs(host, domain) { host = String(host); domain = String(domain); return host.length >= domain.length && host.substring(host.length - domain.length) === domain; }
function localHostOrDomainIs(host, hostdom) { host = String(host); hostdom = String(hostdom); return host === hostdom || (host.indexOf(".") < 0 && hostdom.substring(0, host.length + 1) === host + "."); }
function dnsDomainLevels(host) { return String(host).split(".").length - 1; }
function convert_addr(ip) { var p = String(ip).split("."); return (((+p[0] & 255) << 24) | ((+p[1] & 255) << 16) | ((+p[2] & 255) << 8) | (+p[3] & 255)) >>> 0; }
function isInNet(host, pattern, mask) {
  if (!__isV4(String(pattern)) || !__isV4(String(mask))) return false;
  var ip = dnsResolve(host);
  if (!ip || !__isV4(ip)) return false;
  var m = convert_addr(mask);
  return ((convert_addr(ip) & m) >>> 0) === ((convert_addr(pattern) & m) >>> 0);
}
// shell patterns: * any run, ? one character, [abc] / [a-z] / [!abc] classes (an unclosed "[" is literal)
function shExpMatch(str, shexp) {
  var src = "^", s = String(shexp), esc = function (c) { return c.replace(/[\\^$.*+?()[\]{}|\/-]/g, "\\$&"); };
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === "*") src += ".*";
    else if (c === "?") src += ".";
    else if (c === "[" && s.indexOf("]", i + 2) > 0) {
      var j = s.indexOf("]", i + 2), body = s.substring(i + 1, j), neg = body.charAt(0) === "!" || body.charAt(0) === "^";
      if (neg) body = body.substring(1);
      var cls = "";
      for (var k = 0; k < body.length; k++) { var b = body.charAt(k); cls += b === "-" && k > 0 && k < body.length - 1 ? "-" : esc(b); }
      src += "[" + (neg ? "^" : "") + cls + "]"; i = j;
    } else src += esc(c);
  }
  try { return new RegExp(src + "$").test(String(str)); } catch (e) { return false; }
}
var __DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], __MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function __clock(gmt) {
  var d = new Date(__now);
  return gmt ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
             : { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), wd: d.getDay(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
}
function __args(a) { a = Array.prototype.slice.call(a); var gmt = a.length > 0 && String(a[a.length - 1]).toUpperCase() === "GMT"; if (gmt) a.pop(); return { a: a, gmt: gmt }; }
function weekdayRange() {
  var x = __args(arguments), a = x.a; if (a.length < 1 || a.length > 2) return false;
  var w1 = __DAYS.indexOf(String(a[0]).toUpperCase()), w2 = a.length === 2 ? __DAYS.indexOf(String(a[1]).toUpperCase()) : w1;
  if (w1 < 0 || w2 < 0) return false;
  var t = __clock(x.gmt).wd;
  return w1 <= w2 ? t >= w1 && t <= w2 : t >= w1 || t <= w2;
}
function dateRange() {
  var x = __args(arguments), a = x.a; if (a.length < 1 || a.length > 6) return false;
  var toks = [];
  for (var i = 0; i < a.length; i++) {
    var mi = __MONTHS.indexOf(String(a[i]).toUpperCase());
    if (mi >= 0) { toks.push(["m", mi]); continue; }
    var n = Number(a[i]); if (!isFinite(n) || n !== Math.floor(n)) return false;
    toks.push(n > 31 ? ["y", n] : ["d", n]);
  }
  var c = __clock(x.gmt), kinds = toks.map(function (t) { return t[0]; }).join("");
  var key = function (k, vals) { var v = 0; if (k.indexOf("y") >= 0) v += vals.y * 416; if (k.indexOf("m") >= 0) v += vals.m * 32; if (k.indexOf("d") >= 0) v += vals.d; return v; };
  var obj = function (ts) { var o = { y: 0, m: 0, d: 0 }; ts.forEach(function (t) { o[t[0]] = t[1]; }); return o; };
  if (toks.length === 1 || (toks.length <= 3 && new Set(kinds.split("")).size === toks.length && toks.length !== 2)) {
    return toks.every(function (t) { return c[t[0]] === t[1]; }); // one date: every given field matches
  }
  if (toks.length % 2) return false;
  var h = toks.length / 2, s = toks.slice(0, h), e = toks.slice(h), ks = kinds.slice(0, h);
  if (ks !== kinds.slice(h)) return false;
  var sv = key(ks, obj(s)), ev = key(ks, obj(e)), cv = key(ks, c);
  return sv <= ev ? cv >= sv && cv <= ev : ks.indexOf("y") < 0 && (cv >= sv || cv <= ev);
}
function timeRange() {
  var x = __args(arguments), a = x.a.map(Number), c = __clock(x.gmt), now = c.h * 3600 + c.mi * 60 + c.s, s, e;
  for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) return false;
  if (a.length === 1) return c.h === a[0];
  if (a.length === 2) { s = a[0] * 3600; e = a[1] * 3600; return s <= e ? now >= s && now < e : now >= s || now < e; } // hours: [h1, h2)
  if (a.length === 4) { s = a[0] * 3600 + a[1] * 60; e = a[2] * 3600 + a[3] * 60; }
  else if (a.length === 6) { s = a[0] * 3600 + a[1] * 60 + a[2]; e = a[3] * 3600 + a[4] * 60 + a[5]; }
  else return false;
  return s <= e ? now >= s && now <= e : now >= s || now <= e;
}
// Microsoft's IPv6-aware extensions (FindProxyForURLEx scripts)
function isResolvableEx(host) { return isResolvable(host); }
function dnsResolveEx(host) { var r = dnsResolve(host); return r === null ? "" : r; }
function myIpAddressEx() { return __myip; }
function isInNetEx(ip, prefix) {
  var m = /^([\d.]+)\/(\d{1,2})$/.exec(String(prefix)); if (!m || !__isV4(m[1]) || +m[2] > 32 || !__isV4(String(ip))) return false;
  var bits = +m[2], mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((convert_addr(ip) & mask) >>> 0) === ((convert_addr(m[1]) & mask) >>> 0);
}
function sortIpAddressList(list) { return String(list).split(";").filter(Boolean).sort().join(";"); }
function getClientVersion() { return "1.0"; }
function alert() {}
`;

export interface PacEntry { type: "DIRECT" | "PROXY" | "HTTP" | "HTTPS" | "SOCKS" | "SOCKS4" | "SOCKS5" | "QUIC"; host?: string; port?: number }

/** "PROXY a:1; SOCKS5 b:2; DIRECT" → entries (unknown or malformed entries are skipped, as browsers do). */
export function parsePacResult(s: unknown): PacEntry[] {
  if (typeof s !== "string") return [];
  const out: PacEntry[] = [];
  for (const part of s.split(";")) {
    const t = part.trim(); if (!t) continue;
    const m = /^(DIRECT|PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5|QUIC)(?:\s+(\S+))?$/i.exec(t);
    if (!m) continue;
    const type = m[1].toUpperCase() as PacEntry["type"];
    if (type === "DIRECT") { if (!m[2]) out.push({ type }); continue; }
    if (!m[2]) continue;
    const hp = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(m[2]);
    if (!hp) continue;
    const def = type === "HTTPS" ? 443 : type.startsWith("SOCKS") ? 1080 : 80;
    const port = hp[2] ? Number(hp[2]) : def;
    if (port < 1 || port > 65535) continue;
    out.push({ type, host: hp[1].replace(/^\[|\]$/g, ""), port });
  }
  return out;
}

/** The URL a PAC script is shown: https:// (and wss://) stripped to scheme://host[:port]/ as Chrome does. */
export function pacUrlFor(target: URL): string {
  return target.protocol === "https:" || target.protocol === "wss:" ? `${target.protocol}//${target.host}/` : target.href.replace(/#.*$/, "");
}

export interface PacOptions { dns?: boolean; resolve?: (host: string) => Promise<string | null>; now?: number; myIp?: string; timeoutMs?: number }

export function primaryIPv4(): string {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return "127.0.0.1";
}
async function defaultResolve(host: string): Promise<string | null> {
  try { const r = await lookup(host, { family: 4 }); return r.address; } catch { return null; }
}

/** A compiled PAC script. find() may be called many times; each call runs in the same isolated context. */
export class PacScript {
  private ctx: vm.Context;
  private fnName: "FindProxyForURL" | "FindProxyForURLEx";
  /** host → [answer, time] — answers are reused for PAC_DNS_TTL_MS, then asked again */
  readonly dnsCache = new Map<string, [string | null, number]>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(source: string) {
    if (typeof source !== "string" || !source.trim()) throw new Error("PAC: empty script");
    if (Buffer.byteLength(source) > PAC_MAX_BYTES) throw new Error(`PAC: script larger than ${PAC_MAX_BYTES} bytes`);
    // no host objects in the context at all; no eval / new Function from strings, no WebAssembly
    // microtaskMode "afterEvaluate": promise jobs queued by the script run INSIDE the time limit, not later on the
    // server's own queue (a `Promise.resolve().then(() => { for (;;); })` would otherwise hang the server)
    this.ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, name: "pac", microtaskMode: "afterEvaluate" });
    vm.runInContext(HELPERS, this.ctx, { timeout: PAC_TIMEOUT_MS, displayErrors: false });
    let script: vm.Script;
    try { script = new vm.Script(source, { filename: "proxy.pac" }); } // compile errors are host-realm SyntaxErrors: safe to read
    catch (e) { throw new Error(`PAC: the script does not parse: ${(e as Error).message}`); }
    // displayErrors false: otherwise Node decorates an escaping exception's stack AFTER the time limit has stopped
    // watching, which formats the error and runs a planted `message` getter on the server's own thread (verified hang)
    try { script.runInContext(this.ctx, { timeout: PAC_TIMEOUT_MS, displayErrors: false }); }
    catch (e) { throw new Error(`PAC: the script failed to load${timedOut(e) ? " (time limit)" : ""}`); } // never touch a thrown sandbox value (getters / Proxy traps)
    const has = (n: string) => vm.runInContext(`typeof ${n} === "function"`, this.ctx, { timeout: PAC_TIMEOUT_MS, displayErrors: false }) === true;
    if (has("FindProxyForURLEx")) this.fnName = "FindProxyForURLEx";
    else if (has("FindProxyForURL")) this.fnName = "FindProxyForURL";
    else throw new Error("PAC: the script defines no FindProxyForURL function");
  }
  /** Evaluate for one target → the raw result string. */
  find(target: URL, o: PacOptions = {}): Promise<string> {
    // one decision at a time: the context's clock / DNS answers belong to the decision being made
    const run = this.chain.then(() => this.findNow(target, o));
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async findNow(target: URL, o: PacOptions): Promise<string> {
    const dnsOn = o.dns !== false, resolve = o.resolve ?? defaultResolve, timeout = o.timeoutMs ?? PAC_TIMEOUT_MS;
    const set = `__dns=Object.create(null);__dnsOn=${dnsOn};__myip=${JSON.stringify(o.myIp ?? primaryIPv4())};__now=${Number(o.now ?? Date.now())};`;
    vm.runInContext(set, this.ctx, { timeout, displayErrors: false });
    // everything that inspects the script's results or exceptions runs INSIDE the sandbox under the time limit, and
    // only a primitive string comes out: "R<result>", "D<name to resolve>" or "E<message>"
    const call = `(function () { try { return "R" + String(${this.fnName}(${JSON.stringify(pacUrlFor(target))}, ${JSON.stringify(target.hostname.replace(/^\[|\]$/g, ""))})); }
      catch (e) { try { if (e !== null && typeof e === "object" && typeof e.__fusionNeedDns === "string") return "D" + e.__fusionNeedDns; return "E" + String(e && e.message || e); } catch (x) { return "Ean exception that cannot be described"; } } })()`;
    for (let round = 0; round <= PAC_MAX_DNS_ROUNDS; round++) {
      let out: unknown;
      try { out = vm.runInContext(call, this.ctx, { timeout, displayErrors: false }); }
      catch (e) { throw new Error(`PAC: FindProxyForURL failed${timedOut(e) ? ` (time limit ${timeout} ms)` : ""}`); }
      if (typeof out !== "string" || !out) throw new Error("PAC: FindProxyForURL returned no usable value");
      if (out[0] === "R") return out.slice(1);
      if (out[0] !== "D") throw new Error(`PAC: FindProxyForURL failed: ${out.slice(1, 200)}`);
      const need = out.slice(1, 300);
      if (round === PAC_MAX_DNS_ROUNDS) throw new Error(`PAC: more than ${PAC_MAX_DNS_ROUNDS} DNS lookups for one decision`);
      const hit = this.dnsCache.get(need), t = Date.now();
      let ip: string | null;
      if (hit && t - hit[1] < PAC_DNS_TTL_MS) ip = hit[0];
      else { ip = await resolve(need); if (this.dnsCache.size > 4096) this.dnsCache.clear(); this.dnsCache.set(need, [ip, Date.now()]); }
      vm.runInContext(`__dns[${JSON.stringify(need)}]=${JSON.stringify(ip ?? "")};`, this.ctx, { timeout, displayErrors: false });
    }
    throw new Error("PAC: unreachable");
  }
}

/**
 * Fetch a PAC file. Unlike web content it may live on the local network (that is where organisations host them),
 * so this does not go through the public-address guard — it is configured by the computer's owner, never by a page.
 * http(s) with a size cap and a time limit, or file:// .
 */
export async function loadPac(url: string, timeoutMs = 5000): Promise<string> {
  const u = new URL(url);
  if (u.protocol === "file:") {
    const { readFile, stat } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const p = fileURLToPath(u);
    if ((await stat(p)).size > PAC_MAX_BYTES) throw new Error(`PAC: file larger than ${PAC_MAX_BYTES} bytes`);
    return readFile(p, "utf8");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`PAC: unsupported URL scheme ${u.protocol}`);
  const mod = u.protocol === "https:" ? await import("node:https") : await import("node:http");
  return new Promise((resolve, reject) => {
    const req = mod.get(u, { timeout: timeoutMs, headers: { accept: "application/x-ns-proxy-autoconfig, */*", "user-agent": "Fusion-PAC/1" } }, (res) => {
      if ((res.statusCode ?? 0) >= 300) { res.resume(); reject(new Error(`PAC: ${u.href} answered HTTP ${res.statusCode}`)); return; }
      const parts: Buffer[] = []; let n = 0;
      res.on("data", (c: Buffer) => { n += c.length; if (n > PAC_MAX_BYTES) { req.destroy(); reject(new Error(`PAC: file larger than ${PAC_MAX_BYTES} bytes`)); return; } parts.push(c); });
      res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`PAC: ${u.href} timed out`)));
    req.on("error", reject);
  });
}
