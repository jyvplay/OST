#!/usr/bin/env python3
"""Bounded download source mutations; browser cases need an exclusive disposable DB/dev server."""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time
if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1" or not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("Refusing mutations: use the disposable DB/dev-server opt-ins and matching DATABASE_URL/BASE.")
ROOT = Path(__file__).resolve().parent.parent; LIB = ROOT / "src/lib/browser-download.ts"; UI = ROOT / "src/components/modules/ProxyFrame.tsx"
original = {p: p.read_text() for p in [LIB, UI]}
M = [
 ("accept untrusted MIME syntax", LIB, '  return mime.length <= 200 && /^[a-z0-9!#$&^_.+-]+\\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";', '  return mime;', "tt91-browser-download.mts", "MIME metadata"),
 ("drop filename sanitization", LIB, '  let name = (decoded || u.hostname).replace(/[\\\\/:*?"<>|\\x00-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]/g, "_").replace(/^\\.+/, "").trim().slice(0, 120) || "page";', '  let name = decoded || u.hostname;', "tt91-browser-download.mts", "download names"),
 ("trust declared length over cap", LIB, 'declared && /^\\d+$/.test(declared) && Number(declared) > MAX_BROWSER_SAVE_BYTES', 'false', "tt91-browser-download.mts", "oversized declared"),
 ("trust dishonest stream length", LIB, '      if (size > MAX_BROWSER_SAVE_BYTES) throw new Error("This file exceeds the 8 MiB Fusion Files limit");', '      /* injected missing streaming cap */', "tt91-browser-download.mts", "missing or dishonest"),
 ("accept partial HTTP 206", LIB, '!response.ok || response.status === 206', '!response.ok', "tt91-browser-download.mts", "HTTP errors"),
 ("return bytes after reader cancellation", LIB, '      if (signal.aborted) throw new DOMException("Download cancelled", "AbortError");', '      /* injected ignored abort */', "tt91-browser-download.mts", "an abort interrupts"),
 ("save without an installed privacy guard", LIB, '!privacy.status().installed || privacy.status().amnesic', 'privacy.status().amnesic', "tt91-browser-download.mts", "server import refuses"),
 ("save while amnesic", LIB, '!privacy.status().installed || privacy.status().amnesic', '!privacy.status().installed', "tt91-browser-download.mts", "an installed amnesic"),
 ("replace conditional creation with overwriting write", LIB, 'op: "writeIfUnchanged", path, content, encoding: "base64", mime, expected: null', 'op: "write", path, content, encoding: "base64", mime, expected: null', "e2e-tt91-browser-download.mts", "real PyPI bytes"),
 ("claim failure after a lost commit acknowledgement", UI, 'Save not confirmed; check /Downloads before retrying.', 'Not saved.', "e2e-tt91-browser-download.mts", "a committed write with"),
]
def run(script, prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    p = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", f"scripts/{script}"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout + p.stderr
results = []
try:
    for i, (name, path, old, new, script, prefix) in enumerate(M, 1):
        start = time.monotonic(); state, detail = "crashed", ""
        try:
            if original[path].count(old) != 1: raise ValueError(f"expected one source match, found {original[path].count(old)}")
            code, baseline = run(script, prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("baseline failed: " + baseline[-1200:])
            path.write_text(original[path].replace(old, new, 1)); code, output = run(script, prefix)
            if code != 0 and "0 passed, 1 failed" in output and re.search(r"Expected|does not match|did not match|Missing expected rejection|should not|not attempted", output, re.I): state, detail = "killed", output[-1200:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-1200:]
            else: detail = output[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally:
            for p, src in original.items(): p.write_text(src)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt91-download-mutants", "name": name, "covers": {"PR-07m": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - start) * 1000)})
finally:
    for p, src in original.items(): p.write_text(src)
    dest = ROOT / "docs/test-results/tt91-download-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt91-download-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed"); sys.exit(0 if n == len(M) and len(results) == len(M) else 1)
