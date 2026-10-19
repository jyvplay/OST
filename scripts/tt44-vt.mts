/**
 * TT44 — src/lib/vt.ts (the from-scratch terminal emulator behind the SSH module) against INDEPENDENT oracles:
 *   - xterm.js 6.0.0 headless + unicode11 addon (MIT, devDependency, test-only — never shipped) as a differential
 *     oracle: random well-formed escape streams and real programs captured through a real pty (ls, less, top, bash
 *     readline, an ncurses app, git log --graph), fed in random chunk splits;
 *   - xterm's own C source semantics (ThomasDickey/xterm util.c) and the VT510 manual where xterm.js deviates;
 *   - the system terminfo entry for xterm-256color (infocmp) for the key encoder;
 *   - xterm.js's core mouse service for the mouse encoder.
 * Every divergence from xterm.js is either fixed or recognised by a NAMED, mechanical classifier (see vt-diff.mts).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeHarness } from "./harness.mts";
import { Vt, keyToBytes, mouseReport, A, type KeyLike } from "../src/lib/vt.ts";
import { diffRun, fuzzOps, minimize, isSavedCursorAnchoring, explainedByPendingWrapErase } from "./oracle/vt-diff.mts";

const { test, finish } = makeHarness("tt44-vt");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const COV = { "TD-03": "partial" } as const;
const require = createRequire(import.meta.url);

await test("fuzz differential vs xterm.js: 600 seeds × (40×12, 80×24), random chunking — zero unexplained mismatches", COV, async () => {
  let bad = 0, crash = 0, anch = 0, pwe = 0, cells = 0; const first: string[] = [];
  for (let seed = 1; seed <= 600; seed++) {
    for (const [c, r] of [[40, 12], [80, 24]] as const) {
      const ops = fuzzOps(seed); const res = await diffRun(ops.join(""), c, r, seed); cells += res.cells;
      if (res.oracleCrash) { crash++; continue; }
      if (!res.mismatches.length) continue;
      const m = await minimize(ops, c, r); const mm = (await diffRun(m.join(""), c, r, 1)).mismatches;
      if (isSavedCursorAnchoring(m, mm)) { anch++; continue; }
      if (await explainedByPendingWrapErase(m, c, r)) { pwe++; continue; }
      bad++; if (first.length < 3) first.push(`${seed}@${c}: ${JSON.stringify(m)} → ${mm[0]}`);
    }
  }
  console.log(`   cells compared ${cells}; xterm.js self-crashes ${crash}; saved-cursor anchoring ${anch}; pending-wrap erase ${pwe}`);
  ok(cells > 1_000_000, `only ${cells} cells compared`);
  ok(bad === 0, `${bad} unexplained mismatches: ${first.join(" | ")}`);
});

await test("xterm.js itself crashes on CUP-past-corner + ED1 (oracle bug) — vt.ts survives it with a sane cursor", COV, async () => {
  const r = await diffRun("\x1b[14;45H\x1b[1J", 40, 12, 1);
  ok(r.oracleCrash && /isWrapped/.test(r.oracleCrash), `expected the xterm.js 6.0.0 eraseInDisplay crash, got ${JSON.stringify(r)}`);
  const v = new Vt(40, 12); v.write("Q\x1b[14;45H\x1b[1J");
  ok(v.cursor.x === 39 && v.cursor.y === 11 && v.screen.every((row) => row.text() === ""), "ED1 at the clamped corner must clear everything");
});

await test("real programs through a real pty (ls, less, top, bash readline, ncurses app, git log --graph) == xterm.js under 2 chunkings", COV, async () => {
  const cases: [string, number, number, string[], [number, string][]][] = [
    ["ls --color", 80, 24, ["ls", "--color=always", "-la", "/usr/bin"], []],
    ["less", 80, 24, ["less", "/etc/services"], [[0.3, " "], [0.3, "/tcp\r"], [0.3, "G"], [0.3, "g"], [0.3, "q"]]],
    ["top", 100, 30, ["top", "-d", "0.5"], [[1.2, ""], [0.3, "q"]]],
    ["bash", 60, 16, ["bash", "--norc", "--noprofile", "-i"], [[0.2, "echo hello wörld 日本"], [0.1, "\x1b[D\x1b[D\x01X\x05Y"], [0.2, "\r"], [0.2, "for i in 1 2 3; do printf '\\e[3%dmC%d\\e[0m\\n' $i $i; done\r"], [0.3, "exit\r"]]],
    ["curses", 80, 24, ["python3", "scripts/oracle/curses-demo.py"], [[1.0, "q"]]],
    ["git log", 100, 30, ["git", "--no-pager", "log", "--graph", "--color=always", "--oneline", "-n", "40"], []],
  ];
  const fails: string[] = []; let explained = 0;
  for (const [name, c, r, cmd, keys] of cases) {
    const p = spawnSync("python3", ["scripts/oracle/pty-capture.py", String(c), String(r), ...cmd], { env: { ...process.env, KEYS: JSON.stringify(keys) }, encoding: "utf8", timeout: 30000 });
    const bytes = new Uint8Array(Buffer.from(p.stdout.trim(), "base64"));
    ok(bytes.length > 200, `${name}: capture too small (${bytes.length} bytes) — ${p.stderr}`);
    for (const seed of [1, 2]) {
      const res = await diffRun(bytes, c, r, seed);
      if (res.oracleCrash) { fails.push(`${name}: oracle crash`); continue; }
      if (!res.mismatches.length) continue;
      if (await explainedByPendingWrapErase([new TextDecoder().decode(bytes)], c, r)) { explained++; continue; }
      fails.push(`${name}#${seed}: ${res.mismatches[0]}`);
    }
  }
  console.log(`   ${cases.length} programs × 2 chunkings; ${explained} explained by the pending-wrap-erase rule (xterm util.c ClearRight)`);
  ok(!fails.length, fails.join(" | "));
});

await test("where xterm.js deviates, vt.ts follows xterm/VT510: DECALN, DECOM, CPR in pending wrap, EL0 at the margin", COV, () => {
  const replies: string[] = []; const v = new Vt(20, 6); v.onReply = (s) => replies.push(s);
  // DECALN fills the WHOLE screen, resets the margins and homes the cursor (VT510 DECALN)
  v.write("\x1b[3;5r\x1b[4;7H\x1b#8"); ok(v.screen.every((r) => r.text() === "E".repeat(20)), "DECALN must fill every row");
  ok(v.scrollRegion.top === 0 && v.scrollRegion.bottom === 5 && v.cursor.x === 0 && v.cursor.y === 0, "DECALN resets margins and homes");
  // DECOM: CUP/CPR relative to the top margin; relative moves are not offset twice
  v.write("\x1b[2;5r\x1b[?6h\x1b[2;3H"); ok(v.cursor.y === 2 && v.cursor.x === 2, `DECOM CUP: ${JSON.stringify(v.cursor)}`);
  v.write("\x1b[1a"); ok(v.cursor.y === 2 && v.cursor.x === 3, `HPR under DECOM: ${JSON.stringify(v.cursor)}`);
  v.write("\x1b[6n"); ok(replies.pop() === "\x1b[2;4R", "CPR under DECOM is margin-relative (VT510)");
  v.write("\x1b[9;1H"); ok(v.cursor.y === 4, "DECOM clamps to the bottom margin");
  v.write("\x1b[?6l\x1b[r");
  // pending wrap: CPR reports the LAST column; EL0 erases the last cell and clears the wrap (xterm util.c ClearRight)
  v.write("\x1b[1;1H\x1b[2J" + "x".repeat(20) + "\x1b[6n"); ok(replies.pop() === "\x1b[1;20R", "CPR at the margin");
  ok(v.pendingWrap, "pending wrap after filling the row");
  v.write("\x1b[K"); ok(!v.pendingWrap && v.screen[0].text() === "x".repeat(19), "EL0 erases the margin cell and resets the wrap");
  v.write("Z"); ok(v.screen[0].text() === "x".repeat(19) + "Z" && v.cursor.y === 0, "after EL0 the next char overwrites the margin (no wrap)");
  v.write("\x1b[1;1H" + "y".repeat(20) + "\x1b[1K"); ok(v.pendingWrap, "EL1 does NOT reset the wrap (ClearLeft)");
});

await test("DECRQSS / DA / DSR replies match xterm.js exactly", COV, async () => {
  for (const q of ["\x1bP$qm\x1b\\", "\x1bP$qr\x1b\\", "\x1b[3;9r\x1bP$qr\x1b\\", "\x1bP$q q\x1b\\", "\x1bP$q\"q\x1b\\", "\x1bP$q\"p\x1b\\", "\x1bP$qzz\x1b\\", "\x1b[c", "\x1b[>c", "\x1b[5n", "\x1b[6n", "\x1b[?6n"]) {
    const r = await diffRun(q, 40, 12, 1, { checkModes: true });
    ok(!r.mismatches.length, `${JSON.stringify(q)}: ${r.mismatches.join(" | ")}`);
  }
});

await test("key encoder == terminfo xterm-256color (cursor keys in keypad-transmit mode, F1–F63 with modifier banks, editing keys)", COV, () => {
  const ti = execFileSync("infocmp", ["-1", "-x", "xterm-256color"], { encoding: "utf8" });
  const cap = (n: string): string | null => {
    const m = new RegExp(`^\\s${n}=([^,]*),`, "m").exec(ti); if (!m) return null;
    return m[1].replace(/\\E/g, "\x1b").replace(/\^\?/g, "\x7f").replace(/\^([A-Z@\[\]\\^_])/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) - 64));
  };
  const K = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const app = { appCursor: true, appKeypad: false };
  const checks: [string, string | null][] = [
    ["kcuu1", keyToBytes(K("ArrowUp"), app)], ["kcud1", keyToBytes(K("ArrowDown"), app)], ["kcuf1", keyToBytes(K("ArrowRight"), app)], ["kcub1", keyToBytes(K("ArrowLeft"), app)],
    ["khome", keyToBytes(K("Home"), app)], ["kend", keyToBytes(K("End"), app)], ["kich1", keyToBytes(K("Insert"), app)], ["kdch1", keyToBytes(K("Delete"), app)],
    ["kpp", keyToBytes(K("PageUp"), app)], ["knp", keyToBytes(K("PageDown"), app)], ["kcbt", keyToBytes(K("Tab", { shiftKey: true }), app)], ["kbs", keyToBytes(K("Backspace"), app)],
    ["kri", keyToBytes(K("ArrowUp", { shiftKey: true }), app)], ["kind", keyToBytes(K("ArrowDown", { shiftKey: true }), app)],
    ["kUP3", keyToBytes(K("ArrowUp", { altKey: true }), app)], ["kUP5", keyToBytes(K("ArrowUp", { ctrlKey: true }), app)], ["kLFT6", keyToBytes(K("ArrowLeft", { ctrlKey: true, shiftKey: true }), app)],
    ["kDC5", keyToBytes(K("Delete", { ctrlKey: true }), app)], ["kHOM3", keyToBytes(K("Home", { altKey: true }), app)], ["kNXT5", keyToBytes(K("PageDown", { ctrlKey: true }), app)],
  ];
  // F-key banks: 1–12 plain, 13–24 shift, 25–36 ctrl, 37–48 ctrl+shift, 49–60 alt, 61–63 alt+shift
  const banks: Partial<KeyLike>[] = [{}, { shiftKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { altKey: true }, { altKey: true, shiftKey: true }];
  for (let n = 1; n <= 63; n++) checks.push([`kf${n}`, keyToBytes(K(`F${((n - 1) % 12) + 1}`, banks[Math.floor((n - 1) / 12)]), app)]);
  const bad = checks.filter(([c, got]) => cap(c) !== null && cap(c) !== got).map(([c, got]) => `${c}: terminfo ${JSON.stringify(cap(c))} ours ${JSON.stringify(got)}`);
  ok(checks.filter(([c]) => cap(c) !== null).length >= 70, "terminfo provided too few capabilities to be a meaningful oracle");
  ok(!bad.length, bad.slice(0, 6).join(" | "));
  // normal-cursor mode, control / alt chords, IME-safe text
  const n = { appCursor: false, appKeypad: false };
  ok(keyToBytes(K("ArrowUp"), n) === "\x1b[A" && keyToBytes(K("c", { ctrlKey: true }), n) === "\x03" && keyToBytes(K("x", { altKey: true }), n) === "\x1bx", "chords");
  ok(keyToBytes(K("a"), n) === null && keyToBytes(K("é"), n) === null && keyToBytes(K("Process"), n) === null, "plain text / IME must come through the input event, not keydown");
});

await test("mouse encoder == xterm.js core mouse service (X10/1000/1002/1003 × legacy/SGR × buttons, wheel, drag, modifiers)", COV, () => {
  const { Terminal } = require("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => { write(d: string): void; onData(cb: (s: string) => void): void; onBinary(cb: (s: string) => void): void; _core: { writeSync(d: string): void; coreMouseService: { triggerMouseEvent(e: Record<string, unknown>): boolean } } } };
  const bad: string[] = []; let n = 0;
  for (const mode of [9, 1000, 1002, 1003]) for (const sgr of [false, true]) {
    const t = new Terminal({ cols: 300, rows: 300, allowProposedApi: true }); const out: string[] = []; t.onData((s) => out.push(s)); t.onBinary((s) => out.push(s)); // legacy encoding → onBinary
    t._core.writeSync(`\x1b[?${mode}h${sgr ? "\x1b[?1006h" : ""}`);
    const evs: [string, "down" | "up" | "move" | "wheel", number, number, number][] = [
      ["L down", "down", 0, 1, 0], ["M down", "down", 1, 1, 1], ["R down", "down", 2, 1, 2], ["L up", "up", 0, 0, 0], ["R up", "up", 2, 0, 2],
      ["drag L", "move", 0, 32, 0], ["move none", "move", -1, 32, 3], ["wheel up", "wheel", -1, 0, 4], ["wheel down", "wheel", 1, 1, 4],
    ];
    for (const [label, kind, ourBtn, act, xBtn] of evs) for (const mods of [{ shift: false, alt: false, ctrl: false }, { shift: true, alt: false, ctrl: false }, { shift: false, alt: true, ctrl: true }]) for (const [x, y] of [[4, 2], [150, 40], [240, 250]]) {
      out.length = 0; n++;
      t._core.coreMouseService.triggerMouseEvent({ col: x, row: y, x: 0, y: 0, button: xBtn, action: act, ...mods });
      const theirs = out.join("") || null;
      const ours = mouseReport({ mouse: mode, mouseSgr: sgr }, kind, ourBtn, x, y, mods);
      if (theirs !== ours) bad.push(`${mode}/${sgr ? "sgr" : "legacy"} ${label} ${JSON.stringify(mods)} @${x},${y}: xterm ${JSON.stringify(theirs)} ours ${JSON.stringify(ours)}`);
    }
  }
  ok(n === 4 * 2 * 9 * 3 * 3, `ran ${n}`);
  const kinds = [...new Set(bad.map((b) => b.replace(/ \{.*$/, "")))];
  ok(!bad.length, `${bad.length}/${n} differ (${kinds.length} kinds): ${kinds.slice(0, 8).join(" ; ")} — e.g. ${bad[0]}`);
});

await test("hostile output is bounded: REP / parameter floods, 10 MB stream, malformed UTF-8, OSC 52, title cap, DCS inert", COV, () => {
  const v = new Vt(80, 24, 2000); const replies: string[] = []; v.onReply = (s) => replies.push(s);
  let titles = 0; v.onTitle = () => { titles++; };
  let t = Date.now(); v.write("a\x1b[999999999b\x1b[999999999L\x1b[999999999@\x1b[99999999;99999999H\x1b[999999999S\x1b[999999999T\x1b[99999999X");
  ok(Date.now() - t < 500, `parameter flood took ${Date.now() - t} ms`);
  t = Date.now(); const line = "x".repeat(80) + "\r\n"; const chunk = line.repeat(1000);
  for (let i = 0; i < 125; i++) v.write(chunk);
  const ms = Date.now() - t; console.log(`   10 MB parsed in ${ms} ms`);
  ok(ms < 8000 && v.scrollback.length === 2000, `10 MB: ${ms} ms, scrollback ${v.scrollback.length}`);
  v.write("\x1b[2J\x1b[H"); v.write(new Uint8Array([0xff, 0xc3, 0x28, 0x41, 0xe6, 0x97])); v.write(new Uint8Array([0xa5, 0x0d]));
  ok(v.screen[0].text() === "\ufffd\ufffd(A日", `UTF-8 recovery (incl. a code point split across writes): ${JSON.stringify(v.screen[0].text())}`);
  v.write("\x1b]52;c;?\x07\x1b]52;c;aGVsbG8=\x1b\\"); ok(replies.length === 0, "OSC 52 must never answer (clipboard read) — nor act");
  v.write(`\x1b]0;${"T".repeat(5000)}\x07`); ok(v.title.length === 256 && titles === 1, "title capped at 256");
  v.write("\x1bPq#0;2;0;0;0#0~~@@vv@@~~$-\x1b\\\x1bP+q544e\x1b\\"); ok(replies.length === 0 && v.screen[0].text().startsWith("\ufffd"), "sixel / XTGETTCAP DCS are swallowed, nothing drawn or answered");
  const w = new Vt(10, 3); w.write("日本語日本語"); ok(w.screen[0].text() === "日本語日本" && w.screen[1].text() === "語" && (w.screen[0].at[8] & A.WIDE) !== 0, "wide chars wrap whole");
});

await test("resize keeps the cursor row on screen and bounds everything; scrollback only from the primary screen", COV, () => {
  const v = new Vt(20, 10, 100);
  for (let i = 0; i < 9; i++) v.write(`line${i}\r\n`);
  v.write("cur"); v.resize(20, 4);
  ok(v.screen[v.cursor.y].text() === "cur" && v.cursor.y === 3 && v.scrollback.length === 6, `shrink: y=${v.cursor.y} sb=${v.scrollback.length}`);
  v.resize(10000, 10000); ok(v.cols === 1000 && v.rows === 500, "resize clamps to 1000×500");
  const a = new Vt(10, 3, 100); a.write("\x1b[?1049h"); for (let i = 0; i < 20; i++) a.write("alt\r\n"); a.write("\x1b[?1049l");
  ok(a.scrollback.length === 0, "the alternate screen never feeds the scrollback");
});

await test("reflow: 300 seeds × 4 width changes — every logical line equals the INPUT's line (ground truth) and xterm.js's reflow wherever xterm.js itself keeps the input", COV, async () => {
  const { Terminal } = require("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => any };
  const { Unicode11Addon } = require("@xterm/addon-unicode11") as { Unicode11Addon: new () => unknown };
  const words = ["alpha", "βeta", "日本語", "🙂", "x", "longword-without-breaks-0123456789", "\x1b[31mred\x1b[0m", "  ", "\t"];
  let bad = 0, compared = 0, xtLoss = 0; const first: string[] = [];
  const logical = (rows: { text: string; wrapped: boolean }[]) => { const out: string[] = []; let cur = "";
    rows.forEach((r, i) => { cur += r.text; if (!rows[i + 1]?.wrapped) { out.push(cur.replace(/\s+/g, " ").trim()); cur = ""; } });
    while (out.length && out[out.length - 1] === "") out.pop(); return out; };
  for (let seed = 1; seed <= 300; seed++) {
    let st = seed * 2654435761 >>> 0; const r = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
    let cols = 20 + Math.floor(r() * 60); const rows = 6 + Math.floor(r() * 10);
    const vt = new Vt(cols, rows, 500); const xt = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });
    xt.loadAddon(new Unicode11Addon()); xt.unicode.activeVersion = "11";
    let data = ""; const n = 5 + Math.floor(r() * 40);
    for (let i = 0; i < n; i++) data += words[Math.floor(r() * words.length)] + (r() < 0.25 ? "\r\n" : " ");
    vt.write(data); xt._core.writeSync(new TextEncoder().encode(data));
    const truth = data.split("\r\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim()); const lastLine = truth[truth.length - 1]; while (truth.length && truth[truth.length - 1] === "") truth.pop();
    for (let k = 0; k < 4; k++) {
      cols = 8 + Math.floor(r() * 90); vt.resize(cols, rows); xt.resize(cols, rows);
      const b = xt.buffer.active; const xr: { text: string; wrapped: boolean }[] = [];
      for (let y = 0; y < b.length; y++) {
        const l = b.getLine(y), nx = b.getLine(y + 1), cont = !!(nx && nx.isWrapped);
        let t = l.translateToString(!cont);
        // a null cell left at the row end because the next (wide) char did not fit is padding, not text
        { const lc = l.getCell(cols - 1); if (cont && lc?.getChars() === "" && lc.getWidth() === 1 && nx.getCell(0)?.getWidth() === 2) t = t.slice(0, -1); }
        xr.push({ text: t, wrapped: l.isWrapped });
      }
      const or: { text: string; wrapped: boolean }[] = []; const all = [...vt.scrollback, ...vt.screen];
      all.forEach((row, i) => { let t = row.text(!row.wrapped); if (row.wrapped && row.ch[cols - 1] === "" && !(row.at[cols - 1] & A.WIDE_CONT)) t = t.slice(0, -1); or.push({ text: t, wrapped: i > 0 && all[i - 1].wrapped }); });
      const A1 = logical(or), B1 = logical(xr); compared++;
      const tj = JSON.stringify(truth), xtOk = JSON.stringify(B1) === tj;
      if (!xtOk) {
        // mechanical classifier: xterm.js never reflows the line holding the cursor (it leaves it for the shell to redraw), so
        // narrowing truncates exactly that line; a loss on ANY other line is not excused
        let d = 0; while (d < truth.length && B1[d] === truth[d]) d++;
        const cursorLine = data.split("\r\n").length - 1, laterOk = JSON.stringify(B1.slice(d + 1)) === JSON.stringify(truth.slice(d + 1));
        if (d === cursorLine && laterOk) xtLoss++; else { bad++; if (first.length < 3) first.push(`seed ${seed} k${k}: xterm.js lost text on non-cursor line ${d}/${cursorLine}: ${JSON.stringify(B1[d])} vs input ${JSON.stringify(truth[d])}`); }
      }
      const curLine = (rs: { text: string; wrapped: boolean }[], abs: number) => { let i = abs; while (i > 0 && rs[i].wrapped) i--; let t = ""; for (let j = i; j <= abs; j++) t += rs[j].text; return t.replace(/\s+/g, " ").trim(); };
      const ca = curLine(or, vt.scrollback.length + vt.cursor.y), cb = curLine(xr, b.baseY + b.cursorY);
      if (JSON.stringify(A1) !== tj || ca !== lastLine || (xtOk && (JSON.stringify(A1) !== JSON.stringify(B1) || ca !== cb))) { bad++; if (first.length < 3) { let d = 0; while (d < Math.max(A1.length, truth.length) && A1[d] === truth[d]) d++; first.push(`seed ${seed} k${k} →${cols} line ${d}/${A1.length}/${truth.length}/${B1.length}: ours ${JSON.stringify(A1[d])} input ${JSON.stringify(truth[d])} xterm.js ${JSON.stringify(B1[d])} | cursor line ${JSON.stringify(ca)} vs ${JSON.stringify(cb)} want ${JSON.stringify(lastLine)} data …${JSON.stringify(data.slice(-30))}`); } }
    }
    xt.dispose();
  }
  console.log(`   ${compared} reflow states compared; ours ≠ truth/xterm.js: ${bad}; states where xterm.js truncates the un-reflowed cursor line (its design; ours checked against the input): ${xtLoss}`);
  ok(bad === 0, first.join(" || "));
});

await test("documented divergence: xterm.js does not reflow the cursor's line, so narrowing cuts it; vt.ts re-wraps it (as VTE and kitty do)", COV, async () => {
  const { Terminal } = require("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => any };
  const data = "plain words that are long enough to wrap at nine end";
  const xt = new Terminal({ cols: 20, rows: 6, scrollback: 50, allowProposedApi: true });
  await new Promise<void>((r) => xt.write(data, r)); xt.resize(9, 6); xt.resize(85, 6);
  const xl = xt.buffer.active.getLine(0).translateToString(true); xt.dispose();
  const v = new Vt(20, 6, 50); v.write(data); v.resize(9, 6); v.resize(85, 6);
  ok(!xl.includes("end"), `xterm.js no longer loses it (${JSON.stringify(xl)}) — re-check the reflow classifier`);
  ok(v.screen[0].text() === data, `ours: ${JSON.stringify(v.screen[0].text())}`);
  const x2 = new Terminal({ cols: 20, rows: 6, scrollback: 50, allowProposedApi: true });
  await new Promise<void>((r) => x2.write(data + "\r\n", r)); x2.resize(9, 6); x2.resize(85, 6);
  const l2 = x2.buffer.active.getLine(0).translateToString(true); x2.dispose();
  ok(l2 === data, `the same line NOT under the cursor survives xterm.js reflow (${JSON.stringify(l2)}) — so the cut is the cursor-line rule`);
});

await test("reflow round trip: 70 → 41 → 70 columns restores every cell, colour and the cursor; the alternate screen is cut, not reflowed", COV, () => {
  const v = new Vt(70, 10, 100);
  v.write("WELCOME TERM=xterm-256color COLS=70 ROWS=24 ENV=en_US.UTF-8\r\n$ \x1b[31m日本語 red text that is long enough\x1b[0m end\r\n$ ");
  const snap = () => v.screen.map((r) => r.text() + "|" + Array.from(r.fg).join(",") + "|" + Array.from(r.at).join(",")).join("\n");
  const before = snap(), cur = { ...v.cursor };
  v.resize(41, 10);
  const joined = v.screen[0].text() + v.screen[1].text();
  ok(v.screen[0].wrapped && joined === "WELCOME TERM=xterm-256color COLS=70 ROWS=24 ENV=en_US.UTF-8", `41 cols keeps the whole line: ${JSON.stringify(joined)}`);
  ok(v.screen[v.cursor.y].text() === "$", `cursor still on the prompt row (${v.cursor.x},${v.cursor.y})`);
  v.resize(70, 10);
  ok(snap() === before && v.cursor.x === cur.x && v.cursor.y === cur.y, "widening back restores cells, colours and cursor exactly");
  const a = new Vt(30, 4, 10); a.write("\x1b[?1049h" + "z".repeat(30)); a.resize(10, 4);
  ok(a.screen[0].text() === "z".repeat(10) && !a.screen[1].text(), "alternate screen: cut at the new width (full-screen apps redraw on SIGWINCH)");
});

await finish();
process.exit(0);
