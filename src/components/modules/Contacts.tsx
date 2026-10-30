"use client";
import { fz } from "@/lib/uiscale";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import * as C from "@/lib/contacts-core";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

/**
 * Contacts (TT24; PR-05, CN-01..04). A local address book stored as a real vCard 4.0 file in the VFS
 * (/Contacts/contacts.vcf by default; any .vcf opened from Files becomes the book and saves back to itself).
 *
 *   • Reads vCard 2.1 / 3.0 / 4.0 (src/lib/contacts-core.ts), writes 4.0; unmodelled properties round-trip.
 *   • Autosaves 0.5 s after an edit through the VFS safe-save path; Undo restores the previous book (20 steps).
 *   • Duplicates are found by shared e-mail, phone (last 10 digits) or identical name, and merged without loss.
 *   • Import: .vcf from the computer, or the Contact Picker API where the browser has it (Chrome on Android);
 *     elsewhere the button is disabled and says why. Export: .vcf and CSV (CSV-injection guarded).
 *   • Keyboard: the list is buttons in a labelled list; Enter opens, E edits, Delete deletes, Esc cancels editing.
 */
const BOOK = "/Contacts/contacts.vcf";
const EMAIL_TYPES = ["home", "work", "other"];
const TEL_TYPES = ["cell", "home", "work", "fax", "other"];
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
import { loadStars, storeStars, toggleStar } from "@/lib/contact-stars";
import { filterContacts, type ContactFacet } from "@/lib/contact-filter";
import { sortByFamily } from "@/lib/contact-name-sort";
import { contactCardFile } from "@/lib/contact-card";
import { UiGlyph } from "../AppIcon";
const initials = (c: C.Contact) => (c.n.given || c.fn).charAt(0).toUpperCase() + (c.n.family ? c.n.family.charAt(0).toUpperCase() : "");
const newUid = () => `urn:uuid:${crypto.randomUUID()}`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const firstType = (types: string[], allowed: string[]) => types.find((t) => allowed.includes(t)) ?? "other";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function ContactsModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) || BOOK;
  const idp = `ct-${win.id}`;
  const [list, setList] = useState<C.Contact[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showWarnings, setShowWarnings] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<C.Contact | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [view, setView] = useState<"card" | "dupes">("card");
  const [undo, setUndo] = useState<C.Contact[][]>([]);
  const [ver, setVer] = useState(0);
  const [savedVer, setSavedVer] = useState(0);
  const [saveErr, setSaveErr] = useState("");
  const [pickerOk] = useState(() => typeof window !== "undefined" && "contacts" in navigator && "ContactsManager" in window);

  useEffect(() => {
    let live = true;
    api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`)
      .then((r) => { if (!live) return; const p = C.parseVcf(r.node.content); setList(p.contacts); setWarnings(p.warnings); })
      .catch((e: Error) => { if (!live) return; if (/not found|404/i.test(e.message)) setList([]); else setLoadErr(e.message); });
    return () => { live = false; };
  }, [path]);

  // Autosave: each commit bumps `ver`; a write that finishes records the version it wrote, so a slow save can never
  // mark a newer edit as saved.
  // `pending` holds the newest unsaved book so that closing the window or the tab inside the 0.5 s debounce still
  // writes it (TT24 repair: the timer was simply cleared on unmount and the last edit was lost).
  const pending = useRef<{ path: string; content: string } | null>(null);
  useEffect(() => {
    if (list === null || ver === 0 || ver === savedVer) return;
    const v = ver, content = C.serializeVcf(list);
    pending.current = { path, content };
    const t = window.setTimeout(() => {
      post("/api/fs", { op: "write", path, content, mime: "text/vcard", reason: "contacts" })
        .then(() => { if (pending.current?.content === content) pending.current = null; setSavedVer((s) => Math.max(s, v)); setSaveErr(""); shell.bumpRefresh(); })
        .catch((e: Error) => setSaveErr(e.message));
    }, 500);
    return () => window.clearTimeout(t);
  }, [list, ver, savedVer, path, shell]);
  useEffect(() => {
    const flush = () => {
      const p = pending.current; if (!p) return;
      pending.current = null;
      const body = JSON.stringify({ op: "write", path: p.path, content: p.content, mime: "text/vcard", reason: "contacts" });
      // keepalive lets the request outlive a closing tab, but browsers cap keepalive bodies at 64 KiB
      void fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: body.length < 60_000 }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);

  const commit = (next: C.Contact[]) => {
    if (list) setUndo((u) => [...u.slice(-19), list]);
    setList(next); setVer((v) => v + 1);
  };
  const doUndo = () => {
    const prev = undo.at(-1); if (!prev) return;
    setUndo((u) => u.slice(0, -1)); setList(prev); setVer((v) => v + 1);
  };

  const [nameOrder, setNameOrder] = useState<"given" | "family">("given");
  const sorted = useMemo(() => nameOrder === "family" ? sortByFamily(list ?? []) : C.sortContacts(list ?? []), [list, nameOrder]);
  const [stars, setStars] = useState<Set<string>>(() => { try { return loadStars(localStorage); } catch { return new Set(); } });
  const [starredOnly, setStarredOnly] = useState(false);
  const [facet, setFacet] = useState<ContactFacet>("all");
  const shown = useMemo(() => {
    const base = sorted.filter((c) => C.matches(c, q) && (!starredOnly || stars.has(c.uid)));
    if (facet === "all") return base;
    const keep = new Set(filterContacts(base.map((c) => ({ c, emails: c.emails.map((e) => e.value), phones: c.tels.map((t) => t.value) })), facet).map((x) => x.c.uid));
    return base.filter((c) => keep.has(c.uid));
  }, [sorted, q, starredOnly, stars, facet]);
  const doToggleStar = (uid: string) => setStars((prev) => { const next = toggleStar(prev, uid); try { storeStars(localStorage, next); } catch { /* private mode */ } return next; });
  const dupes = useMemo(() => C.findDuplicates(list ?? []), [list]);
  const birthdays = useMemo(() => C.upcomingBirthdays(list ?? [], today(), 30), [list]);
  const current = (list ?? []).find((c) => c.uid === sel) ?? null;
  const status = loadErr ? "error" : list === null ? "loading" : saveErr ? "save failed" : ver === savedVer ? "saved" : "saving…";

  const startNew = () => { const c = C.emptyContact(newUid()); setDraft(c); setErrors([]); setView("card"); };
  const startEdit = (c: C.Contact) => { setDraft(structuredClone(c)); setErrors([]); };
  const saveDraft = () => {
    if (!draft || !list) return;
    const clean: C.Contact = {
      ...draft,
      fn: draft.fn.trim() || [draft.n.given, draft.n.family].filter(Boolean).join(" ").trim(),
      emails: draft.emails.filter((e) => e.value.trim()), tels: draft.tels.filter((t) => t.value.trim()),
      adrs: draft.adrs.filter((a) => [a.street, a.locality, a.region, a.code, a.country].some((x) => x.trim())),
      urls: draft.urls.filter((u) => u.value.trim()), rev: stamp(),
    };
    const errs = C.validate(clean);
    if (errs.length) { setErrors(errs); return; }
    const exists = list.some((c) => c.uid === clean.uid);
    commit(exists ? list.map((c) => (c.uid === clean.uid ? clean : c)) : [...list, clean]);
    setSel(clean.uid); setDraft(null); setErrors([]);
    shell.toast(exists ? `Saved ${clean.fn}` : `Added ${clean.fn}`, "ok");
  };
  const remove = (c: C.Contact) => {
    if (!list) return;
    commit(list.filter((x) => x.uid !== c.uid)); setSel(null);
    shell.toast(`Deleted ${c.fn}`, "info", { label: "Undo", run: () => document.getElementById(`${idp}-undo`)?.click() });
  };
  const importText = (text: string, from: string) => {
    if (!list) return;
    const r = C.parseVcf(text);
    const have = new Set(list.map((c) => c.uid));
    const fresh = r.contacts.filter((c) => !have.has(c.uid));
    const next = [...list, ...fresh];
    commit(next);
    const d = C.findDuplicates(next).length;
    setWarnings(r.warnings);
    shell.toast(`Imported ${fresh.length} contact(s) from ${from}${r.contacts.length - fresh.length ? `, ${r.contacts.length - fresh.length} already present (same UID)` : ""}${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ""}${d ? ` · ${d} possible duplicate group(s)` : ""}`, fresh.length ? "ok" : "info");
  };
  const fromDevice = async () => {
    try {
      const nav = navigator as Navigator & { contacts: { select(p: string[], o: { multiple: boolean }): Promise<Parameters<typeof C.fromPicker>[0][]> } };
      const picked = await nav.contacts.select(["name", "email", "tel", "address"], { multiple: true });
      if (!list || !picked.length) return;
      commit([...list, ...picked.map((p) => C.fromPicker(p, newUid()))]);
      shell.toast(`Added ${picked.length} contact(s) you picked on this device`, "ok");
    } catch (e) { shell.toast(`Contact Picker: ${(e as Error).message}`, "warn"); }
  };
  const mergeGroup = (g: C.DupGroup) => {
    if (!list) return;
    const members = g.uids.map((u) => list.find((c) => c.uid === u)!).filter(Boolean);
    const merged = members.slice(1).reduce((a, b) => C.mergeContacts(a, b, stamp()), members[0]);
    commit([...list.filter((c) => !g.uids.includes(c.uid)), merged]);
    setSel(merged.uid); setView("card");
    shell.toast(`Merged ${members.length} contacts into ${merged.fn}`, "ok");
  };

  const onListKey = (e: React.KeyboardEvent, c: C.Contact) => {
    if (e.key === "Delete") { e.preventDefault(); remove(c); }
    else if (e.key.toLowerCase() === "e" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setSel(c.uid); startEdit(c); }
  };

  if (loadErr) return <div style={{ padding: 16 }}><Badge tone="bad">Could not open {path}: {loadErr}</Badge></div>;

  return (
    <div data-testid="contacts" style={{ display: "grid", gridTemplateRows: "auto minmax(0,1fr) auto", height: "100%", minHeight: 0 }}>
      <div className="fs-toolbar fs-row" style={{ gap: 6, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--fs-border)" }}>
        <Btn variant="primary" onClick={startNew} data-testid="ct-new">New contact</Btn>
        <label className="fs-btn" style={{ cursor: "pointer" }}>
          Import .vcf
          <input data-testid="ct-import-file" type="file" accept=".vcf,.vcard,text/vcard,text/x-vcard" style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
            onChange={async (e) => { const f = e.target.files?.[0]; if (f) importText(await f.text(), f.name); e.target.value = ""; }} />
        </label>
        <Btn onClick={() => void fromDevice()} disabled={!pickerOk} data-testid="ct-picker"
          title={pickerOk ? "Pick contacts from this device (Contact Picker API)" : "The Contact Picker API is not available in this browser (it ships in Chrome on Android); import a .vcf instead"}>
          From device
        </Btn>
        <select className="fs-select" style={{ width: "auto" }} aria-label="Sort contacts by" value={nameOrder} onChange={(e) => setNameOrder(e.target.value as "given" | "family")} data-testid="contacts-name-order"><option value="given">First name</option><option value="family">Family name</option></select>
        <Btn onClick={() => list && download("contacts.vcf", C.serializeVcf(sorted), "text/vcard")} disabled={!list?.length} data-testid="ct-download-vcf">Download .vcf</Btn>
        <Btn data-testid="ct-export-csv" disabled={!list?.length} onClick={async () => {
          const csv = C.toCsv(sorted); const dst = path.replace(/[^/]+$/, "contacts-export.csv");
          await post("/api/fs", { op: "write", path: dst, content: csv, mime: "text/csv", reason: "contacts-export" });
          download("contacts.csv", csv, "text/csv"); shell.bumpRefresh(); shell.toast(`Exported ${sorted.length} contact(s) to ${dst}`, "ok");
        }}>Export CSV</Btn>
        <Btn data-testid="ct-dupes" onClick={() => { setView(view === "dupes" ? "card" : "dupes"); setDraft(null); }} variant={view === "dupes" ? "primary" : "default"}>
          Duplicates{dupes.length ? ` (${dupes.length})` : ""}
        </Btn>
        <Btn id={`${idp}-undo`} data-testid="ct-undo" onClick={doUndo} disabled={!undo.length}>Undo</Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `minmax(${fz(220)}, ${fz(300)}) minmax(0,1fr)`, minHeight: 0 }}>
        <aside style={{ display: "grid", gridTemplateRows: "auto auto minmax(0,1fr)", minHeight: 0, borderRight: "1px solid var(--fs-border)", gridTemplateColumns: "minmax(0,1fr)" }}>
          <div style={{ padding: 8 }}>
            <label htmlFor={`${idp}-q`} className="fs-dim" style={{ fontSize: fz(11.5) }}>Search name, e-mail, phone, notes</label>
            <input id={`${idp}-q`} data-testid="ct-search" className="fs-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" style={{ width: "100%", boxSizing: "border-box" }} />
            <Btn variant={starredOnly ? "primary" : "ghost"} aria-pressed={starredOnly} onClick={() => setStarredOnly((v) => !v)} style={{ marginTop: 6 }}><UiGlyph name="starFill" size={12} /> Starred</Btn>
            <select className="fs-select" style={{ width: "auto", marginTop: 6 }} aria-label="Filter contacts by contact details" value={facet} onChange={(e) => setFacet(e.target.value as ContactFacet)} data-testid="contacts-facet">
              <option value="all">All contacts</option><option value="email">Has e-mail</option><option value="phone">Has phone</option><option value="noEmail">No e-mail</option>
            </select>
          </div>
          {birthdays.length ? (
            <div data-testid="ct-birthdays" style={{ padding: "0 8px 8px", fontSize: fz(12) }}>
              <div className="fs-dim">Birthdays in the next 30 days</div>
              {birthdays.slice(0, 4).map((b) => (
                <button key={b.uid} className="fs-list-item" style={{ width: "100%", background: "none", border: 0, color: "inherit", font: "inherit", textAlign: "left" }} onClick={() => { setSel(b.uid); setView("card"); setDraft(null); }}>
                  {b.fn} · {b.inDays === 0 ? "today" : b.inDays === 1 ? "tomorrow" : `in ${b.inDays} days`}{b.turns ? ` (turns ${b.turns})` : ""}
                </button>
              ))}
            </div>
          ) : <div />}
          <ul data-testid="ct-list" aria-label="Contacts" className="fs-scroll" style={{ listStyle: "none", margin: 0, padding: "0 6px 8px", overflowY: "auto", overflowX: "hidden", display: "grid", gridTemplateColumns: "minmax(0,1fr)", alignContent: "start", gap: 2 }}>
            {list === null ? <li className="fs-dim" style={{ padding: 8 }}>Loading…</li> : null}
            {list !== null && !shown.length ? <li className="fs-dim" style={{ padding: 8 }}>{list.length ? "No contact matches." : "No contacts yet. Add one or import a .vcf file."}</li> : null}
            {shown.map((c, i) => {
              const letter = C.letterOf(c); const head = i === 0 || C.letterOf(shown[i - 1]) !== letter;
              return (
                <li key={c.uid} style={{ minWidth: 0 }}>
                  {head ? <div aria-hidden className="fs-dim" style={{ fontSize: fz(11), padding: "6px 6px 2px", fontWeight: 700 }}>{letter}</div> : null}
                  <span style={{ display: "flex", gap: 2, alignItems: "stretch" }}>
                  <Btn variant="ghost" aria-pressed={stars.has(c.uid)} aria-label={stars.has(c.uid) ? `Unstar ${c.fn}` : `Star ${c.fn}`} title={stars.has(c.uid) ? "Starred" : "Star"} onClick={() => doToggleStar(c.uid)}>{stars.has(c.uid) ? <UiGlyph name="starFill" size={14} /> : <UiGlyph name="star" size={14} />}</Btn>
                  <button data-testid="ct-item" data-uid={c.uid} aria-current={c.uid === sel ? "true" : undefined} className="fs-list-item" data-selected={c.uid === sel}
                    onClick={() => { setSel(c.uid); setView("card"); setDraft(null); }} onKeyDown={(e) => onListKey(e, c)}
                    style={{ width: "100%", minWidth: 0, boxSizing: "border-box", border: 0, background: c.uid === sel ? undefined : "none", color: "inherit", font: "inherit", textAlign: "left" }}>
                    <Avatar c={c} size={30} />
                    <span style={{ display: "grid", minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.fn}</span>
                      <span className="fs-dim" style={{ fontSize: fz(11.5), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.org[0] || c.emails[0]?.value || c.tels[0]?.value || ""}</span>
                    </span>
                  </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </aside>

        <main className="fs-scroll" style={{ overflow: "auto", padding: 14, minWidth: 0 }} data-testid="ct-detail">
          {draft ? (
            <Editor key={draft.uid} idp={idp} draft={draft} setDraft={setDraft} errors={errors} onSave={saveDraft} onCancel={() => { setDraft(null); setErrors([]); }} isNew={!list?.some((c) => c.uid === draft.uid)} />
          ) : view === "dupes" ? (
            <section data-testid="ct-dupes-view" style={{ display: "grid", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: fz(16) }}>Possible duplicates</h2>
              {!dupes.length ? <div className="fs-dim">No duplicates: no two contacts share an e-mail, a phone number or a name.</div> : null}
              {dupes.map((g) => (
                <div key={g.uids.join()} className="fs-panel" style={{ padding: 10, display: "grid", gap: 6 }} data-testid="ct-dupe-group">
                  <div style={{ fontWeight: 700 }}>{g.uids.map((u) => list?.find((c) => c.uid === u)?.fn).join(" · ")}</div>
                  <div className="fs-dim" style={{ fontSize: fz(12) }}>{g.reasons.join("; ")}</div>
                  <div><Btn variant="primary" data-testid="ct-merge" onClick={() => mergeGroup(g)}>Merge into {list?.find((c) => c.uid === g.uids[0])?.fn}</Btn></div>
                </div>
              ))}
            </section>
          ) : current ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="fs-row" style={{ gap: 6 }}>
                <Btn variant="ghost" onClick={() => void shell.copy(contactCardFile(current).text, "contacts")} data-testid="ct-copy-card">Copy vCard</Btn>
                <Btn variant="ghost" onClick={() => { const f = contactCardFile(current); download(f.filename, f.text, "text/vcard"); }} data-testid="ct-download-card">Download .vcf</Btn>
                <span className="fs-dim" style={{ fontSize: fz(11) }}>just this contact, same format as the whole book</span>
              </div>
              <Card c={current} onEdit={() => startEdit(current)} onDelete={() => remove(current)} />
            </div>
          ) : (
            <div className="fs-dim" style={{ padding: 20 }}>{list?.length ? "Select a contact." : "Your address book is empty."}</div>
          )}
        </main>
      </div>

      <div className="fs-row" style={{ gap: 8, padding: "4px 10px", borderTop: "1px solid var(--fs-border)", fontSize: fz(12), flexWrap: "wrap" }}>
        <span data-testid="ct-count">{list?.length ?? 0} contact(s)</span>
        <span className="fs-dim" style={{ overflowWrap: "anywhere" }}>{path}</span>
        <span data-testid="ct-status"><Badge tone={status === "saved" ? "ok" : status === "error" || status === "save failed" ? "bad" : "info"}>{status}</Badge></span>
        {saveErr ? <span role="alert" style={{ color: "var(--fs-bad-text)" }}>{saveErr}</span> : null}
        {warnings.length ? <Btn variant="ghost" onClick={() => setShowWarnings(!showWarnings)} data-testid="ct-warnings">{warnings.length} import warning(s)</Btn> : null}
      </div>
      {showWarnings && warnings.length ? (
        <ul className="fs-dim" style={{ margin: 0, padding: "4px 26px 8px", fontSize: fz(11.5), maxHeight: 120, overflow: "auto" }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      ) : null}
    </div>
  );
}

function Avatar({ c, size }: { c: C.Contact; size: number }) {
  // FNV-1a, so UIDs that differ in one character (s0, s1, …) still get clearly different hues
  let h = 0x811c9dc5; for (const ch of c.uid) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  const hue = Math.round(((h >>> 0) / 2 ** 32) * 12) * 30;
  return c.photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={c.photo} alt="" width={size} height={size} style={{ width: fz(size), height: fz(size), borderRadius: 999, objectFit: "cover", flex: "none" }} />
  ) : (
    <span aria-hidden style={{ width: fz(size), height: fz(size), borderRadius: 999, flex: "none", display: "grid", placeItems: "center", fontWeight: 800, fontSize: fz(size * 0.4), background: `hsl(${hue} 70% 82%)`, color: "#14213d" }}>{initials(c)}</span>
  );
}

function Card({ c, onEdit, onDelete }: { c: C.Contact; onEdit: () => void; onDelete: () => void }) {
  const b = C.parseBday(c.bday);
  const rows: [string, React.ReactNode][] = [];
  c.emails.forEach((e) => rows.push([`E-mail${e.types.length ? ` (${e.types.join(", ")})` : ""}${e.pref ? " · preferred" : ""}`, <a key={e.value} href={`mailto:${e.value}`}>{e.value}</a>]));
  c.tels.forEach((t) => rows.push([`Phone${t.types.length ? ` (${t.types.join(", ")})` : ""}${t.pref ? " · preferred" : ""}`, <a key={t.value} href={`tel:${C.phoneDigits(t.value) ? t.value.replace(/[^\d+]/g, "") : t.value}`}>{t.value}</a>]));
  c.adrs.forEach((a, i) => rows.push([`Address${a.types.length ? ` (${a.types.join(", ")})` : ""}`, <span key={i} style={{ whiteSpace: "pre-line" }}>{[a.pobox && `PO Box ${a.pobox}`, a.ext, a.street, [a.locality, a.region, a.code].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n")}</span>]));
  c.urls.forEach((u) => rows.push(["Website", /^https?:\/\//i.test(u.value) ? <a key={u.value} href={u.value} target="_blank" rel="noreferrer noopener">{u.value}</a> : u.value]));
  if (c.bday) rows.push(["Birthday", b ? new Date(Date.UTC(b.year ?? 2000, b.month - 1, b.day)).toLocaleDateString(undefined, { day: "numeric", month: "long", ...(b.year ? { year: "numeric" } : {}), timeZone: "UTC" }) : c.bday]);
  if (c.nickname.length) rows.push(["Nickname", c.nickname.join(", ")]);
  return (
    <article data-testid="ct-card" data-uid={c.uid} className="ct-card" style={{ display: "grid", gap: 12, maxWidth: fz(640) }}>
      <style>{".ct-card a { color: inherit; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; } .ct-card a:hover { text-decoration-thickness: 2px; }"}</style>
      <header className="fs-row" style={{ gap: 12, flexWrap: "wrap" }}>
        <Avatar c={c} size={56} />
        <div style={{ display: "grid", minWidth: 0, flex: 1 }}>
          <h2 data-testid="ct-card-name" style={{ margin: 0, fontSize: fz(20), overflowWrap: "anywhere" }}>{c.fn}</h2>
          {c.title || c.org.length ? <div className="fs-dim">{[c.title, c.org.join(" · ")].filter(Boolean).join(" at ")}</div> : null}
        </div>
        <Btn onClick={onEdit} data-testid="ct-edit">Edit</Btn>
        <Btn variant="danger" onClick={onDelete} data-testid="ct-delete">Delete</Btn>
      </header>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content minmax(0,1fr)", gap: "6px 14px", margin: 0 }}>
        {rows.map(([k, v], i) => <div key={i} style={{ display: "contents" }}><dt className="fs-dim">{k}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{v}</dd></div>)}
      </dl>
      {c.categories.length ? <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>{c.categories.map((x) => <Badge key={x} tone="info">{x}</Badge>)}</div> : null}
      {c.note ? <div className="fs-panel" style={{ padding: 10, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="ct-card-note">{c.note}</div> : null}
      {c.extra.length ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>{c.extra.length} other vCard field(s) are kept unchanged when this contact is saved.</div> : null}
    </article>
  );
}

function Editor({ idp, draft, setDraft, errors, onSave, onCancel, isNew }: {
  idp: string; draft: C.Contact; setDraft: (c: C.Contact) => void; errors: string[]; onSave: () => void; onCancel: () => void; isNew: boolean;
}) {
  const set = (patch: Partial<C.Contact>) => setDraft({ ...draft, ...patch });
  // the groups box keeps its raw text: deriving it from the parsed list would eat the comma you just typed
  const [catText, setCatText] = useState(draft.categories.join(", "));
  const field = (id: string, label: string, value: string, on: (v: string) => void, props: Record<string, unknown> = {}) => (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <label htmlFor={`${idp}-${id}`} style={{ fontSize: fz(12) }}>{label}</label>
      <input id={`${idp}-${id}`} data-testid={`ct-field-${id}`} className="fs-input" value={value} onChange={(e) => on(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} {...props} />
    </div>
  );
  const typed = (kind: "emails" | "tels", label: string, allowed: string[], inputType: string) => (
    <fieldset style={{ border: "1px solid var(--fs-border)", borderRadius: 10, padding: 10, display: "grid", gap: 6, minWidth: 0 }}>
      <legend style={{ fontSize: fz(12) }}>{label}</legend>
      {draft[kind].map((t, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: `minmax(0,1fr) ${fz(110)} auto`, gap: 6, alignItems: "center" }}>
          <input aria-label={`${label} ${i + 1}`} data-testid={`ct-${kind}-${i}`} type={inputType} className="fs-input" value={t.value} style={{ minWidth: 0, boxSizing: "border-box" }}
            onChange={(e) => set({ [kind]: draft[kind].map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
          <select aria-label={`${label} ${i + 1} type`} className="fs-select" value={firstType(t.types, allowed)} style={{ width: "100%" }}
            onChange={(e) => set({ [kind]: draft[kind].map((x, j) => (j === i ? { ...x, types: e.target.value === "other" ? [] : [e.target.value] } : x)) })}>
            {allowed.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <Btn variant="ghost" title={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => set({ [kind]: draft[kind].filter((_, j) => j !== i) })}>Remove</Btn>
        </div>
      ))}
      <div><Btn variant="ghost" data-testid={`ct-${kind}-add`} onClick={() => set({ [kind]: [...draft[kind], { value: "", types: [allowed[0]] }] })}>Add {label.toLowerCase().replace(/s$/, "")}</Btn></div>
    </fieldset>
  );
  const adr = draft.adrs[0] ?? { types: ["home"], pobox: "", ext: "", street: "", locality: "", region: "", code: "", country: "" };
  const setAdr = (patch: Partial<C.Adr>) => set({ adrs: [{ ...adr, ...patch }, ...draft.adrs.slice(1)] });
  return (
    <form data-testid="ct-editor" noValidate style={{ display: "grid", gap: 10, maxWidth: fz(680) }}
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}>
      <h2 style={{ margin: 0, fontSize: fz(18) }}>{isNew ? "New contact" : `Edit ${draft.fn}`}</h2>
      {errors.length ? <div role="alert" data-testid="ct-errors" style={{ color: "var(--fs-bad-text)" }}><ul style={{ margin: 0 }}>{errors.map((x) => <li key={x}>{x}</li>)}</ul></div> : null}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${fz(200)}, 1fr))`, gap: 8 }}>
        {field("given", "First name", draft.n.given, (v) => set({ n: { ...draft.n, given: v } }), { autoFocus: true, autoComplete: "off" })}
        {field("family", "Last name", draft.n.family, (v) => set({ n: { ...draft.n, family: v } }), { autoComplete: "off" })}
        {field("fn", "Display name (blank = first + last)", draft.fn, (v) => set({ fn: v }), { autoComplete: "off" })}
        {field("org", "Company", draft.org[0] ?? "", (v) => set({ org: draft.org.length > 1 ? [v, ...draft.org.slice(1)] : v ? [v] : [] }))}
        {field("title", "Job title", draft.title, (v) => set({ title: v }))}
        {field("bday", "Birthday (YYYY-MM-DD or --MM-DD)", draft.bday, (v) => set({ bday: v }), { inputMode: "numeric" })}
      </div>
      {typed("emails", "E-mails", EMAIL_TYPES, "email")}
      {typed("tels", "Phones", TEL_TYPES, "tel")}
      <fieldset style={{ border: "1px solid var(--fs-border)", borderRadius: 10, padding: 10, display: "grid", gap: 6, gridTemplateColumns: `repeat(auto-fit, minmax(${fz(160)}, 1fr))` }}>
        <legend style={{ fontSize: fz(12) }}>Address{draft.adrs.length > 1 ? ` (first of ${draft.adrs.length}; the others are kept)` : ""}</legend>
        {field("street", "Street", adr.street, (v) => setAdr({ street: v }))}
        {field("city", "City", adr.locality, (v) => setAdr({ locality: v }))}
        {field("region", "State / region", adr.region, (v) => setAdr({ region: v }))}
        {field("code", "Postal code", adr.code, (v) => setAdr({ code: v }))}
        {field("country", "Country", adr.country, (v) => setAdr({ country: v }))}
      </fieldset>
      {field("url", "Website", draft.urls[0]?.value ?? "", (v) => set({ urls: [{ value: v, types: draft.urls[0]?.types ?? [] }, ...draft.urls.slice(1)] }), { type: "url" })}
      {field("categories", "Groups (comma separated)", catText, (v) => { setCatText(v); set({ categories: v.split(",").map((x) => x.trim()).filter(Boolean) }); })}
      <div style={{ display: "grid", gap: 2 }}>
        <label htmlFor={`${idp}-note`} style={{ fontSize: fz(12) }}>Notes</label>
        <textarea id={`${idp}-note`} data-testid="ct-field-note" className="fs-textarea" rows={4} value={draft.note} onChange={(e) => set({ note: e.target.value })} style={{ width: "100%", boxSizing: "border-box" }} />
      </div>
      <div className="fs-row" style={{ gap: 8 }}>
        <Btn type="submit" variant="primary" data-testid="ct-save">Save</Btn>
        <Btn onClick={onCancel} data-testid="ct-cancel">Cancel</Btn>
        <span className="fs-dim" style={{ fontSize: fz(11.5) }}>Esc cancels</span>
      </div>
    </form>
  );
}
