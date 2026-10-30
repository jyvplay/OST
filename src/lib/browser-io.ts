/** TT117 BR-01 — browser session export/import.
 * Export is tabs + groups only: proxy session ids, embed verdicts and per-tab
 * runtime state are deliberately excluded (they are meaningless on another
 * device and leaking a session id would be a privacy bug). Import re-runs every
 * URL through the same safeBrowserUrl guard session restore uses, and reports
 * dropped tabs instead of silently losing them. */
import { safeBrowserUrl, type TabGroup, type Tab } from "./browserSession";
export const BROWSER_EXPORT_KIND = "fusion.browser-session.v1";
export interface BrowserImport { tabs: Tab[]; groups: TabGroup[]; dropped: number }

export function exportSession(tabs: Tab[], groups: TabGroup[]): string {
  return JSON.stringify({
    kind: BROWSER_EXPORT_KIND, exportedAt: new Date().toISOString(),
    tabs: tabs.map((t) => ({ url: t.url, title: t.title, pinned: !!t.pinned, group: t.group || null, profile: t.profile ?? null })),
    groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: !!g.collapsed })),
  }, null, 2);
}
export function parseBrowserImport(json: string, origin: string): BrowserImport {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { throw new Error("browser import is not valid JSON"); }
  const d = doc as { kind?: string; tabs?: unknown; groups?: unknown };
  if (!d || d.kind !== BROWSER_EXPORT_KIND || !Array.isArray(d.tabs)) throw new Error("not a Fusion browser session export");
  if (d.tabs.length > 200) throw new Error("browser import has too many tabs");
  const groups: TabGroup[] = (Array.isArray(d.groups) ? d.groups : []).slice(0, 30).map((raw, i) => {
    const g = raw as Partial<TabGroup>;
    return { id: typeof g.id === "string" && g.id ? g.id.slice(0, 64) : `imported-group-${i + 1}`, name: String(g.name ?? "Imported").slice(0, 60), color: typeof g.color === "string" ? g.color : "#888", collapsed: !!g.collapsed };
  });
  const groupIds = new Set(groups.map((g) => g.id));
  let dropped = 0;
  const tabs: Tab[] = [];
  d.tabs.forEach((raw, i) => {
    const t = raw as Partial<Tab>;
    const url = typeof t.url === "string" ? safeBrowserUrl(t.url, origin) : null;
    if (!url) { dropped++; return; }
    const rawGroup = (t as { group?: unknown }).group;
    tabs.push({
      id: `imported-${i + 1}-${url.length}`, url,
      title: String(t.title ?? "").slice(0, 200) || (() => { try { return new URL(url).host; } catch { return url; } })(),
      pinned: !!t.pinned, asleep: false,
      group: typeof rawGroup === "string" && groupIds.has(rawGroup) ? rawGroup : "",
      profile: typeof t.profile === "string" ? t.profile.slice(0, 40) : undefined,
    });
  });
  if (!tabs.length) throw new Error("browser import contains no usable tabs");
  return { tabs, groups, dropped };
}
