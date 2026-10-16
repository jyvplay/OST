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

export async function launchChromium(extraArgs: string[] = [], opts: LaunchOptions = {}): Promise<Browser> {
  const explicit = process.env.PW_CHROMIUM;
  if (explicit) return chromium.launch({ ...opts, executablePath: explicit, args: extraArgs });
  try {
    if (existsSync(chromium.executablePath())) return await chromium.launch({ ...opts, args: extraArgs });
  } catch { /* fall through to sparticuz */ }
  const tools = process.env.TOOLS_DIR ?? "/home/user/tools";
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
