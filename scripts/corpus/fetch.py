#!/usr/bin/env python3
"""Fetch the Apache POI test-data office corpus (Apache-2.0; TEST-ONLY, never shipped).

    python3 scripts/corpus/fetch.py [dest=/home/user/tools/corpus]

raw.githubusercontent.com is not reachable from the sandbox, so files come through
the GitHub REST API (git trees + blobs, base64).  Authentication reuses the gh CLI
login (`gh auth token`) when available; anonymous works but is rate-limited (60/h).
Idempotent: files already present with the same git blob sha are skipped.
Writes <dest>/xlsx/*.xlsx, <dest>/docx/*.docx and <dest>/MANIFEST.tsv (name, sha, bytes).
"""
import base64, hashlib, json, os, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

REPO = "apache/poi"
DIRS = {"xlsx": ("test-data/spreadsheet", ".xlsx"), "docx": ("test-data/document", ".docx")}
DEST = sys.argv[1] if len(sys.argv) > 1 else "/home/user/tools/corpus"

def token():
    t = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if t:
        return t
    try:
        return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=20).stdout.strip() or None
    except Exception:
        return None

TOK = token()

def get(url, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "fusion-corpus-fetch", **({"Authorization": f"Bearer {TOK}"} if TOK else {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # transient 5xx / resets: back off
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))

def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()

def main():
    head = get(f"https://api.github.com/repos/{REPO}/commits/trunk")
    root = head["commit"]["tree"]["sha"]
    manifest = []
    for kind, (path, ext) in DIRS.items():
        tree = root
        for part in path.split("/"):
            t = get(f"https://api.github.com/repos/{REPO}/git/trees/{tree}")
            tree = next(e["sha"] for e in t["tree"] if e["path"] == part and e["type"] == "tree")
        entries = [e for e in get(f"https://api.github.com/repos/{REPO}/git/trees/{tree}")["tree"] if e["type"] == "blob" and e["path"].lower().endswith(ext)]
        out = os.path.join(DEST, kind); os.makedirs(out, exist_ok=True)

        def one(e):
            p = os.path.join(out, e["path"])
            if os.path.exists(p) and blob_sha(open(p, "rb").read()) == e["sha"]:
                return (e["path"], e["sha"], os.path.getsize(p), "cached")
            b = get(f"https://api.github.com/repos/{REPO}/git/blobs/{e['sha']}")
            data = base64.b64decode(b["content"])
            if blob_sha(data) != e["sha"]:
                raise RuntimeError(f"sha mismatch for {e['path']}")
            open(p, "wb").write(data)
            return (e["path"], e["sha"], len(data), "fetched")

        with ThreadPoolExecutor(3) as pool:  # ≤3 threads: secondary rate limits
            res = list(pool.map(one, entries))
        manifest += [(kind, *r) for r in res]
        print(f"{kind}: {len(res)} files ({sum(1 for r in res if r[3] == 'fetched')} fetched) from {path} @ {head['sha'][:10]}")
    with open(os.path.join(DEST, "MANIFEST.tsv"), "w") as f:
        f.write(f"# apache/poi trunk {head['sha']}\n")
        for k, n, s, size, _ in manifest:
            f.write(f"{k}\t{n}\t{s}\t{size}\n")

if __name__ == "__main__":
    main()
