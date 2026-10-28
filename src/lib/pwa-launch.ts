/** Strict, non-destructive PWA launch intents; never execute arbitrary commands from a URL. */
export const MAX_LAUNCH_URL = 2048;

/** The only external-protocol action is opening an existing Fusion module by id. */
export function protocolModule(raw: string, allowed: readonly string[]): string | null {
  if (!raw || raw.length > MAX_LAUNCH_URL || /[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "web+fusion:" || u.hostname !== "open" || u.username || u.password || u.port || u.hash
      || (u.pathname !== "" && u.pathname !== "/")) return null;
    const keys = [...u.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== "app") return null;
    const app = u.searchParams.get("app");
    return app && allowed.includes(app) ? app : null;
  } catch { return null; }
}

/** Existing-window launch URLs must be same-origin and limited to a module or safe protocol intent. */
export function launchModule(target: string, origin: string, allowed: readonly string[]): string | null {
  if (!target || target.length > MAX_LAUNCH_URL || /[\u0000-\u0020\u007f\\]/.test(target)) return null;
  try {
    const u = new URL(target, origin);
    if (u.origin !== origin || u.username || u.password || u.pathname !== "/" || u.hash) return null;
    const keys = [...u.searchParams.keys()];
    if (keys.length !== 1) return null;
    if (keys[0] === "open") {
      const app = u.searchParams.get("open");
      return app && allowed.includes(app) ? app : null;
    }
    if (keys[0] === "cmd") return protocolModule(u.searchParams.get("cmd") ?? "", allowed);
    return null;
  } catch { return null; }
}
