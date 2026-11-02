/** Actual production kernels, TypeScript-transpiled without algorithm changes,
 * running in real Chromium with native RAF and real Web Storage. This is
 * explicitly a browser-kernel suite, not an app E2E or physical-device test.
 * No mocked scheduler, clock, storage object, stream or network response. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt133-browser-kernels");
const files = ["src/lib/vt.ts", "src/lib/terminal-display.ts", "src/lib/search-query.ts", "src/lib/recent-searches.ts"];
const sources = files.map(path => ({ path, source: readFileSync(path, "utf8") }));
const modules = sources.map(({ source }) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const browser = await launchChromium(), context = await browser.newContext(), page = await context.newPage();
const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
try {
  // A real same-origin HTTP document permits native localStorage. There is no
  // app hydration or injected application state in this isolated JSON page.
  const BASE = process.env.BASE; assert.ok(BASE, "BASE required for real Web Storage origin");
  await page.goto(`${BASE}/api/state?id=default`, { waitUntil: "load" });
  const result = await page.evaluate(async ({ modules }) => {
    const urls: string[] = [], results: { name: string; pass: boolean; error?: string }[] = [];
    const url = (text: string) => { const u = URL.createObjectURL(new Blob([text], { type: "text/javascript" })); urls.push(u); return u; };
    const vt = url(modules[0]), query = url(modules[2]);
    const terminalModule = modules[1].replace(/from ["']\.\/vt["']/g, `from ${JSON.stringify(vt)}`);
    const recentsModule = modules[3].replace(/from ["']\.\/search-query["']/g, `from ${JSON.stringify(query)}`);
    const { TerminalDisplay } = await import(url(terminalModule));
    const recents = await import(url(recentsModule));
    const ok = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const check = async (name: string, fn: () => unknown | Promise<unknown>) => { try { await fn(); results.push({ name, pass: true }); } catch (error) { results.push({ name, pass: false, error: String((error as Error).message) }); } };
    try {
      await check("Native RAF coalesces 100 actual VT writes into one publication and keeps the cached snapshot stable before the frame", async () => {
        const terminal = new TerminalDisplay(40, 5), original = terminal.getSnapshot(); let published = 0;
        const unsubscribe = terminal.subscribe(() => published++);
        for (let i = 0; i < 100; i++) terminal.write("x");
        ok(published === 0 && terminal.getSnapshot() === original, "published before native frame or changed cached identity");
        await frame(); ok(published === 1, `expected one native frame publication, got ${published}`);
        ok(terminal.getSnapshot() !== original, "no new published snapshot"); unsubscribe(); terminal.dispose();
      });
      await check("Copied cursor, mode, line/run and style snapshots cannot be rewritten by later ANSI/Unicode or parser-mode changes", async () => {
        const terminal = new TerminalDisplay(40, 5), original = terminal.getSnapshot(), before = JSON.stringify(original);
        terminal.write("\x1b[31;1mR\x1b[0m é 界🧭\x1b[?1h\x1b[2;3H");
        ok(terminal.input().modes.appCursor === true, "native input modes lag parser state");
        ok(original.modes.appCursor === false, "old modes alias engine");
        await frame(); const current = terminal.getSnapshot();
        ok(JSON.stringify(original) === before, "old render snapshot changed");
        ok(current.cursor.x === 2 && current.cursor.y === 1, "cursor projection lost CSI position");
        ok(current.lines[0].map((r: any) => r.text).join("").startsWith("R é 界🧭"), "wide/combining text projection differs");
        ok(current.lines[0][0].style.color === "#ff7a90" && current.lines[0][0].style.fontWeight === 700, "SGR bold-as-bright style differs");
        const input = terminal.input(); input.modes.appCursor = false;
        ok(terminal.input().modes.appCursor === true, "event-input snapshot aliases mutable parser modes"); terminal.dispose();
      });
      await check("Real CSI 3J history shrink while scrolled up clamps the viewport instead of dereferencing a removed row", async () => {
        const terminal = new TerminalDisplay(30, 4, 100);
        for (let i = 0; i < 30; i++) terminal.write(`line-${i}\r\n`);
        await frame(); terminal.scrollTo(1_000); const scrolled = terminal.getSnapshot(), before = JSON.stringify(scrolled);
        ok(scrolled.scroll > 0 && scrolled.showCursor === false, "scrollback setup did not take effect");
        terminal.write("\x1b[3J"); await frame(); const cleared = terminal.getSnapshot();
        ok(cleared.scrollback === 0 && cleared.scroll === 0 && cleared.lines.length === 4, "history shrink not clamped");
        ok(JSON.stringify(scrolled) === before, "old history snapshot was mutated"); terminal.dispose();
      });
      await check("Synchronous resize/reset cancels a queued native frame; dispose cancels pending publication and unsubscribes bells", async () => {
        const terminal = new TerminalDisplay(30, 4); let published = 0, bells = 0;
        terminal.subscribe(() => published++); terminal.subscribeBell(() => bells++);
        terminal.write("pending\x07"); ok(bells === 1, "real BEL did not notify");
        terminal.resize(32, 5); ok(published === 1, "synchronous resize did not publish");
        await frame(); await frame(); ok(published === 1, "old RAF also published after synchronous resize");
        terminal.write("pending reset"); terminal.reset(); const afterReset = published;
        await frame(); ok(published === afterReset, "old RAF also published after reset");
        const beforeDispose = terminal.getSnapshot(); terminal.write("cancelled"); terminal.dispose();
        await frame(); await frame(); ok(terminal.getSnapshot() === beforeDispose && published === afterReset, "disposed frame still published");
        terminal.write("\x07"); await frame(); ok(bells === 1, "disposed BEL listener still notified");
      });
      await check("Real localStorage purge removes canonical and malformed legacy Private aliases, keeps public neighbours and never creates an empty key", () => {
        const key = recents.RECENT_SEARCHES_KEY;
        try {
          const rows = ["/Private", " /Private/a ", "//Private/a", "/Private//a", "/Documents/../Private", "/Documents"].map((scope, i) => ({ q: `query-${i}`, scope, mode: "text", at: i }));
          localStorage.setItem(key, JSON.stringify(rows)); recents.purgePrivateRecents(localStorage);
          const stored = JSON.parse(localStorage.getItem(key) ?? "null");
          ok(stored.length === 1 && stored[0].scope === "/Documents", "a legacy Private query remains on disk or a public neighbour was lost");
          localStorage.setItem(key, JSON.stringify(rows.slice(0, -1))); recents.purgePrivateRecents(localStorage);
          ok(localStorage.getItem(key) === null, "empty history key remains");
          recents.purgePrivateRecents(localStorage); ok(localStorage.getItem(key) === null, "purge created an empty history key");
        } finally { localStorage.removeItem(key); }
      });
      await check("Corrupt native history JSON cannot retain a Private query after purge", () => {
        const key = recents.RECENT_SEARCHES_KEY;
        try {
          localStorage.setItem(key, '[{"q":"secret","scope":"/Private"'); recents.purgePrivateRecents(localStorage);
          ok(localStorage.getItem(key) === null, "truncated Private JSON retained");
          localStorage.setItem(key, JSON.stringify({ q: "secret", scope: "/Private" })); recents.purgePrivateRecents(localStorage);
          ok(localStorage.getItem(key) === null, "non-array Private history retained");
        } finally { localStorage.removeItem(key); }
      });
    } finally { for (const u of urls) URL.revokeObjectURL(u); }
    return { results, nativeRaf: typeof requestAnimationFrame, nativeStorage: localStorage instanceof Storage };
  }, { modules });
  for (const r of result.results) await test(r.name, {}, () => assert.ok(r.pass, r.error));
  await test("No uncaught browser errors in native kernel ownership/scheduler/storage attacks", {}, () => assert.deepEqual(errors, []));
  mkdirSync("docs/evidence", { recursive: true });
  writeFileSync("docs/evidence/tt133-browser-kernel-provenance.json", JSON.stringify({ at: new Date().toISOString(), browser: browser.version(), typescript: ts.version, scope: "native Chromium kernels; not app E2E or physical devices", sourceHashes: sources.map(({ path, source }) => ({ path, sha256: createHash("sha256").update(source).digest("hex") })), nativeRaf: result.nativeRaf, nativeStorage: result.nativeStorage }, null, 2) + "\n");
} finally { await context.close(); await browser.close(); finish(); }
