"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { privacy } from "@/lib/privacy/session";
import {
  changeContextProfile, classifyContext, CONTEXT_PROFILE_KEY, defaultContextConfig, parseContextConfig,
  type ContextConfig, type ContextKind, type ContextObservation, type ContextProfile,
} from "@/lib/context-profiles";

export interface ContextProfilesApi {
  config: ContextConfig;
  observation: ContextObservation | null;
  active: ContextProfile | null;
  storage: "checking" | "browser" | "memory";
  setEnabled: (enabled: boolean) => void;
  setProfile: (kind: ContextKind, profile: ContextProfile) => void;
  reset: () => void;
}

function observe(): ContextObservation {
  const screen = window.screen as Screen & { isExtended?: boolean };
  let extended: boolean | undefined;
  try { if (typeof screen.isExtended === "boolean") extended = screen.isExtended; } catch { /* unsupported */ }
  let coarse = false;
  try { coarse = !!window.matchMedia?.("(pointer: coarse)").matches; } catch { /* unsupported */ }
  return classifyContext(extended, coarse);
}

/** No permission prompt. When enabled, listen for changes and cheaply recheck
 * the display bit while visible: some browsers fail to deliver Screen.change. */
export function useContextProfiles(): ContextProfilesApi {
  const [config, setConfig] = useState<ContextConfig>(defaultContextConfig);
  const configRef = useRef<ContextConfig>(defaultContextConfig());
  const [observation, setObservation] = useState<ContextObservation | null>(null);
  const [storage, setStorage] = useState<ContextProfilesApi["storage"]>("checking");

  useEffect(() => {
    let alive = true;
    // Read after hydration; the server cannot access this browser-local setting.
    queueMicrotask(() => {
      if (!alive) return;
      try {
        const value = parseContextConfig(window.localStorage.getItem(CONTEXT_PROFILE_KEY));
        configRef.current = value; setConfig(value);
        setStorage(privacy.status().amnesic ? "memory" : "browser");
      } catch { setStorage("memory"); }
    });
    const onStorage = (e: StorageEvent) => {
      if (privacy.status().amnesic || (e.key !== CONTEXT_PROFILE_KEY && e.key !== null)) return;
      const value = parseContextConfig(e.key === null ? null : e.newValue);
      configRef.current = value; setConfig(value);
    };
    window.addEventListener("storage", onStorage);
    return () => { alive = false; window.removeEventListener("storage", onStorage); };
  }, []);

  useEffect(() => {
    if (!config.enabled) return;
    const update = () => {
      const now = observe();
      setObservation((old) => old && old.kind === now.kind && old.displayDetection === now.displayDetection && old.primaryCoarse === now.primaryCoarse ? old : now);
    };
    let media: MediaQueryList | null = null;
    try { media = window.matchMedia?.("(pointer: coarse)") ?? null; } catch { /* unsupported */ }
    let timer: number | null = null;
    const visibility = () => {
      if (document.visibilityState === "visible") {
        update();
        if (timer === null) timer = window.setInterval(update, 3000);
      } else if (timer !== null) { window.clearInterval(timer); timer = null; }
    };
    const screenEvents = window.screen as unknown as Partial<EventTarget>;
    media?.addEventListener("change", update);
    screenEvents.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      if (timer !== null) window.clearInterval(timer);
      media?.removeEventListener("change", update);
      screenEvents.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [config.enabled]);

  const commit = useCallback((value: ContextConfig) => {
    configRef.current = value; setConfig(value);
    if (!value.enabled) setObservation(null);
    if (privacy.status().amnesic) { setStorage("memory"); return; }
    try { window.localStorage.setItem(CONTEXT_PROFILE_KEY, JSON.stringify(value)); setStorage("browser"); }
    catch { setStorage("memory"); }
  }, []);
  const setEnabled = useCallback((enabled: boolean) => commit({ ...configRef.current, enabled }), [commit]);
  const setProfile = useCallback((kind: ContextKind, profile: ContextProfile) => commit(changeContextProfile(configRef.current, kind, profile)), [commit]);
  const reset = useCallback(() => commit(defaultContextConfig()), [commit]);
  return useMemo(() => ({ config, observation, active: config.enabled && observation ? config.profiles[observation.kind] : null, storage, setEnabled, setProfile, reset }),
    [config, observation, storage, setEnabled, setProfile, reset]);
}
