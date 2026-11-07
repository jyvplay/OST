/**
 * TT139 (ST-02) — a settings index that knows what a web page cannot link to.
 *
 * Nearly every "open your browser settings" button in a web app is a lie: a page
 * may not navigate to `chrome://settings`, and `edge://`, `about:preferences`
 * (Firefox internal), `opera://`, `vivaldi://` and `brave://` are equally
 * off-limits. The honest thing is to say so, put the exact deep link on the
 * clipboard so the user can paste it, and name the path in words.
 *
 * This module is a *validator plus an instruction generator*. It never invents a
 * URL for a browser it does not know: an unknown user agent yields the generic
 * path and the module reports that it is guessing.
 */

export type BrowserFamily = "chromium" | "edge" | "brave" | "opera" | "vivaldi" | "firefox" | "safari" | "unknown";

export interface SettingsEntry {
  id: string;
  label: string;
  /** why a user would go here, in one line */
  purpose: string;
  paths: Partial<Record<BrowserFamily, string>>;
  /** self-hosted web apps can link to this in their own UI instead */
  webAlternative?: string;
}

const CHROME = "chrome://settings";
const EDGE = "edge://settings";

export const SETTINGS_INDEX: SettingsEntry[] = [
  { id: "notifications", label: "Notifications", purpose: "Allow or block this site's alerts", paths: { chromium: `${CHROME}/content/notifications`, edge: `${EDGE}/cookiesSitePermissions`, brave: `${CHROME}/content/notifications`, opera: "opera://settings/content/notifications", vivaldi: "vivaldi://settings/privacy", firefox: "about:preferences#privacy", safari: "Safari → Settings for This Website" }, webAlternative: "the Alerts module's permission row" },
  { id: "camera", label: "Camera and microphone", purpose: "Grant device access after a denial", paths: { chromium: `${CHROME}/content/media`, edge: `${EDGE}/cookiesSitePermissions`, brave: `${CHROME}/content/media`, firefox: "about:preferences#privacy", safari: "Safari → Settings for This Website" } },
  { id: "storage", label: "Site data and storage", purpose: "Clear or inspect what this origin keeps", paths: { chromium: `${CHROME}/content/all`, edge: `${EDGE}/sitePermissions`, brave: `${CHROME}/content/all`, firefox: "about:preferences#privacy", safari: "Safari → Privacy → Manage Website Data" } },
  { id: "downloads", label: "Downloads", purpose: "Where saved files land", paths: { chromium: `${CHROME}/downloads`, edge: `${EDGE}/downloads`, firefox: "about:preferences#general", safari: "Safari → Settings → General" } },
  { id: "clipboard", label: "Clipboard", purpose: "Why paste sometimes needs a key press", paths: { chromium: `${CHROME}/content/clipboard`, edge: `${EDGE}/cookiesSitePermissions`, firefox: "about:config (dom.events.asyncClipboard)", safari: "Safari → Settings → Websites" } },
  { id: "shortcuts", label: "Keyboard shortcuts", purpose: "See which chords the browser reserves", paths: { chromium: "chrome://extensions/shortcuts", edge: "edge://extensions/shortcuts", firefox: "about:addons → gear → Manage Extension Shortcuts", safari: "Safari → Settings → Websites" } },
  { id: "flags", label: "Experimental features", purpose: "Enable or disable a platform toggle", paths: { chromium: "chrome://flags", edge: "edge://flags", brave: "brave://flags", opera: "opera://flags", vivaldi: "vivaldi://experiments", firefox: "about:config", safari: "Develop → Experimental Features" } },
  { id: "devices", label: "USB and serial devices", purpose: "Reset a granted hardware permission", paths: { chromium: `${CHROME}/content/hid`, edge: `${EDGE}/cookiesSitePermissions`, firefox: "about:preferences#privacy", safari: "not offered" } },
  { id: "print", label: "Printing and PDF", purpose: "Change how pages are saved as PDF", paths: { chromium: `${CHROME}/printing`, edge: `${EDGE}/printing`, firefox: "about:preferences#general", safari: "Safari → Settings → Websites" } },
  { id: "autoplay", label: "Sound and autoplay", purpose: "Stop or allow media from starting", paths: { chromium: `${CHROME}/content/sound`, edge: `${EDGE}/cookiesSitePermissions`, firefox: "about:preferences#privacy", safari: "Safari → Settings → Websites" } },
];

const INTERNAL_SCHEMES = ["chrome:", "edge:", "brave:", "opera:", "vivaldi:", "about:", "chrome-extension:", "moz-extension:", "view-source:"];
const LINKABLE = ["https:", "http:", "mailto:", "tel:"];

export function detectBrowserFamily(userAgent: string): BrowserFamily {
  const ua = userAgent.toLowerCase();
  // Order matters: every Chromium fork also claims "chrome".
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("opr/") || ua.includes("opera")) return "opera";
  if (ua.includes("vivaldi")) return "vivaldi";
  if (ua.includes("brave")) return "brave";
  if (ua.includes("firefox") || ua.includes("fxios")) return "firefox";
  if (ua.includes("safari") && !ua.includes("chrom")) return "safari";
  if (ua.includes("chrome") || ua.includes("chromium") || ua.includes("crios")) return "chromium";
  return "unknown";
}

export interface LinkCheck { linkable: boolean; scheme: string; reason: string; copyText: string | null }

/**
 * Can this page navigate to `url`? Only for the four schemes a web page may use.
 * Everything else returns `linkable: false` **with the text to copy**, because a
 * refusal without the alternative is just an error message.
 */
export function checkLink(url: string): LinkCheck {
  const raw = String(url ?? "").trim();
  if (!raw) return { linkable: false, scheme: "", reason: "empty", copyText: null };
  if (/[\u0000-\u001f]/.test(raw)) return { linkable: false, scheme: "", reason: "control characters in the URL", copyText: null };
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!m) return { linkable: false, scheme: "", reason: "not an absolute URL (no scheme)", copyText: null };
  const scheme = `${m[1].toLowerCase()}:`;
  if (INTERNAL_SCHEMES.includes(scheme)) {
    return { linkable: false, scheme, reason: `the browser will not let a page open ${scheme} addresses`, copyText: raw };
  }
  if (!LINKABLE.includes(scheme)) return { linkable: false, scheme, reason: `unknown scheme ${scheme}`, copyText: null };
  if (scheme === "javascript:") return { linkable: false, scheme, reason: "script URLs are never a settings link", copyText: null };
  return { linkable: true, scheme, reason: "ok", copyText: null };
}

export interface Resolution {
  entry: SettingsEntry;
  family: BrowserFamily;
  url: string | null;
  /** what to show the user; always truthful about whether a click can work */
  action: "open" | "copy" | "manual" | "unsupported";
  instruction: string;
  guessed: boolean;
}

export function resolveSetting(entryId: string, userAgent: string): Resolution | null {
  const entry = SETTINGS_INDEX.find((e) => e.id === entryId);
  if (!entry) return null;
  const family = detectBrowserFamily(userAgent);
  const path = entry.paths[family];
  const guessed = family === "unknown";
  if (!path) {
    return { entry, family, url: null, action: "unsupported", instruction: `This browser's ${entry.label.toLowerCase()} page is not known here. Look for “${entry.label}” in its own settings, or use ${entry.webAlternative ?? "the app's own controls"}.`, guessed };
  }
  const check = checkLink(path);
  if (check.linkable) return { entry, family, url: path, action: "open", instruction: `Open ${entry.label}`, guessed };
  if (check.copyText) return { entry, family, url: path, action: "copy", instruction: `A page cannot open ${path}. Copy it and paste it into the address bar — it opens ${entry.label} (${entry.purpose.toLowerCase()}).`, guessed };
  // Safari "settings" entries are menus, not URLs.
  return { entry, family, url: null, action: "manual", instruction: `In ${path} turn on ${entry.label.toLowerCase()} for this site.`, guessed };
}
