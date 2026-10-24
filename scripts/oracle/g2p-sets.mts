/**
 * Letter-to-sound evaluation sets (TT32), built from two independent sources in the test-only tools venv:
 *   - CMUdict (as bundled with PocketSphinx 5, BSD) — reference pronunciations;
 *   - the PocketSphinx US-English language model's unigram ranking (exported once to $TOOLS/unigrams.txt).
 * Declared split (before any rule tuning against it): words already in Fusion's hand lexicon are excluded;
 *   DEV  = odd ranks (1st, 3rd, …) of the 4000 most frequent dictionary words — rules may be tuned on these;
 *   HOLD = even ranks of the same 4000 — held out;  RAND = 2000 random dictionary words, 3–12 letters — held out.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TOOLS = process.env.TOOLS_DIR ?? "/home/user/tools";
export const PY = `${TOOLS}/venv/bin/python`;
export function cmudictPath(): string {
  return execFileSync(PY, ["-c", "import pocketsphinx,os;print(os.path.join(os.path.dirname(pocketsphinx.__file__),'model','en-us','cmudict-en-us.dict'))"]).toString().trim();
}
export function loadCmudict(): Map<string, string[][]> {
  const m = new Map<string, string[][]>();
  for (const line of readFileSync(cmudictPath(), "utf8").split("\n")) {
    const [head, ...ph] = line.trim().split(/\s+/);
    if (!head || !ph.length) continue;
    const w = head.replace(/\(\d+\)$/, "");
    if (!/^[a-z]+$/.test(w)) continue;
    (m.get(w) ?? m.set(w, []).get(w)!).push(ph.map((p) => p.replace(/[0-2]$/, "")));
  }
  return m;
}
export function sets(dict: Map<string, string[][]>, inLex: (w: string) => boolean) {
  const uni = existsSync(`${TOOLS}/unigrams.txt`) ? readFileSync(`${TOOLS}/unigrams.txt`, "utf8").split("\n") : [];
  const freq = uni.filter((w) => w.length >= 2 && dict.has(w) && !inLex(w)).slice(0, 4000);
  const dev = freq.filter((_, i) => i % 2 === 0), hold = freq.filter((_, i) => i % 2 === 1);
  // deterministic random sample
  let s = 20261017; const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const all = [...dict.keys()].filter((w) => w.length >= 3 && w.length <= 12 && !inLex(w)).sort();
  const rand: string[] = []; const used = new Set<string>();
  while (rand.length < 2000) { const w = all[Math.floor(rnd() * all.length)]; if (!used.has(w)) { used.add(w); rand.push(w); } }
  return { dev, hold, rand };
}
/** Levenshtein distance over phone arrays */
export function edit(a: string[], b: string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** PER (stress ignored, best reference variant) and word accuracy */
export function score(words: string[], dict: Map<string, string[][]>, g2p: (w: string) => string[]) {
  let err = 0, len = 0, exact = 0; const bad: string[] = [];
  for (const w of words) {
    const hyp = g2p(w).map((p) => p.replace(/[0-2]$/, ""));
    let best = Infinity, bl = 1;
    for (const ref of dict.get(w)!) { const e = edit(hyp, ref); if (e < best || (e === best && ref.length > bl)) { best = e; bl = ref.length; } }
    err += best; len += bl; if (best === 0) exact++; else if (bad.length < 400) bad.push(`${w}: ${hyp.join(" ")} | ${dict.get(w)![0].join(" ")}`);
  }
  return { per: err / len, wordAcc: exact / words.length, bad };
}
