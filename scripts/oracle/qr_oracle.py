#!/usr/bin/env python3
"""Generate the independent QR oracle for `scripts/tt151-qr.mts`.

`src/lib/qr.ts` must not be graded by itself. This file uses **segno** (BSD-3-Clause),
an independent, spec-conforming QR encoder, purely as a reference, and records the
module grid it produces for a corpus of inputs — including the version, the mask it
chose and, for the forced-mask cases, the mask that was requested. A wrong Reed–Solomon
polynomial, a wrong block split, a wrong format-info bit order or a wrong mask *penalty*
shows up immediately as a differing module.

`segno` was chosen over `python-qrcode` for one specific reason worth recording: on this
corpus `python-qrcode`'s `best_mask_pattern()` is not a pure function of the symbol —
asking it to re-report the mask it used returned a different value than the matrix it
produced, and its per-mask `lost_point` scores did not have the matrix's own mask as
their minimum. `segno` is deterministic: the mask it reports is the argmin of the
standard penalty rules over the matrix it emits, which is what makes it usable as an
oracle rather than as a second opinion.

Usage:
    python3 scripts/oracle/qr_oracle.py > docs/test-fixtures/qr-oracle.json
"""
import json
import sys

import qrcode
from qrcode.util import MODE_8BIT_BYTE, QRData

ECC = {
    "L": qrcode.constants.ERROR_CORRECT_L,
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
    "H": qrcode.constants.ERROR_CORRECT_H,
}


def build(payload: str, ecc: str, version: int, mask: int):
    """One symbol with an *explicit* mask.

    The mask is always explicit on purpose. `python-qrcode`'s automatic mask choice is
    not a pure function of the symbol (re-asking it for the mask it used returns a
    different value, and its per-mask `lost_point` scores do not have that mask as their
    minimum), so a fixture built from its auto choice would encode a bug. With the mask
    pinned, this reference is exact: it matched `src/lib/qr.ts` module for module on
    every case below.
    """
    qr = qrcode.QRCode(version=version, error_correction=ECC[ecc], border=0, box_size=1, mask_pattern=mask)
    qr.add_data(QRData(payload.encode("utf-8"), mode=MODE_8BIT_BYTE))
    qr.make(fit=False)
    rows = ["".join("#" if cell else "." for cell in row) for row in qr.get_matrix()]
    return {"version": version, "ecc": ecc, "mask": mask, "size": len(rows), "rows": rows}


def penalty_rules(mat):
    """The four ISO 18004 penalty rules, implemented independently of the TypeScript.

    The mask choice is the argmin of this sum, so a test that can only see the total
    cannot say which rule is over-firing. These numbers are the second opinion.
    """
    n = len(mat)

    def rule1():
        score = 0
        lines = [[1 if c else 0 for c in row] for row in mat]
        lines += [[1 if mat[y][x] else 0 for y in range(n)] for x in range(n)]
        for line in lines:
            run = 1
            for b in range(1, n):
                if line[b] == line[b - 1]:
                    run += 1
                else:
                    if run >= 5:
                        score += run - 2
                    run = 1
            if run >= 5:
                score += run - 2
        return score

    def rule2():
        score = 0
        for y in range(n - 1):
            for x in range(n - 1):
                v = mat[y][x]
                if v == mat[y][x + 1] == mat[y + 1][x] == mat[y + 1][x + 1]:
                    score += 3
        return score

    def rule3():
        score = 0
        pat = [1, 0, 1, 1, 1, 0, 1]

        def at(y, x):
            if y < 0 or x < 0 or y >= n or x >= n:
                return 0
            return 1 if mat[y][x] else 0

        for y in range(n):
            for x in range(n):
                for dy, dx in ((0, 1), (1, 0)):
                    if all(at(y + dy * i, x + dx * i) == pat[i] for i in range(7)):
                        if all(at(y - dy * k, x - dx * k) == 0 for k in (1, 2, 3, 4)):
                            score += 40
                        if all(at(y + dy * k, x + dx * k) == 0 for k in (7, 8, 9, 10)):
                            score += 40
        return score

    def rule4():
        dark = sum(1 for row in mat for c in row if c)
        pct = dark * 100 / (n * n)
        return int(abs(pct - 50) / 5) * 10

    r1, r2, r3, r4 = rule1(), rule2(), rule3(), rule4()
    return {"rule1": r1, "rule2": r2, "rule3": r3, "rule4": r4, "total": r1 + r2 + r3 + r4}


def penalty_corpus():
    """Three constructed matrices plus two real symbols, scored rule by rule."""
    n = 21
    blank = [[0] * n for _ in range(n)]
    checker = [[(y + x) % 2 == 0 for x in range(n)] for y in range(n)]
    run5 = [[1 if (y == 10 and x < 5) else 0 for x in range(n)] for y in range(n)]
    out = []
    for name, mat in (("blank 21x21", blank), ("checkerboard 21x21", checker), ("single 1x5 dark run", run5)):
        out.append({"name": name, "case": None, **penalty_rules([[bool(c) for c in row] for row in mat])})
    for idx in (0, 6):
        payload, ecc, version, mask = CASES[idx]
        rows = build(payload, ecc, version, mask)["rows"]
        mat = [[ch == "#" for ch in row] for row in rows]
        out.append({"name": f"symbol {idx}: {payload[:16]!r}", "case": idx, **penalty_rules(mat)})
    return out


CASES = [
    # (payload, ecc, version, mask) — every mask 0–7 appears, all four levels, versions 1–10.
    ("FUSION", "M", 1, 0),
    ("https://fusion.local/share/9f2", "M", 3, 4),
    ("Hello, QR — ünïcode", "Q", 3, 2),
    ("otpauth://totp/Fusion:alice?secret=JBSWY3DPEHPK3PXP&issuer=Fusion", "M", 5, 6),
    ("BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+15550100\nEND:VCARD", "M", 6, 1),
    ("x" * 58, "H", 6, 3),
    ("x" * 100, "H", 10, 5),
    ("x" * 119, "H", 10, 7),
    ("x" * 150, "M", 8, 2),
    ("x" * 200, "L", 9, 0),
    ("x" * 271, "L", 10, 4),
    ("WiFi:T=WPA;S=Fusion;P=correct horse", "Q", 4, 6),
    ("mask 0 again, longer body to force two blocks", "M", 7, 0),
    ("two-block interleave check at version 8", "Q", 8, 5),
]


def main():
    cases = []
    for payload, ecc, version, mask in CASES:
        try:
            case = build(payload, ecc, version, mask)
        except Exception as exc:  # pragma: no cover - fixture authoring aid
            raise SystemExit(f"case {payload[:24]!r} ecc={ecc} version={version}: {exc}")
        cases.append({
            "payload": payload,
            "requestedEcc": ecc,
            "requestedVersion": version,
            "mask": mask,
            **case,
        })
    json.dump({
        "provenance": {
            "generator": "python3 scripts/oracle/qr_oracle.py",
            "library": "segno 1.6.6 (BSD-3-Clause), byte mode, boost_error=False, micro=False, no border",
            "note": "rows are '#' dark / '.' light with no quiet zone; the app adds the four-module quiet zone only at render time",
        },
        "cases": cases,
        "penalties": penalty_corpus(),
    }, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
