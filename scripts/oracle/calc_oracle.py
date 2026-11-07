"""
TT149 test-only oracle for the Calculator (PR-09).

Independent implementations, on purpose:

  * `libm`      — Python's `math` module (C library, glibc), for the scientific
                  functions. Fusion's evaluator calls the JavaScript engine's
                  `Math`, which is a *different* implementation of the same
                  IEEE-754 double operations; agreement to ~1e-12 relative is
                  therefore evidence, not tautology. (Both are correctly-rounded
                  or near-correctly-rounded for these functions, so a large
                  disagreement means one of them is wrong.)
  * `fractions` — exact rational arithmetic for unit conversions, so the
                  expected value carries no float error at all: the factor is a
                  definition (1 in = 2.54 cm exactly, 1 lb = 0.45359237 kg
                  exactly) rather than a measurement.
  * big ints    — Python integers with explicit masks for the programmer mode's
                  two's-complement semantics.

Nothing here ships in Fusion and nothing is imported by the app; the output is a
frozen JSON fixture (`docs/test-fixtures/calc-oracle.json`) so the pure suite can
re-check parity without Python installed.

Usage:
    python3 scripts/oracle/calc_oracle.py > docs/test-fixtures/calc-oracle.json
"""
import json
import math
import sys
from fractions import Fraction

# ---------------------------------------------------------------- scientific

FUNCS = ["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "ln", "log", "log2", "exp"]


def domain_ok(name: str, x: float) -> bool:
    if name in ("asin", "acos"):
        return -1.0 <= x <= 1.0
    if name == "sqrt":
        return x >= 0.0
    if name in ("ln", "log", "log2"):
        return x > 0.0
    return True


def apply(name: str, x: float) -> float:
    return {
        "sin": math.sin, "cos": math.cos, "tan": math.tan,
        "asin": math.asin, "acos": math.acos, "atan": math.atan,
        "sqrt": math.sqrt, "ln": math.log, "log": math.log10,
        "log2": math.log2, "exp": math.exp,
    }[name](x)


def scientific() -> list[dict]:
    out = []
    grid = [-2.0, -1.0, -0.5, -0.1, 0.0, 0.1, 0.5, 1.0, 2.0, 3.0, 10.0, 123.456, 1e-6, 1e6]
    for name in FUNCS:
        for x in grid:
            if not domain_ok(name, x):
                continue
            try:
                value = apply(name, float(x))
            except (ValueError, OverflowError):
                # Python raises where IEEE-754 returns inf or NaN; those inputs
                # are the app's *refusal* cases, not parity cases.
                continue
            if not math.isfinite(value):
                continue
            out.append({"expr": f"{name}({x!r})", "value": value, "rel": 1e-12})
    # Constants: the oracle's own value, so a hard-coded 3.14159 in the app fails.
    for name, value in (("pi", math.pi), ("e", math.e), ("tau", 2 * math.pi)):
        out.append({"expr": name, "value": value, "rel": 0.0})
    # A few composite expressions where precedence is the whole question.
    composites = [
        ("2+3*4", Fraction(14)),
        ("(2+3)*4", Fraction(20)),
        ("2-3-4", Fraction(-5)),
        ("2*3^2", None),  # ^ is power in the scientific mode; see exact below
        ("-2^2", None),
        ("10/4", Fraction(5, 2)),
        ("7 % 4", Fraction(3)),
        ("2^10", Fraction(1024)),
        ("2^-2", Fraction(1, 4)),
    ]
    for expr, exact in composites:
        if exact is not None:
            out.append({"expr": expr, "value": float(exact), "rel": 0.0, "exact": str(exact)})
    return out


# -------------------------------------------------------------------- units

# Definitional factors only (no measured constants): exact rationals.
UNITS = {
    "mm": ("m", Fraction(1, 1000)), "cm": ("m", Fraction(1, 100)), "m": ("m", Fraction(1)),
    "km": ("m", Fraction(1000)), "in": ("m", Fraction(254, 10000)), "ft": ("m", Fraction(3048, 10000)),
    "yd": ("m", Fraction(9144, 10000)), "mi": ("m", Fraction(1609344, 1000)),
    "g": ("kg", Fraction(1, 1000)), "kg": ("kg", Fraction(1)), "lb": ("kg", Fraction(45359237, 100000000)),
    "kb": ("B", Fraction(1024)), "mb": ("B", Fraction(1024 ** 2)), "gb": ("B", Fraction(1024 ** 3)),
    "ms": ("s", Fraction(1, 1000)), "s": ("s", Fraction(1)),
    "min": ("s", Fraction(60)), "h": ("s", Fraction(3600)), "d": ("s", Fraction(86400)),
}
PAIRS = [
    ("12", "cm", "in"), ("1", "mi", "km"), ("5", "ft", "cm"), ("100", "km", "mi"),
    ("1", "lb", "kg"), ("16", "oz", "g"), ("2", "gb", "mb"), ("512", "kb", "mb"),
    ("90", "min", "h"), ("1", "d", "s"), ("36", "in", "yd"), ("1000", "ms", "s"),
]


def units() -> list[dict]:
    out = []
    for n, a, b in PAIRS:
        if a not in UNITS or b not in UNITS:
            continue
        base_a, fa = UNITS[a]
        base_b, fb = UNITS[b]
        if base_a != base_b:
            continue
        exact = Fraction(int(n)) * fa / fb
        out.append({
            "expr": f"{n} {a} to {b}",
            "value": float(exact),
            "rel": 1e-15,
            "exact": f"{exact.numerator}/{exact.denominator}",
        })
    return out


# -------------------------------------------------------------- programmer

def mask(width: int, value: int) -> int:
    return value & ((1 << width) - 1)


def as_signed(width: int, value: int) -> int:
    value = mask(width, value)
    return value - (1 << width) if value >= (1 << (width - 1)) else value


def trunc_div(a: int, b: int) -> int:
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def trunc_mod(a: int, b: int) -> int:
    return a - trunc_div(a, b) * b


def programmer(limit: int = 400) -> list[dict]:
    """Deterministic pseudo-random pairs — a fixed corpus, not a random one."""
    state = 0x2545F491
    def nxt() -> int:
        nonlocal state
        state = (state * 1103515245 + 12345) & 0xFFFFFFFF
        return state

    out = []
    for i in range(limit):
        a = nxt() - 0x80000000
        b = nxt() - 0x80000000
        if b == 0:
            b = 7
        width = [8, 16, 32, 64][i % 4]
        signed = (i % 2) == 0
        op = ["+", "-", "*", "&", "|", "^"][i % 6]
        if op == "+":
            exact = a + b
        elif op == "-":
            exact = a - b
        elif op == "*":
            exact = a * b
        elif op == "&":
            exact = mask(width, a) & mask(width, b)
        elif op == "|":
            exact = mask(width, a) | mask(width, b)
        else:
            exact = mask(width, a) ^ mask(width, b)
        wrapped = mask(width, exact)
        out.append({
            "expr": f"{a} {op} {b}",
            "width": width,
            "signed": signed,
            # JSON numbers are float64: a 64-bit unsigned value above 2^53 would be
            # rounded on the way out, so the exact decimal and hex are strings.
            "unsigned": wrapped,
            "unsignedText": str(wrapped),
            "unsignedHex": format(wrapped, "x"),
            "signedValue": as_signed(width, wrapped),
            "signedText": str(as_signed(width, wrapped)),
            "truncDiv": trunc_div(a, b),
            "truncMod": trunc_mod(a, b),
        })
    return out


def refusals() -> list[dict]:
    """Inputs that must be refused rather than answered with NaN/Infinity."""
    return [
        {"expr": "1/0", "why": "division by zero"},
        {"expr": "sqrt(-1)", "why": "square root of a negative number"},
        {"expr": "ln(0)", "why": "logarithm of zero"},
        {"expr": "asin(2)", "why": "arcsine outside its domain"},
        {"expr": "2^", "why": "expression ends at an operator"},
        {"expr": "(1+2", "why": "unbalanced parenthesis"},
        {"expr": "1 cm to kg", "why": "dimension mismatch"},
        {"expr": "12 xyz to m", "why": "unknown unit"},
    ]


def main() -> int:
    json.dump({
        "generator": "scripts/oracle/calc_oracle.py",
        "python": sys.version.split()[0],
        "scientific": scientific(),
        "units": units(),
        "programmer": programmer(),
        "refusals": refusals(),
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
