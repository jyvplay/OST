import type { SpecRow } from "./row";

/** TT89: preserve partial status where platform or independent-verification requirements remain. */
export function patchTT89(row: SpecRow): SpecRow {
  if (row.code === "ST-03") return {
    ...row, status: "partial",
    route: "Settings → Default apps: platform guide, handler capability and optional browser protocol registration request",
    nuance: "The guide provides Android, Windows, macOS and Linux steps, exposes the browser's launch-queue/protocol API availability, and can request registration or removal of web+fusion links. API exposure and a returned registration call do not reveal the user's choice or actual OS default; the guide says so. OS settings remain manual and vary by device/version. Browser UI was tested; physical Android/other OS workflows and actual installed-PWA associations were not. The old claim that browser registration state is directly queryable was incorrect.",
    test: "e2e-tt89-launch.mts exercises guide selection, the real Chromium protocol-registration API request, honest status and axe; this does not test native OS defaults or the user's browser approval.",
  };
  if (row.code === "SH-13") return {
    ...row, status: "partial",
    route: "PWA manifest and beforeinstallprompt; Shell LaunchQueue consumer; same-origin module links and consented UTF-8 file copies",
    nuance: "Shell now consumes launchQueue events after desktop hydration and handles documented web+fusion://open?app=<known-id> links on cold and existing-window launches. Up to eight selected UTF-8 text files, 1 MiB each, can be copied after explicit consent to /Documents without overwriting, then opened in Editor. Originals are not written back; copies are sent as plaintext to the Fusion server, and amnesic sessions refuse the import. Browser file-handler support and the OS's default association are not guaranteed. The Chromium tests deliver LaunchQueue events synthetically using real OPFS handles; an installed PWA launched by the OS has not been verified, nor have all share-target/single-instance cases.",
    test: "tt89-launch-unit.mts checks strict intent/file validation; e2e-tt89-launch.mts tests real Chromium, OPFS, consent, modal shortcuts, HTTP, a concurrent PostgreSQL create, amnesia and accessibility with synthetic launch delivery; tt89-launch-mutants.py checks injected defects. Prior tt85 install-event tests still apply.",
  };
  if (row.code === "AU-03") return {
    ...row, status: "partial",
    nuance: "The web+fusion protocol entry point now accepts the documented open-known-module intent; it does not accept arbitrary commands or arguments. Other existing API/postMessage paths have not been established as a complete shared command vocabulary. Native protocol association and installed-app launches remain unverified.",
    test: "tt89-launch-unit.mts adversarially checks protocol parsing; e2e-tt89-launch.mts checks a cold URL and synthetic existing-window delivery in Chromium. This is partial protocol coverage, not a native OS automation test.",
  };
  if (row.code !== "BK-05") return row;
  return {
    ...row, tier: "A", phase: "P2", status: "partial",
    route: "Backup → selected-file health and sampled scratch restore drill; PostgreSQL temporary tables with verified rollback",
    nuance: "The selected plain or browser-decrypted archive is fully validated, then a bounded deterministic sample is actually applied through the normal restore engine to isolated temporary PostgreSQL tables and read back, including the search index, before an acknowledged rollback. The decrypted bundle is sent to the Fusion server; temporary tables/indexes may be disk-backed and rollback is not secure erasure. Browser-local status contains only a date, result and counts; a calendar-month due indication is shown when the Backup window is open. Failed, partial, legacy, skipped-setting, empty, clock and inaccessible-storage states are not called healthy. No background scheduler or automatic notification is provided; not all files are restored, other copies and devices are not checked, Private-volume contents are not unlocked, and PostgreSQL temporary tables do not reproduce triggers/foreign keys or a durable second environment. BK-05 therefore remains partial, not Class A.",
    test: "tt89-drill-health.mts checks dates, malformed status and sampling; tt89-drill-db.mts uses real PostgreSQL, fault injection, read-back and production-table/sequence noninterference; tt89-drill-http.mts and e2e-tt89-drill.mts exercise API and real Chromium encrypted-file workflows. Tests are partial coverage of BK-05, not evidence of automatic monthly scheduling.",
  };
}
