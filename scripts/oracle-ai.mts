/**
 * Oracle suite "oracle-ai" (TT24): FF-04 against a HELD-OUT corpus of real Illustrator files and two independent tools.
 *
 * Corpus: four .ai files saved by Illustrator CS6, CC 2017, CC 22.0 and 28.5, committed by third parties to public
 * GitHub repos. They are NOT vendored (licence not declared), only pinned by git blob SHA and fetched into
 * TOOLS_DIR/ai-corpus with `gh api` (or api.github.com + GITHUB_TOKEN). The git blob SHA re-check proves the bytes.
 *
 * Independent oracles (dev-time only, installed into TOOLS_DIR by scripts/sandbox/bootstrap.sh):
 *  - pypdf 6 (Python): the file parses as PDF, page count ≥ 1, and its /Creator equals ours;
 *  - file-type 16.5.4 (npm alias ft16): its own rule (AIPrivateData in the first 10 MB) must agree on ai-vs-pdf.
 *    (file-type 17+ removed .ai detection and calls every %PDF a PDF, so 16.5.4 is the last version with a rule.
 *    It skips the first 1 350 bytes before searching; the constructed .ai fixtures carry an XMP packet like real files.)
 * Missing tools or corpus make the suite FAIL loudly, never skip.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { makeHarness } from "./harness.mts";
import { sniffAi, streamInflate } from "../src/lib/ai-format.ts";
import * as F from "./fixtures/ai/build.mts";

const { test, finish } = makeHarness("oracle-ai");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const TOOLS = process.env.TOOLS_DIR ?? "/home/user/tools";
const PY = process.env.ORACLE_PY ?? `${TOOLS}/venv/bin/python`;
const CORPUS_DIR = path.join(TOOLS, "ai-corpus");

const CORPUS = [
  { repo: "cncf/artwork", path: "projects/cni/stacked/black/cni-stacked-black.ai", sha: "d96cba0a2ae7584476e708a2687599b9e83dce4c", version: "CC 2017", pages: 1 },
  { repo: "cncf/artwork", path: "archived/servicemeshperformance/social/smp-tag-linkedin.ai", sha: "dbd5e4a67583438780717740d17f017194c90a8f", version: "CC 22.0", pages: 1 },
  { repo: "cncf/artwork", path: "archived/tag-environmental-sustainability/WG Green Reviews/CNCF-TAG-ENV-WG-Green-Reviews-Logo-Master-2024.ai", sha: "6e148f8f84990f9da9eab277ba44edfdec9c3ebb", version: "28.5", pages: 6 },
  { repo: "jenkins-infra/jenkins.io", path: "content/images/jams/SevilleJAM/Seville-JAM_logo.ai", sha: "3d7080ca5b43ffe5cd5afb7837a26ebe1e94128f", version: "CS6", pages: 2 },
];

const gitBlobSha = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

async function fetchBlob(repo: string, sha: string): Promise<Buffer> {
  try {
    const b64 = execFileSync("gh", ["api", `repos/${repo}/git/blobs/${sha}`, "-q", ".content"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return Buffer.from(b64.replace(/\s/g, ""), "base64");
  } catch {
    const headers: Record<string, string> = { accept: "application/vnd.github.raw" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, { headers });
    if (!r.ok) throw new Error(`fetch ${repo} ${sha}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}

async function corpusFile(c: (typeof CORPUS)[number]): Promise<string> {
  mkdirSync(CORPUS_DIR, { recursive: true });
  const file = path.join(CORPUS_DIR, path.basename(c.path).replace(/ /g, "_"));
  if (!existsSync(file) || gitBlobSha(readFileSync(file)) !== c.sha) writeFileSync(file, await fetchBlob(c.repo, c.sha));
  const got = gitBlobSha(readFileSync(file));
  if (got !== c.sha) throw new Error(`${file}: git blob sha ${got} ≠ pinned ${c.sha}`);
  return file;
}

function pypdf(files: string[]): Record<string, { pages: number; creator: string | null } | { error: string }> {
  const prog = `import sys, json, pypdf
out = {}
for f in sys.argv[1:]:
    try:
        r = pypdf.PdfReader(f); md = r.metadata or {}
        out[f] = {"pages": len(r.pages), "creator": md.get("/Creator")}
    except Exception as e:
        out[f] = {"error": type(e).__name__}
print(json.dumps(out))`;
  return JSON.parse(execFileSync(PY, ["-c", prog, ...files], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

const ft16 = createRequire(path.join(TOOLS, "package.json"))("ft16") as { fromFile(p: string): Promise<{ ext: string } | undefined> };
const coarse = (kind: string) => (kind === "ai-pdf" || kind === "ai-no-pdf" ? "ai" : kind === "pdf" || kind === "illustrator-pdf" ? "pdf" : kind);

await test("held-out real Illustrator .ai files (CS6 … 28.5): ai-pdf, renderable, version, creator = pypdf, pages = pypdf", { "FF-04": "full", "FF-03": "partial" }, async () => {
  const files = await Promise.all(CORPUS.map(corpusFile));
  const py = pypdf(files);
  for (const [i, c] of CORPUS.entries()) {
    const r = await sniffAi(new Uint8Array(readFileSync(files[i])), streamInflate);
    const o = py[files[i]];
    ok(!("error" in o), `pypdf cannot parse ${c.path}: ${JSON.stringify(o)}`);
    if ("error" in o) continue;
    ok(r.kind === "ai-pdf" && r.renderable, `${c.path}: kind ${r.kind}`);
    ok(r.illustratorVersion === c.version, `${c.path}: version ${r.illustratorVersion} ≠ ${c.version}`);
    ok(r.creator === o.creator, `${c.path}: creator "${r.creator}" ≠ pypdf "${o.creator}"`);
    ok(o.pages === c.pages, `${c.path}: pypdf pages ${o.pages} ≠ pinned ${c.pages}`);
  }
});

await test("file-type 16.5.4 (independent rule) agrees on ai/pdf/eps for every real and constructed PDF/EPS input", { "FF-04": "full" }, async () => {
  const committed = ["ft-fixture-adobe-illustrator.pdf", "ft-fixture-minimal.pdf", "ft-fixture.eps", "ft-fixture2.eps"].map((n) => `scripts/fixtures/ai/${n}`);
  const tmp = path.join(TOOLS, "ai-constructed"); mkdirSync(tmp, { recursive: true });
  const built: string[] = [];
  for (const [n, b] of Object.entries({ withPdf: F.aiWithPdf(), withoutPdf: F.aiWithoutPdf(), objStm: F.creatorInObjectStream(), utf16: F.utf16Creator() })) {
    const p = path.join(tmp, `${n}.bin`); writeFileSync(p, b); built.push(p);
  }
  const all = [...(await Promise.all(CORPUS.map(corpusFile))), ...committed, ...built];
  for (const f of all) {
    const ours = coarse((await sniffAi(new Uint8Array(readFileSync(f)), streamInflate)).kind);
    const theirs = (await ft16.fromFile(f))?.ext;
    const want = theirs === "eps" ? "ai-ps|eps" : theirs;
    ok(new RegExp(`^(${want})$`).test(ours), `${path.basename(f)}: ours ${ours} vs file-type ${theirs}`);
  }
});

await test("constructed fixtures are real PDFs to an independent parser (pypdf), so the edge cases are not malformed strawmen", { "FF-04": "partial" }, async () => {
  const tmp = path.join(TOOLS, "ai-constructed"); mkdirSync(tmp, { recursive: true });
  const named = { withPdf: F.aiWithPdf(), withoutPdf: F.aiWithoutPdf(), objStm: F.creatorInObjectStream(), utf16: F.utf16Creator(), junk: F.junkBeforeHeader() };
  const files = Object.entries(named).map(([n, b]) => { const p = path.join(tmp, `${n}.pdf`); writeFileSync(p, b); return p; });
  const py = pypdf(files);
  for (const f of files) { const o = py[f]; ok(!("error" in o) && o.pages === 1, `${path.basename(f)}: pypdf ${JSON.stringify(o)}`); }
  const withPdf = py[files[0]] as { creator: string }; ok(withPdf.creator === "Adobe Illustrator 28.5 (Macintosh)", `pypdf creator ${withPdf.creator}`);
  const u = py[files[3]] as { creator: string }; ok(u.creator === "Adobe Illustrator 26.0", `pypdf decodes the UTF-16BE creator the same way: ${u.creator}`);
});

finish();
