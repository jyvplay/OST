"""TT88 independent, test-only AES-GCM/PBKDF2 oracle; reads one JSON object from stdin.
Uses pyca/cryptography, not the application's Web Crypto implementation. It is
not a Fusion runtime dependency. Do not use this helper for real secrets.
"""
import base64
import hashlib
import json
import os
import sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FORMAT = "fusion-recovery-bundle-1"

def b64(v): return base64.b64encode(v).decode("ascii")
def un64(v): return base64.b64decode(v, validate=True)
def aad_header(header): return json.dumps(header, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
def raw_recovery(s): return bytes.fromhex(s.removeprefix("FSR1-").replace("-", ""))
def pass_aad(it): return f"{FORMAT}|passphrase|PBKDF2-SHA256|{it}".encode("utf-8")
def recover_aad(): return f"{FORMAT}|recovery|AES-GCM-256".encode("utf-8")

args = json.load(sys.stdin)
passphrase = args["passphrase"].encode("utf-8")
recovery = raw_recovery(args["recovery"])
if args["operation"] == "open":
    b = args["bundle"]
    pk = hashlib.pbkdf2_hmac("sha256", passphrase, un64(b["salt"]), b["iterations"], 32)
    from_pass = AESGCM(pk).decrypt(un64(b["passIv"]), un64(b["passWrapped"]), pass_aad(b["iterations"]))
    from_recovery = AESGCM(recovery).decrypt(un64(b["recoveryIv"]), un64(b["recoveryWrapped"]), recover_aad())
    assert from_pass == from_recovery
    header = {k: v for k, v in b.items() if k != "data"}
    plain = AESGCM(from_pass).decrypt(un64(b["dataIv"]), un64(b["data"]), aad_header(header))
    print(json.dumps({"plaintext": plain.decode("utf-8")}))
elif args["operation"] == "seal":
    data_key, salt = os.urandom(32), os.urandom(16)
    p_iv, r_iv, d_iv = os.urandom(12), os.urandom(12), os.urandom(12)
    it = args.get("iterations", 600000)
    pk = hashlib.pbkdf2_hmac("sha256", passphrase, salt, it, 32)
    header = {"format": FORMAT, "cipher": "AES-GCM-256", "kdf": "PBKDF2-SHA256", "iterations": it,
              "salt": b64(salt), "passIv": b64(p_iv), "passWrapped": b64(AESGCM(pk).encrypt(p_iv, data_key, pass_aad(it))),
              "recoveryIv": b64(r_iv), "recoveryWrapped": b64(AESGCM(recovery).encrypt(r_iv, data_key, recover_aad())), "dataIv": b64(d_iv)}
    out = {**header, "data": b64(AESGCM(data_key).encrypt(d_iv, args["plaintext"].encode("utf-8"), aad_header(header)))}
    print(json.dumps(out))
else:
    raise ValueError("unknown operation")
