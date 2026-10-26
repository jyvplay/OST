#!/usr/bin/env python3
"""TT79 test-only oracle for PKCS#12 identities and signature trust, built on pyca/cryptography + pyHanko (MIT).

  p12_oracle.py make OUTDIR          -> CA hierarchy, PFX files (cryptography writer), PEM/DER parts, manifest.json
  p12_oracle.py keyeq A.der B.der    -> "same" when two PKCS#8 DER keys hold the same private key
  p12_oracle.py trust FILE [ROOT...] -> JSON per signature: intact, valid, trusted, bottom_line (pyHanko, roots given)
"""
import datetime, io, json, logging, os, sys
logging.disable(logging.CRITICAL)
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

DER, PEM = serialization.Encoding.DER, serialization.Encoding.PEM


def name(cn):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Fusion TT79 oracle")])


def mkcert(key, cn, issuer_key=None, issuer_cn=None, ca=False, days=(-1, 365), sign_usage=True):
    now = datetime.datetime.now(datetime.timezone.utc)
    ku = x509.KeyUsage(digital_signature=sign_usage, content_commitment=sign_usage, key_encipherment=not sign_usage, data_encipherment=False, key_agreement=False,
                       key_cert_sign=ca, crl_sign=ca, encipher_only=False, decipher_only=False)
    b = (x509.CertificateBuilder().subject_name(name(cn)).issuer_name(name(issuer_cn or cn)).public_key(key.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(now + datetime.timedelta(days=days[0])).not_valid_after(now + datetime.timedelta(days=days[1]))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
         .add_extension(ku, critical=True)
         .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False))
    return b.sign(issuer_key or key, hashes.SHA256())


def pk8(k):
    return k.private_bytes(DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


def make(out):
    os.makedirs(out, exist_ok=True)
    root_k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root = mkcert(root_k, "TT79 Root CA", ca=True)
    inter_k = ec.generate_private_key(ec.SECP256R1())
    inter = mkcert(inter_k, "TT79 Issuing CA", root_k, "TT79 Root CA", ca=True)
    leaf_k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = mkcert(leaf_k, "Ada Signer", inter_k, "TT79 Issuing CA")
    ec_k = ec.generate_private_key(ec.SECP256R1())
    ec_leaf = mkcert(ec_k, "Émile Signer", inter_k, "TT79 Issuing CA")
    # negatives for trust: an intermediate that is NOT a CA, an expired leaf, a leaf whose key usage forbids signing
    notca_k = ec.generate_private_key(ec.SECP256R1())
    notca = mkcert(notca_k, "TT79 Not-a-CA", root_k, "TT79 Root CA", ca=False)
    under_notca_k = ec.generate_private_key(ec.SECP256R1())
    under_notca = mkcert(under_notca_k, "Under Not-a-CA", notca_k, "TT79 Not-a-CA")
    expired_k = ec.generate_private_key(ec.SECP256R1())
    expired = mkcert(expired_k, "Expired Signer", inter_k, "TT79 Issuing CA", days=(-400, -10))
    nosign_k = ec.generate_private_key(ec.SECP256R1())
    nosign = mkcert(nosign_k, "Encipher-only Signer", inter_k, "TT79 Issuing CA", sign_usage=False)
    other_k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_root = mkcert(other_k, "Unrelated Root", ca=True)
    for n, c in [("root", root), ("inter", inter), ("leaf", leaf), ("ec_leaf", ec_leaf), ("other_root", other_root)]:
        open(os.path.join(out, n + ".der"), "wb").write(c.public_bytes(DER))
    open(os.path.join(out, "leaf.key.der"), "wb").write(pk8(leaf_k))
    open(os.path.join(out, "ec_leaf.key.der"), "wb").write(pk8(ec_k))
    open(os.path.join(out, "leaf.key.pem"), "wb").write(leaf_k.private_bytes(PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    open(os.path.join(out, "leaf.pem"), "wb").write(leaf.public_bytes(PEM))
    open(os.path.join(out, "chain.pem"), "wb").write(inter.public_bytes(PEM) + root.public_bytes(PEM))
    open(os.path.join(out, "other.key.pem"), "wb").write(other_k.private_bytes(PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    pw = b"correct horse"
    uni = "pässwörd✓".encode()
    enc = serialization.PrivateFormat.PKCS12.encryption_builder
    files = {
        "cg_best.p12": (pkcs12.serialize_key_and_certificates(b"ada", leaf_k, leaf, [inter, root], serialization.BestAvailableEncryption(pw)), pw, "leaf.key.der"),
        "cg_pbes2.p12": (pkcs12.serialize_key_and_certificates(b"ada", leaf_k, leaf, [inter, root],
                         enc().kdf_rounds(30000).key_cert_algorithm(pkcs12.PBES.PBESv2SHA256AndAES256CBC).hmac_hash(hashes.SHA512()).build(pw)), pw, "leaf.key.der"),
        "cg_3des.p12": (pkcs12.serialize_key_and_certificates(b"ada", leaf_k, leaf, [inter, root],
                        enc().kdf_rounds(2048).key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC).hmac_hash(hashes.SHA1()).build(pw)), pw, "leaf.key.der"),
        "cg_ec_unicode.p12": (pkcs12.serialize_key_and_certificates(b"emile", ec_k, ec_leaf, [inter, root], serialization.BestAvailableEncryption(uni)), uni, "ec_leaf.key.der"),
        "cg_plain.p12": (pkcs12.serialize_key_and_certificates(b"ada", leaf_k, leaf, [inter, root], serialization.NoEncryption()), b"", "leaf.key.der"),
        "notca.p12": (pkcs12.serialize_key_and_certificates(b"n", under_notca_k, under_notca, [notca, root], serialization.BestAvailableEncryption(pw)), pw, None),
        "expired.p12": (pkcs12.serialize_key_and_certificates(b"x", expired_k, expired, [inter, root], serialization.BestAvailableEncryption(pw)), pw, None),
        "nosign.p12": (pkcs12.serialize_key_and_certificates(b"e", nosign_k, nosign, [inter, root], serialization.BestAvailableEncryption(pw)), pw, None),
    }
    man = {}
    for n, (data, p, key) in files.items():
        open(os.path.join(out, n), "wb").write(data)
        man[n] = {"password": p.decode(), "key": key}
    json.dump(man, open(os.path.join(out, "manifest.json"), "w"), ensure_ascii=False)
    print("ok", len(files))


def keyeq(a, b):
    ka = serialization.load_der_private_key(open(a, "rb").read(), None)
    kb = serialization.load_der_private_key(open(b, "rb").read(), None)
    print("same" if ka.private_numbers() == kb.private_numbers() else "different")


def trust(path, roots):
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext
    from asn1crypto import x509 as ax509
    r = PdfFileReader(io.BytesIO(open(path, "rb").read()), strict=True)
    trs = [ax509.Certificate.load(open(x, "rb").read()) for x in roots]
    out = []
    for s in r.embedded_signatures:
        try:
            vc = ValidationContext(trust_roots=trs, allow_fetching=False) if trs else ValidationContext(allow_fetching=False)
            st = validate_pdf_signature(s, vc)
            out.append({"field": s.field_name, "intact": bool(st.intact), "valid": bool(st.valid), "trusted": bool(st.trusted), "bottom_line": bool(st.bottom_line),
                        "coverage": str(st.coverage).split(".")[-1], "modification": str(getattr(st, "modification_level", "")).split(".")[-1]})
        except Exception as e:
            out.append({"field": s.field_name, "error": str(e)[:300]})
    print(json.dumps(out))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "make":
        make(sys.argv[2])
    elif cmd == "keyeq":
        keyeq(sys.argv[2], sys.argv[3])
    elif cmd == "trust":
        trust(sys.argv[2], sys.argv[3:])
