#!/usr/bin/env python3
"""Independent Decimal-based references for the calculator's documented unit table.

Decimal constants state the table's intended factors; this oracle does not parse
or import application code. Input is first rounded to binary64, matching the
stated Number contract; the reference is then calculated in Decimal and rounded
back to binary64 only at the end.
"""
import decimal
import json
import math

decimal.getcontext().prec = 500
D = decimal.Decimal
families = [
    {"mm": "0.001", "cm": "0.01", "m": "1", "km": "1000", "in": "0.0254", "ft": "0.3048", "yd": "0.9144", "mi": "1609.344"},
    {"g": "0.001", "kg": "1", "lb": "0.45359237", "oz": "0.028349523"},
    {"b": "1", "kb": "1024", "mb": "1048576", "gb": "1073741824", "tb": "1099511627776"},
    {"ms": "0.001", "s": "1", "min": "60", "h": "3600", "d": "86400"},
]
inputs = ["0", "1", "-1", "3.141592653589793", "1e-300", "1e300", "1e308", "-1e308", "1e-323", "1.7976931348623157e308"]
rows = []
for family in families:
    for source, f in family.items():
        for target, g in family.items():
            for n in inputs:
                expected = float(D.from_float(float(n)) * D(f) / D(g))
                rows.append({"expression": f"{n} {source} to {target}", "expected": repr(expected) if math.isfinite(expected) else "overflow"})
print(json.dumps(rows, separators=(",", ":")))
