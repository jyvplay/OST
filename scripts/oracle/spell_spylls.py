#!/usr/bin/env python3
"""TT59 spell-check oracle (TEST-ONLY, never shipped): spylls (MPL-2.0), an independent pure-Python port of Hunspell's
lookup + suggest algorithms, run on the same en_US .aff/.dic Fusion ships.

    python spell_spylls.py <dict-base-path> [--suggest N]  < words.txt   →  JSON lines {"w":…, "ok":bool, "sug":[…]}
"""
import json, sys
from spylls.hunspell import Dictionary

base = sys.argv[1]
nsug = int(sys.argv[sys.argv.index("--suggest") + 1]) if "--suggest" in sys.argv else 0
d = Dictionary.from_files(base)
for line in sys.stdin:
    w = line.rstrip("\n")
    if not w:
        continue
    ok = bool(d.lookup(w))
    sug = []
    if nsug and not ok:
        for s in d.suggest(w):
            sug.append(s)
            if len(sug) >= nsug:
                break
    print(json.dumps({"w": w, "ok": ok, "sug": sug}, ensure_ascii=False), flush=True)
