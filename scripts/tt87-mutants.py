#!/usr/bin/env python3
"""Temporarily inject defects; run actual Node/HTTP/Chromium gates; always restore sources."""
from pathlib import Path
import os
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
NODE = ["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"]
# (name, source, original text, replacement, test script, HARNESS_ONLY)
MUTANTS = [
    ("ignore the complete snapshot checksum", "src/lib/backup/bundle.ts",
     'if (!legacy && (input.manifest as { sha256: string }).sha256 !== digest)',
     'if (false && !legacy && (input.manifest as { sha256: string }).sha256 !== digest)',
     "tt87-backup.mts", "TT87 checksum"),
    ("accept extra legacy manifest entries", "src/lib/backup/bundle.ts",
     'if (legacy && legacyManifest.size !== entries.length)',
     'if (false && legacy && legacyManifest.size !== entries.length)',
     "tt87-backup.mts", "TT87 legacy"),
    ("accept duplicate file paths", "src/lib/backup/bundle.ts",
     'if (paths.has(path)) return failure(path, "duplicate path");',
     'if (false && paths.has(path)) return failure(path, "duplicate path");',
     "tt87-backup.mts", "TT87 refuses"),
    ("collapse duplicate note occurrences", "src/lib/server/backup-restore.ts",
     'if (count < (existingCount.get(key) ?? 0)) summary.notesUnchanged += 1;',
     'if ((existingCount.get(key) ?? 0) > 0) summary.notesUnchanged += 1;',
     "tt87-backup-http.mts", "BK-01 identical"),
    ("do not reject a stale restore preview", "src/lib/server/backup-restore.ts",
     'if (!token || token !== plan.token)',
     'if (!token)',
     "tt87-backup-http.mts", "BK-03 config export"),
    ("skip known-setting validation", "src/lib/server/backup-restore.ts",
     'if (invalid) throw new RestoreError(`Invalid setting ${item.key}: ${invalid}. Nothing was restored.`, 422);',
     'if (false && invalid) throw new RestoreError(`Invalid setting ${item.key}: ${invalid}. Nothing was restored.`, 422);',
     "tt87-backup-http.mts", "BK-03 stale preview"),
    ("fail to report locked settings", "src/lib/server/backup-restore.ts",
     'if (current.lockReason) { summary.settingsLocked.push(item.key); continue; }',
     'if (false && current.lockReason) { summary.settingsLocked.push(item.key); continue; }',
     "tt87-backup-http.mts", "BK-03 stale preview"),
    ("omit settings undo history", "src/lib/server/backup-restore.ts",
     'await tx.insert(settingsHistory).values({ key: item.key, oldValue: current.value, newValue: item.value });',
     '/* injected mutation: omit settings history */',
     "tt87-backup-http.mts", "BK-03 config export"),
    ("index private restored contents", "src/lib/server/backup-restore.ts",
     'if (isPrivateVfsPath(entry.path)) {',
     'if (false && isPrivateVfsPath(entry.path)) {',
     "tt87-backup-http.mts", "BK-01 restores private"),
    ("skip VFS version check for conditional writes", "src/lib/server/conditional-write.ts",
     'existing.version !== expected.version || existing.sha256 !== expected.sha256',
     'false || existing.sha256 !== expected.sha256',
     "e2e-tt87-localdisk.mts", "BK-02,FM-08,TT87"),
    ("allow conflict resolution from a stale local copy", "src/lib/local-folder-sync.ts",
     'local.sha256 !== conflict.localSha || !vfsText(remote)',
     'false || !vfsText(remote)',
     "e2e-tt87-localdisk.mts", "BK-02,FM-08,TT87"),
    ("allow a 257th queued pointer sample", "src/lib/pointer-triggers.ts",
     'if (pending.length >= MAX_POINTER_SAMPLES_PER_FRAME)',
     'if (pending.length > MAX_POINTER_SAMPLES_PER_FRAME)',
     "tt87-pointer-queue.mts", "SH-06"),
    ("restore legacy backups without explicit consent", "src/app/api/backup/route.ts",
     'if (verification.legacy && !dryRun && body.allowLegacy !== true)',
     'if (false && verification.legacy && !dryRun && body.allowLegacy !== true)',
     "tt87-backup-http.mts", "BK-01 legacy"),
    ("forward conditional writes in amnesic mode", "src/lib/privacy/layer.ts",
     'if (this.amnesic) { this.note("fs.writeIfUnchanged"); throw new HttpError(423, "amnesic session: conditional host writes are unavailable"); }',
     'if (false && this.amnesic) { this.note("fs.writeIfUnchanged"); throw new HttpError(423, "amnesic session: conditional host writes are unavailable"); }',
     "privacy-layer.mts", "TT87 conditional"),
    ("forward plaintext conditional writes into Private", "src/lib/privacy/layer.ts",
     'if (this.storeOf(path) === "private") throw new HttpError(422, "conditional writes are not available inside Persistent Storage; use an encrypted write");',
     'if (false && this.storeOf(path) === "private") throw new HttpError(422, "conditional writes are not available inside Persistent Storage; use an encrypted write");',
     "privacy-layer.mts", "TT87 conditional"),
    ("forward unreviewed fs operations during amnesia", "src/lib/privacy/layer.ts",
     'if (this.amnesic) { this.note(`fs.${op || "unknown"}`); throw new HttpError(423, "amnesic session: unsupported host write refused"); }',
     'if (false && this.amnesic) { this.note(`fs.${op || "unknown"}`); throw new HttpError(423, "amnesic session: unsupported host write refused"); }',
     "privacy-layer.mts", "TT87 conditional"),
    ("show local-folder controls in amnesic mode", "src/components/modules/LocalDisk.tsx",
     'if (amnesic) {\n    return <div style={{ padding: 12 }} role="status">Local folders are unavailable',
     'if (false && amnesic) {\n    return <div style={{ padding: 12 }} role="status">Local folders are unavailable',
     "e2e-tt87-privacy.mts", "TT87 LocalDisk"),
    ("treat PostgreSQL ROLLBACK as a successful COMMIT", "src/lib/server/transaction.ts",
     'if (outcome.command !== "COMMIT") throw new Error("PostgreSQL did not commit the transaction.");',
     'if (false && outcome.command !== "COMMIT") throw new Error("PostgreSQL did not commit the transaction.");',
     "tt87-transaction.mts", "TT87 PostgreSQL"),
    ("return an uncertain or failed-BEGIN client to the pool", "src/lib/server/transaction.ts",
     'discard = true;\n    }\n    throw error;',
     'discard = false;\n    }\n    throw error;',
     "tt87-transaction.mts", "TT87 a real failed BEGIN,TT87 a lost commit"),
    ("mark a moving Tabletop face as settled until a passive effect runs", "src/components/Tabletop.tsx",
     'useLayoutEffect(() => {\n    const el = root.current; if (!el) return;',
     'useEffect(() => {\n    const el = root.current; if (!el) return;',
     "e2e-tabletop.mts", "walls are pinboards"),
]

originals = {str(ROOT / path): (ROOT / path).read_text() for _, path, *_ in MUTANTS}
killed, survived, crashed = [], [], []
try:
    for i, (name, rel, old, new, script, only) in enumerate(MUTANTS, 1):
        path = ROOT / rel
        original = originals[str(path)]
        if original.count(old) != 1:
            print(f"HARNESS ERROR M{i}: {rel} has {original.count(old)} matches", flush=True)
            crashed.append(name)
            continue
        path.write_text(original.replace(old, new, 1))
        env = os.environ.copy()
        env["HARNESS_ONLY"] = only
        env.setdefault("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:5432/app_db")
        env.setdefault("BASE", "http://localhost:3999")
        try:
            r = subprocess.run(NODE + [f"scripts/{script}"], cwd=ROOT, env=env, text=True, capture_output=True, timeout=150)
            output = r.stdout + r.stderr
            if r.returncode != 0 and re.search(r"\b[1-9][0-9]* failed\b", output):
                killed.append(name); print(f"KILLED M{i}: {name}", flush=True)
            elif r.returncode == 0:
                survived.append(name); print(f"SURVIVED M{i}: {name}\n{output[-500:]}", flush=True)
            else:
                crashed.append(name); print(f"CRASHED M{i}: {name}\n{output[-1400:]}", flush=True)
        except subprocess.TimeoutExpired:
            crashed.append(name); print(f"CRASHED M{i}: {name} timed out", flush=True)
        finally:
            path.write_text(original)
finally:
    for path, text in originals.items():
        Path(path).write_text(text)

print(f"Mutants: {len(killed)}/{len(MUTANTS)} killed")
if survived: print("Survivors:", "; ".join(survived))
if crashed: print("Crashes:", "; ".join(crashed))
sys.exit(0 if len(killed) == len(MUTANTS) and not survived and not crashed else 1)
