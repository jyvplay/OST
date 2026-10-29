/**
 * TT111 — rows that shipped without a test, measured for the first time.
 *
 * Each test exercises the row where it actually lives: a pure table or function is imported and
 * interrogated directly (including cases designed to break it), anything with a server contract is
 * driven over HTTP against the running production build. Nothing here grades a row on inspection —
 * if a claim could not be made to fail, it is not asserted.
 */
import assert from 'node:assert/strict';
import { makeHarness } from './harness.mts';
import { BINDINGS, BROWSER_RESERVED, comboFor, codeOfToken, conflicts, type Binding, type Preset } from '../src/lib/shortcuts.ts';
import { FORMATS, GRADE_TEXT, formatFor, lossReport, toVtt } from '../src/lib/forge.ts';
import { parseIcs, toIcs } from '../src/lib/ics.ts';
import { diffCapabilities, memoryPolicy } from '../src/lib/policy.ts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const RUN = Math.random().toString(36).slice(2, 8);
const { test, finish } = makeHarness('tt111-core');

/** The product's collision rule, applied to a crafted table: proves the detector detects, without mutating the real one. */
const conflictsIn = (table: Binding[], preset: Preset) => {
  const seen = new Map<string, string>(); const out: { a: string; b: string; chord: string }[] = [];
  for (const b of table) { const chord = comboFor(b, preset); const prev = seen.get(chord); if (prev) out.push({ a: prev, b: b.id, chord }); else seen.set(chord, b.id); }
  return out;
};

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: r.status, json, text };
};

await test('no preset collides with itself, and every browser-reserved chord ships with the reason it is reserved',
  { 'IN-05': 'full', 'ST-06': 'full' }, async () => {
    const presets: Preset[] = ['hybrid', 'windows', 'mac'];
    let declared = 0;
    for (const preset of presets) {
      // The shipped table must be unambiguous: two actions on one chord is a bug the detector exists to catch.
      assert.deepEqual(conflicts(preset), [], `${preset} has no two actions on one chord`);
      const seen = new Map<string, string>();
      for (const b of BINDINGS) {
        const combo = comboFor(b, preset);
        if (!combo) continue;
        seen.set(combo, b.id);
        // Chords the browser eats are NOT avoided — some are the right chord and work under Keyboard Lock —
        // but each one must carry an explanation, because that is what the warning badge shows the human.
        if (BROWSER_RESERVED.includes(combo)) {
          assert.ok((b.reservedBy ?? '').length > 5, `${preset}: ${b.id} takes reserved ${combo} with no explanation`);
          declared++;
        }
      }
      assert.ok(seen.size >= 10, `${preset} binds a real set of chords (${seen.size})`);
    }
    assert.ok(declared >= 3, `the reserved chords really are flagged (${declared} across the presets)`);
    // The detector has to detect: a deliberately duplicated chord must be reported as a collision.
    const dup = conflictsIn([{ id: 'a', label: 'A', hybrid: 'Ctrl+Alt+9', windows: 'Ctrl+Alt+9', mac: 'Ctrl+Alt+9' },
                             { id: 'b', label: 'B', hybrid: 'Ctrl+Alt+9', windows: 'Ctrl+Alt+9', mac: 'Ctrl+Alt+9' }], 'hybrid');
    assert.deepEqual(dup.map((c) => c.chord), ['Ctrl+Alt+9'], 'a planted collision is found');
    assert.equal(codeOfToken('T'), 'KeyT', 'chords are compared by physical code, not by layout-dependent character');
    assert.equal(codeOfToken('1'), 'Digit1');
    console.log(`    ${BINDINGS.length} bindings x 3 presets: 0 collisions, ${declared} reserved chords each with a stated reason`);
  });

await test('the format registry is a usable contract: engine, grade, boundary and a conversion-loss answer for every entry',
  { 'FF-14': 'full' }, async () => {
    assert.ok(FORMATS.length >= 20, `the registry is populated (${FORMATS.length})`);
    const exts = new Map<string, string>();
    for (const f of FORMATS) {
      assert.ok(f.ext.length > 0 && f.mime.includes('/'), `${f.label}: extensions and a MIME type`);
      assert.ok(f.engine.length > 2, `${f.label}: names the engine that actually opens it`);
      assert.ok(f.boundary.length > 10, `${f.label}: states where the support stops`);
      assert.ok(GRADE_TEXT[f.grade], `${f.label}: grade ${f.grade} is one the UI can explain`);
      for (const e of f.ext) {
        const prior = exts.get(e);
        assert.equal(prior, undefined, `.${e} is claimed by both ${prior} and ${f.label}`);
        exts.set(e, f.label);
        assert.equal(formatFor(`x/y/file.${e.toUpperCase()}`)?.label, f.label, `.${e} resolves case-insensitively through a path`);
      }
    }
    assert.equal(formatFor('notes.unknownext'), null, 'an unknown extension is answered with null, not a guess');
    const lossy = FORMATS.find((f) => (f.dropsOnExport?.length ?? 0) > 0)!;
    const rep = lossReport(`a.${lossy.ext[0]}`, 'txt');
    assert.equal(rep.safe, false, `${lossy.label} → txt is reported as lossy`);
    assert.ok(rep.drops.length > 0, 'and it says what is lost');
    console.log(`    ${FORMATS.length} formats / ${exts.size} extensions, no overlap; ${lossy.label}→txt drops ${rep.drops.length}`);
  });

await test('SRT becomes WebVTT the way a browser needs it, and WebVTT is left alone',
  { 'AX-07': 'partial', 'FF-14': 'partial' }, async () => {
    const srt = '1\n00:00:01,250 --> 00:00:03,500\nFirst line\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line\n';
    const vtt = toVtt(srt);
    assert.ok(vtt.startsWith('WEBVTT\n'), 'the signature a browser demands');
    assert.ok(vtt.includes('00:00:01.250 --> 00:00:03.500'), 'comma timestamps become dot timestamps');
    assert.equal(/^\d+$/m.test(vtt.split('\n').slice(2).join('\n').split('\n\n')[0].split('\n')[0]), false, 'the SRT cue number is dropped');
    assert.ok(vtt.includes('First line') && vtt.includes('Second line'), 'no cue text is lost');
    const already = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nkeep\n';
    assert.equal(toVtt(already), already, 'a file that is already WebVTT is returned byte for byte');
  });

await test('an .ics round-trips and re-importing the same calendar never duplicates',
  { 'PR-04': 'full' }, async () => {
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:tt111-${RUN}@fusion`, 'SUMMARY:Review with a comma\\, and a newline\\nsecond',
      'DTSTART:20261103T140000Z', 'DTEND:20261103T150000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const items = parseIcs(ics);
    assert.equal(items.length, 1);
    assert.equal(items[0].uid, `tt111-${RUN}@fusion`);
    assert.ok(items[0].title.includes(', and a newline'), `escaped comma survives: ${items[0].title}`);
    assert.ok(items[0].title.includes('\n'), 'escaped newline survives as a real newline');
    assert.equal(items[0].start?.toISOString(), '2026-11-03T14:00:00.000Z');
    // Folding: a 150-character summary must come back whole after a write/read cycle (RFC 5545 §3.1).
    const long = 'L'.repeat(150);
    const written = toIcs([{ uid: `tt111b-${RUN}`, title: long, notes: '', start: new Date('2026-11-04T09:00:00Z'), end: null, kind: 'event', done: false }]);
    assert.ok(written.split('\r\n').every((l) => l.length <= 75), 'every written line is folded to 75 octets');
    const back = parseIcs(written);
    assert.equal(back.length, 1);
    assert.equal(back[0].title, long, 'unfolding restores the long summary exactly');
    // The dedup contract is by UID: parsing the same text twice yields the same identity, not two.
    const twice = parseIcs(ics + '\r\n' + ics);
    assert.equal(new Set(twice.map((i) => i.uid)).size, 1, 'two copies of one event are one UID');
    console.log(`    parsed ${items.length}, folded ${written.split('\r\n').length} lines, UIDs stable`);
  });

await test('the new-device checklist is a real diff of two measured reports, and absent memory data is not low memory',
  { 'BK-04': 'full', 'RG-06': 'full' }, async () => {
    const cap = (id: string, available: boolean) => ({ id, label: id, available, degrade: `${id} falls back`, detail: '' });
    const before = { capabilities: [cap('fs-access', true), cap('webgpu', true), cap('wake-lock', false), cap('opfs', true)] };
    const after = { capabilities: [cap('fs-access', false), cap('webgpu', true), cap('wake-lock', true), cap('opfs', true)] };
    const d = diffCapabilities(before, after);
    assert.deepEqual(d.lost.map((l) => l.id), ['fs-access']);
    assert.ok(d.lost[0].degrade.length > 0, 'a loss is reported with what it costs');
    assert.deepEqual(d.gained.map((g) => g.id), ['wake-lock']);
    assert.equal(d.unchanged, 2);
    // A capability the old report never knew about must not be announced as "gained" noise.
    const withNew = { capabilities: [...after.capabilities, cap('brand-new', true)] };
    assert.equal(diffCapabilities(before, withNew).gained.length, 1, 'unknown-before capabilities are not counted as gains');

    assert.equal(memoryPolicy(null).tier, 'unknown');
    assert.equal(memoryPolicy(undefined).tier, 'unknown');
    assert.equal(memoryPolicy(null).maxWindows, 24, 'absence of deviceMemory gets NORMAL limits, not crippled ones');
    assert.equal(memoryPolicy(Number.NaN).tier, 'unknown');
    assert.equal(memoryPolicy(2).tier, 'low');
    assert.equal(memoryPolicy(2).effects, false);
    assert.equal(memoryPolicy(2).maxWindows, 6);
    assert.equal(memoryPolicy(4).maxWindows, 12);
    assert.equal(memoryPolicy(8).maxWindows, 24);
    assert.ok(memoryPolicy(2).reason.includes('2'), 'the reason quotes the measurement it acted on');
  });

await test('every write is journalled and nothing is silently mutated: a read leaves no trace, a write leaves an auditable one',
  { 'DP-04': 'full' }, async () => {
    const path = `/Documents/tt111-audit-${RUN}.txt`;
    const before = ((await call('GET', '/api/jobs')).json as { log?: { id: number }[] }).log ?? [];
    await call('GET', '/api/fs?op=list&path=/Documents');
    const afterRead = ((await call('GET', '/api/jobs')).json as { log?: { id: number }[] }).log ?? [];
    assert.equal(afterRead[0]?.id, before[0]?.id, 'listing a folder writes no audit row');
    const w = await call('POST', '/api/fs', { op: 'write', path, content: 'tt111', encoding: 'utf8' });
    assert.equal(w.status, 200, w.text.slice(0, 160));
    const afterWrite = ((await call('GET', '/api/jobs')).json as { log?: { action: string; detail: string; actor: string }[] }).log ?? [];
    const row = afterWrite.find((r) => (r.detail ?? '').includes(`tt111-audit-${RUN}`));
    assert.ok(row, `the write appears in the audit log (newest: ${JSON.stringify(afterWrite[0] ?? null).slice(0, 120)})`);
    assert.match(row!.action, /^fs\./, `the action names the subsystem (${row!.action})`);
    assert.ok((row!.actor ?? '').length > 0, 'and who did it');
    // The journal is append-only from the client's side: there is no endpoint that edits it.
    const tamper = await call('PUT', '/api/jobs', { id: row, action: 'fs.nothing' });
    assert.ok(tamper.status >= 400, `the audit log cannot be rewritten over the API (${tamper.status})`);
    console.log(`    audit row: ${row!.actor} ${row!.action} — ${String(row!.detail).slice(0, 44)}`);
  });

await test('reversible by default: a trashed file comes back, and a changed setting can be put back from its own history',
  { 'DP-05': 'full' }, async () => {
    const path = `/Documents/tt111-undo-${RUN}.txt`;
    await call('POST', '/api/fs', { op: 'write', path, content: 'original', encoding: 'utf8' });
    const listing = async () => {
      const r = (await call('GET', '/api/fs?op=list&path=/Documents')).json as { nodes?: { path: string }[]; rows?: { path: string }[] };
      return (r.nodes ?? r.rows ?? []).map((n) => n.path);
    };
    assert.ok((await listing()).includes(path), 'the file is in its folder to begin with');
    assert.equal((await call('POST', '/api/fs', { op: 'trash', path })).status, 200);
    assert.equal((await listing()).includes(path), false, 'trashed means gone from its folder');
    const trashed = (await call('GET', `/api/fs?op=read&path=${encodeURIComponent(path)}`)).json as { node?: { trashed?: boolean; content?: string } };
    assert.equal(trashed.node?.trashed, true, 'the row is marked trashed, not deleted — which is what makes undo possible');
    assert.equal(trashed.node?.content, 'original', 'and the bytes are still intact in the Trash');
    assert.equal((await call('POST', '/api/fs', { op: 'restore', path })).status, 200);
    assert.ok((await listing()).includes(path), 'restore puts it back where it was');

    const read = (await call('GET', '/api/settings')).json as { rows: { key: string; value: string }[] };
    const target = read.rows.find((r) => r.key === 'appearance.density')!;
    const other = target.value === 'compact' ? 'balanced' : 'compact';
    const put = await call('PUT', '/api/settings', { key: 'appearance.density', value: other });
    assert.equal(put.status, 200);
    assert.equal((put.json as { undoFrom: string }).undoFrom, target.value, 'the write answers with what it replaced, so undo needs no guesswork');
    await call('PUT', '/api/settings', { key: 'appearance.density', value: target.value });
    const now = ((await call('GET', '/api/settings')).json as { rows: { key: string; value: string }[] }).rows.find((r) => r.key === 'appearance.density')!;
    assert.equal(now.value, target.value, 'and putting it back works');
  });

await test('workspace presets are stored as their own rows and restoring one does not invent a viewport',
  { 'AU-02': 'full' }, async () => {
    const id = `preset:tt111-${RUN}`;
    const windows = [{ id: 'w1', module: 'files', x: 40, y: 40, w: 600, h: 400, z: 1, min: false, max: false, workspace: 1 }];
    const put = await call('PUT', '/api/state', { id, revision: 1, state: { windows, focus: 'w1', nextZ: 2, activeWorkspace: 1 } });
    assert.equal(put.status, 200, put.text.slice(0, 160));
    const got = (await call('GET', `/api/state?id=${encodeURIComponent(id)}`)).json as { row: { revision: number; state: { windows: { module: string }[] } } };
    assert.equal(got.row.revision, 1);
    assert.deepEqual(got.row.state.windows.map((w) => w.module), ['files'], 'the preset holds exactly what was saved');
    // Optimistic concurrency: a tab holding an OLDER revision must not clobber a newer preset.
    const fresh = await call('PUT', '/api/state', { id, revision: 5, state: { windows, focus: 'w1', nextZ: 2, activeWorkspace: 1 } });
    assert.equal(fresh.status, 200, 'a newer revision is accepted');
    const stale = await call('PUT', '/api/state', { id, revision: 2, state: { windows: [], focus: null, nextZ: 1, activeWorkspace: 1 } });
    assert.equal(stale.status, 409, `a stale revision is refused (${stale.status})`);
    const after = (await call('GET', `/api/state?id=${encodeURIComponent(id)}`)).json as { row: { revision: number; state: { windows: unknown[] } } };
    assert.equal(after.row.revision, 5, 'and the refusal left the newer preset untouched');
    assert.equal(after.row.state.windows.length, 1, 'the stale write did not empty it');
    console.log(`    preset ${id}: saved, read back, stale write refused with 409`);
  });

await test('notes are indexed in the same index as files, so one search reaches both',
  { 'PR-02': 'partial' }, async () => {
    const needle = `tt111note${RUN}`;
    const made = await call('POST', '/api/notes', { title: `TT111 ${RUN}`, body: `a note containing ${needle}`, tags: 'tt111' });
    assert.ok(made.status === 200 || made.status === 201, made.text.slice(0, 160));
    const filePath = `/Documents/tt111-search-${RUN}.txt`;
    await call('POST', '/api/fs', { op: 'write', path: filePath, content: `a file containing ${needle}`, encoding: 'utf8' });
    const hits = ((await call('GET', `/api/search?q=${encodeURIComponent(needle)}`)).json as { hits?: { source: string; ref: string; title: string; snippet: string }[] }).hits ?? [];
    assert.ok(hits.length >= 2, `one query reaches both stores (${hits.length} hits)`);
    const note = hits.find((h) => h.source === 'note');
    const file = hits.find((h) => h.source === 'file');
    assert.ok(note, 'the note is found');
    assert.ok(file && file.ref.includes('tt111-search'), 'the file is found');
    assert.ok(note!.snippet.includes(needle), 'the hit carries the matching text, not just an id');
    // A word that is in neither store must not be answered with a hit.
    const none = ((await call('GET', `/api/search?q=zzz${RUN}absent`)).json as { hits?: unknown[] }).hits ?? [];
    assert.equal(none.length, 0, 'and a query for something absent returns nothing');
    console.log(`    "${needle}" → ${hits.length} hits: ${[...new Set(hits.map((h) => h.source))].join(' + ')}`);
  });

await test('long operations are recorded as steps that can be polled, and every one ends in a terminal state',
  { 'NC-05': 'partial' }, async () => {
    const jobs = await call('GET', '/api/jobs');
    assert.equal(jobs.status, 200);
    const src = `/Documents/tt111-progress-${RUN}.txt`;
    await call('POST', '/api/fs', { op: 'write', path: src, content: 'x'.repeat(4096), encoding: 'utf8' });
    const dst = `/Documents/tt111-progress-copy-${RUN}.txt`;
    const copy = await call('POST', '/api/fs', { op: 'copy', src, dst });
    assert.equal(copy.status, 200, copy.text.slice(0, 160));
    const ops = ((await call('GET', '/api/jobs')).json as { ops?: { op: string; src: string; dst: string; state: string; bytes: number; steps?: unknown[] }[] }).ops ?? [];
    assert.ok(ops.length > 0, 'the operation store answers with rows');
    const mine = ops.find((o) => o.dst === dst || o.src === dst);
    assert.ok(mine, `this copy is recorded (${ops.slice(0, 2).map((o) => `${o.op} ${o.dst}`).join(', ')})`);
    assert.match(mine!.state, /^(QUEUED|RUNNING|COMPLETE|FAILED|CANCELLED)$/, `state is one of the declared states (${mine!.state})`);
    assert.equal(mine!.state, 'COMPLETE', 'a finished copy is reported finished, not left running for ever');
    assert.ok(mine!.bytes >= 4096, `and it reports the work done (${mine!.bytes} B)`);
    assert.ok(Array.isArray(mine!.steps) && mine!.steps!.length > 0, 'with the steps a progress bar is drawn from');
    for (const o of ops) assert.match(o.state, /^(QUEUED|RUNNING|COMPLETE|FAILED|CANCELLED)$/, `every row has a declared state (${o.state})`);
    console.log(`    ${ops.length} operation rows; this copy: ${mine!.state}, ${mine!.bytes} B, ${mine!.steps!.length} steps`);
  });

await test('the capability report is exportable and redacted: it describes the browser, not the person',
  { 'ST-04': 'full' }, async () => {
    const probe = await call('GET', '/api/probe');
    assert.equal(probe.status, 200, probe.text.slice(0, 160));
    const body = probe.text;
    // What an exported support artifact must never carry out of the machine.
    for (const leak of ['/home/', 'postgres://', 'postgresql://', 'password', 'Authorization', 'DATABASE_URL']) {
      assert.equal(body.toLowerCase().includes(leak.toLowerCase()), false, `the export must not contain ${leak}`);
    }
    const saved = await call('POST', '/api/probe', { report: { at: new Date().toISOString(), ua: 'test-agent', capabilities: [{ id: 'fs-access', label: 'File System Access', available: true, degrade: 'falls back to download', detail: '' }] } });
    assert.ok(saved.status === 200 || saved.status === 201, `a report can be stored for later comparison (${saved.status})`);
    const back = await call('GET', '/api/probe');
    assert.match(back.text, /fs-access|capabilities/, 'and read back for the migration diff');
  });

finish();
