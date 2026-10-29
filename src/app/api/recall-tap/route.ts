/**
 * TT111 (RC-37) — saving media the browser already loaded.
 *
 * GET  ?sid=…                 → what this proxy session is still holding (descriptions, never bytes)
 * GET  ?sid=…&id=…&op=bytes   → one retained item, for looking at before deciding to keep it
 * POST {cmd:'save',sid,id,…}  → file those exact bytes as a Recall memory. No upstream request is made.
 * POST {cmd:'forget',sid,id?} → drop one item, or everything this session holds, now.
 *
 * The save runs entirely on this server: the bytes are already here, so round-tripping 8 MiB through
 * the browser only to post it back would be theatre. The publication itself is the SAME transaction
 * every other pathway uses (atomicRecallCommit), with a receipt built here — so the memory and its
 * receipt still appear or fail together, and the receipt's claim is checked against its method there.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { readJsonObject } from '@/lib/http-json';
import { createHash, randomUUID } from 'node:crypto';
import { atomicRecallCommit, RecallPolicyRefusal } from '@/lib/server/recall-commit';
import { getSession } from '@/lib/server/wp-sessions';
import { tapForget, tapGet, tapList, tapStats, TAP_ITEM_MAX, TAP_OFF_MESSAGE, TAP_SESSION_BYTES, TAP_SESSION_ITEMS } from '@/lib/server/wp-tap';
import { tapEnabled } from '@/lib/server/wp-tap-policy';
import { recallExtension, recallFolder, recallMime, recallSource, type RecallGrouping } from '@/lib/recall-core';
import { mkdir } from '@/lib/server/vfs';
import { bootstrap } from '@/lib/server/bootstrap';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bad = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const sid = q.get('sid') ?? '';
  // Fresh read, not the proxy's 1-second cache: a human looking at this list is asking what is held
  // RIGHT NOW, and a listing that lags the switch is exactly the kind of lie this feature must not tell.
  const on = await tapEnabled(true);
  // Switched off means held nothing: the answer and the memory are made to agree in the same breath.
  if (!on && sid) tapForget(sid);
  if (!sid) return bad(400, 'sid required');
  if (q.get('op') === 'bytes') {
    if (!on) return bad(403, TAP_OFF_MESSAGE);
    const entry = tapGet(sid, q.get('id') ?? '');
    if (!entry) return bad(404, 'That item is no longer held in memory');
    return new NextResponse(new Uint8Array(entry.bytes), {
      status: 200,
      headers: { 'content-type': entry.mime, 'content-length': String(entry.bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }
  return NextResponse.json({
    ok: true,
    enabled: on,
    items: on ? tapList(sid) : [],
    limits: { itemMax: TAP_ITEM_MAX, sessionItems: TAP_SESSION_ITEMS, sessionBytes: TAP_SESSION_BYTES },
    stats: tapStats(),
    policyKey: 'privacy.recallMediaTap',
  });
}

export async function POST(req: NextRequest) {
  // TT24 contract: every handler that reads a JSON body goes through the shared reader, so an empty,
  // malformed or non-object body is a uniform 400 that writes nothing.
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  const cmd = body.cmd, sid = typeof body.sid === 'string' ? body.sid : '';
  if (!sid) return bad(400, 'sid required');

  if (cmd === 'forget') {
    const dropped = tapForget(sid, typeof body.id === 'string' ? body.id : undefined);
    return NextResponse.json({ ok: true, dropped, held: tapList(sid).length });
  }
  if (cmd !== 'save') return bad(400, 'cmd must be "save" or "forget"');

  // Read the switch without the cache: a refusal at the moment of saving has to be the current answer.
  if (!(await tapEnabled(true))) { tapForget(sid); return bad(403, TAP_OFF_MESSAGE); }
  if (!getSession(sid)) return bad(404, 'That browser session has ended, so nothing of it is held');
  const entry = tapGet(sid, typeof body.id === 'string' ? body.id : '');
  if (!entry) return bad(404, 'That item is no longer held in memory');

  const grouping = (['host', 'title', 'custom'] as const).includes(body.grouping as RecallGrouping) ? (body.grouping as RecallGrouping) : 'host';
  const custom = typeof body.custom === 'string' ? body.custom : '';
  const title = typeof body.title === 'string' ? body.title : '';
  const page = typeof body.page === 'string' && body.page ? body.page : entry.page ?? entry.url;
  let folder: string;
  try { folder = recallFolder(page, title, grouping, custom); } catch (e) { return bad(400, e instanceof Error ? e.message : 'bad folder'); }

  const mime = recallMime(entry.mime);
  const path = `${folder}/${Date.now()}-${randomUUID()}.${recallExtension(mime)}`;
  const digest = createHash('sha256').update(entry.bytes).digest('hex');
  const receipt = JSON.stringify({
    version: 1, path, bytes: entry.bytes.length, sha256: digest, mime,
    method: 'session-retained-response',
    sourceAttribution: 'proxy-recorded-response',
    source: recallSource(entry.url), page: recallSource(page),
    capturedAt: new Date(entry.at).toISOString(),
    queryRedacted: true,
  }, null, 2);

  try {
    await bootstrap();
    for (const dir of ['/Downloads', '/Downloads/Recall', folder]) await mkdir(dir);
    const out = await atomicRecallCommit({
      path, content: entry.bytes.toString('base64'), mime, receipt,
      ...(body.onDuplicate === 'skip' ? { onDuplicate: 'skip' } : {}),
    });
    return NextResponse.json({ ...out, ok: true, method: 'session-retained-response', refetched: false, bytes: entry.bytes.length });
  } catch (e) {
    if (e instanceof RecallPolicyRefusal) return bad(403, e.message);
    return bad(409, e instanceof Error ? e.message : 'save failed');
  }
}
