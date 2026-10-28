/** Original TT100 geometry: a spine with stepped leaves, a pinwheel of tiles, and staggered depth lanes.
 * Authored here, not imported/traced. Familiar concepts may coincide with other visual languages; uniqueness cannot be proven globally. */
export default function FileViewGlyph({view}:{view:'list'|'grid'|'column'}){
 return <svg data-view-glyph={view} viewBox="0 0 28 28" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
 {view==='list'?<><path d="M5 4v20M5 7h5l2-2h11M5 14h7l2-2h9M5 21h9l2-2h7"/><path d="M12 8h8M14 15h6M16 22h4" opacity=".55"/></>:view==='grid'?<><path d="M5 5h8v6H5zM17 5h6v8h-6zM15 17h8v6h-8zM5 15h6v8H5z"/><path d="M12 14h4M14 12v4" opacity=".55"/></>:<><path d="M4 7h5v17H4zM12 4h5v17h-5zM20 7h5v17h-5z"/><path d="M5 11h3M13 8h3M21 11h3M9 15h3M17 15h3" opacity=".6"/></>}
 </svg>;
}
