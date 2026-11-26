import type { Page } from 'playwright';

/** Require the hydrated shell and the requested window identity. Some apps
 * legitimately have little text; keep the legacy best-effort text wait. */
export async function waitForDensity(page: Page, expected: string, timeout = 8_000): Promise<void> {
  await page.locator('[data-shell-ready="true"]').waitFor({ timeout });
  await page.locator('[data-win-id="w1"]').waitFor({ timeout });
  await page.waitForFunction(module => {
    const window = document.querySelector('[data-win-id="w1"]');
    return window?.getAttribute('data-module-id') === module;
  }, expected, { timeout });
  await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"]')?.textContent ?? '').length > 30, null, { timeout: 8_000 }).catch(() => null);
}
