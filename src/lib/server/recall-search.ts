/**
 * TT107 — original receipt-indexed memory search and pair-integrity audit.
 *
 * Both run entirely in PostgreSQL over the receipts this app itself wrote; they
 * never fetch a media URL and never return media bodies. Receipts that are not
 * valid JSON are *excluded and counted*, never allowed to abort the query:
 * `pg_input_is_valid` is evaluated inside a CASE so the cast cannot be hoisted
 * ahead of its own guard by the planner.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db';

const RECALL_ROOT = '/Downloads/Recall/';
const SUFFIX_LEN = '.recall.json'.length;
const MAX_ROWS = 100;

export interface RecallSearchQuery { method?: string | null; host?: string | null; from?: string | null; to?: string | null; limit?: string | null }

function bounded(value: string | null | undefined, max: number, pattern: RegExp, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value.length > max || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** Parsed receipt facts, joined to the live media row. Metadata only. */
export async function recallSearch(q: RecallSearchQuery) {
  const method = bounded(q.method, 64, /^[a-z][a-z0-9-]{0,63}$/, 'method filter');
  const host = bounded(q.host, 255, /^[a-z0-9.-]+(:[0-9]{1,5})?$/i, 'host filter');
  const from = bounded(q.from, 32, /^\d{4}-\d{2}-\d{2}([T ].*)?$/, 'from date');
  const to = bounded(q.to, 32, /^\d{4}-\d{2}-\d{2}([T ].*)?$/, 'to date');
  const limitRaw = bounded(q.limit, 3, /^[1-9][0-9]{0,2}$/, 'limit');
  const limit = Math.min(limitRaw ? Number(limitRaw) : MAX_ROWS, MAX_ROWS);
  for (const [value, label] of [[from, 'from date'], [to, 'to date']] as const)
    if (value !== null && Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${label}`);

  const rows = await db.execute(sql`
    WITH receipts AS (
      SELECT r.path AS receipt_path,
             left(r.path, length(r.path) - ${SUFFIX_LEN}) AS media_path,
             CASE WHEN pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END AS doc
        FROM vfs_nodes r
       WHERE r.kind = 'file' AND r.trashed = false AND r.encoding = 'utf8'
         AND r.name LIKE '%.recall.json' AND r.path LIKE ${RECALL_ROOT + '%'}
         AND octet_length(r.content) <= 16384
    ),
    facts AS (
      SELECT receipt_path, media_path,
             doc->>'method' AS method,
             substring(doc->>'page' from '^https?://([^/]+)') AS host,
             CASE WHEN pg_input_is_valid(doc->>'capturedAt', 'timestamptz')
                  THEN (doc->>'capturedAt')::timestamptz END AS captured_at
        FROM receipts WHERE doc IS NOT NULL
    )
    SELECT m.id, m.path, m.name, m.mime, m.size, f.method, f.host, f.captured_at AS "capturedAt"
      FROM facts f
      JOIN vfs_nodes m ON m.path = f.media_path AND m.kind = 'file' AND m.trashed = false
     WHERE (${method}::text IS NULL OR f.method = ${method})
       AND (${host}::text IS NULL OR lower(f.host) = lower(${host}))
       AND (${from}::text IS NULL OR f.captured_at >= ${from}::timestamptz)
       AND (${to}::text IS NULL OR f.captured_at <= ${to}::timestamptz)
     ORDER BY m.id DESC
     LIMIT ${limit}`);

  const totals = await db.execute(sql`
    SELECT count(*)::int AS receipts,
           count(*) FILTER (WHERE NOT pg_input_is_valid(content, 'jsonb'))::int AS unreadable
      FROM vfs_nodes
     WHERE kind = 'file' AND trashed = false AND encoding = 'utf8'
       AND name LIKE '%.recall.json' AND path LIKE ${RECALL_ROOT + '%'}`);

  return {
    ok: true,
    nodes: rows.rows,
    filters: { method, host, from, to, limit },
    scanned: totals.rows[0]?.receipts ?? 0,
    unreadableReceipts: totals.rows[0]?.unreadable ?? 0,
    bounds: { maxRows: MAX_ROWS, receiptBytes: 16384 },
    note: 'Receipt facts recorded at save time; integrity only, not authenticated provenance.',
  };
}

/**
 * Read-only pair-integrity report. Reports, never repairs: a missing receipt
 * cannot be regenerated without inventing provenance.
 */
export async function recallAudit(folder?: string | null) {
  const scope = folder && folder !== '' ? folder : null;
  if (scope !== null && (!/^\/Downloads\/Recall\/[^/]+$/.test(scope) || scope.length > 256 || /[\u0000-\u001f\u007f]/.test(scope)))
    throw new Error('Select one canonical Recall grouping folder');
  const like = scope === null ? RECALL_ROOT + '%' : scope + '/%';

  const report = await db.execute(sql`
    WITH files AS (
      SELECT id, path, name, sha256, content, encoding, kind, trashed,
             (name LIKE '%.recall.json') AS is_receipt
        FROM vfs_nodes
       WHERE kind = 'file' AND trashed = false AND path LIKE ${like}
    ),
    media AS (SELECT * FROM files WHERE NOT is_receipt),
    receipts AS (
      SELECT f.*, left(f.path, length(f.path) - ${SUFFIX_LEN}) AS media_path,
             CASE WHEN pg_input_is_valid(f.content, 'jsonb') THEN f.content::jsonb END AS doc
        FROM files f WHERE f.is_receipt
    )
    SELECT
      (SELECT count(*)::int FROM media) AS media_files,
      (SELECT count(*)::int FROM receipts) AS receipt_files,
      (SELECT coalesce(json_agg(path ORDER BY path), '[]'::json) FROM (
         SELECT m.path FROM media m
          WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.media_path = m.path) LIMIT 50) t) AS orphan_media,
      (SELECT coalesce(json_agg(path ORDER BY path), '[]'::json) FROM (
         SELECT r.path FROM receipts r
          WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.path = r.media_path) LIMIT 50) t) AS orphan_receipts,
      (SELECT coalesce(json_agg(path ORDER BY path), '[]'::json) FROM (
         SELECT r.path FROM receipts r WHERE r.doc IS NULL LIMIT 50) t) AS unreadable_receipts,
      (SELECT coalesce(json_agg(path ORDER BY path), '[]'::json) FROM (
         SELECT m.path FROM media m
           JOIN receipts r ON r.media_path = m.path
          WHERE r.doc IS NOT NULL AND m.encoding = 'base64'
            -- decode() raises on malformed input, so the shape is checked first and
            -- a corrupt body is reported as a mismatch rather than aborting the audit.
            AND (CASE WHEN m.content ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
                      THEN r.doc->>'sha256' IS DISTINCT FROM encode(sha256(decode(m.content, 'base64')), 'hex')
                      ELSE true END)
          LIMIT 50) t) AS checksum_mismatch`);

  const row = report.rows[0] as Record<string, unknown>;
  const list = (k: string) => (row[k] as string[]) ?? [];
  const healthy = Number(row.media_files) - list('orphan_media').length - list('checksum_mismatch').length;
  return {
    ok: true,
    scope: scope ?? 'all Recall folders',
    mediaFiles: Number(row.media_files), receiptFiles: Number(row.receipt_files),
    healthyPairs: Math.max(healthy, 0),
    orphanMedia: list('orphan_media'), orphanReceipts: list('orphan_receipts'),
    unreadableReceipts: list('unreadable_receipts'), checksumMismatch: list('checksum_mismatch'),
    sampleLimit: 50,
    note: 'Report only. Missing receipts are never regenerated, because provenance cannot be reconstructed after the fact. Trashed files are out of scope.',
  };
}
