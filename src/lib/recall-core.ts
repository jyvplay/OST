/** Recall's bounded, explicit contract. Original code; no native permission or DRM bypass. */
export const RECALL_LIMIT = 8 * 1024 * 1024;
export type RecallGrouping = 'host' | 'title' | 'custom';
export function recallUrl(value: string): URL {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || value.length > 8192) throw new Error('Use an absolute HTTP(S) URL without embedded credentials');
  u.hash = ''; return u;
}
export function recallLabel(value: string): string {
  return value.normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+/, '').trim().slice(0, 90) || 'untitled';
}
export function recallFolder(url: string, title: string, grouping: RecallGrouping, custom: string): string {
  const u = recallUrl(url);
  if (grouping === 'custom' && !custom.trim()) throw new Error('Enter a custom folder name');
  return `/Downloads/Recall/${recallLabel(grouping === 'custom' ? custom : grouping === 'title' ? title || u.hostname : u.host)}`;
}
export function recallSource(url: string): string { const u = recallUrl(url); u.search = ''; return u.href; }
export function recallMime(header: string): string {
  const type = header.split(';')[0].trim().toLowerCase();
  if (!/^(image|video|audio)\/[a-z0-9.+-]+$/.test(type) || /mpegurl|dash\+xml/.test(type)) throw new Error('Not a complete image/audio/video response. Playlists and page HTML are not media files; use authorized capture instead.');
  return type;
}
export function recallExtension(type: string): string {
  const known: Record<string,string> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','video/webm':'webm','video/mp4':'mp4','audio/webm':'webm','audio/ogg':'ogg','audio/mpeg':'mp3','audio/wav':'wav','audio/flac':'flac','audio/mp4':'m4a'};
  return known[type] ?? type.split('/')[1].replace(/[^a-z0-9]/g,'').slice(0,12);
}
export function sameRecallOrigin(asset: string, page: string): boolean {
  try { return recallUrl(asset).origin === recallUrl(page).origin; } catch { return false; }
}
