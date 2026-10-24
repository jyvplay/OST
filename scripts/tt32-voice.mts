/**
 * Suite "tt32-voice" (TT32, AX-15 Fusion Voice): is Fusion's own text-to-speech intelligible? — no browser.
 *
 * Oracle: PocketSphinx 5.1.1 (CMU, BSD-style; test-only, installed by scripts/sandbox/bootstrap.sh) via
 * scripts/oracle/asr.py. Audio is the full product pipeline: synthesizeText(text) = voice-text.ts → voice-synth.ts.
 * Fixed listening condition (frozen before the gates were measured): 300 ms of padding each side + uniform noise
 * ±0.001 (a quiet room); results depend on it (DESIGN-TT32.md lists the sensitivity).
 *
 * Gates (declared before measuring, forced choice, default voice, rate 1):
 *   dev 20 UI words ≥ 85 %, digits ≥ 80 %, held-out 20 app names ≥ 70 %;
 *   letter-to-sound on 2 000 seeded random CMUdict words (never in the lexicon): phone error rate ≤ 30 %.
 * Look log (held-out words were used for nothing but these looks):
 *   held-out voice — look #1 20/20 (initial synth), look #2 19/20 (after the stop-consonant fix). The synth is
 *   frozen at look #2; later runs of this suite are regression checks — any change to voice-synth/voice-text must
 *   be reported as a new look.  G2P hold/rand — look #1 hold 10.5 %, rand 18.0 % PER.
 * Informational (no gate, printed as "info:"): 100-way forced choice over hold[0:100], 6-way stop place/voicing,
 * open-vocabulary sentence WER.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt32-voice.mts
 */
import { makeHarness } from "./harness.mts";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesizeText } from "../src/lib/fusion-voice.ts";
import { synthPhrases, toWav, type PhoneTok } from "../src/lib/voice-synth.ts";
import { normalize, pronounce, spell } from "../src/lib/voice-text.ts";
import { chooseEngine, fusionOpts } from "../src/lib/voice-engine.ts";
import { loadCmudict, score, PY } from "./oracle/g2p-sets.mts";

const { test, finish } = makeHarness("tt32-voice");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const DIR = join(tmpdir(), "fusion-voice-lab"); mkdirSync(DIR, { recursive: true });

// ---- the frozen listening condition
let ds = 12345;
const rnd = () => { ds = (Math.imul(ds, 1103515245) + 12345) >>> 0; return ds / 4294967296 - 0.5; };
export const pad = (x: Float32Array) => { const n = 4800, y = new Float32Array(x.length + 2 * n); y.set(x, n); for (let i = 0; i < y.length; i++) y[i] += rnd() * 0.002; return y; };

type Job = { wav: string; mode: "grammar" | "open" | "phones"; words?: string[]; truth?: string };
function asr(jobs: Job[]): (string | null)[] {
  const out = execFileSync(PY, ["scripts/oracle/asr.py"], { input: JSON.stringify({ jobs }), maxBuffer: 64 << 20 }).toString();
  return (JSON.parse(out).results as { hyp: string | null }[]).map((r) => r.hyp);
}
let fileN = 0;
const wav = (x: Float32Array) => { const f = join(DIR, `a${fileN++}.wav`); writeFileSync(f, toWav(pad(x), 16000)); return f; };
function forcedChoice(words: string[], synth: (w: string) => Float32Array) {
  const hyps = asr(words.map((w) => ({ wav: wav(synth(w)), mode: "grammar", words })));
  const wrong = words.map((w, i) => [w, hyps[i]] as const).filter(([w, h]) => h !== w);
  return { right: words.length - wrong.length, n: words.length, wrong: wrong.map(([w, h]) => `${w}→${h}`) };
}

const DEV = ["button", "link", "heading", "checked", "dialog", "menu", "window", "settings", "search", "close", "open", "file", "folder", "selected", "level", "table", "list", "image", "text", "expanded"];
const HELD = ["music", "video", "calendar", "notes", "photos", "terminal", "browser", "contacts", "weather", "clock", "camera", "trash", "desktop", "printer", "network", "battery", "volume", "keyboard", "mail", "maps"];
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const say = (w: string) => synthesizeText(w);

await test("gate: dev UI words ≥ 85 % forced choice (20-way, chance 5 %)", { "AX-15": "full" }, () => {
  const r = forcedChoice(DEV, say); console.log(`    dev ${r.right}/${r.n} ${r.wrong.join(", ")}`);
  ok(r.right / r.n >= 0.85, `${r.right}/${r.n}: ${r.wrong.join(", ")}`);
});
await test("gate: digits ≥ 80 % forced choice (10-way, chance 10 %)", { "AX-15": "full" }, () => {
  const r = forcedChoice(DIGITS, say); console.log(`    digits ${r.right}/${r.n} ${r.wrong.join(", ")}`);
  ok(r.right / r.n >= 0.8, `${r.right}/${r.n}: ${r.wrong.join(", ")}`);
});
await test("gate: held-out app names ≥ 70 % forced choice (never tuned on; looks logged in the header)", { "AX-15": "full" }, () => {
  const r = forcedChoice(HELD, say); console.log(`    held-out ${r.right}/${r.n} ${r.wrong.join(", ")}`);
  ok(r.right / r.n >= 0.7, `${r.right}/${r.n}: ${r.wrong.join(", ")}`);
});
await test("gate: letter-to-sound on 2 000 frozen random CMUdict words — phone error rate ≤ 30 %", { "AX-15": "partial" }, () => {
  const S = JSON.parse(readFileSync("scripts/oracle/g2p-sets.json", "utf8")) as { rand: string[] };
  const r = score(S.rand, loadCmudict(), pronounce);
  console.log(`    rand PER ${(r.per * 100).toFixed(1)} %, word-exact ${(r.wordAcc * 100).toFixed(1)} %`);
  ok(r.per <= 0.3, `PER ${(r.per * 100).toFixed(1)} %`);
});

await test("text normalisation: numbers, money, ordinals, clock times, abbreviations, keys, file names, URLs", { "AX-15": "partial" }, () => {
  const T: [string, string][] = [
    ["$5 and 50%", "five dollars and fifty percent."],
    ["3rd item of 12", "third item of twelve."],
    ["21st, 2nd", "twenty first, / second."],
    ["10:30", "ten thirty."], ["9:05", "nine oh five."], ["7:00", "seven o'clock."],
    ["e.g. Dr. Smith", "for example doctor smith."],
    ["Ctrl+S", "control plus #s."], ["Press Esc. Then Del", "press escape. / then delete."],
    ["notes.md", "notes dot #m #d."], ["SoundCloud", "sound cloud."], ["1,234.5", "one thousand two hundred thirty four point five."],
    ["https://www.fusion.local/a", "fusion dot local slash a."], ["Level 2 heading", "level two heading."],
  ];
  for (const [inp, want] of T) {
    const got = normalize(inp).map((p) => p.words.join(" ") + p.end).join(" / ");
    ok(got === want, `${JSON.stringify(inp)} → "${got}" (want "${want}")`);
  }
});

await test("engine policy: auto = system voice only when the API exists, has voices and has not failed; else Fusion Voice", { "AX-15": "full" }, () => {
  const c = (pref: "auto" | "system" | "fusion", api: boolean, voices: number, failed: boolean) => chooseEngine(pref, { api, voices, failed });
  ok(c("auto", true, 3, false) === "system", "auto with voices");
  ok(c("auto", true, 0, false) === "fusion", "auto, zero voices (headless Chromium, minimal Linux)");
  ok(c("auto", false, 0, false) === "fusion", "auto, no Web Speech API");
  ok(c("auto", true, 3, true) === "fusion", "auto after a synthesis failure");
  ok(c("system", true, 0, false) === "system", "system is honoured even with 0 voices (user's choice)");
  ok(c("system", false, 0, false) === "fusion", "system without any API falls back rather than going silent");
  ok(c("fusion", true, 9, false) === "fusion", "fusion forced");
  const o = fusionOpts("high", 9); ok(o.rate === 2 && o.pitch === 195, `rate clamp/preset ${JSON.stringify(o)}`);
  ok(fusionOpts("nope", 1).pitch === 112, "unknown preset → standard");
});

await test("mutants: the oracle and gates can fail (time-reversed speech, noise, spelled-out letter-to-sound)", { "AX-15": "full" }, () => {
  let caught = 0;
  // M1: the same audio played backwards keeps the spectrum but not the speech → dev must fall below the gate
  const rev = forcedChoice(DEV, (w) => say(w).slice().reverse()); if (rev.right / rev.n < 0.85) caught++;
  // M2: noise of the same length → (nearly) nothing recognised
  const noise = forcedChoice(DEV, (w) => { const x = say(w); return x.map(() => (Math.random() - 0.5) * 0.4); }); if (noise.right / noise.n < 0.3) caught++;
  // M3: a "letter-to-sound" that just spells the word fails the PER gate
  const S = JSON.parse(readFileSync("scripts/oracle/g2p-sets.json", "utf8")) as { rand: string[] };
  const r = score(S.rand.slice(0, 300), loadCmudict(), (w) => spell(w)); if (r.per > 0.3) caught++;
  console.log(`    reversed dev ${rev.right}/20, noise ${noise.right}/20, spelled PER ${(r.per * 100).toFixed(0)} %`);
  ok(caught === 3, `${caught}/3 mutants caught`);
});

// ---- informational (not gates)
{
  const S = JSON.parse(readFileSync("scripts/oracle/g2p-sets.json", "utf8")) as { hold: string[] };
  const h = forcedChoice(S.hold.slice(0, 100), say);
  console.log(`info: 100-way forced choice over hold[0:100] (G2P pronunciations): ${h.right}/100 (chance 1 %)`);
  const SETS: [string, string, string[]][] = [
    ["AA", "T", ["pot", "tot", "cot", "bot", "dot", "got"]], ["IY", "", ["pea", "tea", "key", "bee", "dee", "ghee"]],
    ["EY", "T", ["pate", "tate", "kate", "bait", "date", "gate"]], ["UW", "", ["pooh", "two", "coo", "boo", "do", "goo"]],
    ["AE", "T", ["pat", "tat", "cat", "bat", "dat", "gat"]],
  ];
  const jobs: Job[] = [], truth: string[] = [];
  for (const [v, fin, words] of SETS) ["P", "T", "K", "B", "D", "G"].forEach((c, i) => {
    const ph: PhoneTok[] = [{ p: c, wordStart: true }, { p: v, stress: 1, wordEnd: !fin }];
    if (fin) ph.push({ p: fin, wordEnd: true });
    jobs.push({ wav: wav(synthPhrases([{ phones: ph, end: "." }])), mode: "grammar", words }); truth.push(words[i]);
  });
  const hp = asr(jobs);
  console.log(`info: stop place/voicing 6-way: ${hp.filter((h, i) => h === truth[i]).length}/30 (chance 5/30)`);
  const SENT = ["open the settings window", "the file was saved", "search for music", "close the dialog", "turn on the light", "play the next video", "what time is it", "delete the selected items", "there are three new messages", "the weather today is sunny"];
  const hs = asr(SENT.map((s) => ({ wav: wav(say(s)), mode: "open" })));
  const ed = (a: string[], b: string[]) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  let e = 0, n = 0;
  SENT.forEach((s, i) => { const ref = s.split(" "); e += ed((hs[i] ?? "").split(" ").filter(Boolean), ref); n += ref.length; });
  console.log(`info: open-vocabulary sentence WER (60k-word LM, no grammar): ${(100 * e / n).toFixed(1)} % (${e}/${n})`);
}

finish();
