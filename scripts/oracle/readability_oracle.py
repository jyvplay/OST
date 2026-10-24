"""Test-only oracle for the reader view (TT36): readability-lxml (Apache-2.0), a Python port of Arc90 / Mozilla
Readability. Reads a page's HTML on stdin, prints {"title", "text"} of what Readability considers the article."""
import json, re, sys
from readability import Document
import lxml.html

html = sys.stdin.read()
doc = Document(html, url=sys.argv[1] if len(sys.argv) > 1 else None)
summary = doc.summary(html_partial=True)
text = lxml.html.fromstring(summary).text_content() if summary.strip() else ""
print(json.dumps({"title": doc.short_title(), "text": re.sub(r"\s+", " ", text).strip()}))
