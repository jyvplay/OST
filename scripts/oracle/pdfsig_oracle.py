#!/usr/bin/env python3
"""TT77 test-only oracle for PDF signatures, built on pyHanko (MIT) + cryptography (Apache-2.0/BSD).

  pdfsig_oracle.py make OUTDIR      -> signed fixtures + manifest.jsonl (pyHanko's own verdict per signature)
  pdfsig_oracle.py validate FILE... -> one JSON line per file: [{field, intact, valid, coverage, docmdp}]
"""
import datetime, io, json, logging, os, sys
logging.disable(logging.CRITICAL)
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa
from cryptography.x509.oid import NameOID
import pikepdf
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign import signers
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext
from asn1crypto import x509 as ax509, keys as akeys


def name(cn):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Fusion TT77 oracle")])


def mkcert(key, cn, issuer_key=None, issuer_cn=None, ca=False):
    now = datetime.datetime.now(datetime.timezone.utc)
    b = (x509.CertificateBuilder().subject_name(name(cn)).issuer_name(name(issuer_cn or cn)).public_key(key.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=365))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
         .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False, data_encipherment=False, key_agreement=False, key_cert_sign=ca, crl_sign=ca, encipher_only=False, decipher_only=False), critical=True)
         .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False))
    sk = issuer_key or key
    algo = None if isinstance(sk, ed25519.Ed25519PrivateKey) else hashes.SHA256()
    return b.sign(sk, algo)


def a_cert(c):
    return ax509.Certificate.load(c.public_bytes(serialization.Encoding.DER))


def a_key(k):
    return akeys.PrivateKeyInfo.load(k.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


def base_pdf():
    p = pikepdf.new()
    p.add_blank_page(page_size=(200, 200))
    p.pages[0].Contents = p.make_stream(b"BT /F1 12 Tf 20 100 Td (Signed by the TT77 oracle) Tj ET")
    p.pages[0].Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica)))
    b = io.BytesIO()
    p.save(b, compress_streams=False)
    return b.getvalue()


def sign(data, key, cert, field, chain=(), pss=False, md="sha256"):
    from pyhanko_certvalidator.registry import SimpleCertificateStore
    s = signers.SimpleSigner(signing_cert=a_cert(cert), signing_key=a_key(key), cert_registry=SimpleCertificateStore.from_certs([a_cert(c) for c in chain]), prefer_pss=pss)
    w = IncrementalPdfFileWriter(io.BytesIO(data))
    out = signers.sign_pdf(w, signers.PdfSignatureMetadata(field_name=field, md_algorithm=md, reason="TT77 oracle", location="Raleigh"), signer=s)
    return out.getvalue()


def reader(data):
    # strict first; the corpus has files with orphaned generations (non-strict) and empty-password encryption
    for strict in (True, False):
        try:
            r = PdfFileReader(io.BytesIO(data), strict=strict)
            if r.encrypted:
                r.decrypt("")
            _ = r.embedded_signatures
            return r
        except Exception:
            if not strict:
                raise


def verdicts(data):
    r = reader(data)
    out = []
    for s in r.embedded_signatures:
        try:
            st = validate_pdf_signature(s, ValidationContext(allow_fetching=False))
            out.append({"field": s.field_name, "intact": bool(st.intact), "valid": bool(st.valid), "coverage": str(st.coverage).split(".")[-1], "modification": str(getattr(st, "modification_level", "")).split(".")[-1]})
        except Exception as e:
            out.append({"field": s.field_name, "error": str(e)[:200]})
    return out


def make(outdir):
    os.makedirs(outdir, exist_ok=True)
    base = base_pdf()
    rsa_k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    p256 = ec.generate_private_key(ec.SECP256R1())
    p384 = ec.generate_private_key(ec.SECP384R1())
    edk = ed25519.Ed25519PrivateKey.generate()
    root_k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root = mkcert(root_k, "TT77 Root CA", ca=True)
    leaf_k = ec.generate_private_key(ec.SECP256R1())
    leaf = mkcert(leaf_k, "TT77 Leaf", issuer_key=root_k, issuer_cn="TT77 Root CA")
    cases = {
        "rsa_pkcs1": sign(base, rsa_k, mkcert(rsa_k, "RSA Signer"), "Sig1"),
        "rsa_pss": sign(base, rsa_k, mkcert(rsa_k, "PSS Signer"), "Sig1", pss=True),
        "ecdsa_p256": sign(base, p256, mkcert(p256, "P-256 Signer"), "Sig1"),
        "ecdsa_p384_sha384": sign(base, p384, mkcert(p384, "P-384 Signer"), "Sig1", md="sha384"),
        "ed25519": sign(base, edk, mkcert(edk, "Ed25519 Signer"), "Sig1", md="sha512"),
        "chain": sign(base, leaf_k, leaf, "Sig1", chain=[root]),
    }
    cases["double"] = sign(cases["rsa_pkcs1"], p256, mkcert(p256, "Second Signer"), "Sig2")
    # tampered: flip one byte of the page content inside the signed range
    t = bytearray(cases["rsa_pkcs1"]); i = t.find(b"Signed by"); assert i > 0; t[i] = ord("Z"); cases["tampered"] = bytes(t)
    # appended: an incremental update after signing (changes the document; the signature still covers its revision)
    w = IncrementalPdfFileWriter(io.BytesIO(cases["ecdsa_p256"]));
    from pyhanko.pdf_utils import generic
    w.root[generic.NameObject("/Lang")] = generic.TextStringObject("en-US"); w.update_root()
    b = io.BytesIO(); w.write(b); cases["appended"] = b.getvalue()
    for k, data in cases.items():
        path = os.path.join(outdir, k + ".pdf")
        with open(path, "wb") as f:
            f.write(data)
        print(json.dumps({"name": k, "file": path, "pyhanko": verdicts(data)}))
    with open(os.path.join(outdir, "base.pdf"), "wb") as f:
        f.write(base)


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    else:
        for f in sys.argv[2:]:
            with open(f, "rb") as fh:
                print(json.dumps({"file": f, "pyhanko": verdicts(fh.read())}))
