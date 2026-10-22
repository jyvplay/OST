/**
 * TT59 browser side of the spell checker: lazy dictionary load, the user dictionary, preferences and the
 * CSS Custom Highlight painting shared by every open editor window.
 *
 * Privacy: the dictionary is a static same-origin file (/dict/en_US.*, cached by the service worker after the first
 * use); words are checked on this device only and the user dictionary lives in this browser's localStorage.
 * Nothing is fetched until a document is actually checked (lightweight: the 0.55 MB word list is never preloaded).
 */
import { Speller } from "./hunspell";

let pending: Promise<Speller> | null = null;
let loaded: Speller | null = null;
const USER_KEY = "fusion.spell.user", MODE_KEY = "fusion.writer.spell", UPPER_KEY = "fusion.spell.skipUpper";
export const USER_MAX = 5000;

export type SpellMode = "fusion" | "browser" | "off";

export function loadSpeller(): Promise<Speller> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= (async () => {
    const get = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); };
    const [aff, dic] = await Promise.all([get("/dict/en_US.aff"), get("/dict/en_US.dic")]);
    const sp = new Speller(aff, dic); sp.setUserWords(readUserWords());
    loaded = sp; return sp;
  })().catch((e) => { pending = null; throw e; });
  return pending;
}
export const spellerIfLoaded = () => loaded;

function ls(): Storage | null { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } }
export function readUserWords(): string[] {
  try { const v = JSON.parse(ls()?.getItem(USER_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-USER_MAX) : []; } catch { return []; }
}
function writeUserWords(list: string[]) { ls()?.setItem(USER_KEY, JSON.stringify(list.slice(-USER_MAX))); loaded?.setUserWords(list.slice(-USER_MAX)); }
export function addUserWord(w: string) { const v = w.trim(); if (!v || /\s/.test(v) || v.length > 64) return false; writeUserWords([...new Set([...readUserWords(), v])]); return true; }
export function removeUserWord(w: string) { writeUserWords(readUserWords().filter((x) => x !== w)); }

export function readSpellMode(): SpellMode { const v = ls()?.getItem(MODE_KEY); return v === "browser" || v === "off" ? v : "fusion"; }
export function writeSpellMode(m: SpellMode) { ls()?.setItem(MODE_KEY, m); }
export function readSkipUpper(): boolean { return ls()?.getItem(UPPER_KEY) !== "0"; }
export function writeSkipUpper(v: boolean) { ls()?.setItem(UPPER_KEY, v ? "1" : "0"); }

/* ------------------------------------------------------------------ painting */
// One Highlight per kind for the whole page: each window contributes its ranges under its own owner key.
const owners = new Map<string, { spell: Range[]; repeat: Range[]; current: Range[] }>();
type HL = { new (...r: Range[]): unknown };
export const HL_SPELL = "fusion-spell", HL_REPEAT = "fusion-repeat", HL_CURRENT = "fusion-spell-current";
export function highlightSupported(): boolean {
  const c = (globalThis as unknown as { CSS?: { highlights?: unknown } }).CSS;
  return typeof (globalThis as unknown as { Highlight?: unknown }).Highlight === "function" && !!c?.highlights;
}
export function paintSpell(owner: string, spell: Range[], repeat: Range[], current: Range[] = []) {
  if (spell.length || repeat.length || current.length) owners.set(owner, { spell, repeat, current }); else owners.delete(owner);
  if (!highlightSupported()) return;
  const H = (globalThis as unknown as { Highlight: HL }).Highlight;
  const reg = (globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights;
  const all = (k: "spell" | "repeat" | "current") => [...owners.values()].flatMap((o) => o[k]);
  for (const [name, k] of [[HL_SPELL, "spell"], [HL_REPEAT, "repeat"], [HL_CURRENT, "current"]] as const) {
    const rs = all(k);
    if (rs.length) reg.set(name, new H(...rs)); else reg.delete(name);
  }
}
/** CSS for the painted ranges (Word-like red wavy underline; repeated words blue double; the issue shown in the
 *  Spelling pane gets a soft background as well). Browsers without the Highlight API simply show no underline —
 *  the Spelling pane still lists and fixes every issue. */
export const SPELL_CSS = `
::highlight(${HL_SPELL}){text-decoration:underline wavy #d0021b;text-decoration-thickness:1.5px;text-underline-offset:2px;text-decoration-skip-ink:none}
::highlight(${HL_REPEAT}){text-decoration:underline double #1f5fbf;text-decoration-skip-ink:none}
::highlight(${HL_CURRENT}){background-color:rgba(255,196,0,.35)}
`;
