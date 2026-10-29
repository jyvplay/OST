"use client";
import { clipboardRead } from "@/lib/access-log";
import { fz } from "@/lib/uiscale";

import { useState } from "react";
import { capAvailable } from "@/lib/capabilities";
import { clearUnpinned, filterClips, ordered, removeClip, togglePin, CLIP_MAX } from "@/lib/cliphistory";
import { exportClips, parseClipImport } from "@/lib/clip-io";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";

/**
 * PR-12. History of copies made *through Fusion*. A web app cannot observe the
 * system clipboard in the background (reads need focus + a gesture), so global
 * history is impossible and the scope is stated. Sensitive entries (Vault) are
 * masked at capture time and never persisted.
 */
export default function ClipboardModule(_: ModuleProps) {
  const shell = useShell();
  const [pasted, setPasted] = useState("");
  const [q, setQ] = useState("");
  const shown = filterClips(ordered(shell.clips), q);
  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="primary" disabled={!capAvailable(shell.caps, "clipboardRead")} onClick={async () => {
          try {
            const t = await clipboardRead("Clipboard");
            setPasted(t);
            await shell.copy(t, "system clipboard (explicit read)");
          } catch (e) { shell.toast(`Clipboard read refused: ${String((e as Error).message)}`, "warn"); }
        }}>Capture system clipboard now</Btn>
        <Badge>{shell.clips.length} entries · memory only</Badge>
        <Btn variant="ghost" disabled={!shell.clips.some((c) => !c.pinned)} onClick={() => shell.editClips(clearUnpinned)}>Clear<span className="sr-only"> unpinned entries</span></Btn>
        <Btn variant="ghost" disabled={!shell.clips.length} onClick={() => {
          const url = URL.createObjectURL(new Blob([exportClips(shell.clips)], { type: "application/json" }));
          const a = document.createElement("a"); a.href = url; a.download = "clipboard-history.json"; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }}>Export</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import
          <input type="file" accept=".json,application/json" hidden aria-label="Import clipboard history" onChange={async (e) => {
            const f = e.target.files?.[0]; if (!f) return;
            try {
              const r = parseClipImport(await f.text(), shell.clips);
              if (r.added.length) shell.editClips((l) => [...r.added, ...l]);
              shell.toast(`Clipboard import: ${r.added.length} added, ${r.skippedDuplicates} duplicates skipped, ${r.refusedSensitive} sensitive refused`, "ok");
            } catch (err) { shell.toast(`Clipboard import refused: ${String((err as Error).message)}`, "warn"); }
            e.target.value = "";
          }} />
        </label>
      </div>
      {shell.clips.length ? <input className="fs-input" type="search" aria-label="Search clipboard history" placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
      {pasted ? <div className="fs-dim" style={{ fontSize: fz(11) }}>Captured {pasted.length} characters with your explicit permission.</div> : null}
      {shell.clips.length === 0 ? <Empty title="No copies yet" hint="Copy a path in Files, a result in Calculator, or capture the system clipboard above." icon="📋" /> : null}
      {shell.clips.length && !shown.length ? <div className="fs-dim" data-testid="clip-none">No entries match “{q}”.</div> : null}
      <div role="list" aria-label="Clipboard history" data-testid="clip-list" style={{ display: "grid", gap: 2 }}>
        {shown.map((c, i) => (
          <div key={c.at} role="listitem" className="fs-list-item" data-pinned={c.pinned ? "1" : undefined}>
            <span className="fs-mono" style={{ flex: 1, fontSize: fz(11.5), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.text}</span>
            {c.sensitive ? <Badge tone="warn">sensitive · masked</Badge> : null}
            <Badge>{c.from}</Badge>
            <span className="fs-dim" style={{ fontSize: fz(10.5) }}>{new Date(c.at).toLocaleTimeString()}</span>
            <Btn variant="ghost" disabled={c.sensitive} onClick={() => void shell.copy(c.text, "clipboard history")}>Copy again<span className="sr-only"> entry {i + 1}</span></Btn>
            <Btn variant="ghost" disabled={c.sensitive} aria-pressed={!!c.pinned} onClick={() => shell.editClips((l) => togglePin(l, c.at))}>{c.pinned ? "Unpin" : "Pin"}<span className="sr-only"> entry {i + 1}</span></Btn>
            <Btn variant="ghost" onClick={() => shell.editClips((l) => removeClip(l, c.at))}>Remove<span className="sr-only"> entry {i + 1}</span></Btn>
          </div>
        ))}
      </div>
      <Section title="Scope">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          History covers copies made inside Fusion plus explicit captures. Copies made in other apps are invisible
          until you press “Capture”: browsers only allow clipboard reads with focus and a user gesture, and there is no
          IME route for a web app. History lives in memory and is gone on reload — by design, since clipboards carry
          secrets. Copying the same text again moves it to the top; up to {CLIP_MAX} unpinned entries are kept and pinned
          ones are never dropped. Sensitive copies (Vault) are stored masked, and the system clipboard is cleared after
          30 seconds if it still holds the secret.
        </div>
      </Section>
    </div>
  );
}
