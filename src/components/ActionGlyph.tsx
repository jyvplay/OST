import type { CSSProperties } from "react";

/** Original, single-stroke concept marks. Decorative; the containing control
 * supplies its full visible or accessible name. No font, image or network fetch. */
export default function ActionGlyph({ name, size = 18, style }: { name: "edit" | "bell" | "snooze" | "calendar" | "task" | "remove" | "arrow"; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0, ...style }}>
    {name === "edit" ? <><path d="m5 16 1 4 4-1L20 9l-5-5Z" /><path d="m12 7 5 5M4 21h16" /></> : null}
    {name === "bell" ? <><path d="M6 10a6 6 0 0 1 12 0v5l2 3H4l2-3ZM10 21h4M12 2v2" /><path d="m2 8 1-3M22 8l-1-3" /></> : null}
    {name === "snooze" ? <><circle cx="10" cy="13" r="8" /><path d="M10 8v5l3 2M16 2h6l-6 5h6" /></> : null}
    {name === "calendar" ? <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 2v6M17 2v6M3 11h18m-13 4 2 2 5-3" /></> : null}
    {name === "task" ? <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="m7 12 3 3 7-7" /></> : null}
    {name === "arrow" ? <path d="M3 12h18m-7-6 7 6-7 6" /> : null}
    {name === "remove" ? <><path d="M4 6h16M9 3h6M6 6l1 15h10l1-15M10 10v7M14 10v7" /></> : null}
  </svg>;
}
