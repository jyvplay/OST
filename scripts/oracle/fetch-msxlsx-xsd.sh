#!/usr/bin/env bash
# TT66: fetches the [MS-XLSX] Appendix A schemas (Microsoft Open Specifications — the published XSDs for the Excel 2010+
# extension namespaces x14 / xm / x15 …) used by scripts/oracle/xlsx_x14.py. TEST-ONLY data, not committed, never shipped.
# Source: the copy kept in github.com/maxprograms-com/OpenXLIFF (catalog/openxml/MS-XLSX-AppendixA), pinned to a commit.
# Uses the GitHub contents API via `gh` (raw.githubusercontent.com is not reachable from every sandbox).
# Usage: bash scripts/oracle/fetch-msxlsx-xsd.sh [DEST]   (default $MSXLSX_XSD or /home/user/tools/xsd/msxlsx)
set -euo pipefail
REF=0b39bc4843f00fe4263f0687c8b93e3959310a79
DIR=catalog/openxml/MS-XLSX-AppendixA
DEST=${1:-${MSXLSX_XSD:-/home/user/tools/xsd/msxlsx}}
mkdir -p "$DEST"
for f in $(gh api "repos/maxprograms-com/OpenXLIFF/contents/$DIR?ref=$REF" --jq '.[] | select(.type=="file") | .name'); do
  gh api -H "Accept: application/vnd.github.raw" "repos/maxprograms-com/OpenXLIFF/contents/$DIR/$f?ref=$REF" > "$DEST/$f.tmp" && mv "$DEST/$f.tmp" "$DEST/$f"
done
grep -q 'targetNamespace="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"' "$DEST/5_4_spreadsheetml_2009_9_main.xsd"
echo "MS-XLSX XSDs in $DEST ($(ls "$DEST"/*.xsd | wc -l) files); xlsx_x14.py builds the import-rewritten set on first use"
