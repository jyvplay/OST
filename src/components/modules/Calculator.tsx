"use client";
import { useEffect, useState } from "react";
import { fz } from "@/lib/uiscale";
import { evaluate } from "@/lib/calc";
import { evaluateProgrammer } from "@/lib/programmer";
import {
  appendCalculatorHistory, CALC_HISTORY_KEEP, CALC_HISTORY_LIMIT, CALC_HISTORY_PREFIX,
  deleteCalculatorHistory, readCalculatorHistory, type CalculatorEntry,
} from "@/lib/calc-history";
import { privacy } from "@/lib/privacy/session";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

const KEYS = [
  ["7", "8", "9", "/", "sqrt("],
  ["4", "5", "6", "*", "^"],
  ["1", "2", "3", "-", "("],
  ["0", ".", "%", "+", ")"],
];
const PROGRAMMER_KEYS = [
  ["7", "8", "9", "/", "&", "|"],
  ["4", "5", "6", "*", "^", "~"],
  ["1", "2", "3", "-", "<<", ">>"],
  ["0", "0x", "0b", "0o", "+", "%"],
  ["A", "B", "C", "D", "E", "F"],
  ["(", ")"],
];

type DisplayEntry = CalculatorEntry & { saved: boolean };
const HISTORY_EVENT = "fusion:calculator-history-changed";
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** Participating same-origin tabs serialize pruning/clearing; distinct entry keys also protect concurrent appends. */
const withHistoryLock = async <T,>(fn: () => T | Promise<T>): Promise<T> => {
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") return navigator.locks.request("fusion.calculator.history.v1", fn);
  return fn();
};
const mergeSaved = (current: DisplayEntry[], saved: CalculatorEntry[]): DisplayEntry[] => {
  const ids = new Set(saved.map((entry) => entry.id));
  return [...current.filter((entry) => !entry.saved && !ids.has(entry.id)), ...saved.map((entry) => ({ ...entry, saved: true }))]
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, CALC_HISTORY_LIMIT);
};

/** Scientific/palette calculations keep the original evaluator; programmer integers have explicit fixed-width semantics. */
export default function CalculatorModule(_: ModuleProps) {
  const shell = useShell();
  const [expr, setExpr] = useState("");
  const [mode, setMode] = useState<"scientific" | "programmer">("scientific");
  const [width, setWidth] = useState(32);
  const [signed, setSigned] = useState(false);
  const [history, setHistory] = useState<DisplayEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [keep, setKeep] = useState(false);
  const [amnesic, setAmnesic] = useState(false);
  const [status, setStatus] = useState("");
  const standard = mode === "scientific" ? evaluate(expr) : null;
  const programmer = mode === "programmer" ? evaluateProgrammer(expr, width, signed) : null;
  const result = standard ?? programmer!;

  useEffect(() => {
    const refresh = () => {
      if (privacy.status().amnesic) { setAmnesic(true); setKeep(false); return; }
      setAmnesic(false);
      try {
        const saved = readCalculatorHistory(window.localStorage);
        setHistory((current) => mergeSaved(current, saved));
        setKeep(window.localStorage.getItem(CALC_HISTORY_KEEP) === "1");
      } catch { setStatus("Browser history is unreadable. It was not overwritten; use Delete history only if you want to discard it."); }
    };
    const unsub = privacy.subscribe((s) => { setAmnesic(s.amnesic); });
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === CALC_HISTORY_KEEP || event.key.startsWith(CALC_HISTORY_PREFIX)) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(HISTORY_EVENT, refresh);
    return () => { unsub(); window.removeEventListener("storage", onStorage); window.removeEventListener(HISTORY_EVENT, refresh); };
  }, []);

  const commit = () => {
    if (!result.ok || !expr.trim()) return;
    const entry: CalculatorEntry = { id: id(), expr, text: result.text, mode, width, signed, at: Date.now() };
    setHistory((items) => [{ ...entry, saved: false }, ...items].slice(0, CALC_HISTORY_LIMIT));
    setExpr(result.text);
    if (!keep || privacy.status().amnesic) return;
    void withHistoryLock(() => {
      if (privacy.status().amnesic || window.localStorage.getItem(CALC_HISTORY_KEEP) !== "1") throw new Error("Local history is not enabled");
      appendCalculatorHistory(window.localStorage, entry);
      return readCalculatorHistory(window.localStorage);
    }).then((saved) => {
      setHistory((items) => mergeSaved(items, saved));
      window.dispatchEvent(new Event(HISTORY_EVENT));
      setStatus("Calculation saved in this browser's local storage.");
    }).catch(() => setStatus("Could not confirm browser-history storage; the calculation remains in this window and might already have been stored."));
  };

  const toggleKeep = () => {
    if (privacy.status().amnesic) { setStatus("Amnesic sessions do not save calculator history to the browser."); return; }
    const next = !keep;
    void withHistoryLock(() => {
      // Do not enable persistence on top of malformed saved data.
      if (next) readCalculatorHistory(window.localStorage);
      window.localStorage.setItem(CALC_HISTORY_KEEP, next ? "1" : "0");
    }).then(() => { setKeep(next); window.dispatchEvent(new Event(HISTORY_EVENT)); setStatus(next ? "Future calculations will be saved locally, unencrypted." : "New calculations will stay in this window; older saved history remains until deleted."); })
      .catch(() => setStatus("Could not change browser-history storage; the previous preference is unchanged."));
  };
  const clearHistory = () => {
    const inAmnesia = privacy.status().amnesic;
    const prompt = inAmnesia ? "Clear this window's session history? Browser storage will not be changed." : "Delete calculator history from this window and this browser?";
    if (!window.confirm(prompt)) return;
    if (inAmnesia) { setHistory([]); setStatus("Session history cleared; browser storage was not changed."); return; }
    void withHistoryLock(() => deleteCalculatorHistory(window.localStorage))
      .then(() => { setHistory([]); window.dispatchEvent(new Event(HISTORY_EVENT)); setStatus("Calculator history deleted from this browser."); })
      .catch(() => setStatus("Could not fully delete browser history; some records may remain."));
  };
  const visible = history.filter((entry) => `${entry.expr} ${entry.text}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflowY: "auto", padding: 10, gap: 8 }}>
      <div className="fs-row" role="group" aria-label="Calculator mode" style={{ flexWrap: "wrap" }}>
        <Btn variant={mode === "scientific" ? "primary" : "ghost"} aria-pressed={mode === "scientific"} onClick={() => setMode("scientific")}>Scientific</Btn>
        <Btn variant={mode === "programmer" ? "primary" : "ghost"} aria-pressed={mode === "programmer"} onClick={() => setMode("programmer")}>Programmer</Btn>
        {mode === "programmer" ? <>
          <label>Word size <select className="fs-select" aria-label="Word size" value={width} onChange={(e) => setWidth(Number(e.target.value))} style={{ width: "auto" }}>
            {[8, 16, 32, 64].map((bits) => <option key={bits} value={bits}>{bits}-bit</option>)}
          </select></label>
          <label><input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} /> Signed</label>
        </> : null}
      </div>
      <input className="fs-input fs-mono" style={{ fontSize: fz(16), padding: 10 }} value={expr} autoFocus
        aria-label="Expression" maxLength={mode === "programmer" ? 512 : undefined}
        onChange={(e) => setExpr(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        placeholder={mode === "programmer" ? "0xff & 0x0f  ·  1 << 7  ·  ~0" : "2+2*3   ·   sqrt(144)   ·   12 cm to in   ·   0xff"} />
      <div className="fs-row" style={{ justifyContent: "space-between" }}>
        <span data-testid="calculator-result" className="fs-mono" style={{ fontSize: fz(18), color: result.ok ? "var(--fs-text)" : "var(--fs-bad-text, #ff9b9b)" }}>
          {expr ? (result.ok ? `= ${result.text}` : result.text) : "—"}
        </span>
        {standard?.detail ? <Badge tone="info">{standard.detail}</Badge> : null}
      </div>
      {programmer?.ok ? <div data-testid="programmer-bases" className="fs-mono" style={{ overflowWrap: "anywhere", fontSize: fz(11) }}>
        <div>HEX {programmer.hex.toUpperCase()}</div><div>OCT {programmer.oct}</div><div>BIN {programmer.bin}</div>
      </div> : null}

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${mode === "programmer" ? 6 : 5}, 1fr)`, gap: 4 }}>
        {(mode === "programmer" ? PROGRAMMER_KEYS : KEYS).flat().map((k) => (
          <Btn key={k} variant="ghost" onClick={() => setExpr((value) => value + k)}>{k}</Btn>
        ))}
        <Btn variant="danger" onClick={() => setExpr("")}>{mode === "programmer" ? "Clear" : "C"}</Btn>
        <Btn variant="ghost" onClick={() => setExpr((value) => value.slice(0, -1))}>⌫</Btn>
        {mode === "scientific" ? <Btn variant="ghost" onClick={() => setExpr((value) => `${value}pi`)}>π</Btn> : null}
        <Btn variant="ghost" onClick={() => void shell.copy(result.text, "calculator")}>Copy</Btn>
        <Btn variant="primary" onClick={commit}>=</Btn>
      </div>

      <div className="fs-row" style={{ flexWrap: "wrap" }}>
        <input className="fs-input" style={{ flex: "1 1 10em", width: "auto" }} aria-label="Filter calculator history" placeholder="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Btn variant={keep ? "primary" : "ghost"} aria-pressed={keep} disabled={amnesic} onClick={toggleKeep}>{keep ? "Stop saving history" : "Keep new history locally"}</Btn>
        <Btn variant="ghost" onClick={clearHistory}>Delete history</Btn>
      </div>
      <div className="fs-scroll" style={{ flex: "1 0 80px", minHeight: fz(80) }} aria-label="Calculator history">
        {visible.map((h) => (
          <button key={h.id} data-testid="calculator-history-entry" className="fs-list-item" style={{ width: "100%", border: 0, background: "none", color: "inherit", textAlign: "left" }}
            onClick={() => { setMode(h.mode); setWidth(h.width); setSigned(h.signed); setExpr(h.expr); }}>
            <span className="fs-dim fs-mono" style={{ flex: 1, fontSize: fz(11.5), overflowWrap: "anywhere" }}>{h.expr}</span>
            <span className="fs-mono" style={{ fontSize: fz(11.5) }}>= {h.text}</span>
            {h.saved ? <Badge>local</Badge> : null}
          </button>
        ))}
      </div>
      {status ? <div role="status" style={{ fontSize: fz(10.5) }}>{status}</div> : null}
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>
        {mode === "programmer"
          ? "Fixed-width wrapping integers; ^ means XOR. Signed division truncates toward zero; signed right shift extends the sign. Shift counts are word-sized and, after wrapping, must be nonnegative and smaller than the word size."
          : "Scientific mode and the palette share a no-eval parser. Rounding: 12 significant digits, trailing zeros trimmed."}
        {" "}History starts in memory. Optional browser history is unencrypted, local to this browser and not in global Search or backups; amnesic sessions never save it.
      </div>
    </div>
  );
}
