/**
 * TT74 (FF-02 / FF-11): every conversion out of an Office app shows its itemised loss report before anything is
 * written. One in-app dialog (src/lib/ask.ts, not window.confirm) lists what the conversion drops and asks for the
 * output file name; cancel aborts. Pure apart from the ask queue and the browser download.
 */
import { askForm } from "../ask";

const DETAIL_MAX = 600;

/** The dialog text: as many loss items as fit, then "+N more". */
export function lossDetail(loss: string[], lead = "This conversion drops:"): string {
  if (!loss.length) return "Nothing is dropped.";
  let out = lead;
  for (let i = 0; i < loss.length; i++) {
    const line = `\n• ${loss[i]}`;
    const more = `\n• +${loss.length - i} more`;
    if (out.length + line.length + (i < loss.length - 1 ? more.length : 0) > DETAIL_MAX) return out + more;
    out += line;
  }
  return out;
}

/** Ask for the export name with the loss list shown; resolves the chosen name or null when cancelled. */
export async function askExport(what: string, defName: string, loss: string[], ext: string): Promise<string | null> {
  const r = await askForm({
    title: `Export as ${what}`, detail: lossDetail(loss), okLabel: "Export",
    fields: [{ name: "name", label: "File name", def: defName }],
    validate: (v) => ((v.name ?? "").trim() ? null : "Enter a file name"),
  });
  if (!r) return null;
  const n = (r.name ?? "").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return n.toLowerCase().endsWith(`.${ext}`) ? n : `${n}.${ext}`;
}

/** Browser download of text or bytes. */
export function downloadAs(name: string, data: string | Uint8Array, mime: string): void {
  const blob = new Blob([typeof data === "string" ? data : (data as Uint8Array<ArrayBuffer>)], { type: mime });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
