/**
 * TT145 (FM-14) — drag & drop, decided instead of attempted.
 *
 * Dragging between windows is the feature people are most confident about and
 * least often right about. The platform's actual rule for a *dragged out* item
 * is a capability decision with four outcomes, and a drop handler that does not
 * make it explicitly is the silent no-op everyone has met:
 *
 *   · **download** — `DataTransfer.setData("DownloadURL", …)` is honoured by
 *     Chromium; the drop leaves the page as a real download.
 *   · **copy** — `text/uri-list` or a custom MIME the target app understands.
 *   · **handoff** — the OS has no shared dock, so the honest fallback is a
 *     visible "Download" affordance, or a same-origin tab handoff (TT136).
 *   · **refuse** — an unsupported type with a sentence, not silence.
 *
 * On the *inbound* side the rules are equally specific: a drop of files must be
 * read from `DataTransfer.files`, not from the string types (which are empty for
 * files for security reasons), a drop on a hidden tab must be refused because the
 * user cannot see where it lands, and a drop of text into a read-only surface is
 * a refusal rather than a scroll.
 *
 * Pure: this engine decides; the component performs. That split is what makes
 * "did the drop do something?" testable without a browser.
 */

export const MAX_DROP_ITEMS = 50;
export const MAX_INBOUND_BYTES = 2 * 1024 * 1024 * 1024;

export type OutboundKind = "download" | "copy" | "handoff" | "refuse";
export type InboundKind = "files" | "text" | "url" | "refuse";

export interface OutboundInput {
  name: string;
  mime: string;
  bytes: number;
  /** True when the blob can be given an object URL (a Blob exists). */
  canBlob: boolean;
  /** Chromium's `DownloadURL` support, probed by the caller. */
  downloadUrl: boolean;
  /** Whether the receiving surface is same-origin (a tab of this app). */
  sameOrigin: boolean;
  /** Read-only surface: it can receive nothing. */
  readOnly?: boolean;
}

export interface OutboundPlan {
  kind: OutboundKind;
  /** The MIME to set, when the plan is `copy`. */
  mime?: string;
  /** The sentence shown if the drop leaves the app, or if it is refused. */
  sentence: string;
  /** What the drag image should say while dragging. */
  badge: string;
}

const SAFE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,255}$/;

/**
 * The outbound decision. Order matters: a read-only source refuses before any
 * capability is consulted, then a real download wins over a copy because it is
 * the outcome the user asked for by dragging the file out.
 */
export function planOutbound(input: OutboundInput): OutboundPlan {
  if (input.readOnly) return { kind: "refuse", sentence: "this pane is read-only; drag from the Finder instead", badge: "read-only" };
  if (!SAFE_NAME.test(input.name)) return { kind: "refuse", sentence: `“${input.name}” contains characters the filesystem strips; rename before dragging`, badge: "bad name" };
  if (!(input.bytes >= 0)) return { kind: "refuse", sentence: "the item has no measured size, so it cannot be promised as a download", badge: "unknown size" };
  if (input.canBlob && input.downloadUrl) {
    return {
      kind: "download",
      sentence: `leaves as a download named “${input.name}”`,
      badge: `${input.name.split(".").pop()?.toUpperCase() ?? "FILE"} · ${Math.max(1, Math.round(input.bytes / 1024))} KB`,
    };
  }
  if (input.sameOrigin && (input.mime === "text/uri-list" || input.mime === "text/plain")) return { kind: "copy", mime: input.mime, sentence: "lands in the other window as a link", badge: "link" };
  if (input.canBlob) return { kind: "handoff", sentence: "this browser cannot drag a file out, so the item offers an explicit Download button instead", badge: "use Download" };
  return { kind: "refuse", sentence: `nothing to drag: ${input.mime} is not a type this item exposes as bytes`, badge: "no data" };
}

export interface InboundInput {
  types: string[];
  fileCount: number;
  /** Largest file size in bytes, or null when no size is exposed. */
  largestBytes: number | null;
  textLength: number;
  /** True when the drop target's tab is visible. */
  visible: boolean;
  accepts: readonly string[];
}

export interface InboundPlan {
  kind: InboundKind;
  /** Items to accept, in the order they were dropped. */
  count: number;
  sentence: string;
  /** Rejections, each with the reason a person can act on. */
  refusals: string[];
}

/**
 * The inbound decision. Three refusals that a naive handler misses:
 *   · a hidden tab cannot show where the drop landed;
 *   · more than MAX_DROP_ITEMS is refused as a batch (the browser will happily
 *     hand over 10 000 files and lock the main thread);
 *   · an "empty" drop is a real event (`types` is empty) and must say so rather
 *     than appear to do nothing.
 */
export function planInbound(input: InboundInput): InboundPlan {
  const refusals: string[] = [];
  if (!input.visible) return { kind: "refuse", count: 0, sentence: "the tab is in the background; bring it forward so the drop lands where you can see it", refusals: ["drop on a hidden tab"] };
  if (!input.types.length && input.fileCount === 0 && input.textLength === 0) return { kind: "refuse", count: 0, sentence: "the drag carried nothing this surface can read", refusals: ["empty DataTransfer"] };
  if (input.fileCount > MAX_DROP_ITEMS) {
    return { kind: "refuse", count: 0, sentence: `${input.fileCount} files is more than the ${MAX_DROP_ITEMS} this surface accepts in one drop`, refusals: [`${input.fileCount} > ${MAX_DROP_ITEMS}`] };
  }
  if (input.largestBytes !== null && input.largestBytes > MAX_INBOUND_BYTES) {
    refusals.push(`a ${Math.round(input.largestBytes / 1e9)} GB file exceeds the 2 GB drop limit`);
  }
  const acceptsFiles = input.accepts.includes("files");
  if (input.fileCount > 0) {
    if (!acceptsFiles) return { kind: "refuse", count: 0, sentence: "this surface does not accept files; drop into Files or the desktop instead", refusals: [...refusals, "surface accepts no files"] };
    // A file drop never carries text types: the browser withholds them on purpose.
    return { kind: "files", count: input.fileCount, sentence: `${input.fileCount} file${input.fileCount === 1 ? "" : "s"} ready to import${refusals.length ? ` — ${refusals[0]}` : ""}`, refusals };
  }
  if (input.types.includes("text/uri-list")) return { kind: "url", count: 1, sentence: "one address ready to open", refusals };
  if (input.types.includes("text/plain") && input.textLength > 0) return { kind: "text", count: 1, sentence: `${input.textLength} characters ready to paste`, refusals };
  return { kind: "refuse", count: 0, sentence: `the drag offers ${input.types.join(", ")}, none of which this surface reads`, refusals: [...refusals, ...input.types] };
}

/**
 * What the platform does not let this row claim. Printed beside the drop zone so
 * the sentence and the behaviour cannot drift apart.
 */
export const LIMITS = [
  "a file drags OUT only where the browser supports DownloadURL; elsewhere an explicit Download button stands in",
  "the OS gives a page no way to accept a drop onto another application's window",
  "files arrive as File objects; the string types are empty for files by design",
  "a drop is one gesture: there is no progress, only accept-then-import",
] as const;
