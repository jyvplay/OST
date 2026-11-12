/**
 * TT147 (ST-02) — the browser/OS settings index.
 *
 * A web app cannot read or change an operating-system setting. What it can do
 * is save a person the hunt: name the panel, and hand over the URI scheme the
 * platform itself registers for it.
 *
 * Three honest constraints shape this module:
 *
 *   1. The URI is a *request*. `ms-settings:privacy-webcam` may open Settings,
 *      open it on a different page, or do nothing at all, depending on the
 *      browser's external-protocol policy and the user's answer. Every row says
 *      so; none says "opened".
 *   2. The mapping is per platform, and a platform we do not have a verified URI
 *      for returns `null` rather than a plausible-looking guess. A wrong deep
 *      link is worse than none: it teaches the user to distrust the feature.
 *   3. iOS has no public scheme for app settings from the web. The index says
 *      that in words instead of offering an `App-Prefs:` link that Safari
 *      ignores.
 *
 * The schemes below are documented by their vendors (Microsoft's `ms-settings:`
 * list, Apple's `x-apple.systempreferences:` pane identifiers, the Android
 * `Settings.ACTION_*` intent actions, and GNOME's `gnome-control-center` panel
 * names); no vendor code or data file is copied here.
 */

export type Platform = "windows" | "macos" | "linux" | "android" | "ios" | "unknown";

export interface SettingsEntry {
  id: string;
  label: string;
  /** Words a person would actually type. */
  keywords: string[];
  /** One line of why the OS panel matters for this app. */
  why: string;
  uris: Partial<Record<Platform, string>>;
}

/**
 * The index. Deliberately small and verified: fourteen panels that this app's
 * own features point at. Adding a row without a verified URI is how an index
 * like this rots.
 */
export const ENTRIES: readonly SettingsEntry[] = [
  {
    id: "camera", label: "Camera access", keywords: ["camera", "webcam", "photo", "video capture", "privacy"],
    why: "Photo capture and video calls fail silently when the OS blocks the camera.",
    uris: {
      windows: "ms-settings:privacy-webcam",
      macos: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
      android: "intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;end",
      linux: "gnome-control-center privacy",
    },
  },
  {
    id: "microphone", label: "Microphone access", keywords: ["microphone", "mic", "audio input", "voice", "record", "privacy"],
    why: "Voice notes and the recorder need the microphone granted to the browser.",
    uris: {
      windows: "ms-settings:privacy-microphone",
      macos: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      android: "intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;end",
      linux: "gnome-control-center privacy",
    },
  },
  {
    id: "notifications", label: "Notifications", keywords: ["notifications", "alerts", "banners", "focus assist", "do not disturb"],
    why: "Alarms and reminders are useless if the OS drops their notifications.",
    uris: {
      windows: "ms-settings:notifications",
      macos: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      android: "intent:#Intent;action=android.settings.APP_NOTIFICATION_SETTINGS;end",
      linux: "gnome-control-center notifications",
    },
  },
  {
    id: "default-browser", label: "Default browser", keywords: ["default browser", "browser default", "http handler", "associations"],
    why: "Links opened from other apps land here only if this app's host browser is the default.",
    uris: {
      windows: "ms-settings:defaultapps",
      macos: "x-apple.systempreferences:com.apple.preference.general",
      linux: "gnome-control-center default-apps",
    },
  },
  {
    id: "display-scaling", label: "Display scaling", keywords: ["display", "resolution", "scale", "dpi", "zoom", "monitor"],
    why: "Per-monitor scaling decides whether this interface is crisp or blurry.",
    uris: {
      windows: "ms-settings:display",
      macos: "x-apple.systempreferences:com.apple.Displays-Settings.extension",
      linux: "gnome-control-center display",
      android: "intent:#Intent;action=android.settings.DISPLAY_SETTINGS;end",
    },
  },
  {
    id: "sound-output", label: "Sound output device", keywords: ["sound", "audio output", "speakers", "headphones", "sink"],
    why: "Output routing this app requests is applied by the OS mixer.",
    uris: {
      windows: "ms-settings:sound",
      macos: "x-apple.systempreferences:com.apple.Sound-Settings.extension",
      linux: "gnome-control-center sound",
    },
  },
  {
    id: "bluetooth", label: "Bluetooth", keywords: ["bluetooth", "pair", "controller", "headset", "gamepad"],
    why: "A gamepad or headset only appears to the browser once the OS has paired it.",
    uris: {
      windows: "ms-settings:bluetooth",
      macos: "x-apple.systempreferences:com.apple.Bluetooth-Settings.extension",
      linux: "gnome-control-center bluetooth",
      android: "intent:#Intent;action=android.settings.BLUETOOTH_SETTINGS;end",
    },
  },
  {
    id: "network", label: "Wi-Fi and network", keywords: ["wifi", "wi-fi", "network", "internet", "proxy", "vpn", "offline"],
    why: "Offline mode is this app's answer to a link the OS is still negotiating.",
    uris: {
      windows: "ms-settings:network",
      macos: "x-apple.systempreferences:com.apple.wifi-settings-extension",
      linux: "gnome-control-center wifi",
      android: "intent:#Intent;action=android.settings.WIFI_SETTINGS;end",
    },
  },
  {
    id: "storage", label: "Storage and disk space", keywords: ["storage", "disk", "space", "quota", "downloads", "full"],
    why: "A full disk is reported by the browser as a quota error, not as a full disk.",
    uris: {
      windows: "ms-settings:storagesense",
      macos: "x-apple.systempreferences:com.apple.settings.Storage",
      linux: "gnome-control-center info-overview",
      android: "intent:#Intent;action=android.settings.INTERNAL_STORAGE_SETTINGS;end",
    },
  },
  {
    id: "accessibility", label: "Accessibility", keywords: ["accessibility", "screen reader", "magnifier", "contrast", "motion", "text size"],
    why: "Reduce-motion and high-contrast preferences are read by the browser, and set here.",
    uris: {
      windows: "ms-settings:easeofaccess",
      macos: "x-apple.systempreferences:com.apple.Accessibility-Settings.extension",
      linux: "gnome-control-center universal-access",
      android: "intent:#Intent;action=android.settings.ACCESSIBILITY_SETTINGS;end",
    },
  },
  {
    id: "power", label: "Power and sleep", keywords: ["power", "sleep", "battery", "hibernate", "suspend", "background"],
    why: "A suspended machine cannot run the timers this app schedules.",
    uris: {
      windows: "ms-settings:powersleep",
      macos: "x-apple.systempreferences:com.apple.Battery-Settings.extension",
      linux: "gnome-control-center power",
      android: "intent:#Intent;action=android.settings.BATTERY_SAVER_SETTINGS;end",
    },
  },
  {
    id: "date-time", label: "Date, time and time zone", keywords: ["time", "date", "timezone", "clock", "automatic", "calendar"],
    why: "An OS clock that is wrong makes every reminder this app fires wrong too.",
    uris: {
      windows: "ms-settings:dateandtime",
      macos: "x-apple.systempreferences:com.apple.Date-Time-Settings.extension",
      linux: "gnome-control-center datetime",
      android: "intent:#Intent;action=android.settings.DATE_SETTINGS;end",
    },
  },
  {
    id: "printers", label: "Printers", keywords: ["printer", "print", "pdf", "scanner"],
    why: "The browser's print dialog forwards to whatever the OS has installed.",
    uris: {
      windows: "ms-settings:printers",
      macos: "x-apple.systempreferences:com.apple.Print-Scan-Settings.extension",
      linux: "gnome-control-center printers",
    },
  },
  {
    id: "apps", label: "Installed applications", keywords: ["apps", "applications", "uninstall", "installed", "programs"],
    why: "A PWA is installed by the browser, and uninstalled from it — not from the OS list, on most platforms.",
    uris: {
      windows: "ms-settings:appsfeatures",
      macos: "x-apple.systempreferences:com.apple.Application-Users-Settings.extension",
      linux: "gnome-control-center applications",
      android: "intent:#Intent;action=android.settings.MANAGE_APPLICATIONS_SETTINGS;end",
    },
  },
] as const;

const MAC = /mac|iphone|ipad|ipod/i;
const WINDOWS = /win/i;
const LINUX = /linux|x11|cros/i;
const ANDROID = /android/i;
const IOS = /iphone|ipad|ipod/i;

/**
 * Which platform's URI table applies.
 *
 * Order matters: an iPad reports `MacIntel` in `platform`, and an Android
 * browser on a phone reports `Linux armv8l`, so the user agent is consulted
 * first for those two and the platform string is the tie-breaker. Unknown is a
 * real answer — it means "do not show a link".
 */
export function detectPlatform(userAgent: string, platform: string): Platform {
  const ua = userAgent || "";
  if (IOS.test(ua)) return "ios";
  if (ANDROID.test(ua)) return "android";
  if (WINDOWS.test(ua) || WINDOWS.test(platform)) return "windows";
  if (MAC.test(ua) || MAC.test(platform)) return "macos";
  if (LINUX.test(ua) || LINUX.test(platform)) return "linux";
  return "unknown";
}

export interface DeepLink {
  entryId: string;
  uri: string;
  /** What the browser can and cannot promise about this URI. */
  caveat: string;
}

/**
 * The URI for one entry on one platform, or a refusal that explains itself.
 *
 * Covers the two cases that produce a dead end: no URI for this platform at all
 * (iOS, and any OS we could not identify) and a platform whose settings are not
 * addressable by URI (also iOS).
 */
export function deepLinkFor(entry: SettingsEntry, platform: Platform): { ok: true; link: DeepLink } | { ok: false; reason: string } {
  if (platform === "ios") {
    return { ok: false, reason: "iOS has no public settings URI for web apps — open Settings by hand and search for the panel." };
  }
  if (platform === "unknown") {
    return { ok: false, reason: "this platform was not identified, so no settings URI is offered." };
  }
  const uri = entry.uris[platform];
  if (!uri) return { ok: false, reason: `${entry.label} has no verified ${platform} settings URI.` };
  const scheme = uri.slice(0, uri.indexOf(":") + 1);
  const caveat = uri.startsWith("intent:")
    ? "an Android intent handed to the browser; it may open the app's settings instead of the system panel."
    : `${scheme} is handed to the ${platform} shell. Your browser may ask first, open a different page, or do nothing; this app cannot tell which happened.`;
  return { ok: true, link: { entryId: entry.id, uri, caveat } };
}

/**
 * Search: label hits outrank keyword hits, and a word that matches several
 * entries ranks the one whose label contains it first. Deterministic — the same
 * query always produces the same order, which is what makes it testable.
 */
export function searchEntries(query: string, platform: Platform, limit = 5): { entry: SettingsEntry; link: DeepLink | null; reason: string | null }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 4);
  const scored: { entry: SettingsEntry; score: number }[] = [];
  for (const entry of ENTRIES) {
    const label = entry.label.toLowerCase();
    const words = `${label} ${entry.keywords.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (label.startsWith(t)) score += 5;
      else if (label.includes(t)) score += 4;
      else if (entry.keywords.some((k) => k.toLowerCase().startsWith(t))) score += 3;
      else if (words.includes(t)) score += 1;
      else score -= 10; // a term that misses makes the entry a non-match
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, Math.max(0, limit)).map(({ entry }) => {
    const r = deepLinkFor(entry, platform);
    return r.ok ? { entry, link: r.link, reason: null } : { entry, link: null, reason: r.reason };
  });
}

/** Every entry with its link (or refusal) for a platform — the index view. */
export function indexFor(platform: Platform): { entry: SettingsEntry; link: DeepLink | null; reason: string | null }[] {
  return ENTRIES.map((entry) => {
    const r = deepLinkFor(entry, platform);
    return r.ok ? { entry, link: r.link, reason: null } : { entry, link: null, reason: r.reason };
  });
}

/** How many entries can actually be offered on this platform. */
export function coverage(platform: Platform): { available: number; total: number } {
  return { available: ENTRIES.filter((e) => Boolean(e.uris[platform])).length, total: ENTRIES.length };
}
