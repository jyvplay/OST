#!/usr/bin/env bash
# TT76 test-only oracle corpus for AutoFilter criteria evaluation (scripts/tt76-sheet.mts O1).
# ClosedXML (MIT) test resources — their hidden rows were computed by ClosedXML / Excel / LibreOffice — plus Apache POI's
# ConditionalFormattingSamples.xlsx (Apache-2.0, written by Excel; already in the POI corpus). Never shipped in Fusion.
set -u
OUT=/home/user/tools/corpus/filters; mkdir -p "$OUT"
get() { # $1 = repo path under ClosedXML.Tests/Resource, $2 = local name
  [ -s "$OUT/$2" ] && return 0
  curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/ClosedXML/ClosedXML/contents/ClosedXML.Tests/Resource/$1?ref=develop" -o "$OUT/$2" || { echo "fetch failed: $1"; rm -f "$OUT/$2"; }
}
for n in CustomAutoFilter DateTimeGroupAutoFilter DynamicAutoFilter RegularAutoFilter TopBottomAutoFilter; do get "Examples/AutoFilter/$n.xlsx" "cx_Examples_AutoFilter_$n.xlsx"; done
get "Examples/Misc/AutoFilter.xlsx" "cx_Examples_Misc_AutoFilter.xlsx"
get "Other/AutoFilter/AutoFilterWithThousandsSeparator.xlsx" "cx_Other_AutoFilter_AutoFilterWithThousandsSeparator.xlsx"
get "TryToLoad/LO/xlsx/autofilter.xlsx" "cx_TryToLoad_LO_xlsx_autofilter.xlsx"
get "TryToLoad/SingleRowAutoFilter.xlsx" "cx_TryToLoad_SingleRowAutoFilter.xlsx"
get "TryToLoad/FilterPrivacyEnabledWorkbook.xlsx" "cx_TryToLoad_FilterPrivacyEnabledWorkbook.xlsx"
POI=/home/user/tools/corpus/xlsx/ConditionalFormattingSamples.xlsx
[ -s "$POI" ] && cp -n "$POI" "$OUT/poi_ConditionalFormattingSamples.xlsx"
ls "$OUT" | wc -l
