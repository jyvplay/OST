"use client";

import { useState } from "react";
import { capAvailable } from "@/lib/capabilities";
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
  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="primary" disabled={!capAvailable(shell.caps, "clipboardRead")} onClick={async () => {
          try {
            const t = await navigator.clipboard.readText();
            setPasted(t);
            await shell.copy(t, "system clipboard (explicit read)");
          } catch (e) { shell.toast(`Clipboard read refused: ${String((e as Error).message)}`, "warn"); }
        }}>Capture system clipboard now</Btn>
        <Badge>{shell.clips.length} entries · memory only</Badge>
      </div>
      {pasted ? <div className="fs-dim" style={{ fontSize: 11 }}>Captured {pasted.length} characters with your explicit permission.</div> : null}
      {shell.clips.length === 0 ? <Empty title="No copies yet" hint="Copy a path in Files, a result in Calculator, or capture the system clipboard above." icon="📋" /> : null}
      <div style={{ display: "grid", gap: 2 }}>
        {shell.clips.map((c, i) => (
          <div key={i} className="fs-list-item">
            <span className="fs-mono" style={{ flex: 1, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.text}</span>
            {c.sensitive ? <Badge tone="warn">sensitive · masked</Badge> : null}
            <Badge>{c.from}</Badge>
            <span className="fs-dim" style={{ fontSize: 10.5 }}>{new Date(c.at).toLocaleTimeString()}</span>
            <Btn variant="ghost" disabled={c.sensitive} onClick={() => void shell.copy(c.text, "clipboard history")}>Copy again</Btn>
          </div>
        ))}
      </div>
      <Section title="Scope">
        <div className="fs-dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          History covers copies made inside Fusion plus explicit captures. Copies made in other apps are invisible
          until you press “Capture”: browsers only allow clipboard reads with focus and a user gesture, and there is no
          IME route for a web app. History lives in memory and is gone on reload — by design, since clipboards carry
          secrets.
        </div>
      </Section>
    </div>
  );
}
