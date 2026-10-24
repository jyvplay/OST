#!/usr/bin/env bash
# TT52: regenerate the PDFium/pypdf reference data the PDF differentials read (wiped by every sandbox reset):
#   /tmp/struct.jsonl (page tree), /tmp/text.jsonl (first 3 pages' text), /tmp/ref/*.p0.png + /tmp/render.jsonl (page-1 renders)
# Renders run one file per process under `timeout`: PDFium crashes the process on some corpus files and hangs on one.
set -uo pipefail
PY=/home/user/tools/venv/bin/python; C=/home/user/tools/corpus/pdf; P="$(cd "$(dirname "$0")/../.." && pwd)/scripts/oracle/pdf_probe.py"
declare -A PW=([issue15893_reduced.pdf]=test [issue3371.pdf]=ELXRTQWS [issue6010_1.pdf]=abc [issue6010_2.pdf]=æøå [bug1782186.pdf]=Hello [issue21579.pdf]=pässwört [saslprep-r6.pdf]=$'SªSL\u00adprep')
cd "$C"; rm -rf /tmp/ref; mkdir -p /tmp/ref; : > /tmp/struct.jsonl; : > /tmp/text.jsonl; : > /tmp/render.jsonl
for f in *.pdf; do
  pw=(); [ -n "${PW[$f]:-}" ] && pw=(--password "${PW[$f]}")
  timeout 30 "$PY" "$P" --struct "${pw[@]}" "$f" >> /tmp/struct.jsonl 2>/dev/null || echo "{\"file\": \"$f\", \"error\": \"struct timeout/crash\"}" >> /tmp/struct.jsonl
  timeout 30 "$PY" "$P" --text --pages 3 "${pw[@]}" "$f" >> /tmp/text.jsonl 2>/dev/null || echo "{\"file\": \"$f\", \"error\": \"text timeout/crash\"}" >> /tmp/text.jsonl
  timeout 30 "$PY" "$P" --render /tmp/ref --scale 1 --pages 1 "${pw[@]}" "$f" >> /tmp/render.jsonl 2>/dev/null || echo "{\"file\": \"$f\", \"error\": \"render timeout/crash\"}" >> /tmp/render.jsonl
done
echo "struct $(wc -l < /tmp/struct.jsonl) text $(wc -l < /tmp/text.jsonl) render $(grep -c '"pngs": \[{' /tmp/render.jsonl)"
