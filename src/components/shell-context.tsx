"use client";

import { createContext, useContext } from "react";
import type { CapabilityReport } from "@/lib/capabilities";
import type { GovernorSnapshot } from "@/lib/governor";
import type { RoutineAction } from "@/lib/routines";
import type { DesktopState, Rect, WindowCommand, WindowState } from "@/lib/windowing/state";

export interface ClipEntry { text: string; at: number; sensitive: boolean; from: string }

export interface BeamSession {
  id: number | null;
  target: string;
  transport: string;
  source: string;
  startedAt: number;
  stop: () => void;
}

export interface ShellApi {
  state: DesktopState;
  dispatch: (cmd: WindowCommand) => void;
  open: (moduleId: string, props?: Record<string, unknown>, rect?: Partial<Rect>) => string;
  caps: CapabilityReport | null;
  gov: GovernorSnapshot;
  settings: Record<string, string>;
  setSetting: (key: string, value: string) => Promise<void>;
  toast: (message: string, tone?: "info" | "ok" | "warn" | "bad", action?: { label: string; run: () => void }) => void;
  /** LN-13: one processed stream, many consumers. */
  streams: Map<string, MediaStream>;
  publishStream: (id: string, stream: MediaStream | null) => void;
  streamVersion: number;
  clips: ClipEntry[];
  copy: (text: string, from: string, sensitive?: boolean) => Promise<void>;
  beam: BeamSession | null;
  setBeam: (s: BeamSession | null) => void;
  commandLog: { cmd: WindowCommand; at: number }[];
  hostKind: "tab" | "pip" | "screen";
  /** called by drag/resize loops so the governor only samples real animation */
  pulse: (ts: number) => void;
  refreshTick: number;
  bumpRefresh: () => void;
  /** AU-01/AU-02: single executor for routines, presets and triggers */
  runActions: (actions: RoutineAction[]) => Promise<void>;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside the Shell");
  return ctx;
}

export interface ModuleProps { win: WindowState }
