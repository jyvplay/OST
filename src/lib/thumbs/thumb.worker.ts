/// <reference lib="webworker" />
/** TT54 (FF-13) — thumbnail Worker: decode + draw + WebP-encode off the main thread. */
import { renderThumbnail, canvasToWebp } from "./render";
import type { PhotoRecipe } from "../photos/recipe";

type Req = { id: number; bytes: Uint8Array; name: string; max: number; recipe?: PhotoRecipe | null };
self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, bytes, name, max, recipe } = e.data;
  try {
    const r = await renderThumbnail(bytes, name, max, recipe);
    const meta = { ...r.meta, picture: undefined };
    if ("canvas" in r) {
      const blob = await canvasToWebp(r.canvas);
      (self as unknown as Worker).postMessage({ id, blob, source: r.source, width: r.canvas.width, height: r.canvas.height, meta });
    } else if ("needsMain" in r) (self as unknown as Worker).postMessage({ id, needsMain: r.needsMain, meta });
    else (self as unknown as Worker).postMessage({ id, none: r.none, meta });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
