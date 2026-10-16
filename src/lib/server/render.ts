/**
 * Mechanism B4 (browser-engine alternative): server-side headless-render
 * snapshot for sites that refuse both direct iframing (B-default) and the
 * same-origin proxy (B1 — e.g. sites that are mostly client-side-rendered JS
 * the proxy's static-HTML rewrite can't execute meaningfully). Renders the
 * target with a real Chromium (Playwright) OUT OF PROCESS on the server and
 * returns a screenshot. You are not framing their site — you are looking at a
 * picture of it. No interaction, which is the honest, declared limit.
 *
 * DECLARED CAPABILITY UNCERTAINTY (this is deliberately NOT assumed to work):
 * Playwright's Chromium BINARY is a separate ~100 MB download from the npm
 * package; whether it is present in the platform's production container is a
 * genuine open question this module answers by PROBING, not assuming. If the
 * binary is missing, `capable()` returns false (cached) and every caller
 * degrades to an honest "snapshot rendering unavailable in this deployment"
 * message — exactly DP-10 capability honesty, extended to a SERVER-side
 * capability instead of only browser APIs.
 */
let cached: boolean | null = null;

export async function renderCapable(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ args: ["--no-sandbox"], timeout: 10_000 });
    await browser.close();
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

export async function renderSnapshot(url: string, opts: { width?: number; height?: number } = {}): Promise<{ png: Buffer; title: string; finalUrl: string }> {
  if (!(await renderCapable())) throw new Error("server-side rendering is unavailable in this deployment (Chromium binary not present)");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    const [png, title] = await Promise.all([page.screenshot({ type: "png" }), page.title()]);
    return { png: Buffer.from(png), title, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}
