/**
 * PR-07 Browser tab/session model (TT16; pure). Pareto-superior parts adapted from the competitor TT14 tree
 * (browserState.ts — URL guard, restore normalisation, batch close, sleep invariants) onto OUR tab shape, plus
 * fixes found while porting:
 *  - restored/typed URLs must be absolute http(s) without credentials and NOT our own origin: same-origin content in an
 *    iframe that has allow-scripts + allow-same-origin can remove its own sandbox (HTML spec warning on the sandbox
 *    attribute), so a crafted session/preset could otherwise run code with the shell's privileges;
 *  - closing the active tab re-points `active` (previously the view went blank).
 * Per-site permissions (PR-07l) are DELEGATION only: the iframe `allow` attribute can pass a feature the shell itself
 * holds to an embedded origin, or deny it; it can never grant what the top-level document lacks.
 */
export interface Tab {
  id: string; url: string; title: string; group: string; pinned: boolean; asleep: boolean;
  verdict?: string; reason?: string; host?: string; mode?: "iframe" | "proxy" | "reader" | "snapshot";
  /** TT36: named private-proxy profile; tabs with the same name share one cookie jar (absent = this tab only) */
  profile?: string;
}
export interface TabGroup { id: string; name: string; color: string; collapsed: boolean }
export interface Session { tabs: Tab[]; active: string; groups: TabGroup[]; perms: Record<string, string[]> }

export const MAX_TABS = 100, MAX_GROUPS = 30;
export const PERMISSION_FEATURES = ["camera", "microphone", "geolocation", "fullscreen", "clipboard-write", "autoplay", "payment", "display-capture"] as const;
export const GROUP_COLORS = ["#5b8cff", "#39d98a", "#f5a524", "#f43f5e", "#a855f7", "#14b8a6", "#94a3b8"];

/** Absolute http(s) only; no userinfo (https://bank.com@evil.example phishing form); not `selfOrigin`. Bare hosts get https://. */
export function safeBrowserUrl(input: string, selfOrigin?: string): string | null {
  const text = String(input ?? "").trim();
  if (!text || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || !u.hostname) return null;
    if (selfOrigin && u.origin === new URL(selfOrigin).origin) return null;
    return u.href;
  } catch { return null; }
}
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
let seq = 0;
export const makeTab = (url: string, id?: string): Tab => ({ id: id ?? `t${Date.now().toString(36)}${(seq++).toString(36)}`, url, title: hostOf(url), group: "", pinned: false, asleep: false });

/** Validate an untrusted saved session (win.props / presets / imported bundles). */
/** A profile name from untrusted input: 1–30 letters, digits, spaces, "-" or "_"; anything else → none. */
export function safeProfileName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N} _-]{1,30}$/u.test(t) ? t : undefined;
}

export function normalizeSession(raw: unknown, selfOrigin?: string, fallbackUrl = "https://example.com"): Session & { dropped: number } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Session> & { tabs?: unknown[] };
  let dropped = 0;
  const groups: TabGroup[] = (Array.isArray(o.groups) ? o.groups : []).slice(0, MAX_GROUPS)
    .filter((g): g is TabGroup => !!g && typeof g.id === "string" && /^[\w-]{1,40}$/.test(g.id))
    .map((g) => ({ id: g.id, name: String(g.name ?? "Group").slice(0, 60) || "Group", color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : GROUP_COLORS[0], collapsed: !!g.collapsed }));
  const gids = new Set(groups.map((g) => g.id));
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of (Array.isArray(o.tabs) ? o.tabs : []).slice(0, MAX_TABS) as Partial<Tab>[]) {
    const url = t && typeof t.url === "string" ? safeBrowserUrl(t.url, selfOrigin) : null;
    if (!url || typeof t.id !== "string" || !/^[\w-]{1,40}$/.test(t.id) || seen.has(t.id)) { dropped++; continue; }
    seen.add(t.id);
    tabs.push({ id: t.id, url, title: String(t.title ?? hostOf(url)).slice(0, 100), group: t.group && gids.has(t.group) ? t.group : "", pinned: !!t.pinned, asleep: !!t.asleep,
      mode: t.mode === "proxy" || t.mode === "reader" || t.mode === "snapshot" ? t.mode : undefined,
      profile: safeProfileName(t.profile) });
  }
  if (!tabs.length) tabs.push(makeTab(safeBrowserUrl(fallbackUrl, selfOrigin) ?? "https://example.com/"));
  const perms: Record<string, string[]> = {};
  if (o.perms && typeof o.perms === "object") for (const [h, fs] of Object.entries(o.perms).slice(0, 200)) {
    if (/^[a-z0-9.-]+(:\d+)?$/i.test(h) && Array.isArray(fs)) perms[h] = fs.filter((f): f is string => (PERMISSION_FEATURES as readonly string[]).includes(f));
  }
  const ordered = sortPinned(tabs);
  const active = typeof o.active === "string" && tabs.some((t) => t.id === o.active) ? o.active : ordered[0].id;
  return { tabs: ordered, active, groups, perms, dropped };
}

/** Pinned tabs sit left of all others (Chrome/Edge/Firefox behaviour); relative order otherwise kept. */
export const sortPinned = (tabs: Tab[]) => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];

function reconcile(s: Session, tabs: Tab[], closedIndex = 0): Session {
  if (!tabs.length) { const t = makeTab("https://example.com"); return { ...s, tabs: [t], active: t.id }; }
  if (tabs.some((t) => t.id === s.active)) return { ...s, tabs };
  // like desktop browsers: activate the tab that slid into the closed slot, else the new last tab
  const next = tabs[Math.min(closedIndex, tabs.length - 1)];
  return { ...s, tabs: tabs.map((t) => (t.id === next.id ? { ...t, asleep: false } : t)), active: next.id };
}
export function closeTab(s: Session, id: string): Session {
  const i = s.tabs.findIndex((t) => t.id === id);
  return i < 0 ? s : reconcile(s, s.tabs.filter((t) => t.id !== id), i);
}
/** PR-07q batch actions. Pinned tabs are never batch-closed (desktop browsers behave the same). */
export function batchClose(s: Session, id: string, target: "others" | "right" | "duplicates"): { session: Session; closed: number } {
  const idx = s.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return { session: s, closed: 0 };
  const keepUrl = new Set<string>();
  const tabs = s.tabs.filter((t, i) => {
    if (t.pinned || t.id === id) { keepUrl.add(t.url); return true; }
    if (target === "others") return false;
    if (target === "right") return i < idx;
    if (keepUrl.has(t.url) || t.url === s.tabs[idx].url) return false;
    keepUrl.add(t.url); return true;
  });
  const session = reconcile({ ...s, active: s.tabs.some((t) => t.id === s.active && tabs.includes(t)) ? s.active : id }, tabs);
  return { session, closed: s.tabs.length - tabs.length };
}
export const togglePin = (s: Session, id: string): Session => ({ ...s, tabs: sortPinned(s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned, asleep: false } : t))) });
/** Sleeping discards the frame. The visible tabs (active + split partner) and pinned tabs are never put to sleep. */
export function sleepTab(s: Session, id: string, splitPartner: string | null): Session {
  const t = s.tabs.find((x) => x.id === id);
  if (!t || t.pinned || id === s.active || id === splitPartner) return s;
  return { ...s, tabs: s.tabs.map((x) => (x.id === id ? { ...x, asleep: true } : x)) };
}
export function sleepInactive(s: Session, splitPartner: string | null): { session: Session; slept: number } {
  let n = 0; let cur = s;
  for (const t of s.tabs) { const next = sleepTab(cur, t.id, splitPartner); if (next !== cur && !t.asleep) n++; cur = next; }
  return { session: cur, slept: n };
}
export const activate = (s: Session, id: string): Session => (s.tabs.some((t) => t.id === id) ? { ...s, active: id, tabs: s.tabs.map((t) => (t.id === id ? { ...t, asleep: false } : t)) } : s);
export function createGroup(s: Session, tabId: string, name: string): Session {
  if (s.groups.length >= MAX_GROUPS) return s;
  let n = s.groups.length + 1; while (s.groups.some((g) => g.id === `g${n}`)) n++;
  const g: TabGroup = { id: `g${n}`, name: name.trim().slice(0, 60) || `Group ${n}`, color: GROUP_COLORS[(n - 1) % GROUP_COLORS.length], collapsed: false };
  return { ...s, groups: [...s.groups, g], tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, group: g.id } : t)) };
}
export const setGroup = (s: Session, tabId: string, gid: string): Session => ({ ...s, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, group: s.groups.some((g) => g.id === gid) ? gid : "" } : t)) });
export const toggleCollapse = (s: Session, gid: string): Session => ({ ...s, groups: s.groups.map((g) => (g.id === gid ? { ...g, collapsed: !g.collapsed } : g)) });
/** Removing a group ungroups its tabs (never closes them). */
export const removeGroup = (s: Session, gid: string): Session => ({ ...s, groups: s.groups.filter((g) => g.id !== gid), tabs: s.tabs.map((t) => (t.group === gid ? { ...t, group: "" } : t)) });
/** Visible strip order: ungrouped/collapsed handling — tabs of a collapsed group are hidden unless active. */
export const visibleTabs = (s: Session, query = "") => {
  const q = query.trim().toLowerCase();
  return s.tabs.filter((t) => {
    if (q) return t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q);
    const g = s.groups.find((x) => x.id === t.group);
    return !g?.collapsed || t.id === s.active;
  });
};
/** iframe `allow` attribute: every listed feature explicitly 'none' unless delegated to this host. */
export function allowAttribute(perms: Record<string, string[]>, url: string): string {
  const granted = new Set(perms[hostOf(url)] ?? []);
  return PERMISSION_FEATURES.map((f) => (granted.has(f) ? `${f} ${originOf(url)}` : `${f} 'none'`)).join("; ");
}
const originOf = (url: string) => { try { return new URL(url).origin; } catch { return "'none'"; } };
export { hostOf };
