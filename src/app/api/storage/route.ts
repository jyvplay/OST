import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { bootstrap } from "@/lib/server/bootstrap";
import { readJsonObject } from "@/lib/http-json";
import {
  SERVER_BUCKETS,
  summarizePreview,
  validateBucketSelection,
  validatePurgeRequest,
  verifyPostPurge,
  type BucketStat,
  type ServerBucketId,
} from "@/lib/storage-core";

export const dynamic = "force-dynamic";

const PROTECTED_DIRS = "('/', '/Documents', '/Pictures', '/Downloads', '/Projects', '/Widgets')";

async function queryServerBuckets(): Promise<BucketStat[]> {
  const [vfsUser, trash, versions, notesStat, alertsStat, plannerStat, settingsStat, sessionsStat] = await Promise.all([
    db.execute(sql.raw(`
      select count(*)::int as rows,
             coalesce(sum(size), 0)::bigint as bytes,
             coalesce((select array_agg(path) from (select path from vfs_nodes where trashed = false and path not like '/System%' and path not in ${PROTECTED_DIRS} order by size desc, path asc limit 5) s), array[]::text[]) as samples
      from vfs_nodes
      where trashed = false and path not like '/System%' and path not in ${PROTECTED_DIRS}
    `)),
    db.execute(sql`
      select count(*)::int as rows,
             coalesce(sum(size), 0)::bigint as bytes,
             coalesce((select array_agg(path) from (select path from vfs_nodes where trashed = true order by size desc, path asc limit 5) s), array[]::text[]) as samples
      from vfs_nodes
      where trashed = true
    `),
    db.execute(sql`
      select ((select count(*)::int from vfs_versions) + (select count(*)::int from file_ops))::int as rows,
             ((select coalesce(sum(size), 0)::bigint from vfs_versions) + (select coalesce(sum(octet_length(op) + octet_length(src) + octet_length(dst)), 0)::bigint from file_ops))::bigint as bytes,
             coalesce((select array_agg(label) from (
               select path || ' (v' || version || ')' as label from vfs_versions order by id desc limit 3
             ) s), array[]::text[]) as samples
    `),
    db.execute(sql`
      select count(*)::int as rows,
             coalesce(sum(octet_length(title) + octet_length(body) + octet_length(tags)), 0)::bigint as bytes,
             coalesce((select array_agg(title) from (select title from notes order by id desc limit 5) s), array[]::text[]) as samples
      from notes
    `),
    db.execute(sql`
      select count(*)::int as rows,
             coalesce(sum(octet_length(app) + octet_length(title) + octet_length(body)), 0)::bigint as bytes,
             coalesce((select array_agg(title) from (select title from alerts order by id desc limit 5) s), array[]::text[]) as samples
      from alerts
    `),
    db.execute(sql`
      select ((select count(*)::int from tasks) + (select count(*)::int from routines))::int as rows,
             ((select coalesce(sum(octet_length(title) + octet_length(notes)), 0)::bigint from tasks) +
              (select coalesce(sum(octet_length(name) + octet_length(actions::text)), 0)::bigint from routines))::bigint as bytes,
             coalesce((select array_agg(title) from (
               select title from tasks order by id desc limit 3
             ) s), array[]::text[]) as samples
    `),
    db.execute(sql`
      select ((select count(*)::int from settings_history) +
              (select count(*)::int from desktop_state where id like 'preset:%' or id like 'session:%'))::int as rows,
             ((select coalesce(sum(octet_length(key) + octet_length(old_value) + octet_length(new_value)), 0)::bigint from settings_history) +
              (select coalesce(sum(octet_length(id) + octet_length(state::text)), 0)::bigint from desktop_state where id like 'preset:%' or id like 'session:%'))::bigint as bytes,
             coalesce((select array_agg(label) from (
               select key || '=' || new_value as label from settings_history order by id desc limit 3
             ) s), array[]::text[]) as samples
    `),
    db.execute(sql`
      select ((select count(*)::int from beam_sessions) +
              (select count(*)::int from cast_targets) +
              (select count(*)::int from together_rooms) +
              (select count(*)::int from together_events) +
              (select count(*)::int from rtc_signals) +
              (select count(*)::int from capability_reports) +
              (select count(*)::int from audit_log))::int as rows,
             ((select coalesce(sum(octet_length(target_name) + octet_length(stats::text)), 0)::bigint from beam_sessions) +
              (select coalesce(sum(octet_length(name) + octet_length(capability::text)), 0)::bigint from cast_targets) +
              (select coalesce(sum(octet_length(code) + octet_length(name)), 0)::bigint from together_rooms) +
              (select coalesce(sum(octet_length(kind) + octet_length(payload::text)), 0)::bigint from together_events) +
              (select coalesce(sum(octet_length(kind) + octet_length(payload::text)), 0)::bigint from rtc_signals) +
              (select coalesce(sum(octet_length(ua) + octet_length(report::text)), 0)::bigint from capability_reports) +
              (select coalesce(sum(octet_length(action) + octet_length(detail)), 0)::bigint from audit_log))::bigint as bytes,
             coalesce((select array_agg(action) from (select action from audit_log order by id desc limit 4) s), array[]::text[]) as samples
    `),
  ]);

  const rawById: Record<ServerBucketId, { rows?: unknown; bytes?: unknown; samples?: unknown }> = {
    vfs_user: (vfsUser.rows[0] ?? {}) as Record<string, unknown>,
    trash: (trash.rows[0] ?? {}) as Record<string, unknown>,
    versions: (versions.rows[0] ?? {}) as Record<string, unknown>,
    notes: (notesStat.rows[0] ?? {}) as Record<string, unknown>,
    alerts: (alertsStat.rows[0] ?? {}) as Record<string, unknown>,
    planner: (plannerStat.rows[0] ?? {}) as Record<string, unknown>,
    settings: (settingsStat.rows[0] ?? {}) as Record<string, unknown>,
    sessions: (sessionsStat.rows[0] ?? {}) as Record<string, unknown>,
  };

  return SERVER_BUCKETS.map((meta) => {
    const r = rawById[meta.id];
    const samples = Array.isArray(r.samples) ? r.samples.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    return {
      id: meta.id,
      label: meta.label,
      description: meta.description,
      rows: Number(r.rows ?? 0),
      bytes: Number(r.bytes ?? 0),
      samples,
    };
  });
}

async function purgeBucket(id: ServerBucketId) {
  switch (id) {
    case "vfs_user":
      await db.execute(sql.raw(`
        delete from index_docs
        where source = 'file'
          and ref not like '/System%'
          and ref not in ${PROTECTED_DIRS}
      `));
      await db.execute(sql.raw(`
        delete from vfs_nodes
        where trashed = false
          and path not like '/System%'
          and path not in ${PROTECTED_DIRS}
      `));
      break;
    case "trash":
      await db.execute(sql`delete from vfs_nodes where trashed = true`);
      break;
    case "versions":
      await db.execute(sql`delete from vfs_versions`);
      await db.execute(sql`delete from file_ops`);
      break;
    case "notes":
      await db.execute(sql`delete from index_docs where source = 'note'`);
      await db.execute(sql`delete from notes`);
      break;
    case "alerts":
      await db.execute(sql`delete from alerts`);
      break;
    case "planner":
      await db.execute(sql`delete from tasks`);
      await db.execute(sql`delete from routines`);
      break;
    case "settings":
      await db.execute(sql`delete from settings_history`);
      await db.execute(sql`delete from desktop_state where id like 'preset:%' or id like 'session:%'`);
      break;
    case "sessions":
      await db.execute(sql`delete from beam_sessions`);
      await db.execute(sql`delete from cast_targets`);
      await db.execute(sql`delete from together_events`);
      await db.execute(sql`delete from together_rooms`);
      await db.execute(sql`delete from rtc_signals`);
      await db.execute(sql`delete from capability_reports`);
      await db.execute(sql`delete from audit_log`);
      break;
  }
}

/**
 * FM-07 storage overview + AP-02 uninstall assistant.
 * Duplicates are found by content digest (sha256), not by name+size.
 * AP-02 computes live per-bucket row counts and byte totals before any removal,
 * and refuses destructive purge requests without the exact confirmation token.
 */
export async function GET() {
  await bootstrap();
  const [categories, large, dupes, trash, versions, buckets] = await Promise.all([
    db.execute(sql`
      select case
        when mime like 'image/%' then 'images'
        when mime like 'video/%' then 'video'
        when mime like 'audio/%' then 'audio'
        when mime like 'text/%' or mime in ('application/json') then 'text'
        when mime like 'application/vnd.openxmlformats%' or mime = 'application/pdf' then 'documents'
        when mime = 'application/zip' then 'archives'
        else 'other' end as category,
        count(*)::int as files, coalesce(sum(size),0)::bigint as bytes
      from vfs_nodes where kind = 'file' and trashed = false
      group by 1 order by 3 desc`),
    db.execute(sql`
      select path, size, mime from vfs_nodes where kind='file' and trashed=false order by size desc limit 15`),
    db.execute(sql`
      select sha256, count(*)::int as copies, max(size)::int as size,
             (count(*) - 1) * max(size) as reclaimable, array_agg(path order by path) as paths
      from vfs_nodes where kind='file' and trashed=false and sha256 <> '' and size > 0
      group by sha256 having count(*) > 1 order by reclaimable desc limit 30`),
    db.execute(sql`
      select count(*)::int as files, coalesce(sum(size),0)::bigint as bytes from vfs_nodes where trashed = true and kind='file'`),
    db.execute(sql`
      select count(*)::int as versions, coalesce(sum(size),0)::bigint as bytes from vfs_versions`),
    queryServerBuckets(),
  ]);
  return NextResponse.json({
    ok: true,
    categories: categories.rows,
    large: large.rows,
    duplicates: dupes.rows,
    trash: trash.rows[0],
    versions: versions.rows[0],
    buckets,
  });
}

export async function POST(req: NextRequest) {
  await bootstrap();
  const body = (await readJsonObject(req)) as Record<string, unknown> | Response;
  if (body instanceof Response) return body;

  const op = body.op;
  if (op === "preview") {
    const valid = validateBucketSelection(body.buckets);
    if (!valid.ok) return NextResponse.json({ ok: false, error: valid.error }, { status: 400 });
    const allBuckets = await queryServerBuckets();
    const preview = summarizePreview(allBuckets, valid.buckets);
    return NextResponse.json({ ok: true, preview });
  }

  if (op === "purge") {
    const valid = validatePurgeRequest(body);
    if (!valid.ok) return NextResponse.json({ ok: false, error: valid.error }, { status: 400 });
    const before = await queryServerBuckets();
    const preview = summarizePreview(before, valid.buckets);
    for (const id of valid.buckets) {
      await purgeBucket(id);
    }
    if (!valid.buckets.includes("sessions")) {
      const detail = JSON.stringify({ buckets: valid.buckets, rows: preview.totalRows, bytes: preview.totalBytes });
      await db.execute(sql`insert into audit_log (actor, action, detail) values ('user', 'uninstall.purge', ${detail})`);
    }
    const after = await queryServerBuckets();
    const verified = verifyPostPurge(before, after, valid.buckets);
    return NextResponse.json({
      ok: verified.ok,
      purged: preview,
      buckets: after,
      verified: verified.ok,
    });
  }

  return NextResponse.json({ ok: false, error: "op must be 'preview' or 'purge'" }, { status: 400 });
}
