"use client";

/**
 * TT147 (ST-02) — the OS settings index, as a panel.
 *
 * A web page cannot open a system setting for the user; it can hand the
 * browser a URI scheme and let the user decide. So this panel is a search box,
 * a short list of panels, and the URL each one would try — with the platform's
 * coverage stated ("9 of 14 panels are addressable here") instead of a promise.
 */

import { useMemo, useState } from "react";
import { fz } from "@/lib/uiscale";
import { Badge, Btn, Section } from "./ui";
import { coverage, detectPlatform, indexFor, searchEntries, type Platform } from "@/lib/settings/deep-links";

const PLATFORM_NAME: Record<Platform, string> = {
  windows: "Windows", macos: "macOS", linux: "Linux", android: "Android", ios: "iOS", unknown: "unidentified",
};

export default function SystemLinks() {
  const [q, setQ] = useState("");
  const platform = useMemo<Platform>(() => {
    if (typeof navigator === "undefined") return "unknown";
    return detectPlatform(navigator.userAgent, navigator.platform ?? "");
  }, []);
  const rows = useMemo(() => (q.trim() ? searchEntries(q, platform, 6) : indexFor(platform).slice(0, 8)), [q, platform]);
  const cov = coverage(platform);

  return (
    <Section title="System settings (ST-02)" icon="sliders"
      right={<Badge tone={cov.available > 0 ? "ok" : "warn"} data-testid="syslinks-coverage">{cov.available}/{cov.total} on {PLATFORM_NAME[platform]}</Badge>}>
      <div className="fs-row" style={{ gap: 6 }}>
        <input className="fs-input" style={{ flex: 1 }} placeholder="camera, sound, storage, time…" aria-label="Search system settings"
          value={q} onChange={(e) => setQ(e.target.value)} data-testid="syslinks-search" />
      </div>
      {rows.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(11.5) }} data-testid="syslinks-empty">nothing in the index matches that</div> : null}
      {rows.map(({ entry, link, reason }) => (
        <div key={entry.id} className="fs-row" style={{ justifyContent: "space-between", gap: 8, alignItems: "center" }} data-syslink={entry.id}>
          <span style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: fz(12) }}>{entry.label}</div>
            <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{link ? link.caveat : reason}</div>
          </span>
          {link ? (
            <Btn variant="ghost" data-testid={`syslink-open-${entry.id}`}
              title={link.uri}
              onClick={() => { window.location.href = link.uri; }}>Open panel</Btn>
          ) : <Badge tone="default">no link</Badge>}
        </div>
      ))}
      <div className="fs-dim" style={{ fontSize: fz(10.5) }}>
        These are the OS&apos;s own URI schemes. Your browser may ask first, open a different page, or do nothing — this app cannot see which.
      </div>
    </Section>
  );
}
