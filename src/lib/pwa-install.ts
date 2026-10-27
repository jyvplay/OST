"use client";

interface InstallChoice { outcome: "accepted" | "dismissed"; platform?: string }
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
}
type Listener = (available: boolean, installed: boolean) => void;

let promptEvent: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<Listener>();

function emit(): void { for (const listener of listeners) listener(Boolean(promptEvent), installed); }

/** Called only for the real browser beforeinstallprompt event (never synthesized by Fusion). */
export function captureInstallPrompt(event: Event): boolean {
  const candidate = event as InstallPromptEvent;
  if (typeof candidate.prompt !== "function" || !candidate.userChoice) return false;
  event.preventDefault();
  promptEvent = candidate;
  installed = false;
  emit();
  return true;
}

export function markPwaInstalled(): void {
  installed = true;
  promptEvent = null;
  emit();
}

export function subscribePwaInstall(listener: Listener): () => void {
  listeners.add(listener);
  listener(Boolean(promptEvent), installed);
  return () => { listeners.delete(listener); };
}

export async function requestPwaInstall(): Promise<InstallChoice | null> {
  const event = promptEvent;
  if (!event) return null;
  promptEvent = null;
  emit();
  await event.prompt();
  const choice = await event.userChoice;
  if (choice.outcome === "accepted") installed = true;
  emit();
  return choice;
}
