"""Independent oracle for the TT18 Encrypted Persistent Storage format (src/lib/privacy/pcrypt.ts).

Implements the format from its written specification using pyca/cryptography (OpenSSL AES-GCM,
HKDF, HMAC) and argon2-cffi (the reference phc-winner-argon2 C implementation) — no shared code
with the TypeScript side. Reads one JSON request on stdin, writes one JSON response on stdout.

ops:
  argon2      {password, salt_b64, m, t, p}            -> {hex}
  pbkdf2      {password, salt_b64, iterations}         -> {hex}
  padme       {lengths: [...]}                         -> {padded: [...]}   (paper pseudocode)
  unwrap      {header, secret}                         -> {dek_b64}        (tries every slot)
  decrypt     {dek_b64, volume_b64, blob_b64}          -> {data_b64, mime, encoding}
  encrypt     {dek_b64, volume_b64, data_b64, mime, encoding} -> {blob_b64}
  name        {dek_b64, volume_b64, name}              -> {enc}            (deterministic, must match)
  name_dec    {dek_b64, volume_b64, enc}               -> {name}
  name_bad_iv {dek_b64, volume_b64, name}              -> {enc}            (valid GCM, random nonce)
"""
import base64, hashlib, hmac, json, math, os, struct, sys, unicodedata

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

FMT = "fusion-private-1"
b64d = base64.b64decode
b64e = lambda b: base64.b64encode(b).decode()


def b64u_e(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def b64u_d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hkdf(dek, volume, info):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=volume, info=f"{FMT}/{info}".encode()).derive(dek)


def kek(secret, salt, kdf):
    pw = unicodedata.normalize("NFKC", secret).encode()
    if kdf["kdf"] == "argon2id":
        return hash_secret_raw(pw, salt, time_cost=kdf["t"], memory_cost=kdf["m"], parallelism=kdf["p"], hash_len=32, type=Type.ID)
    return hashlib.pbkdf2_hmac("sha256", pw, salt, kdf["iterations"], 32)


def kdf_tag(k):
    return f"argon2id:m={k['m']},t={k['t']},p={k['p']}" if k["kdf"] == "argon2id" else f"pbkdf2-sha256:i={k['iterations']}"


def norm_recovery(s):
    return s.upper().replace(" ", "").replace("-", "").replace("O", "0").replace("I", "1").replace("L", "1")


def padme(L):
    # Nikitin et al., PETS 2019, Algorithm 1
    if L < 2:
        return L
    E = int(math.floor(math.log2(L)))
    S = int(math.floor(math.log2(E))) + 1
    last = E - S
    mask = (1 << last) - 1
    return (L + mask) & ~mask


def main():
    req = json.load(sys.stdin)
    op = req["op"]
    if op == "argon2":
        out = hash_secret_raw(req["password"].encode(), b64d(req["salt_b64"]), time_cost=req["t"], memory_cost=req["m"], parallelism=req["p"], hash_len=32, type=Type.ID)
        return {"hex": out.hex()}
    if op == "pbkdf2":
        return {"hex": hashlib.pbkdf2_hmac("sha256", req["password"].encode(), b64d(req["salt_b64"]), req["iterations"], 32).hex()}
    if op == "padme":
        return {"padded": [padme(L) for L in req["lengths"]]}
    if op == "unwrap":
        h = req["header"]
        for s in h["slots"]:
            secret = norm_recovery(req["secret"]) if s["kind"] == "recovery" else req["secret"]
            k = kek(secret, b64d(s["salt"]), s["kdf"])
            aad = f"{FMT}|{h['volumeId']}|{s['id']}|{s['kind']}|{kdf_tag(s['kdf'])}".encode()
            try:
                return {"dek_b64": b64e(AESGCM(k).decrypt(b64d(s["iv"]), b64d(s["wrapped"]), aad)), "slot": s["id"]}
            except Exception:
                continue
        return {"error": "no slot opened"}
    dek, vol = b64d(req["dek_b64"]), b64d(req["volume_b64"])
    if op == "decrypt":
        blob = b64d(req["blob_b64"])
        assert blob[:4] == b"FEN1" and blob[4] == 1, "magic/version"
        flags = blob[5]
        aad = b"FEN1" + bytes([1, flags]) + vol
        pt = AESGCM(hkdf(dek, vol, "content-v1")).decrypt(blob[6:18], blob[18:], aad)
        (n,) = struct.unpack(">I", pt[:4])
        ml = pt[4]
        mime = pt[5:5 + ml].decode()
        encd = "base64" if pt[5 + ml] == 1 else "utf8"
        data = pt[6 + ml:6 + ml + n]
        pad = pt[6 + ml + n:]
        return {"data_b64": b64e(data), "mime": mime, "encoding": encd, "payload_len": len(pt), "padding_all_zero": all(b == 0 for b in pad)}
    if op == "encrypt":
        data, mime = b64d(req["data_b64"]), req["mime"].encode()
        head = struct.pack(">I", len(data)) + bytes([len(mime)]) + mime + bytes([1 if req["encoding"] == "base64" else 0])
        body = head + data
        payload = body + b"\0" * (padme(len(body)) - len(body))
        iv = os.urandom(12)
        aad = b"FEN1" + bytes([1, 1]) + vol
        return {"blob_b64": b64e(b"FEN1" + bytes([1, 1]) + iv + AESGCM(hkdf(dek, vol, "content-v1")).encrypt(iv, payload, aad))}
    if op in ("name", "name_bad_iv"):
        pt = unicodedata.normalize("NFC", req["name"]).encode()
        siv = hmac.new(hkdf(dek, vol, "names-siv-v1"), pt, hashlib.sha256).digest()[:12]
        if op == "name_bad_iv":
            siv = os.urandom(12)
        ct = AESGCM(hkdf(dek, vol, "names-v1")).encrypt(siv, pt, b"FNM1|" + vol)
        return {"enc": "~" + b64u_e(siv + ct)}
    if op == "name_dec":
        raw = b64u_d(req["enc"][1:])
        pt = AESGCM(hkdf(dek, vol, "names-v1")).decrypt(raw[:12], raw[12:], b"FNM1|" + vol)
        return {"name": pt.decode()}
    return {"error": f"unknown op {op}"}


if __name__ == "__main__":
    json.dump(main(), sys.stdout)
