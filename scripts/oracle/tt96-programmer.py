#!/usr/bin/env python3
"""Independent integer oracle for the bounded JS programmer expression grammar.

Uses Python integers and explicit modulo/sign interpretation; does not call the
application parser. Deterministic random operands, including values above 2**53.
"""
import json
import random

rng = random.Random(0x96CA1C)
cases = []
for width in (8, 16, 32, 64):
    modulus = 1 << width
    mask = modulus - 1
    for signed in (False, True):
        def interpret(value):
            value %= modulus
            return value - modulus if signed and value >= modulus // 2 else value

        for operator in ("+", "-", "*", "&", "|", "^", "/", "%", "<<", ">>"):
            for _ in range(20):
                a = rng.getrandbits(width)
                b = rng.getrandbits(width)
                if operator in ("<<", ">>"):
                    b = rng.randrange(width)
                if operator in ("/", "%") and b == 0:
                    b = 1
                av, bv = interpret(a), interpret(b)
                if operator == "+":
                    out = av + bv
                elif operator == "-":
                    out = av - bv
                elif operator == "*":
                    out = av * bv
                elif operator == "&":
                    out = a & b
                elif operator == "|":
                    out = a | b
                elif operator == "^":
                    out = a ^ b
                elif operator in ("/", "%"):
                    q = abs(av) // abs(bv)
                    if (av < 0) != (bv < 0):
                        q = -q
                    out = q if operator == "/" else av - q * bv
                elif operator == "<<":
                    out = a << b
                else:
                    out = av >> b
                cases.append({"expression": f"0x{a:x} {operator} 0x{b:x}", "bits": width, "signed": signed, "result": str(interpret(out & mask))})

        def tree(depth):
            if depth == 0:
                value = rng.getrandbits(width)
                return f"0x{value:x}", value
            operator = rng.choice(("+", "-", "*", "&", "|", "^", "/", "%", "<<", ">>", "~", "neg"))
            left_s, left = tree(depth - 1)
            if operator in ("~", "neg"):
                return (f"(~{left_s})", (~left) & mask) if operator == "~" else (f"(-{left_s})", (-left) & mask)
            if operator in ("<<", ">>"):
                right = rng.randrange(width)
                right_s = str(right)
            elif operator in ("/", "%"):
                right = rng.randrange(1, modulus)
                right_s = f"0x{right:x}"
            else:
                right_s, right = tree(depth - 1)
            av, bv = interpret(left), interpret(right)
            if operator == "+": result = av + bv
            elif operator == "-": result = av - bv
            elif operator == "*": result = av * bv
            elif operator == "&": result = left & right
            elif operator == "|": result = left | right
            elif operator == "^": result = left ^ right
            elif operator in ("/", "%"):
                q = abs(av) // abs(bv)
                if (av < 0) != (bv < 0): q = -q
                result = q if operator == "/" else av - q * bv
            elif operator == "<<": result = left << right
            else: result = av >> right
            return f"({left_s} {operator} {right_s})", result & mask

        for _ in range(64):
            expression, value = tree(3)
            cases.append({"expression": expression, "bits": width, "signed": signed, "result": str(interpret(value))})
print(json.dumps(cases))
