"use client";
import { useEffect, useMemo, useState } from "react";

/** Results are labelled by the complete input. A delayed response from an old
 * worker cannot display stale matches. No synchronous regex backtracking in a
 * render, including patterns restored from untrusted saved-search files. */
export function useSearchFilter<T extends { title: string; snippet: string }>(hits: T[], pattern: string, regex: boolean, caseSensitive: boolean) {
  const key = useMemo(() => JSON.stringify([pattern, caseSensitive, hits.map(hit => `${hit.title} ${hit.snippet}`)]), [hits, pattern, caseSensitive]);
  const [result, setResult] = useState<{ key: string; indices: number[]; error: string }>({ key: "", indices: [], error: "" });
  useEffect(() => {
    if (!pattern || !regex) return;
    let active = true, worker: Worker | null = null, budget: ReturnType<typeof setTimeout> | undefined;
    const settle = (indices: number[], error = "") => {
      if (!active) return;
      active = false; if (budget) clearTimeout(budget); worker?.terminate();
      setResult({ key, indices, error });
    };
    // Typing a pattern is one job after a short debounce, not one worker per key.
    const debounce = setTimeout(() => {
      try {
        worker = new Worker("/workers/find-filter.js");
        // Metadata pages accumulate: retain the worker's 50-text message cap,
        // but run ALL pages in batches under ONE shared one-second budget.
        const texts = hits.map(hit => `${hit.title} ${hit.snippet}`), indices: number[] = [];
        let offset = 0, batchSize = 0;
        const send = () => {
          const batch = texts.slice(offset, offset + 50); batchSize = batch.length;
          worker!.postMessage({ pattern, caseSensitive, texts: batch });
        };
        worker.onmessage = event => {
          if (!active) return;
          const data = event.data as { indices?: number[]; error?: string };
          if (data.error) { settle([], `Invalid pattern: ${data.error}`); return; }
          if (!Array.isArray(data.indices) || new Set(data.indices).size !== data.indices.length || !data.indices.every(i => Number.isInteger(i) && i >= 0 && i < batchSize)) { settle([], "Filter returned an invalid result"); return; }
          indices.push(...data.indices.map(i => offset + i)); offset += batchSize;
          if (offset < texts.length) send(); else settle(indices);
        };
        worker.onerror = event => { event.preventDefault(); settle([], "Regex filter worker unavailable"); };
        budget = setTimeout(() => settle([], "Regex filter timed out after 1 second. Simplify the pattern."), 1000);
        send();
      } catch { settle([], "Regex filtering is unavailable in this browser"); }
    }, 150);
    return () => { active = false; clearTimeout(debounce); if (budget) clearTimeout(budget); worker?.terminate(); };
  }, [key, hits, pattern, regex, caseSensitive]);
  if (!pattern) return { hits, error: "", busy: false };
  if (!regex) {
    const literal = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "u" : "iu");
    return { hits: hits.filter(hit => literal.test(`${hit.title} ${hit.snippet}`)), error: "", busy: false };
  }
  if (result.key !== key) return { hits: [] as T[], error: "", busy: true };
  const matched = new Set(result.indices);
  return { hits: hits.filter((_, i) => matched.has(i)), error: result.error, busy: false };
}
