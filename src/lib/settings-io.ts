/** TT118 ST-10 — settings import with a closed vocabulary.
 * Export is the settings map as JSON. Import only accepts keys the running app
 * already knows (from its own settings graph): an unknown key is refused in the
 * report, not written "for later", because a silently stored key that nothing
 * reads is a lie. Values must be strings; lock-protected keys are skipped and
 * reported. Nothing is applied by parsing — the caller applies `accepted`. */
export const SETTINGS_EXPORT_KIND = "fusion.settings.v1";
export interface SettingsImportReport { accepted: Record<string, string>; unknownKeys: string[]; invalidValues: string[] }
export function exportSettings(settings: Record<string, string>): string {
  return JSON.stringify({ kind: SETTINGS_EXPORT_KIND, exportedAt: new Date().toISOString(), settings }, null, 2);
}
export function parseSettingsImport(json: string, knownKeys: ReadonlySet<string>, lockedKeys: ReadonlySet<string> = new Set()): SettingsImportReport {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { throw new Error("settings import is not valid JSON"); }
  const d = doc as { kind?: string; settings?: unknown };
  if (!d || d.kind !== SETTINGS_EXPORT_KIND || !d.settings || typeof d.settings !== "object" || Array.isArray(d.settings)) throw new Error("not a Fusion settings export");
  const entries = Object.entries(d.settings as Record<string, unknown>);
  if (entries.length > 500) throw new Error("settings import has too many entries");
  const accepted: Record<string, string> = {};
  const unknownKeys: string[] = [], invalidValues: string[] = [];
  for (const [key, value] of entries) {
    if (lockedKeys.has(key)) { invalidValues.push(`${key} (locked)`); continue; }
    if (!knownKeys.has(key)) { unknownKeys.push(key); continue; }
    if (typeof value !== "string" || value.length > 10_000) { invalidValues.push(key); continue; }
    accepted[key] = value;
  }
  return { accepted, unknownKeys, invalidValues };
}
