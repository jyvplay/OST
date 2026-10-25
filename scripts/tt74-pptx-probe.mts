/**
 * TT74 (FF-02) deck conversion probe: every corpus .pptx is read by Fusion (readPptxDoc → deckToIR, the model behind the
 * Markdown / text outline) and by python-pptx (independent, MIT); per slide: hidden flag, paragraph texts in shape-tree
 * order (title included at its position; table cells as "|cell"), notes. Shapes Fusion reads from mc:AlternateContent
 * are excluded from the comparison (python-pptx does not read them) and counted.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readPptxDoc } from "../src/lib/office/pml.ts";
import { deckToIR, deckToMarkdown } from "../src/lib/office/convert-slides.ts";

const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/pptx";
type OSlide = { hidden: boolean; paras: string[]; notes: string };
export async function runPptxProbe(filter = "", resolveAlt = true) {
  const theirs = JSON.parse(execFileSync(PY, ["scripts/oracle/pptx_outline.py", CORPUS], { maxBuffer: 1 << 28, env: { ...process.env, ...(resolveAlt ? { RESOLVE_ALT: "1" } : {}) } }).toString()) as Record<string, { slides?: OSlide[]; error?: string }>;
  const files: { name: string; status: "match" | "diff" | "refused" | "oracle-error" | "both-refuse"; detail?: string; slides?: number; altExcluded?: number }[] = [];
  let slidesCompared = 0, slidesAgree = 0, altExcluded = 0;
  for (const name of readdirSync(CORPUS).filter((n) => n.endsWith(".pptx") && n.includes(filter)).sort()) {
    const t = theirs[name];
    let ours: OSlide[] | null = null; let err = "";
    try {
      const d = await readPptxDoc(new Uint8Array(readFileSync(`${CORPUS}/${name}`)), name);
      deckToMarkdown(d);
      ours = deckToIR(d).slides.map((s) => {
        const paras: string[] = [];
        for (const sh of s.shapes) {
          if ((sh as { alt?: boolean }).alt || (sh as { fromAlt?: boolean }).fromAlt) { altExcluded++; if (!resolveAlt) continue; }
          if (sh.k === "text") paras.push(...sh.paras.map((p) => p.text));
          else if (sh.k === "table") for (const r of sh.rows) for (const c of r) paras.push(`|${c}`);
        }
        return { hidden: s.hidden, paras, notes: s.notes };
      });
    } catch (e) { err = String((e as Error).message).slice(0, 160); }
    if (!ours) { files.push({ name, status: t?.error ? "both-refuse" : "refused", detail: `${err} | oracle: ${t?.error ?? "read it"}` }); continue; }
    if (!t || t.error || !t.slides) { files.push({ name, status: "oracle-error", detail: t?.error }); continue; }
    const diffs: string[] = [];
    if (ours.length !== t.slides.length) diffs.push(`slide count ours=${ours.length} theirs=${t.slides.length}`);
    for (let i = 0; i < Math.min(ours.length, t.slides.length); i++) {
      slidesCompared++;
      const o = ours[i], th = t.slides[i];
      const ok = o.hidden === th.hidden && JSON.stringify(o.paras) === JSON.stringify(th.paras) && o.notes === th.notes;
      if (ok) slidesAgree++;
      else if (diffs.length < 3) {
        if (o.hidden !== th.hidden) diffs.push(`slide ${i + 1} hidden ours=${o.hidden} theirs=${th.hidden}`);
        if (JSON.stringify(o.paras) !== JSON.stringify(th.paras)) { let k = 0; while (o.paras[k] === th.paras[k]) k++; diffs.push(`slide ${i + 1} para #${k}: ours=${JSON.stringify((o.paras[k] ?? "<none>").slice(0, 80))} theirs=${JSON.stringify((th.paras[k] ?? "<none>").slice(0, 80))} (${o.paras.length}/${th.paras.length})`); }
        if (o.notes !== th.notes) diffs.push(`slide ${i + 1} notes ours=${JSON.stringify(o.notes.slice(0, 80))} theirs=${JSON.stringify(th.notes.slice(0, 80))}`);
      }
    }
    files.push({ name, status: diffs.length ? "diff" : "match", detail: diffs.join(" ; "), slides: ours.length });
  }
  return { files, slidesCompared, slidesAgree, altExcluded, decks: files.filter((f) => f.status === "match" || f.status === "diff").length, decksAgree: files.filter((f) => f.status === "match").length };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runPptxProbe(process.argv[2] ?? "", process.env.NO_ALT !== "1");
  for (const f of r.files) if (f.status !== "match") console.log(f.status.padEnd(12), f.name, "\n    ", (f.detail ?? "").slice(0, 600));
  console.log(JSON.stringify({ decks: r.decks, decksAgree: r.decksAgree, slidesCompared: r.slidesCompared, slidesAgree: r.slidesAgree, altExcluded: r.altExcluded, refused: r.files.filter((f) => f.status === "refused").length, bothRefuse: r.files.filter((f) => f.status === "both-refuse").length, oracleErrors: r.files.filter((f) => f.status === "oracle-error").length }));
}
