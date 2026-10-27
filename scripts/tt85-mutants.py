#!/usr/bin/env python3
"""TT85 mutation adversary for PR-07n, AP-05, and PR-07h.
Each defect must be killed by its targeted production-code suite (Chromium, unit, or live socket); source is restored after every run.
"""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = {
    **os.environ,
    "AWS_EXECUTION_ENV": os.environ.get("AWS_EXECUTION_ENV", "AWS_Lambda_nodejs22.x"),
    "LD_LIBRARY_PATH": "/tmp/al2023/lib:/tmp:" + os.environ.get("LD_LIBRARY_PATH", ""),
}
NODE = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"]

MUTANTS = [
    (
        "M1 find: start a whitespace-normalized word one source unit late",
        "public/wp-find.js",
        "if (!addSpace(node, i, next, false)) return false;",
        "if (!addSpace(node, next, next, false)) return false;",
        "scripts/tt85-find.mts",
    ),
    (
        "M2 find: reset match ordinal when DOM mutates before the next key press",
        "public/wp-find.js",
        "current = isNew ? -1 : hits.length && previous >= 0 ? Math.min(previous, hits.length - 1) : -1;",
        "current = -1;",
        "scripts/tt85-find.mts",
    ),
    (
        "M3 find: skip overlapping occurrences",
        "public/wp-find.js",
        "from = at + (cp > 0xffff ? 2 : 1);",
        "from = at + query.length;",
        "scripts/tt85-find.mts",
    ),
    (
        "M4 find: include hidden, inert and aria-hidden text",
        "public/wp-find.js",
        "if (SKIP[tag] || !isVisible(n, view)) continue;",
        "if (SKIP[tag]) continue;",
        "scripts/tt85-find.mts",
    ),
    (
        "M5 find: ignore the DOM-node scan cap",
        "public/wp-find.js",
        "if (visited > maxNodes) { truncated = true; break; }",
        "if (visited > 50000000) { truncated = true; break; }",
        "scripts/tt85-find.mts",
    ),
    (
        "M6 find: omit the partial-scan marker at the node cap",
        "public/wp-find.js",
        "if (visited > maxNodes) { truncated = true; break; }",
        "if (visited > maxNodes) { break; }",
        "scripts/tt85-find.mts",
    ),
    (
        "M7 AP-05: count status refreshes as if callbacks ran",
        "src/lib/background-inventory.ts",
        "state.set(id, { ...old, lastAt: Date.now(), lastStatus: String(status).slice(0, 240) });",
        "state.set(id, { ...old, callbacks: old.callbacks + 1, lastAt: Date.now(), lastStatus: String(status).slice(0, 240) });",
        "scripts/tt85-inventory.mts",
    ),
    (
        "M8 PR-07h: ignore the selected host's user-agent override",
        "src/lib/server/wp-sessions.ts",
        "return s.uaOverrides.get(key) ?? s.ua;",
        "return s.ua;",
        "scripts/tt85-identity.mts",
    ),
    (
        "M9 PR-07h: accept a malformed site key into the override map",
        "src/lib/server/wp-sessions.ts",
        'if (!key || (ua !== "desktop" && ua !== "mobile")) return false;',
        'if (ua !== "desktop" && ua !== "mobile") return false;',
        "scripts/tt85-identity.mts",
    ),
    (
        "M10 PR-07h: clearing one site clears every host override",
        "src/lib/server/wp-sessions.ts",
        "return key ? s.uaOverrides.delete(key) : false;",
        "if (!key) return false; const had = s.uaOverrides.size > 0; s.uaOverrides.clear(); return had;",
        "scripts/tt85-identity.mts",
    ),
    (
        "M11 PR-07h: remove the 64-host memory bound",
        "src/lib/server/wp-sessions.ts",
        "while (s.uaOverrides.size > WP_MAX_UA_OVERRIDES)",
        "while (s.uaOverrides.size > 1000)",
        "scripts/tt85-identity.mts",
    ),
    (
        "M12 PR-07h: use the session-global UA for every WebSocket target",
        "src/lib/server/wp-ws.ts",
        "UA[uaForSite(s, target.host)]",
        "UA[s.ua]",
        "scripts/tt38-unit.mts",
    ),
    (
        "M13 PR-07h: bypass the target-host UA on ordinary upstream HTTP requests",
        "src/app/api/wp/s/[sid]/[...rest]/route.ts",
        "const uh = upstreamHeaders(req.headers.entries(), target, { ua: uaForSite(s, target.host)",
        "const uh = upstreamHeaders(req.headers.entries(), target, { ua: s.ua",
        "scripts/tt85-identity.mts",
    ),
]


def run():
    killed = 0
    survivors = []
    for name, rel_path, old, new, suite in MUTANTS:
        target = ROOT / rel_path
        original = target.read_text(encoding="utf-8")
        if old not in original:
            print(f"INVALID {name}: target snippet not found in {rel_path}")
            sys.exit(2)
        try:
            target.write_text(original.replace(old, new, 1), encoding="utf-8")
            proc = subprocess.run(NODE + [suite], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=90)
            output = proc.stdout + proc.stderr
            if proc.returncode != 0:
                killed += 1
                print(f"  KILLED   {name}")
            else:
                survivors.append(name)
                print(f"  SURVIVED {name}\n{output[-2000:]}")
        finally:
            target.write_text(original, encoding="utf-8")
    print(f"\nMutants: {killed}/{len(MUTANTS)} killed")
    if survivors:
        print("Survived:", survivors)
        sys.exit(1)


if __name__ == "__main__":
    run()
