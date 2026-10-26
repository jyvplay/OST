"""TT45 test-only oracle: OpenSSL's ML-KEM through python `cryptography` (Apache-2.0/BSD). Batch JSON in, JSON out.
ops: {"op":"pub","set":768,"seed":hex64} -> ek ; {"op":"encap","set":768,"ek":hex} -> ss, ct ; {"op":"decap","set":768,"seed":hex64,"ct":hex} -> ss"""
import json, sys
from cryptography.hazmat.primitives.asymmetric import mlkem
PRIV = {768: mlkem.MLKEM768PrivateKey, 1024: mlkem.MLKEM1024PrivateKey}
PUB = {768: mlkem.MLKEM768PublicKey, 1024: mlkem.MLKEM1024PublicKey}
out = []
for o in json.load(sys.stdin):
    try:
        if o["op"] == "pub":
            out.append({"ek": PRIV[o["set"]].from_seed_bytes(bytes.fromhex(o["seed"])).public_key().public_bytes_raw().hex()})
        elif o["op"] == "encap":
            ss, ct = PUB[o["set"]].from_public_bytes(bytes.fromhex(o["ek"])).encapsulate()
            out.append({"ss": ss.hex(), "ct": ct.hex()})
        elif o["op"] == "decap":
            out.append({"ss": PRIV[o["set"]].from_seed_bytes(bytes.fromhex(o["seed"])).decapsulate(bytes.fromhex(o["ct"])).hex()})
    except Exception as e:
        out.append({"error": type(e).__name__ + ": " + str(e)})
json.dump(out, sys.stdout)
