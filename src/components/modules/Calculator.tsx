"use client";

import { useState } from "react";
import { evaluate } from "@/lib/calc";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

const KEYS = [
  ["7", "8", "9", "/", "sqrt("],
  ["4", "5", "6", "*", "^"],
  ["1", "2", "3", "-", "("],
  ["0", ".", "%", "+", ")"],
];

/** PR-09: the same evaluator the palette uses — no second implementation to drift. */
export default function CalculatorModule(_: ModuleProps) {
  const shell = useShell();
  const [expr, setExpr] = useState("");
  const [history, setHistory] = useState<{ expr: string; text: string }[]>([]);
  const result = evaluate(expr);

  const commit = () => {
    if (!result.ok || !expr.trim()) return;
    setHistory((h) => [{ expr, text: result.text }, ...h].slice(0, 40));
    setExpr(result.text);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, padding: 10, gap: 8 }}>
      <input className="fs-input fs-mono" style={{ fontSize: 16, padding: 10 }} value={expr} autoFocus
        aria-label="Expression"
        onChange={(e) => setExpr(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        placeholder="2+2*3   ·   sqrt(144)   ·   12 cm to in   ·   0xff" />
      <div className="fs-row" style={{ justifyContent: "space-between" }}>
        <span className="fs-mono" style={{ fontSize: 18, color: result.ok ? "var(--fs-text)" : "#ff9b9b" }}>
          {expr ? (result.ok ? `= ${result.text}` : result.text) : "—"}
        </span>
        {result.detail ? <Badge tone="info">{result.detail}</Badge> : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
        {KEYS.flat().map((k) => (
          <Btn key={k} variant="ghost" onClick={() => setExpr((e) => e + k)}>{k}</Btn>
        ))}
        <Btn variant="danger" onClick={() => setExpr("")}>C</Btn>
        <Btn variant="ghost" onClick={() => setExpr((e) => e.slice(0, -1))}>⌫</Btn>
        <Btn variant="ghost" onClick={() => setExpr((e) => `${e}pi`)}>π</Btn>
        <Btn variant="ghost" onClick={() => void shell.copy(result.text, "calculator")}>Copy</Btn>
        <Btn variant="primary" onClick={commit}>=</Btn>
      </div>

      <div className="fs-scroll" style={{ flex: 1, minHeight: 0 }}>
        {history.map((h, i) => (
          <button key={i} className="fs-list-item" style={{ width: "100%", border: 0, background: "none", color: "inherit", textAlign: "left" }}
            onClick={() => setExpr(h.expr)}>
            <span className="fs-dim fs-mono" style={{ flex: 1, fontSize: 11.5 }}>{h.expr}</span>
            <span className="fs-mono" style={{ fontSize: 11.5 }}>= {h.text}</span>
          </button>
        ))}
      </div>

      <div className="fs-dim" style={{ fontSize: 10.5 }}>
        Recursive-descent parser, no eval(). Rounding policy: 12 significant digits, trailing zeros trimmed —
        stated rather than implied, because the palette must agree with this window exactly.
      </div>
    </div>
  );
}
