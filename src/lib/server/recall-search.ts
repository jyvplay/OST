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

export interface RecallSearchQuery { method?: string | null; host?: string | null; from?: string | null; to?: string | null; limit?: string | null; folder?: string | null }

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
  // TT108: a folder-scoped timeline must drill down inside its own scope, so the
  // search accepts the same canonical grouping folder the timeline and audit take.
  const folder = bounded(q.folder, 256, /^\/Downloads\/Recall\/[^/]+$/, 'folder filter');
  if (folder !== null && /[\u0000-\u001f\u007f]/.test(folder)) throw new Error('Invalid folder filter');
  const folderLike = folder === null ? null : folder + '/%';
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
     WHERE (${folderLike}::text IS NULL OR m.path LIKE ${folderLike})
       AND (${method}::text IS NULL OR f.method = ${method})
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
    filters: { method, host, from, to, limit, folder },
    scanned: totals.rows[0]?.receipts ?? 0,
    unreadableReceipts: totals.rows[0]?.unreadable ?? 0,
    bounds: { maxRows: MAX_ROWS, receiptBytes: 16384 },
    note: 'Receipt facts recorded at save time; integrity only, not authenticated provenance.',
  };
}

/**
 * TT108 (RC-32) — a day-grouped timeline of saving activity.
 *
 * The shape is borrowed from the screenshot timelines shipped by large vendors:
 * scrub by day, see how much is there, jump straight to it. The substance is
 * deliberately different and the UI says so — these are only the memories a person
 * explicitly saved. Fusion records no periodic background snapshots, so a quiet day
 * is genuinely absent from this timeline rather than hidden.
 *
 * Grouping happens in UTC so a day bucket is reproducible regardless of where the
 * server runs; receipts whose capture time is unreadable are counted apart rather
 * than being dropped into an arbitrary day.
 */
const MAX_DAYS = 90;

export async function recallTimeline(folder?: string | null, tz?: string | null) {
  const scope = folder && folder !== '' ? folder : null;
  if (scope !== null && (!/^\/Downloads\/Recall\/[^/]+$/.test(scope) || scope.length > 256 || /[\u0000-\u001f\u007f]/.test(scope)))
    throw new Error('Select one canonical Recall grouping folder');
  // An IANA zone name only; the value reaches AT TIME ZONE as a bound parameter.
  if (tz !== undefined && tz !== null && tz !== '' && (tz.length > 64 || !/^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+._-]+){0,2}$/.test(tz)))
    throw new Error('Invalid time zone');
  const zone = tz && tz !== '' ? tz : 'UTC';
  const like = scope === null ? RECALL_ROOT + '%' : scope + '/%';

  const rows = await db.execute(sql`
    WITH receipts AS (
      SELECT left(r.path, length(r.path) - ${SUFFIX_LEN}) AS media_path,
             CASE WHEN pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END AS doc
        FROM vfs_nodes r
       WHERE r.kind = 'file' AND r.trashed = false AND r.encoding = 'utf8'
         AND r.name LIKE '%.recall.json' AND r.path LIKE ${like}
         AND octet_length(r.content) <= 16384
    ),
    facts AS (
      SELECT media_path, doc->>'method' AS method,
             CASE WHEN pg_input_is_valid(doc->>'capturedAt', 'timestamptz')
                  THEN (doc->>'capturedAt')::timestamptz END AS captured_at
        FROM receipts WHERE doc IS NOT NULL
    ),
    joined AS (
      SELECT f.*, m.size FROM facts f
        JOIN vfs_nodes m ON m.path = f.media_path AND m.kind = 'file' AND m.trashed = false
    )
    SELECT to_char(date_trunc('day', captured_at AT TIME ZONE ${zone}), 'YYYY-MM-DD') AS day,
           count(*)::int AS memories,
           sum(size)::bigint AS bytes,
           (SELECT array_agg(DISTINCT x) FROM unnest(array_agg(method)) AS x WHERE x IS NOT NULL) AS methods,
           min(captured_at) AS "firstAt", max(captured_at) AS "lastAt"
      FROM joined WHERE captured_at IS NOT NULL
     GROUP BY 1 ORDER BY 1 DESC LIMIT ${MAX_DAYS}`);

  const undated = await db.execute(sql`
    WITH receipts AS (
      SELECT left(r.path, length(r.path) - ${SUFFIX_LEN}) AS media_path,
             CASE WHEN pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END AS doc
        FROM vfs_nodes r
       WHERE r.kind = 'file' AND r.trashed = false AND r.encoding = 'utf8'
         AND r.name LIKE '%.recall.json' AND r.path LIKE ${like} AND octet_length(r.content) <= 16384
    )
    SELECT count(*) FILTER (WHERE doc IS NULL)::int AS unreadable,
           count(*) FILTER (WHERE doc IS NOT NULL
             AND NOT pg_input_is_valid(coalesce(doc->>'capturedAt', ''), 'timestamptz'))::int AS undated
      FROM receipts`);

  const totals = undated.rows[0] as { unreadable: number; undated: number } | undefined;
  const days = rows.rows.map((d) => {
    const row = d as Record<string, unknown>;
    return { ...row, bytes: Number(row.bytes ?? 0), memories: Number(row.memories ?? 0) };
  });
  return {
    ok: true,
    scope: scope ?? 'all Recall folders',
    zone,
    days,
    totalDays: days.length,
    totalMemories: days.reduce((n, d) => n + d.memories, 0),
    undatedReceipts: totals?.undated ?? 0,
    unreadableReceipts: totals?.unreadable ?? 0,
    bounds: { maxDays: MAX_DAYS },
    note: 'Only memories you chose to save appear here. Fusion takes no periodic background screenshots, so an empty day means nothing was saved that day.',
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
