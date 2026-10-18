"""Test-only oracle for TT35 (tt35-unit): walk HTML with Python's own html.parser (independent of Fusion's
tokenizer) and report every URL-bearing attribute that could still reach the network OUTSIDE the proxy, plus the
start-tag sequence (to prove the rewriter loses no markup).

stdin:  JSON list of {"html": str, "prefix": str}
stdout: JSON list of {"leaks": [[tag, attr, value]], "tags": [tag...], "urls": int}
"""
import json
import sys
from html.parser import HTMLParser

URL_ATTRS = {"href", "src", "action", "formaction", "poster", "data", "background", "xlink:href", "manifest"}
SRCSET = {"srcset", "imagesrcset"}
SAFE = ("data:", "blob:", "javascript:", "mailto:", "tel:", "sms:", "about:", "#", "ws:", "wss:", "intent:", "geo:", "magnet:", "chrome:", "file:", "ftp:")


def network(v, prefix):
    v = v.strip()
    if not v or v.lower().startswith(SAFE):
        return False
    if v.startswith(prefix):
        return False
    low = v.lower()
    # absolute, protocol-relative or root-relative URLs escape the proxy's path; plain relative ones stay inside it
    return low.startswith("http:") or low.startswith("https:") or v.startswith("//") or v.startswith("/") or v.startswith("\\")


class P(HTMLParser):
    def __init__(self, prefix):
        super().__init__(convert_charrefs=True)
        self.prefix = prefix
        self.leaks = []
        self.tags = []
        self.urls = 0

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        for k, v in attrs:
            if v is None:
                continue
            k = k.lower()
            if k == "data" and tag != "object":
                continue
            if k in URL_ATTRS:
                self.urls += 1
                if network(v, self.prefix):
                    self.leaks.append([tag, k, v[:200]])
            elif k in SRCSET:
                for cand in v.split(","):
                    parts = cand.strip().split()
                    if parts:
                        self.urls += 1
                        if network(parts[0], self.prefix):
                            self.leaks.append([tag, k, parts[0][:200]])

    handle_startendtag = handle_starttag


out = []
for job in json.load(sys.stdin):
    p = P(job["prefix"])
    p.feed(job["html"])
    p.close()
    out.append({"leaks": p.leaks, "tags": p.tags, "urls": p.urls})
json.dump(out, sys.stdout)
