/** AP-07: app-hub ordering. Group order follows the registry's own group
 *  sequence (the shell's taxonomy), title is alphabetical within group;
 *  sorts copy so the registry order stays canonical elsewhere. */
export interface AppSortItem { title: string; group: string }
export type AppSort = "group" | "title";
export function sortApps<T extends AppSortItem>(apps: T[], sort: AppSort, groupOrder: string[]): T[] {
  const rank = (g: string) => { const i = groupOrder.indexOf(g); return i < 0 ? groupOrder.length : i; };
  return [...apps].sort((a, b) => (sort === "group" ? rank(a.group) - rank(b.group) : 0) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}
