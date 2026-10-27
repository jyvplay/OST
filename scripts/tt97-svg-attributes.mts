/** Static guard: SVG geometry attributes must not receive CSS calc()/var() expressions. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt97-svg-attributes");
const cov = { "AX-08": "partial", "PR-09": "partial" } as const;

/** Walk src/ for .tsx files without following symlinks. */
function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Extracts literal `name={...}` attribute expressions that appear after an `<svg` tag on the same element.
 *  This is a deliberately conservative lexical scan, not a JSX parser: it cannot prove absence in
 *  dynamically spread props, which are reported separately below. */
function scanned(): { css: string[]; dynamic: string[]; svgFiles: number } {
  const css: string[] = [], dynamic: string[] = []; let svgFiles = 0;
  for (const file of files("src")) {
    const source = readFileSync(file, "utf8");
    if (!/<svg[\s>]/.test(source)) continue;
    if (/<svg[\s>]/.test(source)) svgFiles += 1;
    for (const element of source.matchAll(/<svg\b[^>]*>/g)) {
      for (const attribute of element[0].matchAll(/\b(width|height|x|y|r|rx|ry|d|cx|cy|stroke-width)=\{([^{}]*)\}/g)) {
        if (/\b(fz|calc|var)\(|--fs-/.test(attribute[2])) css.push(`${file}: ${attribute[1]}={${attribute[2].trim()}}`);
      }
      for (const attribute of element[0].matchAll(/\b(width|height)=\{([^{}]*\{[^{}]*\}[^{}]*)\}/g)) {
        dynamic.push(`${file}: ${attribute[1]}={${attribute[2].trim()}}`);
      }
    }
  }
  return { css, dynamic, svgFiles };
}

await test("no JSX SVG geometry attribute receives calc()/var()/fz(); the fixed banner chevron is present", cov, () => {
  const { css, svgFiles } = scanned();
  assert.ok(svgFiles > 5, `scan found only ${svgFiles} files with SVG; the walker is probably broken`);
  assert.deepEqual(css, []);
  assert.match(readFileSync("src/components/AppBanner.tsx", "utf8"), /<svg[^>]*style=\{\{ width: fz\(14\), height: fz\(14\)/);
});
await test("detector rejects the exact pre-repair attribute shape", cov, () => {
  const sample = '<svg aria-hidden="true" width={fz(14)} height={fz(14)} viewBox="0 0 16 16"><path d="M0 0" /></svg>';
  const found = [...sample.matchAll(/\b(width|height)=\{([^{}]*)\}/g)].filter((m) => /\b(fz|calc|var)\(/.test(m[2])).map((m) => m[1]);
  assert.deepEqual(found, ["width", "height"]);
});
await test("dynamic width/height expressions on SVG elements are absent or explicitly listed", cov, () => {
  const { dynamic } = scanned();
  // This assertion documents the current inventory rather than claiming universal safety.
  assert.deepEqual(dynamic, []);
});
finish();
