/**
 * TT59 Writer proofing: the from-scratch Hunspell-format engine (src/lib/spell/hunspell.ts) and the document layer
 * (src/lib/office/wordspell.ts).
 * Ground truth:
 *   - spylls (MPL-2.0, PyPI; an independent pure-Python port of Hunspell's lookup + suggest), TEST-ONLY, on the same
 *     en_US .aff/.dic Fusion ships — every one of ~22,000 words (dictionary forms, affixed forms, random misspellings,
 *     case variants, ordinals, apostrophes, hyphenation) must get the same verdict; plus a hand-written dictionary that
 *     exercises FLAG long, KEEPCASE, FORBIDDENWORD, NEEDAFFIX, BREAK, COMPOUNDRULE ?, conditions and cross products.
 *   - python-docx + lxml (scripts/oracle/docx_spell.py) build the .docx fixture and read saved files back.
 *   - mutants of the engine must each be caught by the oracle comparison.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt59-writer-spell.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { Speller, capType, tokenize } from "../src/lib/spell/hunspell.ts";
import { readWord, writeWord, allParas } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import * as WS from "../src/lib/office/wordspell.ts";

const { test, finish } = makeHarness("tt59-writer-spell");
const COV = { "FF-38": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
const AFF = readFileSync("public/dict/en_US.aff", "utf8"), DIC = readFileSync("public/dict/en_US.dic", "utf8");
type O = { w: string; ok: boolean; sug: string[] };
const spylls = (base: string, words: string[], nsug = 0): O[] =>
  execFileSync(PY, ["scripts/oracle/spell_spylls.py", base, ...(nsug ? ["--suggest", String(nsug)] : [])], { input: words.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 })
    .trim().split("\n").map((l) => JSON.parse(l) as O);

let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function corpus(sp: Speller): string[] {
  const entries = DIC.split("\n").slice(1).filter(Boolean); const words: string[] = [];
  for (let i = 0; i < entries.length; i += 17) {
    const [w, fl = ""] = entries[i].split("/"); words.push(w);
    for (const f of fl) {
      for (const [add, list] of sp.aff.sfx) for (const s of list) if (s.flag === f && w.endsWith(s.strip)) words.push(w.slice(0, w.length - s.strip.length) + add);
      for (const [add, list] of sp.aff.pfx) for (const p of list) if (p.flag === f) words.push(add + w);
    }
  }
  const base = [...new Set(words)]; const mut: string[] = [];
  for (const w of base) {
    const r = rnd(); const a = [...w]; const i = Math.floor(rnd() * a.length);
    if (r < 0.25) a.splice(i, 1); else if (r < 0.5) a.splice(i, 0, "etaoinsr"[Math.floor(rnd() * 8)]); else if (r < 0.75 && i + 1 < a.length) [a[i], a[i + 1]] = [a[i + 1], a[i]]; else a[i] = "etaoinsrlcdu"[Math.floor(rnd() * 12)];
    mut.push(a.join(""));
    if (rnd() < 0.2) mut.push(w.toUpperCase()); if (rnd() < 0.2) mut.push(w[0].toUpperCase() + w.slice(1)); if (rnd() < 0.1) mut.push(w.toLowerCase());
  }
  const extra = ["21st", "11th", "11st", "101st", "1th", "2th", "3th", "113th", "22nd", "23rd", "2nd", "12nd", "0th", "1000000th", "112th", "well-known", "-foo", "foo-", "re-walked", "O'BRIEN'S", "o'brien", "don't", "DON'T", "it’s", "isn’t", "3.14", "1.2.3", "Paris's", "PARIS'S", "McDonald", "MCDONALD", "Mcdonald", "mcdonald", "iPhone", "IPHONE", "BigQuery", "BIGQUERY", "Bigquery", "unwalked", "rewalked", "I", "i", "AA", "aa", "Aa", "self-self-help", "e-mail", "E-MAIL"];
  return [...new Set([...base, ...mut, ...extra])].filter((w) => w && !w.includes(" "));
}

const sp = new Speller(AFF, DIC);
const words = corpus(sp);
const ORACLE = spylls("public/dict/en_US", words);

await test("en_US: every verdict equals spylls (Hunspell port) on ~22k words — forms, misspellings, case, ordinals, apostrophes, hyphens", COV, () => {
  ok(words.length > 20000, `corpus ${words.length}`);
  const bad = ORACLE.filter((o) => sp.check(o.w) !== o.ok);
  eq(bad.slice(0, 10).map((o) => `${o.w}:${o.ok}`), [], `${bad.length} mismatches`);
  const nTrue = ORACLE.filter((o) => o.ok).length, nFalse = ORACLE.length - nTrue;
  ok(nTrue > 8000 && nFalse > 8000, `both verdicts well represented (${nTrue}/${nFalse})`);
  // H− shapes inside the corpus: a lowercase proper noun, a mixed-case brand in wrong case, ONLYINCOMPOUND ordinal pieces
  for (const w of ["paris", "Mcdonald", "Bigquery", "1th", "11st", "12nd", "unwalked"]) ok(!sp.check(w), `${w} must be rejected`);
  for (const w of ["Paris", "PARIS'S", "MCDONALD", "IPHONE", "21st", "113th", "well-known", "it’s", "O'BRIEN'S"]) ok(sp.check(w), `${w} must be accepted`);
});

await test("hand-written dictionary (FLAG long, KEEPCASE, FORBIDDENWORD, NEEDAFFIX, NOSUGGEST, BREAK, COMPOUNDRULE ?, conditions, cross product) equals spylls", COV, () => {
  mkdirSync("/tmp/tt59spell", { recursive: true });
  const aff = `SET UTF-8
FLAG long
TRY esianrtolcdugmphbyfvkwz
KEEPCASE Kc
FORBIDDENWORD Fb
NEEDAFFIX Na
NOSUGGEST Ns
BREAK 2
BREAK -
BREAK ^-
COMPOUNDMIN 1
ONLYINCOMPOUND Oc
COMPOUNDRULE 1
COMPOUNDRULE (Aa)(Bb)?(Cc)

PFX Pr Y 1
PFX Pr 0 re [^r]

PFX Un N 1
PFX Un 0 un .

SFX Sx Y 3
SFX Sx y ies [^aeiou]y
SFX Sx 0 s [aeiou]y
SFX Sx 0 s [^y]

SFX Ed N 2
SFX Ed 0 ed [^e]
SFX Ed 0 d e
`;
  const dic = `11
work/PrSxEd
try/SxPr
play/SxEd
happy/Un
OpenOffice/Kc
pastas/Fb
pasta/Sx
kind/NaSx
foo/AaOc
bar/Bb
baz/CcOc
`;
  writeFileSync("/tmp/tt59spell/t.aff", aff); writeFileSync("/tmp/tt59spell/t.dic", dic);
  const s2 = new Speller(aff, dic);
  const ws = ["work", "works", "worked", "rework", "reworks", "reworked", "try", "tries", "trys", "retry", "retries", "play", "plays", "plaies", "played", "replay", "happy", "unhappy", "unhappies", "OpenOffice", "OPENOFFICE", "openoffice", "Openoffice", "pasta", "pastas", "PASTAS", "kind", "kinds", "foo", "baz", "foobaz", "foobarbaz", "foobarbarbaz", "barbaz", "foo-baz", "work-play", "-work", "work-", "work--play", "Work", "WORK", "Works", "REWORKS", "rrework", "rerework", "Kinds", "KINDS", "KIND", "wor", "workk", "tried", "trying"];
  const o = spylls("/tmp/tt59spell/t", ws);
  const bad = o.filter((x) => s2.check(x.w) !== x.ok);
  eq(bad.map((x) => `${x.w}:${x.ok}`), [], "verdicts differ from spylls");
  ok(o.filter((x) => x.ok).length >= 15 && o.filter((x) => !x.ok).length >= 15, "both verdicts represented");
  // NOSUGGEST and FORBIDDENWORD never appear among suggestions
  const s3 = new Speller(aff.replace("NOSUGGEST Ns", "NOSUGGEST Ns"), dic.replace("11\n", "12\n") + "darn/Ns\n");
  ok(s3.check("darn"), "a NOSUGGEST word is still correct");
  ok(!s3.suggest("darm").includes("darn") && !s3.suggest("darns").includes("darn"), `NOSUGGEST word suggested: ${s3.suggest("darm")}`);
  ok(!s2.suggest("pastass").includes("pastas"), "a forbidden word must never be suggested");
  // refused (not silently misread): unsupported directives
  for (const bad of ["COMPOUNDFLAG X", "CIRCUMFIX X", "SET ISO8859-1"]) { let threw = false; try { new Speller(`${bad}\n`, "0\n"); } catch { threw = true; } ok(threw, `${bad} must be refused`); }
});

await test("suggestions: oracle's first suggestion is in ours ≥ 90%, our first is among the oracle's 5 ≥ 85%, never an invalid or NOSUGGEST word", COV, () => {
  const bad = ORACLE.filter((o) => !o.ok).filter((_, i) => i % 29 === 0).slice(0, 240).map((o) => o.w);
  const o = spylls("public/dict/en_US", bad, 5).filter((x) => x.sug.length);
  let hit1 = 0, ours1 = 0, invalid = 0;
  const t0 = performance.now();
  for (const x of o) {
    const s = sp.suggest(x.w, 8);
    if (s.includes(x.sug[0])) hit1++;
    if (s.length && x.sug.includes(s[0])) ours1++;
    for (const y of s) if (!y.split(" ").every((p) => sp.check(p))) invalid++;
  }
  const ms = (performance.now() - t0) / o.length;
  console.log(`    suggestions: n=${o.length} oracle-top1-in-ours=${(hit1 / o.length).toFixed(3)} ours-top1-in-oracle5=${(ours1 / o.length).toFixed(3)} invalid=${invalid} ${ms.toFixed(0)} ms/word`);
  ok(o.length >= 150, `sample ${o.length}`);
  ok(hit1 / o.length >= 0.9, `oracle top-1 recall ${hit1 / o.length}`);
  ok(ours1 / o.length >= 0.85, `our top-1 precision ${ours1 / o.length}`);
  eq(invalid, 0, "invalid suggestions");
  // offensive NOSUGGEST (!) entries of the shipped dictionary: misspelled, they are never offered
  const ns = DIC.split("\n").filter((l) => /\/.*!/.test(l)).map((l) => l.split("/")[0]).slice(0, 12);
  ok(ns.length >= 10, "dictionary has NOSUGGEST words");
  for (const w of ns) { const m = w.slice(0, -1) + (w.endsWith("e") ? "a" : "e"); ok(!sp.suggest(m).some((s) => s.toLowerCase() === w.toLowerCase()), `NOSUGGEST ${w} offered for ${m}`); }
  // case of the input is kept; split suggestions; empty-safe
  ok(sp.suggest("Teh")[0] === "The", `Teh → ${sp.suggest("Teh")}`);
  ok(sp.suggest("TEH").includes("THE"), `TEH → ${sp.suggest("TEH")}`);
  ok(sp.suggest("alot").includes("a lot"), `alot → ${sp.suggest("alot")}`);
  eq(sp.suggest(""), [], "empty word");
});

await test("tokenizer + capitalisation classes: URLs, e-mail, paths, digits skipped; ordinals and inner apostrophes kept; UPPERCASE optional", COV, () => {
  const t = (s: string, o = {}) => tokenize(s, o).map((x) => x.word);
  eq(t("Visit https://exampel.com/a?b=c or www.exampel.org, mail me@exampel.org now"), ["Visit", "or", "mail", "now"], "links skipped");
  eq(t("the 21st and 3rd item, 4x4 and A1 cells, C:\\Users\\bob\\file.txt /usr/local/bin ok"), ["the", "21st", "and", "3rd", "item", "and", "cells", "ok"], "digits / paths");
  eq(t("it’s don't 'quoted' rock'n'roll"), ["it’s", "don't", "quoted", "rock'n'roll"], "apostrophes");
  eq(t("NASA and XYZZY Go", { skipUpper: true }), ["and", "Go"], "skip upper");
  eq(t("NASA and XYZZY", {}), ["NASA", "and", "XYZZY"], "keep upper");
  eq(tokenize("ab cd").map((x) => [x.start, x.end]), [[0, 2], [3, 5]], "offsets");
  eq(["hello", "Hello", "HELLO", "hELLO", "McDonald", "A", "I'D", "x2"].map(capType), ["none", "init", "all", "huh", "huh", "init", "all", "none"], "capType");
});

const fx = "/tmp/tt59spell/fx.docx";
execFileSync(PY, ["scripts/oracle/docx_spell.py", "make", fx]);
const readBack = (b: Uint8Array) => { writeFileSync("/tmp/tt59spell/out.docx", b); return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_spell.py", "read", "/tmp/tt59spell/out.docx"], { encoding: "utf8" })).paras as { text: string; ins: string; del: string }[]; };

await test("document layer on a python-docx file: exactly the right issues — tracked deletion, w:noProof, w:lang fr-FR, links, UPPERCASE skipped; table cell + repeated word found", COV, async () => {
  const d = await readWord(new Uint8Array(readFileSync(fx)), "fx.docx");
  const got = WS.spellIssues(d, sp, { skipUpper: true }).map((i) => `${i.kind}:${i.word}`);
  eq(got, ["spell:Teh", "spell:jumpd", "spell:recieve", "repeat: is", "spell:Tabel"], "issues (Word order)");
  const all = WS.spellIssues(d, sp, { skipUpper: false }).map((i) => i.word);
  ok(all.includes("XYZZY") && !all.includes("NASA"), `UPPERCASE off: ${all}`);
  // Ignore All / Ignore Once / user dictionary
  eq(WS.spellIssues(d, sp, { skipUpper: true, ignoreAll: new Set(["Teh"]) }).map((i) => i.word)[0], "jumpd", "ignore all");
  const first = WS.spellIssues(d, sp, { skipUpper: true })[0];
  ok(!WS.spellIssues(d, sp, { skipUpper: true, ignoreOnce: new Set([WS.issueKey(first)]) }).some((i) => i.word === "Teh"), "ignore once");
  const s2 = new Speller(AFF, DIC); s2.setUserWords(["Tabel"]);
  ok(!WS.spellIssues(d, s2, { skipUpper: true }).some((i) => i.word === "Tabel"), "user dictionary");
  ok(s2.suggest("Tabell").includes("Tabel"), "user words are suggested");
  // issueAt (right-click) maps a position inside / at the end of a word, not beyond
  const iss = WS.spellIssues(d, sp, { skipUpper: true });
  const teh = iss[0];
  ok(WS.issueAt(iss, { pid: teh.pid, off: 1 }) === teh && WS.issueAt(iss, { pid: teh.pid, off: 3 }) === teh && !WS.issueAt(iss, { pid: teh.pid, off: 5 }), "issueAt");
});

await test("fixes write correct .docx (lxml read-back): Change, Change All, Delete repeated word; under Track Changes they are w:del + w:ins", COV, async () => {
  let d = await readWord(new Uint8Array(readFileSync(fx)), "fx.docx");
  let iss = WS.spellIssues(d, sp, { skipUpper: true });
  WS.fixIssue(d, iss.find((i) => i.word === "Teh")!, "The");
  iss = WS.spellIssues(d, sp, { skipUpper: true });
  WS.fixIssue(d, iss.find((i) => i.kind === "repeat")!, "");
  iss = WS.spellIssues(d, sp, { skipUpper: true });
  WS.fixIssue(d, iss.find((i) => i.word === "recieve")!, "receive");
  let o = readBack(await writeWord(d));
  eq(o[0].text, "The quick brown fox jumpd over the lazy dog.", "para 1");
  eq(o[2].text, "Fusionz bonjour mademoiselle and receive this.", "para 3 (runs around it untouched)");
  eq(o[3].text, "This is a repeated word and NASA plus XYZZY.", "repeat deleted with its space");
  eq(o[6], { text: "Kept text.", ins: "", del: "wrongg " }, "the file's own tracked deletion is preserved");
  eq(WS.spellIssues(d, sp, { skipUpper: true }).map((i) => i.word), ["jumpd", "Tabel"], "remaining");
  // Change All across paragraphs (exact word only)
  const p0 = allParas(d.blocks)[0]; E.insertText(d, { pid: p0.id, off: E.plen(p0) }, " Another jumpd and Jumpd.");
  eq(WS.changeAll(d, sp, "jumpd", "jumped"), 2, "change all count (exact case)");
  o = readBack(await writeWord(d));
  eq(o[0].text, "The quick brown fox jumped over the lazy dog. Another jumped and Jumpd.", "change all");
  // tracked
  d = await readWord(new Uint8Array(readFileSync(fx)), "fx.docx");
  E.setTracking(d, true, "Proofer");
  iss = WS.spellIssues(d, sp, { skipUpper: true });
  WS.fixIssue(d, iss.find((i) => i.word === "Tabel")!, "Table");
  o = readBack(await writeWord(d));
  const cell = o.find((p) => p.del === "Tabel");
  ok(cell && cell.ins === "Table" && cell.text === "Table cell", `tracked fix: ${JSON.stringify(o.slice(4, 6))}`);
  ok(!WS.spellIssues(d, sp, { skipUpper: true }).some((i) => i.word === "Tabel"), "struck text is no longer an issue");
});

await test("performance and robustness: dictionary loads < 1.5 s, 50k checks < 3 s, hostile input (long / odd Unicode / huge word) never throws", COV, () => {
  const t0 = performance.now(); const s = new Speller(AFF, DIC); const load = performance.now() - t0;
  const ws = words.slice(0, 25000); const t1 = performance.now(); let n = 0; for (let r = 0; r < 2; r++) for (const w of ws) if (s.check(w)) n++; const chk = performance.now() - t1;
  console.log(`    load ${load.toFixed(0)} ms; ${ws.length * 2} checks ${chk.toFixed(0)} ms`);
  ok(load < 1500, `load ${load}`); ok(chk < 3000, `checks ${chk}`); ok(n > 0, "some true");
  for (const w of ["x".repeat(5000), "\u0301\u0301", "ǅemal", "İstanbul", "ß", "a'", "'a", "--", "a-", "\ud83d\ude00", "日本語", "e\u0301te\u0301"]) { s.check(w); s.suggest(w.slice(0, 40)); }
  const long = "word ".repeat(20000) + "mispeled";
  const t2 = performance.now(); const toks = tokenize(long); ok(toks.length === 20001 && performance.now() - t2 < 1500, "tokenize 100 kB");
});

/* ---------------------------------------------------------------- mutants: each must be caught by the oracle comparison */
await test("mutants of the engine are each caught by the spylls comparison (6 mutants)", COV, async () => {
  const src = readFileSync("src/lib/spell/hunspell.ts", "utf8");
  const muts: [string, string, string][] = [
    ["no cross product", "if (p.cross && this.suffixForms(stem, p)) return true;", ""],
    ["affix conditions ignored", "if (!stem || !condOk(s.cond, stem, true)) continue;", "if (!stem) continue;"],
    ["no upper-case homonyms", "return this.allCaps || !fl.includes(ONLYUP);", "return !fl.includes(ONLYUP);"],
    ["ONLYINCOMPOUND ignored", "(inCompound || !this.has(fl, this.aff.onlyInCompound))", "true"],
    ["ALL-CAPS apostrophe rule removed", "if (this.checkForm(initCap(head) + initCap(tail))) return true;", ""],
    ["no hyphen BREAK", "return this.checkBreaks(w, 0);", "return false;"],
  ];
  mkdirSync("/tmp/tt59spell/mut", { recursive: true });
  const caught: string[] = [];
  for (const [name, a, b] of muts) {
    ok(src.includes(a), `mutant anchor missing: ${name}`);
    const f = `/tmp/tt59spell/mut/h${caught.length}-${Date.now()}.ts`; writeFileSync(f, src.replace(a, b));
    const M = await import(f) as { Speller: typeof Speller };
    const m = new M.Speller(AFF, DIC);
    const diff = ORACLE.filter((o) => m.check(o.w) !== o.ok).length;
    if (diff > 0) caught.push(name); else throw new Error(`mutant survived: ${name}`);
  }
  eq(caught.length, muts.length, "all caught");
});

finish();
