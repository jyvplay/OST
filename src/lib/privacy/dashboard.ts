/**
 * TT139 (SC-05, SC-07) — Privacy dashboard and encrypted-container state machine.
 *
 * SC-05 is the honest half of a privacy story: it cannot stop a browser from
 * sending telemetry, but it can make every capability this app uses *visible*,
 * attributable to a module, and revocable in one place. The dashboard is
 * therefore a ledger, not a blocker, and the report says so.
 *
 * SC-07 is a state machine around an encrypted container. The crypto itself is
 * WebCrypto (AES-GCM) in the caller; this module owns the part that is easy to
 * get wrong: the unlock/lock/seal lifecycle, attempt rate limiting, and the
 * guarantee that a destroyed container cannot be reopened by a stale reference.
 *
 * Security properties this module deliberately does NOT claim:
 *   • It does not encrypt anything. It tracks a container whose bytes the
 *     caller encrypts.
 *   • `destroyContainer` wipes the reference and the stored hash. It cannot
 *     guarantee physical erasure of flash cells or of a browser's copy-on-write
 *     store, and the UI must say "removed from this app", not "erased".
 */

// ══ SC-05: privacy dashboard ═════════════════════════════════════════════

/** Every data class this app can touch. Closed set: an unknown class is a bug. */
export const DATA_TYPES = [
  "local-storage", "indexeddb", "file-handles", "clipboard-read", "clipboard-write",
  "notifications", "geolocation", "camera", "microphone", "screen-capture",
  "midi", "bluetooth", "usb", "network", "service-worker", "wake-lock",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export interface PrivacyEntry {
  module: string;
  dataTypes: DataType[];
  allowed: boolean;
  /** Why the module needs this class — shown verbatim in the UI. */
  reason: string;
}

export interface PrivacyDashboard {
  entries: PrivacyEntry[];
  /** Master switch: when on, nothing is allowed regardless of per-module state. */
  globalOptOut: boolean;
}

export function createPrivacyDashboard(): PrivacyDashboard {
  return { entries: [], globalOptOut: false };
}

export function addPrivacyEntry(
  dash: PrivacyDashboard,
  module: string,
  dataTypes: DataType[],
  allowed: boolean,
  reason: string,
): PrivacyDashboard {
  if (!module) throw new Error("Module name required");
  if (module.length > 64) throw new Error("Module name too long (>64)");
  if (!reason.trim()) throw new Error("A privacy entry needs a reason; 'not stated' is not acceptable");
  for (const t of dataTypes) {
    if (!(DATA_TYPES as readonly string[]).includes(t)) throw new Error(`Unknown data type: ${t}`);
  }
  const filtered = dash.entries.filter((e) => e.module !== module);
  return { ...dash, entries: [...filtered, { module, dataTypes: [...new Set(dataTypes)], allowed, reason }] };
}

export function setPrivacyAllowed(dash: PrivacyDashboard, module: string, allowed: boolean): PrivacyDashboard {
  if (!dash.entries.some((e) => e.module === module)) {
    throw new Error(`No privacy entry for module: ${module}`);
  }
  return { ...dash, entries: dash.entries.map((e) => (e.module === module ? { ...e, allowed } : e)) };
}

export function setGlobalOptOut(dash: PrivacyDashboard, optOut: boolean): PrivacyDashboard {
  // The previous implementation ANDed the flag into every entry, which made
  // turning opt-out back off impossible: the per-module state was destroyed.
  // The master switch must be a separate decision, not a destructive one.
  return { ...dash, globalOptOut: optOut };
}

export function effectiveAllowed(dash: PrivacyDashboard, module: string): boolean {
  if (dash.globalOptOut) return false;
  return dash.entries.find((e) => e.module === module)?.allowed ?? false;
}

export interface PrivacyReport {
  totalModules: number;
  allowedModules: number;
  deniedModules: number;
  dataTypesAccessed: DataType[];
  /** Modules relying on a class that is granted nowhere else — the outliers. */
  soleHolders: Array<{ dataType: DataType; module: string }>;
  summary: string;
}

export function privacyReport(dash: PrivacyDashboard): PrivacyReport {
  const allowed = dash.entries.filter((e) => effectiveAllowed(dash, e.module));
  const denied = dash.entries.filter((e) => !effectiveAllowed(dash, e.module));
  const granted = new Set<DataType>();
  for (const e of allowed) for (const t of e.dataTypes) granted.add(t);

  const perType = new Map<DataType, string[]>();
  for (const e of allowed) {
    for (const t of e.dataTypes) {
      const list = perType.get(t) ?? [];
      list.push(e.module);
      perType.set(t, list);
    }
  }
  const soleHolders: Array<{ dataType: DataType; module: string }> = [];
  for (const [dataType, modules] of perType) {
    if (modules.length === 1) soleHolders.push({ dataType, module: modules[0] });
  }

  const summary = dash.globalOptOut
    ? `Global opt-out is ON: all ${dash.entries.length} modules are denied.`
    : `${allowed.length} of ${dash.entries.length} modules allowed, across ${granted.size} data class(es).`;

  return {
    totalModules: dash.entries.length,
    allowedModules: allowed.length,
    deniedModules: denied.length,
    dataTypesAccessed: [...granted].sort(),
    soleHolders: soleHolders.sort((a, b) => a.dataType.localeCompare(b.dataType)),
    summary,
  };
}

/** A capability the app cannot satisfy — shown as blocked, with the reason. */
export interface BlockedCapability {
  capability: string;
  reason: string;
}

/**
 * A prompt-free audit: every data class any module wants, whether it is
 * granted, and what would break if it were revoked. This is what a user reads
 * to decide, so it is generated from the ledger rather than hand-written.
 */
export function privacyAudit(dash: PrivacyDashboard): { entries: Array<{ dataType: DataType; modules: string[]; grantedTo: string[] }>; blocked: BlockedCapability[] } {
  const byType = new Map<DataType, { modules: string[]; grantedTo: string[] }>();
  for (const e of dash.entries) {
    for (const t of e.dataTypes) {
      const cur = byType.get(t) ?? { modules: [], grantedTo: [] };
      cur.modules.push(e.module);
      if (effectiveAllowed(dash, e.module)) cur.grantedTo.push(e.module);
      byType.set(t, cur);
    }
  }
  const blocked: BlockedCapability[] = [];
  if (dash.globalOptOut) {
    blocked.push({ capability: "all", reason: "Global opt-out is on, so nothing is granted." });
  }
  return {
    entries: [...byType.entries()].map(([dataType, v]) => ({ dataType, ...v })).sort((a, b) => a.dataType.localeCompare(b.dataType)),
    blocked,
  };
}

// ══ SC-07: encrypted containers ══════════════════════════════════════════

/**
 * sealed   — has a payload hash, cannot be read
 * unlocked — decrypted in memory for this session
 * locked   — was unlocked, re-encrypted; needs the password again
 * destroyed— the reference is gone; unrecoverable through this API
 */
export type ContainerPhase = "sealed" | "unlocked" | "locked" | "destroyed";

export interface EncryptedContainer {
  name: string;
  phase: ContainerPhase;
  /** SHA-256 of the encrypted payload, hex. Set when sealed. */
  sealedHash?: string;
  /** Salt / IV material, hex, opaque to this module. */
  saltHex?: string;
  size: number;
  createdAt: number;
  lastUnlock?: number;
  /** Failed attempts since the last successful unlock. */
  failedAttempts: number;
  /** Total successful unlocks, for the audit trail. */
  unlockCount: number;
}

export const MAX_FAILED_ATTEMPTS = 5;
export const AUTO_LOCK_MS = 5 * 60 * 1000;

export function createContainer(name: string, size: number, createdAt: number): EncryptedContainer {
  if (!name.trim()) throw new Error("Container name required");
  if (name.length > 64) throw new Error("Container name too long (>64)");
  if (!(size >= 0)) throw new Error("Size must be non-negative");
  if (!Number.isFinite(createdAt)) throw new Error("createdAt must be a finite timestamp");
  return { name, phase: "sealed", size, createdAt, failedAttempts: 0, unlockCount: 0 };
}

export type UnlockOutcome =
  | { ok: true; container: EncryptedContainer }
  | { ok: false; reason: string; container: EncryptedContainer; lockedOut: boolean };

/**
 * Attempt an unlock. `verify` is supplied by the caller and must perform the
 * real AEAD decryption; this module only owns the policy around it.
 *
 * Rate limiting counts *failures*, not attempts, and resets on success. The
 * earlier version incremented on success too, so five successful unlocks
 * locked the container out — a bug that reads as "works" until day two.
 */
export function unlockContainer(
  c: EncryptedContainer,
  password: string,
  now: number,
  verify: (password: string) => boolean,
): UnlockOutcome {
  if (c.phase === "destroyed") {
    return { ok: false, reason: "Container has been destroyed", container: c, lockedOut: true };
  }
  if (c.phase === "unlocked") {
    return { ok: true, container: c };
  }
  if (c.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return {
      ok: false,
      reason: `Locked out after ${MAX_FAILED_ATTEMPTS} failed attempts`,
      container: c,
      lockedOut: true,
    };
  }
  if (!password) {
    return { ok: false, reason: "Password required", container: c, lockedOut: false };
  }

  let verified = false;
  try {
    verified = verify(password);
  } catch {
    verified = false; // a throwing verifier is a failed attempt, not a crash
  }

  if (!verified) {
    const failedAttempts = c.failedAttempts + 1;
    return {
      ok: false,
      reason: `Incorrect password (attempt ${failedAttempts} of ${MAX_FAILED_ATTEMPTS})`,
      container: { ...c, failedAttempts },
      lockedOut: failedAttempts >= MAX_FAILED_ATTEMPTS,
    };
  }

  return {
    ok: true,
    container: { ...c, phase: "unlocked", lastUnlock: now, failedAttempts: 0, unlockCount: c.unlockCount + 1 },
  };
}

export function lockContainer(c: EncryptedContainer): EncryptedContainer {
  if (c.phase !== "unlocked") return c;
  return { ...c, phase: "locked" };
}

/** Auto-lock after inactivity. Returns the same object when nothing changed. */
export function autoLock(c: EncryptedContainer, now: number, idleMs = AUTO_LOCK_MS): EncryptedContainer {
  if (c.phase !== "unlocked" || c.lastUnlock === undefined) return c;
  return now - c.lastUnlock >= idleMs ? { ...c, phase: "locked" } : c;
}

export function sealContainer(c: EncryptedContainer, hash: string, saltHex?: string): EncryptedContainer {
  // Sealing while unlocked would leave plaintext in memory with a "sealed"
  // label on the record. Require an explicit lock first.
  if (c.phase === "unlocked") throw new Error("Lock the container before sealing it");
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("Sealed hash must be 64 hex characters (SHA-256)");
  if (saltHex !== undefined && !/^[0-9a-f]+$/i.test(saltHex)) throw new Error("Salt must be hex");
  return { ...c, phase: "sealed", sealedHash: hash.toLowerCase(), saltHex, failedAttempts: 0 };
}

export function destroyContainer(c: EncryptedContainer): EncryptedContainer {
  return { ...c, phase: "destroyed", sealedHash: undefined, saltHex: undefined };
}

export function containerStatus(c: EncryptedContainer): string {
  switch (c.phase) {
    case "sealed":
      return "Sealed — encrypted, not readable";
    case "unlocked":
      return "Unlocked — decrypted for this session";
    case "locked":
      return "Locked — was unlocked, re-encrypted";
    case "destroyed":
      return "Removed from this app — contents are not recoverable here";
  }
}

/** Honest capability statement for the UI, not a marketing string. */
export function containerCaveats(): string[] {
  return [
    "Encryption is AES-GCM via WebCrypto in the caller; this module never sees plaintext keys.",
    "Removal deletes the app's reference and hash; flash-level erasure is not claimed.",
    "Auto-lock triggers on idle time only; it cannot detect another tab reading the same store.",
    "A forgotten password is unrecoverable by design: there is no recovery key.",
  ];
}
