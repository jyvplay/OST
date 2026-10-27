#!/usr/bin/env python3
"""One-at-a-time deliberate defects. ONLY use a disposable PostgreSQL and dev server.
Never run this against user data; always restores all source text in finally blocks.
"""
from pathlib import Path
from datetime import datetime, timezone
import json, os, re, subprocess, sys, time

if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1":
    raise SystemExit("Refusing mutations: set TT89_DISPOSABLE_DATABASE=1 only for a disposable test database and development server.")
ROOT = Path(__file__).resolve().parent.parent
NODE = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"]
MUTANTS = [
    ("do not request rollback-only", "src/lib/server/backup-drill.ts",
     'isolationLevel: "serializable", rollbackOnly: true', 'isolationLevel: "serializable", rollbackOnly: false', "tt89-drill-db.mts", "lost rollback acknowledgement"),
    ("ignore unexpected rollback command tag", "src/lib/server/transaction.ts",
     'if (outcome.command !== "ROLLBACK") { discard = true; throw new Error("PostgreSQL did not confirm the rollback."); }',
     'if (false && outcome.command !== "ROLLBACK") { discard = true; throw new Error("PostgreSQL did not confirm the rollback."); }', "tt89-drill-db.mts", "unexpected rollback command"),
    ("ignore failed scratch read-back", "src/lib/server/backup-drill.ts",
     'const fail = () => { throw new RestoreError("Scratch restore read-back did not match the selected sample.", 409); };',
     'const fail = () => { /* injected omission */ };', "tt89-drill-db.mts", "read-back is mandatory"),
    ("ignore private-index leakage", "src/lib/server/backup-drill.ts",
     'if (isPrivateVfsPath(e.path) ? !!found : !found || found.title !== baseName(e.path) || found.body !== expectedBody) fail();',
     'if (!isPrivateVfsPath(e.path) && (!found || found.title !== baseName(e.path) || found.body !== expectedBody)) fail();', "tt89-drill-db.mts", "private-index leakage"),
    ("allow unshadowed production relations in search path", "src/lib/server/backup-drill.ts",
     'await tx.execute(sql`SET LOCAL search_path = pg_temp, pg_catalog`);',
     'await tx.execute(sql`SET LOCAL search_path = pg_temp, public, pg_catalog`);', "tt89-drill-db.mts", "an unshadowed relation"),
    ("allow an unbounded file sample", "src/lib/server/backup-drill.ts",
     'files: 12, folders: 8, notes: 8, settings: 12', 'files: 120, folders: 8, notes: 8, settings: 12', "tt89-drill-health.mts", "deterministic stratified"),
    ("delay reminder until after the exact monthly boundary", "src/lib/backup/drill-health.ts",
     'now >= Date.parse(dueAt)', 'now > Date.parse(dueAt)', "tt89-drill-health.mts", "monthly reminder changes"),
    ("call a failed or partial attempt passed", "src/lib/backup/drill-health.ts",
     'if (health.lastAttempt.outcome !== "passed") return { state: health.lastAttempt.outcome, dueAt };',
     'if (health.lastAttempt.outcome !== "passed") return { state: "passed", dueAt };', "tt89-drill-health.mts", "failed and partial attempts"),
    ("hide locked and unknown sampled settings", "src/lib/server/backup-drill.ts",
     'const skippedSettings = applied.summary.settingsLocked.length + applied.summary.settingsUnknown.length;',
     'const skippedSettings = 0;', "tt89-drill-db.mts", "config drill writes"),
    ("allow an empty backup to count as a drill", "src/lib/server/backup-drill.ts",
     'if (!sampled.files && !sampled.folders && !sampled.notes && !sampled.settings) throw new RestoreError',
     'if (false && !sampled.files && !sampled.folders && !sampled.notes && !sampled.settings) throw new RestoreError', "tt89-drill-db.mts", "empty backup and all-unknown"),
    ("omit complete bundle checksum verification", "src/lib/backup/bundle.ts",
     'if (!legacy && (input.manifest as { sha256: string }).sha256 !== digest) return failure',
     'if (false && !legacy && (input.manifest as { sha256: string }).sha256 !== digest) return failure', "tt89-drill-http.mts", "tampering content"),
    ("send the user's passphrase and recovery key with the drill", "src/components/modules/Backup.tsx",
     'const result = await send({ bundle: parsed, drill: true });',
     'const result = await send({ bundle: parsed, drill: true, passphrase: pass, recovery: unlockKey });', "e2e-tt89-drill.mts", "a real downloaded,real encrypted-file"),
    ("remove the explicit amnesic drill refusal", "src/components/modules/Backup.tsx",
     'if (!privacy.status().installed || privacy.status().amnesic) {',
     'if (false) {', "e2e-tt89-drill.mts", "a real downloaded,amnesic session"),
]
originals = {str(ROOT / path): (ROOT / path).read_text() for _, path, *_ in MUTANTS}
results = []
try:
    for i, (name, rel, old, new, script, only) in enumerate(MUTANTS, 1):
        started = time.monotonic()
        path = ROOT / rel; original = originals[str(path)]
        state = "crashed"; detail = ""
        try:
            if original.count(old) != 1:
                raise ValueError(f"expected one source match, found {original.count(old)}")
            path.write_text(original.replace(old, new, 1))
            env = os.environ.copy(); env["HARNESS_ONLY"] = only
            env.setdefault("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:5432/app_db")
            env.setdefault("BASE", "http://localhost:3000")
            r = subprocess.run(NODE + [f"scripts/{script}"], cwd=ROOT, env=env, text=True, capture_output=True, timeout=150)
            output = r.stdout + r.stderr
            if re.search(r"\b0 passed, 0 failed\b", output): detail = "No tests selected"
            elif r.returncode != 0 and re.search(r"\b[1-9][0-9]* failed\b", output): state = "killed"
            elif r.returncode == 0: state = "survived"; detail = output[-1000:]
            else: detail = output[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if detail else ""), flush=True)
        results.append({ "suite": "tt89-mutants", "name": name, "covers": {"BK-05": "partial"}, "pass": state == "killed",
                         "error": None if state == "killed" else detail or state, "ms": round((time.monotonic() - started) * 1000) })
finally:
    for path, text in originals.items(): Path(path).write_text(text)
    dest = ROOT / "docs/test-results/tt89-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt89-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
killed = sum(r["pass"] for r in results)
print(f"Mutants: {killed}/{len(MUTANTS)} killed")
sys.exit(0 if killed == len(MUTANTS) and len(results) == len(MUTANTS) else 1)
