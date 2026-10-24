"use client";
/**
 * TT59 Writer "Spelling" pane (F7) — Word's Editor/Spelling pane: the current issue in context, suggestions, Change /
 * Change All / Ignore Once / Ignore All / Add to Dictionary, repeated-word Delete, and the proofing options.
 * All checking runs on this device (src/lib/spell/hunspell.ts); see src/lib/office/wordspell.ts for what is checked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Btn } from "../../ui";
import { fz } from "@/lib/uiscale";
import type { Speller } from "@/lib/spell/hunspell";
import type { SpellIssue } from "@/lib/office/wordspell";
import type { SpellMode } from "@/lib/spell/client";

export interface SpellPanelProps {
  issues: SpellIssue[]; idx: number; setIdx: (i: number) => void; sp: Speller | null; loading: string;
  context: (i: SpellIssue) => { before: string; word: string; after: string };
  mode: SpellMode; setMode: (m: SpellMode) => void; skipUpper: boolean; setSkipUpper: (v: boolean) => void;
  onGo: (i: SpellIssue) => void; onChange: (i: SpellIssue, to: string) => void; onChangeAll: (i: SpellIssue, to: string) => void;
  onIgnoreOnce: (i: SpellIssue) => void; onIgnoreAll: (i: SpellIssue) => void; onAdd: (i: SpellIssue) => void;
  userWords: string[]; onRemoveWord: (w: string) => void;
}

export default function SpellPanel(p: SpellPanelProps) {
  const n = p.issues.length;
  const i = n ? Math.min(Math.max(p.idx, 0), n - 1) : -1;
  const cur = i >= 0 ? p.issues[i] : null;
  const sugs = useMemo(() => (cur && p.sp && cur.kind === "spell" ? p.sp.suggest(cur.word, 8) : []), [cur, p.sp]);
  const [pick, setPick] = useState<{ key: string; v: string } | null>(null);
  const curKey = cur ? `${cur.pid}:${cur.off}:${cur.word}` : "";
  const to = pick && pick.key === curKey ? pick.v : (cur?.kind === "repeat" ? "" : sugs[0] ?? "");
  const [showWords, setShowWords] = useState(false);
  const ctx = cur ? p.context(cur) : null;
  // TT59: the button just pressed can disappear (last issue fixed, issue kind changed) — keep keyboard focus inside the
  // pane instead of letting it fall to <body>, where Writer's shortcuts (Ctrl+S, F7) no longer reach
  const rootEl = useRef<HTMLDivElement>(null);
  useEffect(() => { const a = document.activeElement; if ((!a || a === document.body) && rootEl.current) rootEl.current.focus({ preventScroll: true }); }, [curKey, n]);
  return (
    <div ref={rootEl} tabIndex={-1} data-testid="writer-spell-panel" style={{ outline: "none",  display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="wside-h">Spelling</div>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: fz(12) }}>Check spelling as you type
        <select className="fs-select" aria-label="Spell checking" value={p.mode} onChange={(e) => p.setMode(e.target.value as SpellMode)}>
          <option value="fusion">Fusion (private, on this device)</option>
          <option value="browser">Browser built-in</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label style={{ fontSize: fz(12) }}><input type="checkbox" checked={p.skipUpper} onChange={(e) => p.setSkipUpper(e.target.checked)} /> Ignore words in UPPERCASE</label>
      {p.mode !== "fusion" ? <div style={{ opacity: 0.8 }}>{p.mode === "browser" ? "The browser's own checker underlines words; this pane needs Fusion checking." : "Spell checking is off."}</div>
        : p.loading ? <div role="status">{p.loading}</div>
        : !cur ? <div role="status" data-testid="spell-count">Spelling check complete. No issues found.</div>
        : <>
          <div role="status" data-testid="spell-count">Issue {i + 1} of {n}{cur.where ? <> &middot; <span data-testid="spell-where">in {cur.where}</span></> : null}</div>
          <div style={{ fontWeight: 600 }}>{cur.kind === "repeat" ? "Repeated word" : "Not in dictionary"}</div>
          <div className="wspell-ctx" data-testid="spell-context" style={{ fontSize: fz(13), lineHeight: 1.5, padding: 6, border: "1px solid var(--fs-border)", borderRadius: 6, background: "var(--fs-field, rgba(6,10,22,.7))", color: "var(--fs-text)", wordBreak: "break-word" }}>
            {ctx!.before}<mark data-testid="spell-word" style={{ background: "transparent", textDecoration: cur.kind === "repeat" ? "underline double #1f5fbf" : "underline wavy #d0021b", color: "inherit" }}>{ctx!.word}</mark>{ctx!.after}
          </div>
          {cur.kind === "spell" && <>
            <div style={{ fontSize: fz(12) }}>Suggestions</div>
            <div role="listbox" aria-label="Suggestions" data-testid="spell-suggestions" style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: fz(190), overflow: "auto" }}>
              {sugs.length ? sugs.map((s) => <button key={s} role="option" aria-selected={to === s} className={`wspell-sug${to === s ? " on" : ""}`}
                onClick={() => setPick({ key: curKey, v: s })} onDoubleClick={() => p.onChange(cur, s)}>{s}</button>)
                : <div style={{ opacity: 0.75 }}>(no suggestions)</div>}
            </div>
            <input className="fs-input" aria-label="Change to" value={to} onChange={(e) => setPick({ key: curKey, v: e.target.value })} />
          </>}
          <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
            {cur.kind === "spell" ? <>
              <Btn disabled={!to} onClick={() => p.onChange(cur, to)}>Change</Btn>
              <Btn variant="ghost" disabled={!to} onClick={() => p.onChangeAll(cur, to)}>Change All</Btn>
            </> : <Btn onClick={() => p.onChange(cur, "")}>Delete repeated word</Btn>}
            <Btn variant="ghost" onClick={() => p.onIgnoreOnce(cur)}>Ignore Once</Btn>
            {cur.kind === "spell" && <><Btn variant="ghost" onClick={() => p.onIgnoreAll(cur)}>Ignore All</Btn>
              <Btn variant="ghost" onClick={() => p.onAdd(cur)}>Add to Dictionary</Btn></>}
          </div>
          <div className="fs-row" style={{ gap: 4 }}>
            <Btn variant="ghost" disabled={n < 2} onClick={() => { const j = (i - 1 + n) % n; p.setIdx(j); p.onGo(p.issues[j]); }}>Previous issue</Btn>
            <Btn variant="ghost" disabled={n < 2} onClick={() => { const j = (i + 1) % n; p.setIdx(j); p.onGo(p.issues[j]); }}>Next issue</Btn>
            <Btn variant="ghost" onClick={() => p.onGo(cur)}>Show</Btn>
          </div>
        </>}
      <button className="wspell-link" onClick={() => setShowWords(!showWords)} aria-expanded={showWords}>Your dictionary ({p.userWords.length})</button>
      {showWords && <div role="list" aria-label="Your dictionary" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {p.userWords.length ? p.userWords.map((w) => <div role="listitem" key={w} className="fs-row" style={{ gap: 4, alignItems: "center" }}><span style={{ flex: 1 }}>{w}</span><Btn variant="ghost" onClick={() => p.onRemoveWord(w)}>Remove<span className="sr-only"> {w}</span></Btn></div>)
          : <div style={{ opacity: 0.75 }}>No words added yet.</div>}
      </div>}
      <div style={{ fontSize: fz(11), opacity: 0.7 }}>English (US) dictionary: SCOWL / Hunspell en_US (MIT/BSD-style licence). Checked on this device; nothing is sent anywhere.</div>
    </div>
  );
}
