"use client";

import { fz } from "@/lib/uiscale";
import { useEffect, useMemo, useState } from "react";
import { fmtBytes } from "@/lib/api";
import { MODULES } from "@/lib/registry";
import { filterApps, appGroups } from "@/lib/app-filter";
import { getBackgroundInventory, subscribeBackgroundInventory, type BackgroundJobSnapshot } from "@/lib/background-inventory";
import { requestPwaInstall, subscribePwaInstall } from "@/lib/pwa-install";
import { useShell, type ModuleProps } from "../shell-context";
import { AppIcon } from "../AppIcon";
import { Badge, Btn, KV, Section, Tabs } from "../ui";

type HubTab = "apps" | "background";
interface AppManifest {
  name?: string;
  short_name?: string;
  id?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  display_override?: string[];
  related_applications?: { platform?: string; id?: string; url?: string }[];
  file_handlers?: { action?: string; accept?: Record<string, string[]> }[];
  protocol_handlers?: { protocol?: string; url?: string }[];
  share_target?: { action?: string; method?: string; params?: Record<string, string> };
}
interface RelatedApp { platform?: string; id?: string; url?: string }
type TagsResult = { state: "available" | "not-exposed" | "query-failed"; tags: string[]; detail: string };
interface RegistrationView {
  scope: string;
  updateViaCache: string;
  active: { scriptURL: string; state: string } | null;
  waiting: { scriptURL: string; state: string } | null;
  installing: { scriptURL: string; state: string } | null;
  sync: TagsResult;
  periodic: TagsResult;
}
type ServiceWorkerRegistrationExtended = ServiceWorkerRegistration & {
  sync?: { getTags?: () => Promise<string[]> };
  periodicSync?: { getTags?: () => Promise<string[]> };
};
type InstallListener = (available: boolean, installed: boolean) => void;

async function inspectTags(manager: { getTags?: () => Promise<string[]> } | undefined): Promise<TagsResult> {
  if (!manager || typeof manager.getTags !== "function") return { state: "not-exposed", tags: [], detail: "API not exposed by this browser" };
  try {
    const tags = await manager.getTags();
    return { state: "available", tags: Array.isArray(tags) ? tags.filter((x) => typeof x === "string") : [], detail: "Read from the live ServiceWorkerRegistration API" };
  } catch (e) {
    return { state: "query-failed", tags: [], detail: `Browser refused query: ${String((e as Error).message ?? e).slice(0, 120)}` };
  }
}
function workerInfo(worker: ServiceWorker | null): RegistrationView["active"] {
  return worker ? { scriptURL: worker.scriptURL, state: worker.state } : null;
}
async function inspectRegistrations(): Promise<{ state: string; registrations: RegistrationView[]; permission: string }> {
  if (!("serviceWorker" in navigator)) return { state: "not-exposed", registrations: [], permission: "not exposed" };
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    const registrations = await Promise.all(regs.map(async (reg) => {
      const extended = reg as ServiceWorkerRegistrationExtended;
      const [sync, periodic] = await Promise.all([inspectTags(extended.sync), inspectTags(extended.periodicSync)]);
      return {
        scope: reg.scope,
        updateViaCache: reg.updateViaCache,
        active: workerInfo(reg.active),
        waiting: workerInfo(reg.waiting),
        installing: workerInfo(reg.installing),
        sync,
        periodic,
      };
    }));
    let permission = "not queried";
    const periodicAvailable = registrations.some((r) => r.periodic.state !== "not-exposed");
    if (periodicAvailable && navigator.permissions?.query) {
      try { permission = (await navigator.permissions.query({ name: "periodic-background-sync" as PermissionName })).state; }
      catch { permission = "query not permitted by browser"; }
    } else if (!periodicAvailable) permission = "API not exposed";
    return { state: "available", registrations, permission };
  } catch (e) {
    return { state: `query-failed: ${String((e as Error).message ?? e).slice(0, 120)}`, registrations: [], permission: "unknown" };
  }
}

function displayMode(): string {
  if (typeof window === "undefined") return "unknown";
  for (const [query, label] of [["(display-mode: window-controls-overlay)", "window-controls-overlay"], ["(display-mode: standalone)", "standalone"], ["(display-mode: minimal-ui)", "minimal-ui"], ["(display-mode: fullscreen)", "fullscreen"]] as const) {
    if (window.matchMedia?.(query).matches) return label;
  }
  if (Boolean((navigator as Navigator & { standalone?: boolean }).standalone)) return "standalone (platform flag)";
  return "browser tab";
}

export default function AppsModule(_: ModuleProps) {
  const shell = useShell();
  const [tab, setTab] = useState<HubTab>("apps");
  const [manifest, setManifest] = useState<AppManifest | null>(null);
  const [manifestState, setManifestState] = useState("loading manifest…");
  const [related, setRelated] = useState<RelatedApp[]>([]);
  const [relatedState, setRelatedState] = useState("waiting for manifest…");
  const [storage, setStorage] = useState<{ text: string; usage: number | null; quota: number | null; state: "loading" | "available" | "not-exposed" | "query-failed" }>({ text: "measuring origin quota…", usage: null, quota: null, state: "loading" });
  const [persisted, setPersisted] = useState("not reported");
  const [mode, setMode] = useState("checking display mode…");
  const [install, setInstall] = useState({ available: false, installed: false });
  const [sw, setSw] = useState<{ state: string; registrations: RegistrationView[]; permission: string }>({ state: "checking browser APIs…", registrations: [], permission: "unknown" });
  const [jobs, setJobs] = useState<BackgroundJobSnapshot[]>(() => getBackgroundInventory());
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => subscribePwaInstall((available, installed) => setInstall({ available, installed })), []);
  useEffect(() => subscribeBackgroundInventory(setJobs), []);

  useEffect(() => {
    let live = true;
    fetch("/manifest.webmanifest", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json() as AppManifest; })
      .then((m) => { if (live) { setManifest(m); setManifestState("read from /manifest.webmanifest"); } })
      .catch((e) => { if (live) setManifestState(`unavailable: ${String((e as Error).message ?? e).slice(0, 120)}`); });

    const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<RelatedApp[]> };
    // The API can disclose only manifest-declared, browser-verified related apps, not the device's installed-app list.
    if (!window.isSecureContext) {
      void Promise.resolve().then(() => { if (live) setRelatedState("unavailable in an insecure context; arbitrary installed apps are not enumerable"); });
    }
    else {
      fetch("/manifest.webmanifest", { cache: "no-store" }).then((r) => r.json() as Promise<AppManifest>).then(async (m) => {
        if (!live) return;
        if (!m.related_applications?.length) {
          const apiState = typeof nav.getInstalledRelatedApps === "function" ? "related-app API exposed but has no declared relationship to query" : "related-app API not exposed";
          setRelatedState(`no related apps declared; ${apiState}; arbitrary installed apps are not enumerable`);
          return;
        }
        if (typeof nav.getInstalledRelatedApps !== "function") { setRelatedState("manifest relationships declared, but browser does not expose getInstalledRelatedApps()"); return; }
        try {
          const found = await nav.getInstalledRelatedApps();
          if (live) { setRelated(found.filter((x) => x && typeof x.platform === "string")); setRelatedState("browser-reported related apps only; this is not a device-wide inventory"); }
        } catch (e) { if (live) setRelatedState(`browser query failed: ${String((e as Error).message ?? e).slice(0, 120)}`); }
      }).catch(() => { if (live) setRelatedState("manifest relationship could not be read"); });
    }

    const measure = async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (!live) return;
        setStorage(estimate
          ? { text: `${fmtBytes(estimate.usage ?? 0)} used of ${fmtBytes(estimate.quota ?? 0)} origin quota`, usage: Number(estimate.usage ?? 0), quota: Number(estimate.quota ?? 0), state: "available" }
          : { text: "Storage estimate API not exposed", usage: null, quota: null, state: "not-exposed" });
      } catch { if (live) setStorage({ text: "origin estimate unavailable", usage: null, quota: null, state: "query-failed" }); }
      try {
        const p = await navigator.storage?.persisted?.();
        if (live && typeof p === "boolean") setPersisted(p ? "persistent storage granted" : "best-effort storage; browser may evict it");
      } catch { if (live) setPersisted("persistence state unavailable"); }
    };
    void measure();
    const refresh = () => { setMode(displayMode()); void inspectRegistrations().then((r) => { if (live) setSw(r); }); };
    refresh();
    const media = window.matchMedia?.("(display-mode: standalone)");
    media?.addEventListener?.("change", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); media?.removeEventListener?.("change", refresh); };
  }, []);

  const [groupFacet, setGroupFacet] = useState("all");
  const modules = useMemo(() => filterApps(MODULES, query, groupFacet), [query, groupFacet]);

  const installNow = async () => {
    try {
      const choice = await requestPwaInstall();
      if (!choice) setNotice("No real browser install prompt is available in this session. Use the browser's install control when it offers one.");
      else if (choice.outcome === "accepted") setNotice("The browser accepted the PWA install request.");
      else setNotice("The browser install prompt was dismissed; Fusion did not retry or open another prompt.");
    } catch (e) { setNotice(`Install prompt failed: ${String((e as Error).message ?? e).slice(0, 160)}`); }
  };

  const handlerCount = (manifest?.file_handlers?.length ?? 0) + (manifest?.protocol_handlers?.length ?? 0) + (manifest?.share_target ? 1 : 0);
  return (
    <div className="fs-scroll" data-testid="app-hub" data-module-count={MODULES.length} style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Tabs<HubTab> className="fs-app-tabs" value={tab} onChange={setTab} tabs={[
        { id: "apps", label: "Apps & handlers", badge: ` ${MODULES.length}` },
        { id: "background", label: "Background & startup" },
      ]} />

      {tab === "apps" ? (
        <>
          <Section title="This Fusion PWA" right={<Badge data-testid="app-display-mode" tone={mode === "browser tab" ? "info" : "ok"}>{mode}</Badge>}>
            <KV k="Manifest" v={manifest?.name ?? manifestState} />
            <KV k="Short name / id" v={`${manifest?.short_name ?? "—"} · ${manifest?.id ?? "—"}`} mono />
            <KV k="Start URL / scope" v={`${manifest?.start_url ?? "—"} · ${manifest?.scope ?? "—"}`} mono />
            <KV k="Install prompt" v={install.installed ? <Badge tone="ok">installed event received</Badge> : install.available ? <Badge tone="ok">browser prompt available</Badge> : <Badge>no prompt event available</Badge>} />
            <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Btn data-testid="app-install" variant="primary" disabled={!install.available} onClick={() => void installNow()}>Install from browser</Btn>
              <Btn variant="ghost" onClick={() => shell.open("settings", { focus: "install PWA" })}>Install guidance</Btn>
            </div>
            {notice ? <div role="status" data-testid="app-hub-notice" className="fs-dim" style={{ fontSize: fz(11.5) }}>{notice}</div> : null}
          </Section>

          <Section title={`Declared handlers (${handlerCount})`}>
            <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>{manifestState}. These entries declare what an installed browser shell may offer; they do not prove that the OS accepted each association.</div>
            {(manifest?.file_handlers ?? []).map((handler, i) => (
              <div key={`file-${i}`} className="fs-panel" data-testid="app-file-handler" style={{ padding: 8, display: "grid", gap: 3 }}>
                <strong style={{ fontSize: fz(11.5) }}>File handler · action {handler.action ?? "(unspecified)"}</strong>
                {Object.entries(handler.accept ?? {}).map(([mime, extensions]) => <KV key={mime} k={mime} v={extensions.join(", ")} mono />)}
              </div>
            ))}
            {(manifest?.protocol_handlers ?? []).map((handler, i) => <KV key={`protocol-${i}`} k={`Protocol · ${handler.protocol ?? "unknown"}`} v={handler.url ?? "(unspecified)"} mono />)}
            {manifest?.share_target ? <KV k="Share target" v={`${manifest.share_target.method ?? "GET"} ${manifest.share_target.action ?? "(unspecified)"}`} mono /> : null}
            {handlerCount === 0 ? <div className="fs-dim">No handlers declared in the manifest.</div> : null}
          </Section>

          <Section title="Installed related apps (bounded by browser privacy)">
            <div data-testid="app-related-state" data-count={related.length} className="fs-dim" style={{ fontSize: fz(11.5) }}>{relatedState}</div>
            {related.map((app, i) => <KV key={`${app.platform}-${app.id ?? app.url ?? i}`} k={app.platform ?? "related app"} v={app.id ?? app.url ?? "browser returned no identifier"} mono />)}
            <div className="fs-dim" style={{ fontSize: fz(11) }}>Fusion does not scan the device, installed-app folders, or unrelated PWAs.</div>
          </Section>

          <Section title="Storage scope">
            <KV k="Browser origin quota" v={<span data-testid="app-storage-estimate" data-state={storage.state} data-usage={storage.usage ?? ""} data-quota={storage.quota ?? ""}>{storage.text}</span>} />
            <KV k="Eviction status" v={persisted} />
            <Badge tone="info">one shared PWA origin</Badge>
            <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.5 }}>The browser reports storage per origin, not per Fusion module. Modules also use shared server-side VFS/database buckets; there is no honest per-module byte attribution. Open Storage for exact server bucket counts and the uninstall preview.</div>
            <Btn variant="ghost" data-testid="app-open-storage" onClick={() => shell.open("storage")}>Open Storage & data assistant</Btn>
          </Section>

          <Section title={`Fusion modules (${modules.length} of ${MODULES.length})`}>
            <input className="fs-input" aria-label="Filter Fusion modules" data-testid="app-module-filter" placeholder="Find an app or feature" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="fs-select" style={{ width: "auto" }} aria-label="Filter apps by group" value={groupFacet} onChange={(e) => setGroupFacet(e.target.value)} data-testid="app-group-filter">
              <option value="all">All groups</option>
              {appGroups(MODULES).map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <div data-testid="app-module-list" style={{ display: "grid", gap: 4 }}>
              {modules.map((m) => (
                <button key={m.id} type="button" data-testid="app-module-open" data-module-id={m.id} className="fs-list-item fs-row" onClick={() => shell.open(m.id)}
                  style={{ width: "100%", justifyContent: "flex-start", gap: 8, border: "1px solid var(--fs-border)", textAlign: "left", color: "inherit", padding: 7 }}>
                  <AppIcon id={m.id} size={28} />
                  <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                    <strong style={{ fontSize: fz(11.5) }}>{m.title}<span className="fs-dim"> · {m.group}</span></strong>
                    <span className="fs-dim" style={{ fontSize: fz(10.5), lineHeight: 1.35 }}>{m.summary}</span>
                  </span>
                  <span className="fs-dim" style={{ marginInlineStart: "auto", fontSize: fz(10) }}>Open</span>
                </button>
              ))}
              {modules.length === 0 ? <div className="fs-dim">No modules match that filter.</div> : null}
            </div>
          </Section>
        </>
      ) : null}

      {tab === "background" ? (
        <>
          <Section title="Fusion-owned page jobs (DP-14)">
            <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.5 }}>Callback counts below are measured in this open page&apos;s memory. They reset on reload and are not operating-system wake counts. A throttled or suspended page may skip timers; no claim is made that a PWA runs continuously in the background.</div>
            <div data-testid="app-runtime-inventory" role="region" aria-label="Fusion background work inventory" style={{ display: "grid", gap: 6 }}>
              {jobs.map((job) => (
                <div key={job.id} data-testid="app-bg-job" data-job-id={job.id} data-callbacks={job.callbacks} className="fs-panel" style={{ padding: 8, display: "grid", gap: 4 }}>
                  <div className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontSize: fz(11.5) }}>{job.title}</strong>
                    <Badge tone={job.callbacks ? "info" : "default"}>{job.callbacks} page callbacks</Badge>
                  </div>
                  <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{job.trigger} · {job.scope}</div>
                  <div style={{ fontSize: fz(10.5) }}>{job.data}</div>
                  <div data-testid="app-bg-status" className="fs-dim" style={{ fontSize: fz(10.5) }}>Last: {job.lastAt ? new Date(job.lastAt).toLocaleTimeString() : "never"} · {job.lastStatus}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Live service-worker registrations">
            <div data-testid="app-sw-state" data-state={sw.state} className="fs-dim" style={{ fontSize: fz(11) }}>Registration query: {sw.state}</div>
            {sw.registrations.map((reg) => (
              <div key={reg.scope} data-testid="app-sw-registration" data-scope={reg.scope} className="fs-panel" style={{ padding: 8, display: "grid", gap: 4 }}>
                <KV k="Scope" v={reg.scope} mono />
                <KV k="Active worker" v={reg.active ? `${reg.active.scriptURL} · ${reg.active.state}` : "none"} mono />
                <KV k="Waiting worker" v={reg.waiting ? `${reg.waiting.scriptURL} · ${reg.waiting.state}` : "none"} mono />
                <KV k="Installing worker" v={reg.installing ? `${reg.installing.scriptURL} · ${reg.installing.state}` : "none"} mono />
                <KV k="Update cache policy" v={reg.updateViaCache} mono />
                <div data-testid="app-sync-tags" data-state={reg.sync.state} data-tags={reg.sync.tags.join(" ")}>
                  <KV k="One-off Sync tags" v={reg.sync.state === "available" ? (reg.sync.tags.length ? reg.sync.tags.join(", ") : "none registered") : reg.sync.detail} mono />
                </div>
                <div data-testid="app-periodic-sync" data-state={reg.periodic.state} data-tags={reg.periodic.tags.join(" ")}>
                  <KV k="Periodic Sync tags" v={reg.periodic.state === "available" ? (reg.periodic.tags.length ? reg.periodic.tags.join(", ") : "none registered") : reg.periodic.detail} mono />
                </div>
              </div>
            ))}
            {sw.state === "available" && sw.registrations.length === 0 ? <div className="fs-dim">No service worker registration is currently visible for this origin.</div> : null}
            <KV k="Periodic background-sync permission" v={sw.permission} mono />
            <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>Sync tags are read-only browser registrations. The browser may choose whether and when to dispatch an event; a tag is not proof of a scheduled wake. Fusion registers no periodic sync job itself.</div>
          </Section>
        </>
      ) : null}
    </div>
  );
}
