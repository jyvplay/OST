"use client";
/**
 * TT80 — one banner for every creative app (Writer, Spreadsheet, Slides, PDF, Vector, Image Editor, Whiteboard, Tables,
 * Notes, Planner, Contacts, Media, Capture, Lens, Photos, Books, Editor).
 *
 *   ┌ menu row ─ Keep  Tweak  Put  Look  Glance  Polish ……………………………… status chips ┐
 *   └ tool strip ‹ [Keep: New Open Save …] │ [Tweak: Undo Redo] │ [Look: B I U …] … › ┘
 *
 * - The tool strip is ONE line. It never wraps; when the window is narrow it scrolls sideways (wheel, touch, keyboard
 *   focus or the ‹ › buttons) with a fade at the clipped edge, so the document keeps its height.
 * - Each top-level menu lists EVERY control of its group in order, read from the live controls when it opens (labels,
 *   pressed / checked / disabled state, the options of short lists). There is one source of truth: a menu item clicks
 *   the very control it mirrors, so a command can never behave differently from its toolbar button, and a control
 *   scrolled out of view is still one click away.
 * - The menu names are Fusion's own (src/lib/banner-core.ts) and are published per window to the shell menu bar
 *   (Art layout), which shows the focused app's menus beside its own Frame / Guide.
 */
import { Children, isValidElement, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { fz } from "@/lib/uiscale";
import { MENU_ITEM_CAP, type BannerMenu } from "@/lib/banner-core";
import { MenuButton, type MenuItem } from "./chrome-bits";
import { useShell } from "./shell-context";
import { layoutOf } from "@/lib/layout-core";

/* ------------------------------------------------------------------ per-window store of menu names (shell menu bar) */
const names = new Map<string, readonly string[]>();
const subs = new Set<() => void>();
const EMPTY: readonly string[] = [];
export const bannerStore = {
  subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; },
  get(win: string | null | undefined) { return (win && names.get(win)) || EMPTY; },
  set(win: string, list: readonly string[]) { const cur = names.get(win); if (cur && cur.join("|") === list.join("|")) return; names.set(win, list); subs.forEach((f) => f()); },
  del(win: string) { if (names.delete(win)) subs.forEach((f) => f()); },
};
export function useBannerMenus(win: string | null | undefined): readonly string[] {
  return useSyncExternalStore(bannerStore.subscribe, () => bannerStore.get(win), () => EMPTY);
}

/* ------------------------------------------------------------------ mirroring live controls into menu items */
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** the words a person would say for a control: its visible text when that is a word, else its accessible name,
 *  else its tooltip (the last is only reached for glyph buttons, which have no text a screen reader can read) */
export function controlLabel(el: HTMLElement): string {
  const text = clean(el.innerText || el.textContent);
  const aria = clean(el.getAttribute("aria-label"));
  const title = clean(el.getAttribute("title"));
  if (el instanceof HTMLInputElement && el.type === "checkbox") return aria || clean(el.closest("label")?.textContent) || title;
  const wordy = text.length >= 3 && /[A-Za-z\u00C0-\u024F]{2}/.test(text);
  if (wordy) return text;                      // "New", "Bold", "1. Numbering" — a tooltip is not a better name
  return aria || title || text;
}
function setNativeValue(el: HTMLSelectElement, v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (set) set.call(el, v); else el.value = v;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
const reveal = (el: HTMLElement) => { el.scrollIntoView({ block: "nearest", inline: "nearest" }); el.focus(); };
/** short lists (≤ this many choices) are listed inline in the menu; longer ones get a "Name…" item that opens the list */
export const INLINE_OPTIONS = 12;


/** every group with this name, in strip order, as one menu (a name may appear twice: essentials early, the rest late) */
export function mirrorGroups(groups: Iterable<Element>, inlineOptions = INLINE_OPTIONS): MenuItem[] {
  const out: MenuItem[] = [];
  for (const g of groups) { const part = mirrorGroup(g, inlineOptions); if (part.length && out.length) out.push({ label: "", separator: true }); out.push(...part); }
  return out;
}
export function mirrorGroup(group: Element | null | undefined, inlineOptions = INLINE_OPTIONS): MenuItem[] {
  if (!group) return [];
  return mirrorControls(group.querySelectorAll<HTMLElement>("button, select, input, label"), inlineOptions, group);
}
/** TT110: the same mirroring for an explicit list of controls — used by the "More tools" menu,
 *  which lists exactly the controls that stepped aside, not their whole group. */
export function mirrorControls(controls: Iterable<HTMLElement>, inlineOptions = INLINE_OPTIONS, group?: Element): MenuItem[] {
  const out: MenuItem[] = [];
  const sep = () => { if (out.length && !out[out.length - 1].separator) out.push({ label: "", separator: true }); };
  for (const el of controls) {
    // a <label> styled as a button around a hidden file input ("Open…", "Picture…") is a command of its own
    if (el instanceof HTMLLabelElement) {
      const file = el.querySelector<HTMLInputElement>("input[type=file]");
      if (file && !el.closest("[role=menu],[data-banner-skip]")) { const label = clean(el.textContent) || clean(file.getAttribute("aria-label")); if (label) out.push({ label, disabled: file.disabled, onSelect: () => file.click() }); }
      continue;
    }
    if (el.closest("[hidden],[role=menu],[data-banner-skip]") || el.hidden) continue;
    if (el instanceof HTMLInputElement && (el.type === "file" || el.type === "hidden")) continue;
    if (group && el.getAttribute("aria-haspopup") === "menu" && el.closest("[data-banner-group]") !== group) continue;
    if (el instanceof HTMLButtonElement) {
      const label = controlLabel(el); if (!label) continue;
      const pressed = el.getAttribute("aria-pressed");
      out.push({ label, disabled: el.disabled, checked: pressed === null ? undefined : pressed === "true", hint: clean(el.dataset.hint) || undefined, onSelect: () => el.click() });
    } else if (el instanceof HTMLSelectElement) {
      const name = clean(el.getAttribute("aria-label")) || clean(el.title) || "Choose";
      const opts = [...el.options].filter((o) => !o.disabled && !o.hidden);
      if (opts.length && opts.length <= inlineOptions) {
        sep(); out.push({ label: name, heading: true });
        for (const o of opts) out.push({ label: clean(o.text) || o.value, checked: o.selected, disabled: el.disabled, onSelect: () => setNativeValue(el, o.value) });
        sep();
      } else out.push({ label: `${name}…`, disabled: el.disabled, onSelect: () => { reveal(el); try { (el as HTMLSelectElement & { showPicker?: () => void }).showPicker?.(); } catch { /* the focused list opens with Alt+Down */ } } });
    } else if (el instanceof HTMLInputElement) {
      const label = controlLabel(el); if (!label) continue;
      if (el.type === "checkbox" || el.type === "radio") out.push({ label, checked: el.checked, disabled: el.disabled, onSelect: () => el.click() });
      else out.push({ label, disabled: el.disabled, onSelect: () => { reveal(el); if (el.type === "color" || el.type === "file") el.click(); } });
    }
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  while (out.length && out[0].separator) out.shift();
  return out;
}

/** the group's controls with every short list opened out inline; falls back to compact when that would be too long */
export function mirrorGroupsDetailed(groups: Iterable<Element>): MenuItem[] {
  const detailed = mirrorGroups(groups, INLINE_OPTIONS);
  return detailed.length > MENU_ITEM_CAP ? mirrorGroups(groups, 0) : detailed;
}

/** the shell menu bar (Art layout) shows the focused window's menus: read the same groups straight from the DOM */
export function menuItemsForWindow(winId: string | null | undefined, name: string): MenuItem[] {
  if (!winId) return [];
  const win = document.querySelector(`[data-win-id="${CSS.escape(winId)}"]`);
  return mirrorGroupsDetailed(win?.querySelectorAll(`[data-banner-group="${name}"]`) ?? []);
}

/* ------------------------------------------------------------------ components */
/** a named cluster of controls; its name is a top-level menu that lists the same controls */
/** `keepFocus`: pressing its buttons does not take focus from the document (formatting keeps the text selection) */
export function BannerGroup({ name, children, testid, keepFocus }: { name: BannerMenu; children: ReactNode; testid?: string; keepFocus?: boolean }) {
  return <div role="group" aria-label={name} data-banner-group={name} data-testid={testid} data-keep-focus={keepFocus ? "1" : undefined} className="fs-bgroup">{children}</div>;
}

function groupNames(children: ReactNode): BannerMenu[] {
  const out: BannerMenu[] = [];
  const walk = (c: ReactNode) => Children.forEach(c, (ch) => {
    if (!isValidElement(ch)) return;
    if (ch.type === BannerGroup) { const n = (ch.props as { name: BannerMenu }).name; if (!out.includes(n)) out.push(n); }
    else if ((ch.props as { children?: ReactNode })?.children !== undefined && typeof ch.type !== "string") walk((ch.props as { children?: ReactNode }).children);
  });
  walk(children);
  return out;
}

/** TT110: groups that stay on the bar, folded only as a last resort and in this order (last = most
 *  protected): undo/redo first, then the fonts-and-alignment group a person types with. */
const KEEP_INLINE = ["Tweak", "Look"];

const Chev = ({ dir }: { dir: "l" | "r" }) => (
  // SVG geometry attributes take plain lengths; calc()/var() must go through CSS,
  // or the browser logs an invalid-attribute error on every banner render.
  <svg aria-hidden="true" viewBox="0 0 16 16" data-icon="chev" style={{ width: fz(14), height: fz(14), flex: "0 0 auto" }}><path d={dir === "l" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/** `extra`: menus whose controls live elsewhere in the same window (a tool palette, a side panel), marked there with
 *  data-banner-group="<name>" — listed after the strip's own menus, never duplicated as buttons */
export function AppBanner({ label, children, status, testid, extra = [], span }: { label: string; children: ReactNode; status?: ReactNode; testid?: string; extra?: BannerMenu[]; span?: string }) {
  const root = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const own = groupNames(children);
  const menus = [...own, ...extra.filter((n) => !own.includes(n))];
  const key = menus.join("|");
  const [ov, setOv] = useState({ l: false, r: false });
  /**
   * TT110 — Art layout only. The shell menu bar at the top of the screen already shows the FOCUSED
   * window's menus, so repeating them inside that window is noise; and the tool strip is wider than
   * any realistic window, so its tail could only be reached by scrolling sideways.
   *
   * Here the window drops the repeated menu row and collapses whatever does not fit into one
   * "More tools" menu. Collapsed groups stay in the DOM and stay rendered (visibility, not display),
   * because the menus mirror the live controls and click the very control they name: a collapsed
   * control is one click away, never unreachable.
   */
  const shell = useShell();
  const [winId, setWinId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(0);
  const artBar = layoutOf(shell.settings["appearance.layout"]) === "art";
  const focusedHere = artBar && winId !== null && shell.state.focus === winId;

  useEffect(() => {
    const el = strip.current; if (!el) return;
    const upd = () => {
      const l = el.scrollLeft > 2, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setOv((o) => (o.l === l && o.r === r ? o : { l, r }));
    };
    const ro = new ResizeObserver(upd); ro.observe(el);
    for (const c of el.children) ro.observe(c);
    const mo = new MutationObserver(() => { for (const c of el.children) ro.observe(c); upd(); });
    mo.observe(el, { childList: true });
    el.addEventListener("scroll", upd, { passive: true });
    // a vertical wheel over the strip scrolls it sideways (mouse users have no horizontal wheel)
    const onWheel = (e: WheelEvent) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { el.scrollLeft += e.deltaY; e.preventDefault(); } };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { ro.disconnect(); mo.disconnect(); el.removeEventListener("scroll", upd); el.removeEventListener("wheel", onWheel); };
  }, [key]);

  useEffect(() => {
    const win = root.current?.closest("[data-win-id]")?.getAttribute("data-win-id");
    setWinId(win ?? null);
    if (!win) return;
    bannerStore.set(win, key ? key.split("|") : []);
    return () => bannerStore.del(win);
  }, [key]);

  /**
   * Which groups step aside so the rest fit on one line. Order matters: the formatting controls
   * (fonts, alignment) are what a person is reaching for while they work, so they are the LAST to
   * go, not the first — the tail of the strip folds before them.
   */
  const natural = useRef<{ key: string; widths: number[] } | null>(null);
  useEffect(() => {
    const el = strip.current;
    const groupsOf = () => [...(el?.children ?? [])].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.bannerGroup);
    if (!el || !artBar) {
      for (const g of groupsOf()) delete g.dataset.folded;
      natural.current = null;
      setCollapsed((c) => (c === 0 ? c : 0));
      return;
    }
    const fit = () => {
      const kids = groupsOf();
      if (!kids.length) return;
      if (natural.current?.key !== key || natural.current.widths.length !== kids.length) {
        for (const k of kids) delete k.dataset.folded;       // measure every group at its real width
        natural.current = { key, widths: kids.map((k) => k.getBoundingClientRect().width || k.scrollWidth) };
      }
      const widths = natural.current.widths;
      const room = el.clientWidth - 4;
      const MORE = 86;                                       // the "More tools" button, once it is needed
      const name = (k: HTMLElement) => k.dataset.bannerGroup ?? "";
      const order: number[] = [];                            // fold these first: the tail, least-used end first
      for (let i = kids.length - 1; i >= 0; i--) if (!KEEP_INLINE.includes(name(kids[i]))) order.push(i);
      for (const keep of KEEP_INLINE)                        // then the protected ones, formatting dead last
        for (let i = kids.length - 1; i >= 0; i--) if (name(kids[i]) === keep) order.push(i);
      const folded = new Set<number>();
      let used = widths.reduce((a, b) => a + b, 0);
      for (const idx of order) {
        if (used + (folded.size ? MORE : 0) <= room) break;
        if (folded.size >= kids.length - 1) break;           // never fold the whole strip away
        folded.add(idx); used -= widths[idx];
      }
      kids.forEach((k, i) => { if (folded.has(i)) k.dataset.folded = "1"; else delete k.dataset.folded; });

      /**
       * A single group can be wider than the window on its own — Writer's formatting group measures
       * 1530px in a 936px strip. Keeping it whole would mean scrolling for a font size, so the group
       * stays and its TAIL steps aside control by control, in the same "More tools" menu.
       */
      let spare = room - used - (folded.size ? MORE : 0);
      for (const k of kids) {
        const controls = [...k.querySelectorAll<HTMLElement>(":scope > *")];
        for (const c of controls) delete c.dataset.folded;
      }
      let perControl = 0;
      for (let i = 0; i < kids.length; i++) {
        if (folded.has(i) || widths[i] <= 0) continue;
        if (spare >= 0 && widths[i] <= room) continue;       // this group already fits
        const k = kids[i];
        const controls = [...k.querySelectorAll<HTMLElement>(":scope > *")];
        const cw = controls.map((c) => c.getBoundingClientRect().width || 0);
        const chrome = widths[i] - cw.reduce((a, b) => a + b, 0);
        let run = chrome;
        const budget = room - (used - widths[i]) - (MORE);   // what is left for this group
        for (let j = 0; j < controls.length; j++) {
          run += cw[j] + 2;
          if (run > budget && j > 0) { controls[j].dataset.folded = "1"; perControl += 1; }
        }
        used = used - widths[i] + Math.min(widths[i], budget);
      }
      spare = 0;
      setCollapsed((c) => (c === folded.size + perControl ? c : folded.size + perControl));
    };
    const ro = new ResizeObserver(fit); ro.observe(el);
    fit();
    return () => { ro.disconnect(); for (const g of groupsOf()) delete g.dataset.folded; };
  }, [artBar, key]);

  const page = (dir: 1 | -1) => { const el = strip.current; if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" }); };
  const groups = (n: string) => (root.current?.closest("[data-win-id]") ?? root.current)?.querySelectorAll(`[data-banner-group="${n}"]`) ?? [];
  return (
    <div ref={root} className="fs-banner" data-testid={testid ?? "app-banner"} data-app={label} style={span ? { gridColumn: span } : undefined}>
      {focusedHere && !status ? null : (
        <div className="fs-banner-menus">
          {focusedHere ? null : (
            <nav aria-label={`${label} menus`} className="fs-banner-nav">
              {menus.map((n) => (
                <MenuButton key={n} label={n} testid={`banner-menu-${n.toLowerCase()}`} items={() => mirrorGroupsDetailed(groups(n))}
                  buttonStyle={{ minHeight: fz(24), padding: `0 ${fz(9)}`, borderRadius: 999, fontWeight: 600 }}>{n}</MenuButton>
              ))}
            </nav>
          )}
          {status ? <div className="fs-banner-status">{status}</div> : null}
        </div>
      )}
      <div className="fs-banner-stripwrap" data-ol={ov.l ? "1" : undefined} data-or={ov.r ? "1" : undefined}>
        <button type="button" className="fs-banner-chev" aria-label="Show earlier tools" tabIndex={-1} hidden={!ov.l} data-testid="banner-prev" onClick={() => page(-1)}><Chev dir="l" /></button>
        <div ref={strip} className="fs-banner-strip" role="toolbar" aria-label={`${label} tools`} data-testid="banner-strip"
          data-collapsed={collapsed || undefined}
          onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button") && (e.target as HTMLElement).closest("[data-keep-focus]")) e.preventDefault(); }}>
          {children}
        </div>
        {collapsed > 0 ? (
          <MenuButton label="More tools" testid="banner-more" buttonStyle={{ minHeight: fz(22), padding: `0 ${fz(8)}`, borderRadius: 8, margin: `0 ${fz(2)}`, flex: "0 0 auto", whiteSpace: "nowrap" }}
            items={() => {
              const el = strip.current;
              if (!el) return [];
              const items: MenuItem[] = [];
              for (const node of el.querySelectorAll<HTMLElement>('[data-folded="1"]')) {
                if (node.closest('[data-banner-group][data-folded="1"]') && !node.dataset.bannerGroup) continue;
                const part = node.dataset.bannerGroup
                  ? mirrorGroupsDetailed([node])
                  : mirrorControls([node]);
                if (part.length && items.length) items.push({ label: "", separator: true });
                items.push(...part);
              }
              return items;
            }}>More</MenuButton>
        ) : null}
        <button type="button" className="fs-banner-chev" aria-label="Show more tools" tabIndex={-1} hidden={!ov.r} data-testid="banner-next" onClick={() => page(1)}><Chev dir="r" /></button>
      </div>
    </div>
  );
}
