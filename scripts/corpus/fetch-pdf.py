#!/usr/bin/env python3
"""Fetch the PDF test corpus: mozilla/pdf.js test/pdfs (Apache-2.0 repository; TEST-ONLY, never shipped, kept outside the repo).

    python3 scripts/corpus/fetch-pdf.py [dest=/home/user/tools/corpus] [max_bytes=1048576]

Same transport as fetch.py (GitHub REST git trees + blobs; raw.githubusercontent.com is blocked in the sandbox).
The commit is pinned in <dest>/pdf/MANIFEST.tsv so results are reproducible; files already present with the same
git blob sha are skipped.  Writes <dest>/pdf/*.pdf.
"""
import base64, os, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from fetch import get, blob_sha  # noqa: E402  (shared GitHub API helpers)

REPO = "mozilla/pdf.js"
DEST = sys.argv[1] if len(sys.argv) > 1 else "/home/user/tools/corpus"
MAX = int(sys.argv[2]) if len(sys.argv) > 2 else 1 << 20
PIN = os.environ.get("PDFJS_COMMIT", "8fb674ceb7")  # the commit TT52 was measured on (prefix is enough for the API)

def main():
    head = get(f"https://api.github.com/repos/{REPO}/commits/{PIN}")
    tree = head["commit"]["tree"]["sha"]
    for part in ("test", "pdfs"):
        tree = next(e["sha"] for e in get(f"https://api.github.com/repos/{REPO}/git/trees/{tree}")["tree"] if e["path"] == part and e["type"] == "tree")
    entries = [e for e in get(f"https://api.github.com/repos/{REPO}/git/trees/{tree}")["tree"]
               if e["type"] == "blob" and e["path"].lower().endswith(".pdf") and e["size"] <= MAX]
    out = os.path.join(DEST, "pdf"); os.makedirs(out, exist_ok=True)

    def one(e):
        p = os.path.join(out, e["path"])
        if os.path.exists(p) and blob_sha(open(p, "rb").read()) == e["sha"]:
            return (e["path"], e["sha"], os.path.getsize(p), "cached")
        data = base64.b64decode(get(f"https://api.github.com/repos/{REPO}/git/blobs/{e['sha']}")["content"])
        if blob_sha(data) != e["sha"]:
            raise RuntimeError(f"sha mismatch for {e['path']}")
        open(p, "wb").write(data)
        return (e["path"], e["sha"], len(data), "fetched")

    with ThreadPoolExecutor(3) as pool:
        res = list(pool.map(one, entries))
    with open(os.path.join(out, "MANIFEST.tsv"), "w") as f:
        f.write(f"# {REPO} {head['sha']} test/pdfs, blobs <= {MAX} bytes\n")
        for n, s, size, _ in res:
            f.write(f"{n}\t{s}\t{size}\n")
    print(f"pdf: {len(res)} files ({sum(1 for r in res if r[3] == 'fetched')} fetched) from {REPO}@{head['sha'][:10]} test/pdfs")

if __name__ == "__main__":
    main()
