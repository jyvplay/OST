#!/usr/bin/env bash
# A sequential, bounded production regression gate, NOT the repository's entire suite inventory.
# Several constituent tests revoke privileges, inject DB faults or clear disposable Private/cache data.
# The database and running server must be exclusive and correspond to each other.
set -euo pipefail
if [ "${TT89_DISPOSABLE_DATABASE:-0}" != "1" ] || [ -z "${DATABASE_URL:-}" ] || [ -z "${BASE:-}" ]; then
  echo "Refusing TT96 gate without explicit disposable opt-in, DATABASE_URL, and matching BASE." >&2
  exit 2
fi
cd "$(dirname "$0")/.."
export SUITES="integration tabletop-unit e2e-tabletop tt55-files-unit e2e-tt55-files e2e-tt55-shell tt67-input e2e-tt67-input e2e-tt81 e2e-a11y e2e-tt35 tt86-pointer e2e-tt86-pointer tt87-pointer-queue e2e-tt87-pointer-fallback tt87-transaction tt87-backup tt87-backup-http e2e-tt87-backup e2e-tt87-localdisk e2e-tt87-privacy tt88-recovery e2e-tt88-recovery tt89-drill-health tt89-drill-db tt89-drill-http e2e-tt89-drill tt89-launch-unit e2e-tt89-launch tt90-context-unit e2e-tt90-context tt90-worker-pool tt90-private-thumb-path e2e-tt90-thumbnails e2e-tt90-private-thumbnails tt91-thumbnail-cleanup-race tt91-purge tt91-purge-race tt91-write-atomic e2e-tt91-purge tt91-browser-download e2e-tt91-browser-download tt92-trash tt92-trash-race e2e-tt92-trash tt92-ledger-audit tt92-ledger-policy e2e-tt54 tt93-transfer tt93-transfer-race tt93-restore-race tt93-metadata-race e2e-tt93-sidecar e2e-tt93-photos-clear tt94-photo-guard tt94-photo-guard-race e2e-tt94-photo-stale e2e-tt94-photos-offline e2e-tt94-offline-race tt95-photo-concurrency tt95-photo-race e2e-tt95-photo-concurrency tt95-calculator-audit e2e-tt95-a11y-settings-race tt89-test-safety privacy-crypto privacy-layer privacy-backup e2e-privacy tt96-programmer tt96-calc-history e2e-tt96-calculator e2e-tt96-desktop-menu e2e-tt96-files-contrast"
exec bash scripts/run-all.sh
