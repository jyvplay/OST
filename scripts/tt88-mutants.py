#!/usr/bin/env python3
"""Inject one defect at a time against the real dev app and restore each original."""
from pathlib import Path
import os, re, subprocess, sys

ROOT = Path(__file__).resolve().parent.parent
NODE = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"]
MUTANTS = [
    ("omit the passphrase slot from authenticated header", "src/lib/backup/recovery.ts",
     'const headerAad = (b: Header) => enc.encode(canonicalJson(b));',
     'const headerAad = (b: Header) => enc.encode(canonicalJson({ ...b, passWrapped: "" }));', "tt88-recovery.mts", "BK-06 Web Crypto output"),
    ("allow a below-policy but correctly authenticated work factor", "src/lib/backup/recovery.ts",
     'const MIN_ITERATIONS = 600_000;', 'const MIN_ITERATIONS = 599_999;', "tt88-recovery.mts", "BK-06 schema"),
    ("allow an excessive but correctly authenticated work factor", "src/lib/backup/recovery.ts",
     'const MAX_ITERATIONS = 2_000_000;', 'const MAX_ITERATIONS = 2_000_001;', "tt88-recovery.mts", "BK-06 schema"),
    ("generate the same recovery key repeatedly", "src/lib/backup/recovery.ts",
     'const raw = random(32);', 'const raw = new Uint8Array(32);', "tt88-recovery.mts", "BK-06 random 256-bit"),
    ("accept unknown extra header fields", "src/lib/backup/recovery.ts",
     'Object.keys(value).length !== keys.length', 'false', "tt88-recovery.mts", "BK-06 schema"),
    ("accept noncanonical ciphertext padding bits", "src/lib/backup/recovery.ts",
     'if (value.endsWith("=") && !value.endsWith("==") && alphabet.indexOf(value[value.length - 2]) % 4 !== 0)',
     'if (false && value.endsWith("=") && !value.endsWith("==") && alphabet.indexOf(value[value.length - 2]) % 4 !== 0)', "tt88-recovery.mts", "BK-06 schema"),
    ("enable download without confirmed recovery key", "src/components/modules/Backup.tsx",
     'disabled={busy || pass.length < 8 || confirmKey.trim().toUpperCase() !== recoveryKey} onClick={() => void downloadRecovery()}',
     'disabled={busy || pass.length < 8} onClick={() => void downloadRecovery()}', "e2e-tt88-recovery.mts", "BK-06"),
    ("leave the generated recovery key visible after download", "src/components/modules/Backup.tsx",
     'setRecoveryKey(""); setConfirmKey("");\n      setReport("Recovery-key encrypted download started.',
     'setConfirmKey("");\n      setReport("Recovery-key encrypted download started.', "e2e-tt88-recovery.mts", "BK-06"),
    ("post the recovery key with the decrypted preview", "src/components/modules/Backup.tsx",
     'const preview = await send({ bundle: parsed, dryRun: true })',
     'const preview = await send({ bundle: parsed, dryRun: true, recoveryKey: unlockKey })', "e2e-tt88-recovery.mts", "BK-06"),
    ("do not reject missing secure-context crypto before generating a key", "src/lib/backup/recovery.ts",
     'if (!globalThis.crypto?.subtle) throw new Error("Secure-context Web Crypto is unavailable.");',
     '/* injected: omit secure-context crypto guard */', "tt88-recovery.mts", "BK-06 missing secure-context"),
]
originals = {str(ROOT / path): (ROOT / path).read_text() for _, path, *_ in MUTANTS}
killed, survived, crashed = [], [], []
try:
    for i, (name, rel, old, new, script, only) in enumerate(MUTANTS, 1):
        path = ROOT / rel
        original = originals[str(path)]
        if original.count(old) != 1:
            crashed.append(name); print(f"HARNESS ERROR M{i}: {rel} has {original.count(old)} matches", flush=True); continue
        path.write_text(original.replace(old, new, 1))
        env = os.environ.copy(); env["HARNESS_ONLY"] = only
        env.setdefault("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:5432/app_db")
        env.setdefault("BASE", "http://localhost:3999")
        try:
            result = subprocess.run(NODE + [f"scripts/{script}"], cwd=ROOT, env=env, text=True, capture_output=True, timeout=150)
            output = result.stdout + result.stderr
            if re.search(r"\b0 passed, 0 failed\b", output):
                crashed.append(name); print(f"CRASHED M{i}: {name}: no selected tests", flush=True)
            elif result.returncode != 0 and re.search(r"\b[1-9][0-9]* failed\b", output):
                killed.append(name); print(f"KILLED M{i}: {name}", flush=True)
            elif result.returncode == 0:
                survived.append(name); print(f"SURVIVED M{i}: {name}\n{output[-800:]}", flush=True)
            else:
                crashed.append(name); print(f"CRASHED M{i}: {name}\n{output[-1400:]}", flush=True)
        except subprocess.TimeoutExpired:
            crashed.append(name); print(f"CRASHED M{i}: {name} timed out", flush=True)
        finally:
            path.write_text(original)
finally:
    for path, text in originals.items(): Path(path).write_text(text)
print(f"Mutants: {len(killed)}/{len(MUTANTS)} killed")
if survived: print("Survivors:", "; ".join(survived))
if crashed: print("Crashes:", "; ".join(crashed))
sys.exit(0 if len(killed) == len(MUTANTS) and not survived and not crashed else 1)
