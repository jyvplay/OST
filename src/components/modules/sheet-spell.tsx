"use client";
/**
 * TT59 Spreadsheet spelling bar (Review ▸ Spelling, F7): the current issue with its cell, suggestions, Change /
 * Change All / Ignore Once / Ignore All / Add to Dictionary / Next. Checking: src/lib/formula/sheetspell.ts.
 */
import { useMemo, useState } from "react";
import { Btn } from "../ui";
import { fz } from "@/lib/uiscale";
import type { Sheet } from "@/lib/formula/engine";
import type { Speller } from "@/lib/spell/hunspell";
import { readSkipUpper } from "@/lib/spell/client";
import { cellIssueKey, sheetSpellIssues, type CellSpellIssue, type SheetSpellOpts } from "@/lib/formula/sheetspell";
import { rangeA1 } from "@/lib/formula/sheetops";
import { a1 } from "@/lib/formula/engine";

type Scope = { c0: number; r0: number; c1: number; r1: number } | null;
export default function SheetSpellBar(p: {
  sheet: Sheet; rev: number; speller: Speller | null; err: string; scope: Scope; ignore: { all: Set<string>; once: Set<string> }; gen: number;
  idx: number; setIdx: (i: number) => void; onFix: (x: CellSpellIssue, v: string) => void; onShow: (x: CellSpellIssue) => void;
  onChangeAll: (x: CellSpellIssue, v: string, o: SheetSpellOpts) => void; onIgnore: (all: boolean, v: string) => void; onAdd: (w: string) => void; onClose: () => void;
}) {
  const { sheet, rev, speller, scope, ignore, gen } = p;
  const opts = useMemo<SheetSpellOpts>(() => ({ skipUpper: readSkipUpper(), ignoreAll: ignore.all, ignoreOnce: ignore.once, range: scope ?? undefined }), [ignore, scope]);
  // rev / gen: the workbook or the user dictionary changed — recheck
  const list = useMemo(() => (speller ? sheetSpellIssues(sheet, speller, opts) : []), [sheet, speller, opts, rev, gen]); // eslint-disable-line react-hooks/exhaustive-deps
  const i = list.length ? Math.min(p.idx, list.length - 1) : -1; const cur = i >= 0 ? list[i] : null;
  const key = cur ? cellIssueKey(cur) : "";
  const sugs = useMemo(() => (cur && speller && cur.kind === "spell" ? speller.suggest(cur.word, 8) : []), [cur, speller]);
  const [typed, setTyped] = useState<{ key: string; v: string } | null>(null);
  const to = typed && typed.key === key ? typed.v : cur?.kind === "repeat" ? "" : sugs[0] ?? "";
  const where = cur ? `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(cur.sheet) ? cur.sheet : `'${cur.sheet.replace(/'/g, "''")}'`}!${a1(cur.col, cur.row)}` : "";
  const word = cur ? cur.word.replace(/’/g, "'") : "";
  return (
    <div className="fs-row" role="group" aria-label="Spelling" data-testid="sheet-spell-panel" style={{ gap: 8, padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5), flexWrap: "wrap", alignItems: "center" }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); p.onClose(); } }}>
      <b>Spelling{scope ? <> in <span className="fs-mono">{rangeA1(scope)}</span></> : <> on {sheet.name}</>}</b>
      {p.err ? <span role="status">{p.err}</span> : !speller ? <span role="status">Loading the English (US) dictionary…</span>
        : !cur ? <span role="status" data-testid="sheet-spell-status">Spelling check complete. No issues found.</span>
        : <>
          <span role="status" data-testid="sheet-spell-status">{cur.kind === "repeat" ? "Repeated word" : "Not in dictionary"} {i + 1} of {list.length}: <b data-testid="sheet-spell-word">{cur.word.trim()}</b> in <span className="fs-mono">{where}</span></span>
          {cur.kind === "spell" ? <>
            <select className="fs-input" aria-label="Suggestions" data-testid="sheet-spell-suggestions" value={sugs.includes(to) ? to : ""} onChange={(e) => setTyped({ key, v: e.target.value })} style={{ width: 150 }}>
              {!sugs.includes(to) ? <option value="">{sugs.length ? "(typed)" : "(no suggestions)"}</option> : null}
              {sugs.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <input className="fs-input" aria-label="Change to" value={to} onChange={(e) => setTyped({ key, v: e.target.value })} style={{ width: 130 }} />
            <Btn variant="primary" disabled={!to} onClick={() => p.onFix(cur, to)}>Change</Btn>
            <Btn variant="ghost" disabled={!to} onClick={() => p.onChangeAll(cur, to, opts)}>Change All</Btn>
            <Btn variant="ghost" onClick={() => p.onIgnore(true, word)}>Ignore All</Btn>
            <Btn variant="ghost" onClick={() => p.onAdd(word)}>Add to Dictionary</Btn>
          </> : <Btn variant="primary" onClick={() => p.onFix(cur, "")}>Delete repeated word</Btn>}
          <Btn variant="ghost" onClick={() => p.onIgnore(false, key)}>Ignore Once</Btn>
          <Btn variant="ghost" disabled={list.length < 2} onClick={() => { const j = (i + 1) % list.length; p.setIdx(j); p.onShow(list[j]); }}>Next</Btn>
          <Btn variant="ghost" onClick={() => p.onShow(cur)}>Show cell</Btn>
        </>}
      <Btn variant="ghost" onClick={p.onClose}>Close</Btn>
    </div>
  );
}
