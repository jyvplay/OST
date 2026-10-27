#!/usr/bin/env python3
"""TT84 mutation adversary: 10 plausible defects across wordcount.ts, storage-core.ts, pdfdoc.ts and pdfcanvas.ts.
Every mutant must be killed by scripts/tt84-wordcount.mts or scripts/tt81-core.mts; original files are restored in a finally block.
"""
import os, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = {**os.environ, "ORACLE_PY": "/home/user/tools/venv/bin/python"}

MUTANTS = [
    (
        "M1 wordcount: split words on combining marks (drop \\p{M} from WORD_RE)",
        "src/lib/office/wordcount.ts",
        r"const WORD_RE = /\p{Unified_Ideograph}|[\p{L}\p{N}](?:(?!\p{Unified_Ideograph})[\p{L}\p{N}\p{M}'’\u2010-\u2013-])*/gu;",
        r"const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;",
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M2 wordcount: group CJK ideographs as one word instead of per-ideograph",
        "src/lib/office/wordcount.ts",
        r"const WORD_RE = /\p{Unified_Ideograph}|[\p{L}\p{N}](?:(?!\p{Unified_Ideograph})[\p{L}\p{N}\p{M}'’\u2010-\u2013-])*/gu;",
        r"const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\u2010-\u2013-]*/gu;",
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M3 wordcount: count tracked deletions (skip rev.kind === 'del' check)",
        "src/lib/office/wordcount.ts",
        'if (it.rev?.kind === "del") return "";',
        'if (false && it.rev?.kind === "del") return "";',
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M4 wordcount: include inline image alt-text/label in countableInlineText",
        "src/lib/office/wordcount.ts",
        'case "image":',
        'case "image": return it.label;',
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M5 wordcount: count deleted table rows under Track Changes",
        "src/lib/office/wordcount.ts",
        'if (r.rev?.kind === "del") continue;',
        'if (false && r.rev?.kind === "del") continue;',
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M6 wordcount: do not merge paragraphs across deleted paragraph marks",
        "src/lib/office/wordcount.ts",
        'if (b.markRev?.kind !== "del") flush();',
        'flush();',
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M7 storage-core: accept case-insensitive 'delete' confirmation token",
        "src/lib/storage-core.ts",
        'if (rec.confirm !== "DELETE")',
        'if (String(rec.confirm).toUpperCase() !== "DELETE")',
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M8 storage-core: ignore residual rows in verifyPostPurge",
        "src/lib/storage-core.ts",
        "if (b1.rows !== 0 || b1.bytes !== 0)",
        "if (false && (b1.rows !== 0 || b1.bytes !== 0))",
        "scripts/tt84-wordcount.mts",
    ),
    (
        "M9 pdfdoc: do not resolve indirect /UserUnit reference",
        "src/lib/pdf/pdfdoc.ts",
        'const uv = this.resolve(d.get("UserUnit")); let userUnit = 1;',
        'const uv = d.get("UserUnit"); let userUnit = 1;',
        "scripts/tt81-core.mts",
    ),
    (
        "M10 pdfdoc: inherit /UserUnit from parent /Pages dictionary",
        "src/lib/pdf/pdfdoc.ts",
        'const uv = this.resolve(d.get("UserUnit")); let userUnit = 1;',
        'const uv = this.resolve(d.get("UserUnit") ?? cat?.get("Pages") && this.dict(cat.get("Pages"))?.get("UserUnit")); let userUnit = 1;',
        "scripts/tt81-core.mts",
    ),
]

def run():
    killed = 0
    survived = []
    for name, rel_path, old, new, suite in MUTANTS:
        fp = ROOT / rel_path
        src = fp.read_text(encoding="utf-8")
        if old not in src:
            print(f"INVALID {name}: target snippet not found in {rel_path}")
            sys.exit(2)
        try:
            fp.write_text(src.replace(old, new, 1), encoding="utf-8")
            cmd = [
                "node",
                "--use-system-ca",
                "--experimental-strip-types",
                "--no-warnings",
                "--import",
                "./scripts/register-hook.mjs",
                suite,
            ]
            env = {**ENV, "HARNESS_ONLY": "P4" if suite.endswith("tt81-core.mts") else ""}
            if not env["HARNESS_ONLY"]:
                del env["HARNESS_ONLY"]
            r = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
            if r.returncode != 0 or "failed" in r.stdout and not r.stdout.strip().endswith("0 failed"):
                killed += 1
                print(f"  KILLED   {name}")
            else:
                survived.append(name)
                print(f"  SURVIVED {name}")
        finally:
            fp.write_text(src, encoding="utf-8")
    print(f"\nMutants: {killed}/{len(MUTANTS)} killed")
    if survived:
        print("Survived:", survived)
        sys.exit(1)

if __name__ == "__main__":
    run()
