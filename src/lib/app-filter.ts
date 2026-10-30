/** AP-06: app-hub filtering. Matches title and group; group facet is exact
 *  so "Create" never substring-matches an unrelated group name. */
export interface AppLike { title: string; group: string; summary?: string }
export function filterApps<T extends AppLike>(apps: T[], q: string, group = "all"): T[] {
  const needle = q.trim().toLowerCase();
  return apps.filter((a) => (group === "all" || a.group === group) && (!needle || `${a.title} ${a.group} ${a.summary ?? ""}`.toLowerCase().includes(needle)));
}
export const appGroups = <T extends AppLike>(apps: T[]): string[] => [...new Set(apps.map((a) => a.group))].sort();
