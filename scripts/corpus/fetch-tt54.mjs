/** Fetch only the pinned, test-only Photos corpus objects. Nothing is shipped in the app.
 * Run: TOOLSDIR=/home/user/tools node scripts/corpus/fetch-tt54.mjs
 * Requires gh authenticated/network access. Existing mismatching files are never overwritten.
 * The exif-samples README says contributed images are CC BY-SA 4.0; retain attribution/terms
 * if distributing them. PDF.js is Apache-2.0. These files remain outside the repository.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const tools = process.env.TOOLSDIR ?? "/home/user/tools";
const objects = [
  { repo: "ianare/exif-samples", ref: "5332a9cf0220e9c6c93f88a187daa90808051e10", source: "jpg/gps/DSCN0010.jpg", sha: "4a2c1552b991add9a356a460415626ad700f401b", dest: "corpus/exif/jpg__gps__DSCN0010.jpg" },
  { repo: "ianare/exif-samples", ref: "5332a9cf0220e9c6c93f88a187daa90808051e10", source: "tiff/Picoawards.tiff", sha: "08c7228437a7adabf2c643475f0b56fb38f0ab58", dest: "corpus/exif/tiff__Picoawards.tiff" },
  { repo: "mozilla/pdf.js", ref: "8fb674ceb7", source: "test/pdfs/Embedded_font.pdf", sha: "823909f92a813180ac5e1c53789f5cb2898305d3", dest: "corpus/pdf/Embedded_font.pdf" },
];
const blobHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
for (const item of objects) {
  const path = join(tools, item.dest);
  if (existsSync(path)) {
    if (blobHash(readFileSync(path)) !== item.sha) throw new Error(`Refusing to overwrite a mismatching existing fixture: ${path}`);
    console.log(`verified existing ${item.repo}/${item.source} → ${path}`); continue;
  }
  const response = JSON.parse(execFileSync("gh", ["api", `repos/${item.repo}/contents/${item.source}?ref=${item.ref}`], { encoding: "utf8" }));
  if (response.encoding !== "base64" || response.sha !== item.sha || typeof response.content !== "string") throw new Error(`Unexpected GitHub object metadata for ${item.source}`);
  const bytes = Buffer.from(response.content, "base64");
  if (bytes.length !== response.size || blobHash(bytes) !== item.sha) throw new Error(`Git blob verification failed for ${item.source}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
  console.log(`downloaded and verified ${item.repo}/${item.source} → ${path}`);
}
