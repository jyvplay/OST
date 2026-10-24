#!/usr/bin/env python3
"""TT54 test corpora for the metadata + thumbnail service (FF-13) — test-only, never committed or shipped.

usage: fetch-meta.py DEST        (e.g. /home/user/tools/corpus)
  DEST/exif/   real camera JPEG/TIFF files from ianare/exif-samples (pinned commit)
  DEST/audio/  real-world tagged audio from quodlibet/mutagen tests/data (pinned commit)
Both come from codeload.github.com tarballs (the only file host the sandbox allows besides PyPI/npm).
"""
import io, os, sys, tarfile, urllib.request

PINS = {
    "exif": ("ianare/exif-samples", "5332a9cf0220e9c6c93f88a187daa90808051e10", ("jpg/", "tiff/", "heic/")),
    "audio": ("quodlibet/mutagen", "ada28b2cc92c515f3f26640a6feef6516d195872", ("tests/data/",)),
}
dest = sys.argv[1]
for name, (repo, sha, prefixes) in PINS.items():
    out = os.path.join(dest, name); os.makedirs(out, exist_ok=True)
    url = f"https://codeload.github.com/{repo}/tar.gz/{sha}"
    data = urllib.request.urlopen(url, timeout=300).read()
    n = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
        for m in t.getmembers():
            if not m.isfile(): continue
            rel = m.name.split("/", 1)[1] if "/" in m.name else m.name
            if not rel.startswith(prefixes): continue
            flat = rel.replace("/", "__")
            with open(os.path.join(out, flat), "wb") as f: f.write(t.extractfile(m).read())
            n += 1
    with open(os.path.join(out, "SOURCE.txt"), "w") as f: f.write(f"{repo}@{sha}\n")
    print(name, n, "files")
