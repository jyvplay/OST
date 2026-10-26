/**
 * Narrator DOM layer (TT30, AX-14): adapts live DOM nodes to narrator-core's NNode and runs the reader — focus and
 * state announcements, live regions, typing echo, the Narrator-key scan cursor, and speech through the browser's own
 * Web Speech API (speechSynthesis). Captions are always produced, so the reader stays usable (and testable) where the
 * browser has no voices. Browser-only; all decisions are delegated to the pure core.
 * TT32 (AX-15): when the browser has no voices (or its engine fails) speech goes through Fusion Voice, Fusion's own
 * on-device synthesiser (voice-engine.ts), so the reader is audible there too; Settings can force either engine.
 */
import * as C from "./narrator-core";
import { chooseEngine, fusionOpts, FusionSpeaker, type EngineId, type VoicePref } from "./voice-engine";

const unquote = (c: string) => {
  if (!c || c === "none" || c === "normal") return "";
  const m = /^"([^]*)"$/.exec(c) ?? /^'([^]*)'$/.exec(c);
  return m ? m[1].replace(/\\(.)/g, "$1") : "";
};

function transformed(t: string, parent: Element | null): string {
  if (!parent || !t.trim()) return t;
  const tt = getComputedStyle(parent).textTransform;
  if (tt === "uppercase") return t.toUpperCase();
  if (tt === "lowercase") return t.toLowerCase();
  if (tt === "capitalize") return t.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return t;
}
const cache = new WeakMap<Node, C.NNode>();
const back = new WeakMap<C.NNode, Element>();
/** the DOM element behind an NNode */
export function el(n: C.NNode): Element | null { return back.get(n) ?? null; }
export function nn(node: Node): C.NNode {
  const hit = cache.get(node);
  if (hit) return hit;
  const el = node.nodeType === 1 ? (node as HTMLElement) : null;
  const v: C.NNode = {
    kind: el ? "el" : "text",
    tag: el ? el.tagName.toLowerCase() : "",
    // rendered text: CSS text-transform applies (Chromium names use layout text, so platform readers hear it too)
    get text() { return el ? "" : transformed(node.textContent ?? "", node.parentElement); },
    attr: (k) => el?.getAttribute(k) ?? null,
    children: () => Array.from(node.childNodes).filter((c) => c.nodeType === 1 || c.nodeType === 3).map(nn),
    parent: () => (node.parentNode && node.parentNode.nodeType === 1 ? nn(node.parentNode) : null),
    hidden: () => {
      const e = el ?? node.parentElement;
      if (!e) return true;
      if (e.closest("[aria-hidden=true]")) return true;
      if (e.tagName === "OPTION") return !!e.closest("[hidden]");
      return !e.checkVisibility({ visibilityProperty: true });
    },
    byId: (id) => { const r = node.ownerDocument?.getElementById(id); return r ? nn(r) : null; },
    labels: () => { const ls = (el as HTMLInputElement | null)?.labels; return ls ? Array.from(ls).map(nn) : []; },
    value: () => {
      if (!el) return "";
      if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions).map((o) => o.text).join(", ");
      if (el instanceof HTMLInputElement) return el.type === "password" ? "•".repeat(el.value.length) : ["checkbox", "radio", "button", "submit", "reset", "image"].includes(el.type) ? "" : el.value;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLOutputElement) return el.value;
      if (el.isContentEditable) return el.innerText;
      return "";
    },
    block: () => { if (!el) return false; const d = getComputedStyle(el).display; return !(d.startsWith("inline") || d === "contents"); },
    before: () => (el ? unquote(getComputedStyle(el, "::before").content) : ""),
    after: () => (el ? unquote(getComputedStyle(el, "::after").content) : ""),
    focusable: () => !!el && (el.tabIndex >= 0 || el.hasAttribute("tabindex") || el.isContentEditable || ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && !(el as HTMLButtonElement).disabled),
    checked: () => (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? (el.indeterminate ? null : el.checked) : null),
    disabled: () => !!el && ("disabled" in el && (el as HTMLButtonElement).disabled === true || !!el.closest("fieldset[disabled]") && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName)),
    same: (o) => o === v,
  };
  cache.set(node, v);
  if (el) back.set(v, el);
  return v;
}

export interface NarratorOptions {
  rate: () => number;
  onCaption: (text: string, kind: "focus" | "live" | "cursor" | "system" | "echo") => void;
  onCursor: (rect: DOMRect | null) => void;
  onRate: (dir: 1 | -1) => void;
  onHelp: () => void;
  /** spoken through speechSynthesis (default true); captions are shown either way */
  speech?: () => boolean;
  /** the browser's speech engine failed (e.g. no voice installed): the host tells the user, captions continue */
  onSpeechError?: (error: string) => void;
  /** TT32: which engine speaks — auto (system voices if any, else Fusion Voice) | system | fusion */
  voicePref?: () => VoicePref;
  /** TT32: Fusion Voice preset id (standard | bright | high) */
  fusionVoice?: () => string;
  /** TT32: reports the engine that spoke the last utterance */
  onEngine?: (engine: EngineId) => void;
}

export class Narrator {
  private o: NarratorOptions;
  private on = false;
  private nk = false;
  private nkUsed = false;
  private prevCtx: C.NNode[] = [];
  private items: C.Item[] = [];
  private idx = -1;
  private mo: MutationObserver | null = null;
  private pending = new Map<Element, { pol: C.Politeness; texts: string[]; atomic: boolean }>();
  private flushT = 0;
  private focusT = 0;
  private reading = false;
  speechAvailable = false;
  /** TT32: system voice count (updated on voiceschanged) and whether the system engine has failed this session */
  private sysVoices = 0;
  private sysFailed = false;
  private fusion: FusionSpeaker | null = null;
  private onVoices = () => { try { this.sysVoices = window.speechSynthesis.getVoices().length; } catch { this.sysVoices = 0; } };

  constructor(o: NarratorOptions) { this.o = o; }

  start() {
    if (this.on) return;
    this.on = true;
    this.speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
    if (this.speechAvailable) { this.onVoices(); window.speechSynthesis.addEventListener?.("voiceschanged", this.onVoices); }
    if (FusionSpeaker.available()) this.fusion = new FusionSpeaker();
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("focusin", this.onFocus, true);
    document.addEventListener("input", this.onInput, true);
    document.addEventListener("change", this.onChange, true);
    this.mo = new MutationObserver(this.onMutations);
    this.mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-checked", "aria-pressed", "aria-expanded", "aria-selected", "aria-activedescendant", "aria-valuenow", "aria-valuetext"] });
    this.say("Narrator on. Hold Caps Lock or Insert and press F1 for Narrator commands.", "system", true);
    const a = document.activeElement;
    if (a && a !== document.body) this.prevCtx = C.contextChain(nn(a));
  }

  stop() {
    if (!this.on) return;
    this.say("Narrator off.", "system", true);
    this.on = false;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("focusin", this.onFocus, true);
    document.removeEventListener("input", this.onInput, true);
    document.removeEventListener("change", this.onChange, true);
    this.mo?.disconnect(); this.mo = null;
    window.clearTimeout(this.flushT); window.clearTimeout(this.focusT);
    if (this.speechAvailable) window.speechSynthesis.removeEventListener?.("voiceschanged", this.onVoices);
    // let "Narrator off." finish, then release the audio device
    const f = this.fusion; this.fusion = null;
    if (f) window.setTimeout(() => f.close(), 2500);
    this.o.onCursor(null);
  }

  /** speak + caption; interrupt = flush what is being said (focus changes, assertive alerts, commands) */
  say(text: string, kind: Parameters<NarratorOptions["onCaption"]>[1], interrupt: boolean) {
    const t = text.trim();
    if (!t) return;
    this.o.onCaption(t, kind);
    if (this.o.speech?.() === false) return;
    const pref = this.o.voicePref?.() ?? "auto";
    const engine = chooseEngine(pref, { api: this.speechAvailable, voices: this.sysVoices, failed: this.sysFailed });
    if (engine === "fusion" && !this.fusion) return; // no Web Audio either: captions only
    this.o.onEngine?.(engine);
    if (engine === "fusion") {
      if (interrupt && this.speechAvailable) try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      this.fusion!.speak(t, fusionOpts(this.o.fusionVoice?.() ?? "standard", this.o.rate()), interrupt, (err) => this.o.onSpeechError?.(`fusion: ${err}`));
      return;
    }
    try {
      if (interrupt) { window.speechSynthesis.cancel(); this.fusion?.cancel(); }
      const u = new SpeechSynthesisUtterance(t);
      u.rate = this.o.rate();
      u.lang = document.documentElement.lang || "en";
      // "interrupted" / "canceled" are our own cancels; anything else means the engine could not speak —
      // in auto mode Fusion Voice takes over (and keeps the job for the rest of the session)
      u.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled") return;
        this.o.onSpeechError?.(e.error);
        if (pref === "auto" && this.fusion) { this.sysFailed = true; this.o.onEngine?.("fusion"); this.fusion.speak(t, fusionOpts(this.o.fusionVoice?.() ?? "standard", this.o.rate()), false); }
      };
      window.speechSynthesis.speak(u);
    } catch { /* a browser without a working speech backend still gets captions */ }
  }
  silence() {
    this.reading = false;
    this.fusion?.cancel();
    if (this.speechAvailable) try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ focus, state, typing
  private announceFocus(target: Element, withContext: boolean) {
    const n = nn(target);
    const ctx = C.contextChain(n);
    const parts: string[] = [];
    if (withContext) for (const c of C.entered(this.prevCtx, ctx)) parts.push(C.contextWords(c));
    this.prevCtx = ctx;
    // an active descendant (combobox / listbox / grid) is what the user is on
    const ad = target.getAttribute("aria-activedescendant");
    const adEl = ad ? document.getElementById(ad) : null;
    parts.push(C.utterance(C.spoken(adEl ? nn(adEl) : n)));
    this.say(parts.filter(Boolean).join(". "), "focus", true);
    this.cursorTo(adEl ?? target);
  }
  private onFocus = (e: FocusEvent) => {
    const t = e.target as Element | null;
    if (!t || t === document.body || !(t instanceof Element)) return;
    // coalesce focus bursts (a dialog opening moves focus twice): announce the last one
    window.clearTimeout(this.focusT);
    this.focusT = window.setTimeout(() => { if (this.on && document.activeElement === t) this.announceFocus(t, true); }, 40);
  };
  private onInput = (e: Event) => {
    const t = e.target as HTMLElement;
    const ie = e as InputEvent;
    if (t instanceof HTMLInputElement && t.type === "range") { this.say(C.spoken(nn(t)).value, "echo", true); return; }
    if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) && ie.inputType === "insertText" && ie.data) {
      const pw = t instanceof HTMLInputElement && t.type === "password";
      this.say(pw ? "star" : ie.data === " " ? "space" : ie.data, "echo", true);
    }
  };
  private onChange = (e: Event) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio")) this.say(C.spoken(nn(t)).states.join(", "), "focus", true);
    else if (t instanceof HTMLSelectElement) this.say(C.spoken(nn(t)).value, "focus", true);
  };

  // ------------------------------------------------------------------ live regions + state changes
  private onMutations = (ms: MutationRecord[]) => {
    for (const m of ms) {
      const target = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
      if (!target || target.closest("[data-narrator-ui]")) continue;
      if (m.type === "attributes") {
        // state change on the focused element: say just the new state (as readers do)
        if (target === document.activeElement) {
          if (m.attributeName === "aria-activedescendant") { this.announceFocus(target, false); continue; }
          const s = C.spoken(nn(target));
          const words = m.attributeName === "aria-valuenow" || m.attributeName === "aria-valuetext" ? s.value : s.states.join(", ");
          if (words) this.say(words, "focus", true);
        }
        continue;
      }
      const live = C.liveOf(nn(target));
      if (live.politeness === "off" || live.busy || !live.root) continue;
      const rootEl = el(live.root);
      if (!rootEl || (rootEl as HTMLElement).closest("[aria-hidden=true]")) continue;
      const slot = this.pending.get(rootEl) ?? { pol: live.politeness, texts: [], atomic: live.atomic };
      if (live.atomic) slot.texts = [(rootEl as HTMLElement).innerText ?? rootEl.textContent ?? ""];
      else if (m.type === "characterData") { if (live.relevant.includes("text") || live.relevant.includes("all")) slot.texts.push(m.target.textContent ?? ""); }
      else if (live.relevant.includes("additions") || live.relevant.includes("all")) for (const a of Array.from(m.addedNodes)) slot.texts.push((a as HTMLElement).innerText ?? a.textContent ?? "");
      this.pending.set(rootEl, slot);
    }
    if (this.pending.size) { window.clearTimeout(this.flushT); this.flushT = window.setTimeout(this.flushLive, 120); }
  };
  private flushLive = () => {
    for (const [, s] of this.pending) {
      const t = s.texts.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join(". ");
      if (t) this.say(t, "live", s.pol === "assertive");
    }
    this.pending.clear();
  };

  // ------------------------------------------------------------------ Narrator key + scan cursor
  private onBlur = () => { this.nk = false; };
  private onKeyUp = (e: KeyboardEvent) => { if (C.NARRATOR_KEYS.includes(e.code)) { this.nk = false; if (this.nkUsed) e.preventDefault(); } };
  private onKey = (e: KeyboardEvent) => {
    if (!this.on) return;
    if (C.NARRATOR_KEYS.includes(e.code)) { this.nk = true; this.nkUsed = false; if (e.code === "Insert") e.preventDefault(); return; }
    if (e.key === "Control" && !e.altKey && !e.shiftKey && !e.metaKey) { this.silence(); return; }
    if (!this.nk) return;
    const cmd = C.commandFor(e.code, e.shiftKey);
    if (!cmd) return;
    e.preventDefault(); e.stopImmediatePropagation();
    this.nkUsed = true;
    this.run(cmd);
  };

  /** the subtree the scan cursor walks: the focused window, else the whole page */
  private scope(): Element {
    const a = document.activeElement;
    return (a && a.closest("[data-win-id]")) || (a && a.closest("[role=dialog]")) || document.body;
  }
  private refresh() {
    const root = this.scope();
    this.items = C.readingItems(nn(root)).filter((it) => !el(it.node)?.closest?.("[data-narrator-ui]"));
    // keep the cursor where it was if still present, else start at the focused element
    const cur = this.cursorEl;
    let i = cur ? this.items.findIndex((it) => el(it.node) === cur || (el(it.node)?.contains(cur) ?? false)) : -1;
    if (i < 0) { const a = document.activeElement; i = a ? this.items.findIndex((it) => el(it.node) === a) : -1; }
    this.idx = i;
  }
  private cursorEl: Element | null = null;
  private cursorTo(e: Element | null) {
    this.cursorEl = e;
    this.o.onCursor(e ? e.getBoundingClientRect() : null);
  }
  private move(dir: 1 | -1, j: C.Jump) {
    this.refresh();
    if (!this.items.length) { this.say("Nothing to read here.", "cursor", true); return; }
    const from = this.idx < 0 ? (dir === 1 ? -1 : this.items.length) : this.idx;
    const k = C.nextIndex(this.items, from, dir, j);
    if (k < 0) { this.say(dir === 1 ? `No next ${j === "item" ? "item" : j}.` : `No previous ${j === "item" ? "item" : j}.`, "cursor", true); return; }
    this.idx = k;
    const it = this.items[k], e = el(it.node);
    if (e) { e.scrollIntoView?.({ block: "nearest" }); this.cursorTo(e); }
    this.say(C.itemText(it), "cursor", true);
  }
  run(cmd: string) {
    switch (cmd) {
      case "next": return this.move(1, "item");
      case "prev": return this.move(-1, "item");
      case "nextHeading": return this.move(1, "heading");
      case "prevHeading": return this.move(-1, "heading");
      case "nextLandmark": return this.move(1, "landmark");
      case "prevLandmark": return this.move(-1, "landmark");
      case "nextField": return this.move(1, "field");
      case "prevField": return this.move(-1, "field");
      case "nextLink": return this.move(1, "link");
      case "prevLink": return this.move(-1, "link");
      case "readFocus": { const a = document.activeElement; if (a && a !== document.body) this.announceFocus(a, false); else this.say("Nothing has focus.", "cursor", true); return; }
      case "activate": {
        const e = this.cursorEl as HTMLElement | null;
        if (!e) { this.say("Move the Narrator cursor to an item first.", "cursor", true); return; }
        const f = e.matches("input,select,textarea,[contenteditable=true]") ? e : null;
        if (f) f.focus(); else e.click();
        return;
      }
      case "readWindow": {
        const a = document.activeElement;
        const win = a?.closest("[data-win-id]") ?? a?.closest("[role=dialog]");
        const ctx = a && a !== document.body ? C.contextChain(nn(a)).map(C.contextWords) : [];
        this.say([win ? C.contextWords(nn(win)) : document.title, ...ctx.filter((c) => !win || c !== C.contextWords(nn(win)))].filter(Boolean).join(". "), "cursor", true);
        return;
      }
      case "readAll": {
        this.refresh();
        const start = Math.max(0, this.idx);
        this.reading = true;
        const chunk = this.items.slice(start).map(C.itemText).filter(Boolean);
        // queue every item (polite) so Ctrl stops it; captions show the whole run
        chunk.forEach((t, i) => { if (this.reading) this.say(t, "cursor", i === 0); });
        return;
      }
      case "faster": return this.o.onRate(1);
      case "slower": return this.o.onRate(-1);
      case "help": return this.o.onHelp();
    }
  }
}
