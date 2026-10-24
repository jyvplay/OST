import { readFileSync, readdirSync } from "node:fs";
import { readPptxDoc, writePptxDoc, blankPptx, isEdited } from "../src/lib/office/pml.ts";
import { slideView } from "../src/lib/office/pmlview.ts";
const dir = "/home/user/tools/corpus/pptx"; let ok = 0, bad = 0, shapes = 0, approx = new Map<string, number>(), ident = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".pptx")).sort()) {
  const b = new Uint8Array(readFileSync(`${dir}/${f}`));
  try {
    const d = await readPptxDoc(b, f);
    for (const s of d.slides) { const v = slideView(d, s); const walk = (xs: any[]) => { for (const x of xs) { shapes++; if (x.note) approx.set(x.note.replace(/\d+/g, "#"), (approx.get(x.note.replace(/\d+/g, "#")) ?? 0) + 1); if (x.children) walk(x.children); } }; walk(v.shapes); }
    const out = await writePptxDoc(d); if (!isEdited(d) && out === b || Buffer.compare(Buffer.from(out), Buffer.from(b)) === 0) ident++;
    ok++;
  } catch (e) { bad++; console.log("ERR", f, String((e as Error).message).slice(0, 120)); }
}
const blank = await readPptxDoc(await blankPptx("Hi"), "b.pptx"); console.log("blank slides", blank.slides.length, slideView(blank, blank.slides[0]).shapes.length);
console.log({ ok, bad, shapes, ident }); console.log([...approx].sort((a, b) => b[1] - a[1]).slice(0, 25));
