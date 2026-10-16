// TT22: hook-free so the Node a11y-unit suite can import it.
/** Automatic font colour for a filled cell: WCAG relative luminance of a #rgb/#rrggbb fill → white or ink. */
export function autoInk(fill: string | undefined): string | undefined {
  if (!fill) return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fill.trim());
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
  // white or black, whichever contrasts more: with pure black the worse of the two is still ≥4.58:1 for ANY fill
  // (a near-black like #111827 drops mid-greys such as #777777 below 4.5:1 — the a11y-unit test caught that)
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? "#ffffff" : "#000000";
}
