#!/usr/bin/env python3
"""TT86 mutation check: temporarily inject plausible SH-06 pointer-trigger regressions, require tt86-pointer to fail, restore."""
from pathlib import Path
import os
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src/lib/pointer-triggers.ts"
NODE = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt86-pointer.mts"]

MUTANTS = [
    ("corner repeats on every in-zone move", "const entered = moved && corner !== previousCorner;", "const entered = moved;"),
    ("first point already inside a corner fires", """if (!before) {
      previousCorner = corner;
      edgeArm = null;
      return null;
    }""", """if (!before) {
      previousCorner = corner;
      edgeArm = null;
      return corner ? CORNER_ACTION[corner] : null;
    }"""),
    ("corner boundary is inclusive at x = 6", "const left = s.x < w, right = s.x >= s.width - w;", "const left = s.x <= w, right = s.x >= s.width - w;"),
    ("edge fires on rail entry without the inward flick", "if (entered) edgeArm = { edge: entered, x: sample.x, y: sample.y, at: sample.at };", "if (entered) return EDGE_ACTION[entered];"),
    ("edge threshold rejects an exact 18 px flick", "inwardDistance(edgeArm.edge, edgeArm, sample) >= EDGE_FLICK_DISTANCE", "inwardDistance(edgeArm.edge, edgeArm, sample) > EDGE_FLICK_DISTANCE"),
    ("edge arm survives beyond 600 ms", "elapsed > EDGE_FLICK_WINDOW_MS", "elapsed > 60_000"),
    ("right-button gesture directions are reversed", "dx < 0 ? \"launcher\" : \"overview\"", "dx < 0 ? \"overview\" : \"launcher\""),
    ("left/aux button can masquerade as a right-button gesture", "button !== 2 || !Number.isFinite(dx)", "button === 2 || !Number.isFinite(dx)"),
    ("ambiguous diagonal gesture is accepted", "x >= y * MOUSE_GESTURE_AXIS_RATIO", "x >= y"),
    ("gesture threshold is reduced by one CSS pixel", "export const MOUSE_GESTURE_MIN_DISTANCE = 36;", "export const MOUSE_GESTURE_MIN_DISTANCE = 35;"),
    ("bottom edge opens the wrong panel", "bottom: \"palette\",", "bottom: \"quickPanel\","),
]

original = SOURCE.read_text()
killed = 0
survived: list[str] = []
crashed: list[str] = []
try:
    for index, (name, old, new) in enumerate(MUTANTS, 1):
        if original.count(old) != 1:
            print(f"HARNESS ERROR M{index}: expected one match for {old!r}, found {original.count(old)}")
            sys.exit(2)
        SOURCE.write_text(original.replace(old, new, 1))
        env = os.environ.copy()
        env["HARNESS_ONLY"] = "SH-06"
        try:
            result = subprocess.run(NODE, cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)
        except subprocess.TimeoutExpired as error:
            crashed.append(name)
            print(f"CRASHED M{index}: {name} — {error}")
            continue
        output = result.stdout + result.stderr
        has_assertion_failure = bool(re.search(r"\b[1-9][0-9]* failed\b", output))
        if has_assertion_failure and result.returncode != 0:
            killed += 1
            print(f"KILLED M{index}: {name}")
        elif result.returncode == 0:
            survived.append(name)
            print(f"SURVIVED M{index}: {name}")
        else:
            crashed.append(name)
            print(f"CRASHED M{index}: {name} (no harness assertion summary)\n{output[-1200:]}")
finally:
    SOURCE.write_text(original)

print(f"Mutants: {killed}/{len(MUTANTS)} killed")
if survived:
    print("Survivors:", "; ".join(survived))
if crashed:
    print("Crashes:", "; ".join(crashed))
sys.exit(0 if killed == len(MUTANTS) and not crashed else 1)
