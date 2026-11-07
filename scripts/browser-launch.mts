/**
 * Resolve a real Chromium for the test/screenshot scripts.
 *
 * Order:
 *  1. PW_CHROMIUM=/path/to/chrome (explicit)
 *  2. Playwright's own downloaded browser (default `chromium.launch()`), if present
 *  3. @sparticuz/chromium from a side install (TOOLS_DIR, default /home/user/tools):
 *     a brotli-packed Chromium shipped *inside* the npm tarball, so it can be
 *     installed from registry.npmjs.org when the Playwright CDN is unreachable
 *     (the Arena sandbox's network allowlist). Its bundled NSS/NSPR libraries
 *     are unpacked to /tmp/al2023/lib and passed through LD_LIBRARY_PATH.
 *
 * Nothing here fakes a browser: if none of the three resolves, launch throws.
 */
import { chromium, type Browser, type LaunchOptions } from "playwright";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

let sharedBrowser: Browser | null = null;

/**
 * Process-wide shared Chromium for suites that open several contexts.
 *
 * A context is a separate cookie jar, cache and permission set, so two contexts
 * in one browser cannot observe each other — the isolation a browser suite needs
 * is per context, not per process. Reusing the *same* binary removes ~1.5–2.5 s of
 * launch per test file with zero change to what is asserted. Callers that need a
 * private browser (or a special launch flag) must call `launchChromium` directly;
 * this helper is opt-in and never silently downgrades a flag set.
 */
export async function sharedChromium(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await launchChromium();
  return sharedBrowser;
}

/**
 * Close and forget the shared browser.
 *
 * TT142 speed repair: this used to set the cache to null and leave a live browser
 * behind, so a second `sharedChromium()` in the same process launched a *second*
 * Chromium whose first call then had to shut down lazily. Each of those costs
 * memory on a 2-CPU host, and a suite that opens several contexts paid it once
 * per suite. Closing is awaited by callers that care; the return is a promise so
 * the caller can wait for the process to actually exit rather than hope.
 */
export async function releaseSharedChromium(): Promise<void> {
  const b = sharedBrowser;
  sharedBrowser = null;
  if (b && b.isConnected()) await b.close().catch(() => undefined);
}

export async function launchChromium(extraArgs: string[] = [], opts: LaunchOptions = {}): Promise<Browser> {
  // TT142: a launch-time failure of the *bundled* binary is the common case here
  // (the sandbox has no `playwright install`), so fall through on any error, not
  // only a missing file. The sparticuz path below is the one that actually works.
  const explicit = process.env.PW_CHROMIUM;
  if (explicit) return chromium.launch({ ...opts, executablePath: explicit, args: extraArgs });
  try {
    if (existsSync(chromium.executablePath())) return await chromium.launch({ ...opts, args: extraArgs });
  } catch { /* fall through to sparticuz */ }
  const tools = process.env.TOOLS_DIR ?? "/home/user/tools";
  const args0 = ["--no-sandbox", "--no-zygote", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", ...extraArgs];
  const ld0 = ["/tmp/al2023/lib", "/tmp", process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(":");
  // TT119 fast path: a previous suite already paid sparticuz's unpack
  // (~2.5 s of brotli verify/decompress per process). If the unpack products
  // are all on disk, launch the very same binary with the very same args and
  // environment the slow path below would build — scheduling only, the
  // browser under test is byte-identical. Any missing marker falls through
  // to the real unpack, so a cold machine behaves exactly as before.
  if (existsSync("/tmp/chromium") && existsSync("/tmp/al2023/lib") && existsSync("/tmp/fonts/fonts.conf")) {
    return chromium.launch({ ...opts, executablePath: "/tmp/chromium", args: args0, env: { ...process.env, LD_LIBRARY_PATH: ld0, FONTCONFIG_PATH: "/tmp/fonts" } as Record<string, string> });
  }
  const req = createRequire(`${tools}/package.json`);
  process.env.AWS_EXECUTION_ENV ??= "AWS_Lambda_nodejs22.x"; // makes sparticuz unpack its shared libs
  const mod = req("@sparticuz/chromium");
  const sp = mod.default ?? mod;
  const executablePath: string = await sp.executablePath();
  const ld = ["/tmp/al2023/lib", "/tmp", process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(":");
  // sparticuz's default args force --single-process (Lambda); we keep the multi-process model so
  // site-isolation / OOPIF tests remain meaningful, and only add what headless needs.
  const args = ["--no-sandbox", "--no-zygote", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", ...extraArgs];
  return chromium.launch({ ...opts, executablePath, args, env: { ...process.env, LD_LIBRARY_PATH: ld, FONTCONFIG_PATH: "/tmp/fonts" } as Record<string, string> });
}
