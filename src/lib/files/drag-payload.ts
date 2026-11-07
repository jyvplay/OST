/**
 * TT146 (FM-14) — drag and drop, with the payload written down.
 *
 * HTML5 drag and drop is mostly a negotiation between two strangers: the source
 * says what it can offer, the target says whether it wants any of it. Almost
 * every bug in a file manager's DnD comes from skipping the negotiation —
 * reading `dataTransfer.files` on `dragover` (where the spec forbids it),
 * accepting a `text/uri-list` that points somewhere else, or starting a drag
 * that quietly does nothing when the browser refuses the custom type.
 *
 * So the decision is a pure function of what the platform reported:
 *
 *   • **Outgoing.** We publish `text/plain` (the paths, for any text field),
 *     `text/uri-list` (the paths in a `fusion:` scheme, so another Fusion window
 *     recognises them and no other application is invited to fetch anything) and
 *     — only where the browser supports it — `DownloadURL`, which is the single
 *     documented way to drag a file *out* of a web page onto the desktop.
 *   • **Incoming.** A drop is accepted when it carries our scheme, plain text,
 *     or real files. A foreign `https:` URI is refused: turning a drag from an
 *     arbitrary page into a server-side fetch would make the user's browser a
 *     proxy for whoever wrote that link.
 *   • **Keyboard.** Every one of these has a keyboard equivalent, because a
 *     drag-only affordance fails WCAG 2.5.7 and fails anyone without a pointer.
 */

export const FUSION_SCHEME = "fusion://";
export const OS_DRAG_MIME = "application/vnd.chromium.download-url";
export const MAX_DRAG_ITEMS = 200;

export interface DragItem { path: string; name: string; kind: "file" | "folder" }

export interface DragPayload {
  /** Types we will set, in the order they should be set. */
  types: string[];
  text: string;
  uriList: string;
  browserDownloadUrl: string;
  itemCount: number;
}

export interface DragSource { items: readonly DragItem[]; origin: string }

/** Build the payload for a drag that starts in Files (or any window). */
export function dragPayloadFor(source: DragSource): DragPayload {
  const items = source.items.slice(0, MAX_DRAG_ITEMS);
  const paths = items.map((i) => i.path);
  const host = typeof location !== "undefined" && location.host ? location.host : "fusion.local";
  const types = ["text/plain", "text/uri-list"];
  // DownloadURL is Chromium-only and only for a single item; advertising it for
  // a multi-file drag produces a drag that claims to work and then does not.
  const canDownload = items.length === 1;
  if (canDownload) types.push(OS_DRAG_MIME);
  return {
    types,
    text: paths.join("\n"),
    // `fusion:///Documents/a.md` — a URI, not a URL any other application is expected to resolve.
    uriList: paths.map((p) => `${FUSION_SCHEME}${p.startsWith("/") ? "" : "/"}${p}`).join("\r\n"),
    browserDownloadUrl: canDownload
      ? `https://${host}/api/fs?op=download&path=${encodeURIComponent(paths[0] ?? "")}`
      : "",
    itemCount: items.length,
  };
}

export interface DropData { types: readonly string[]; uriList?: string; fileCount?: number; fileNames?: readonly string[] }

export interface DropDecision {
  accept: boolean;
  fromFusion: boolean;
  paths: string[];
  fileCount: number;
  reason: string;
}

/** Decide whether to accept a drop, from what the browser put on the event. */
export function dropDecision(data: DropData): DropDecision {
  const has = (...t: string[]) => t.some((x) => data.types.includes(x));
  if (data.types.includes("Files") && (data.fileCount ?? 0) > 0) {
    return { accept: true, fromFusion: false, paths: [], fileCount: data.fileCount ?? 0, reason: `${data.fileCount} file(s) from this device` };
  }
  const uri = data.uriList ?? "";
  if (uri) {
    const fusionPaths: string[] = [];
    const foreign: string[] = [];
    for (const line of uri.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith("#")) continue;
      if (entry.startsWith(FUSION_SCHEME)) {
        const raw = entry.slice(FUSION_SCHEME.length);
        if (raw.startsWith("/")) fusionPaths.push(raw);
        else foreign.push(entry);
      } else if (entry.startsWith("/")) {
        // A same-origin path is ours; a full URL is not (scheme check below).
        fusionPaths.push(entry);
      } else foreign.push(entry);
    }
    if (fusionPaths.length) return { accept: true, fromFusion: true, paths: fusionPaths, fileCount: 0, reason: `${fusionPaths.length} path(s) from another Fusion window` };
    if (foreign.length) {
      // A cross-origin URL is not fetched. The reason names the alternative.
      return { accept: false, fromFusion: false, paths: [], fileCount: 0, reason: "the drop carried a link from another site; use Browser → Save to Files so you can see what is fetched" };
    }
  }
  if (has("text/plain")) {
    const text = (data.uriList ?? "").trim();
    if (text) return { accept: true, fromFusion: false, paths: [], fileCount: 0, reason: "plain text dropped" };
  }
  return { accept: false, fromFusion: false, paths: [], fileCount: 0, reason: "nothing this window can use was dropped" };
}

/**
 * The keyboard route for each pointer gesture. Returned as labels because the
 * shell already owns these bindings; duplicating the chord logic here would let
 * the two drift apart.
 */
export function keyboardAlternative(op: { action: "move" | "copy" | "drag-out"; paths: readonly string[] }): string[] | null {
  if (!op.paths.length) return null;
  switch (op.action) {
    case "move": return ["Ctrl+X (cut)", "focus the destination and Ctrl+V (paste)"];
    case "copy": return ["Ctrl+C (copy)", "focus the destination and Ctrl+V (paste)"];
    case "drag-out": return ["Shift+F10 → Download", "Ctrl+Shift+S (Save a copy)"];
  }
}
