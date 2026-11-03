/** Exercise the real responsive toolbar route, never force-click or invoke a
 * hidden control. At narrow widths a person uses More; the tests must too. */
import type { Locator, Page } from "playwright";
export async function bannerClick(page: Page, scope: Locator, name: string | RegExp, menuName: string | RegExp = name) {
  const direct = scope.getByRole("button", { name }).first();
  if (await direct.isVisible()) { await direct.click(); return; }
  await scope.getByRole("button", { name: /^More/ }).first().click();
  const item = page.getByRole("menuitem", { name: menuName }).or(page.getByRole("menuitemcheckbox", { name: menuName }));
  await item.first().click();
}
export async function bannerTestId(page: Page, scope: Locator, id: string, menuName: string | RegExp) {
  const direct = scope.getByTestId(id).first();
  if (await direct.isVisible()) { await direct.click(); return; }
  await scope.getByRole("button", { name: /^More/ }).first().click();
  await page.getByRole("menuitem", { name: menuName, exact: typeof menuName === "string" }).or(page.getByRole("menuitemcheckbox", { name: menuName, exact: typeof menuName === "string" })).first().click();
}
