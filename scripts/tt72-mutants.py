#!/usr/bin/env python3
"""TT72 mutation check. Each mutant re-introduces one plausible bug; the named suite must FAIL for every mutant.
 · O*: the office readers' namespace / XML 1.0 attribute handling (scripts/tt72-office.mts, only the tests that target the
   mutated code run — HARNESS_ONLY — because the whole corpus suite takes ~3 min).
 · P*: the SH-11 pad protocol (src/lib/windowing/pad-link.ts → scripts/tt72-padlink.mts).
 · A*: the SC-05 access log (src/lib/access-log.ts → scripts/tt72-access.mts).
The hook / Shell / Privacy UI wiring (recipient check, presence, dashboard) needs a rebuild per mutant and is covered by
e2e-tt72-pad / e2e-tt72-access against the production build instead. Files and result JSONs are restored afterwards.
Run from the repository root:  /home/user/tools/venv/bin/python scripts/tt72-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

WM, DX, XL, XC, PP, OC = "src/lib/office/wordml.ts", "src/lib/office/docx.ts", "src/lib/formula/xlsx.ts", "src/lib/formula/xlsxcolor.ts", "src/lib/office/pptx.ts", "src/lib/office/offcrypto.ts"
PL, AL = "src/lib/windowing/pad-link.ts", "src/lib/access-log.ts"
MUTANTS = [
    # (name, suite, HARNESS_ONLY, path, old, new)
    ("O1 Writer reader: no namespace canonicalisation", "O", "W1", WM, "const text = (p: string) => { const t = raw(p); return t === null ? null : canonicalizeNs(t, /\\.rels$/i.test(p) ? RELS_CANON : WML_CANON, { knownRoot: true }); };", "const text = (p: string) => raw(p);"),
    ("O2 Writer save: settings.xml not canonicalised (foreign prefix)", "O", "W3", WM, "parseXml(src ? canonicalizeNs(td.decode(src), WML_CANON, { knownRoot: true }) :", "parseXml(src ? td.decode(src) :"),
    ("O3 Writer save: revision ids read double-quoted only", "O", "W5", WM, "/\\sw:id\\s*=\\s*(?:\"(-?\\d+)\"|'(-?\\d+)')/g", "/\\sw:id=\"(-?\\d+)\"()/g"),
    ("O4 legacy docx: no namespace canonicalisation", "O", "W4", DX, "const xml = canonicalizeNs(readEntryVerified(buf, e).toString(\"utf8\"), WML_CANON, { knownRoot: true });", "const xml = readEntryVerified(buf, e).toString(\"utf8\");"),
    ("O5 legacy docx: entities decoded twice (&amp;lt; → <)", "O", "W4", DX, "const decode = (s: string) => s.replace(/&(?:#", "const decode = (s: string) => s.replace(/&lt;/g, \"<\").replace(/&gt;/g, \">\").replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, \"&\").replace(/&(?:#"),
    ("O6 legacy docx: pStyle double-quoted only", "O", "W4", DX, "w:val\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)')/.exec(xml)", "w:val=\"([^\"]+)\"()/.exec(xml)"),
    ("O7 xlsx: attributes double-quoted only", "O", "S1", XL, "/([A-Za-z_:][\\w:.-]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')/g", "/([A-Za-z_:][\\w:.-]*)=\"([^\"]*)\"()/g"),
    ("O8 xlsx: val='false' counts as on", "O", "S2", XL, "new Set([\"0\", \"false\", \"none\"])", "new Set([\"0\", \"none\"])"),
    ("O9 xlsx: solid fill detected by literal patternType=\"solid\"", "O", "S2", XL, "xmlAttrs(/<patternFill\\b([^>]*)/.exec(inner)?.[1] ?? \"\").patternType === \"solid\"", "/patternType=\"solid\"/.test(inner)"),
    ("O10 xlsxcolor: attr double-quoted only", "O", "S1", XC, "new RegExp(`\\\\b${name}\\\\s*=\\\\s*(?:\"([^\"]*)\"|'([^']*)')`)", "new RegExp(`\\\\b${name}=\"([^\"]*)\"()`)"),
    ("O11 xlsxcolor: srgbClr double-quoted only", "O", "S1", XC, "\\bval\\s*=\\s*[\"']([0-9A-Fa-f]{6})[\"']/", "\\bval=\"([0-9A-Fa-f]{6})\"/"),
    ("O12 xlsxcolor: custom palette double-quoted only", "O", "S1", XC, "\\brgb\\s*=\\s*[\"']([0-9A-Fa-f]{8})[\"']/g", "\\brgb=\"([0-9A-Fa-f]{8})\"/g"),
    ("O13 pptx: attributes double-quoted only", "O", "P1", PP, "/([\\w:.-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')/g", "/([\\w:.-]+)=\"([^\"]*)\"()/g"),
    ("O14 offcrypto: EncryptionInfo attributes double-quoted only", "O", "C1", OC, "/([\\w:]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')/g", "/([\\w:]+)=\"([^\"]*)\"()/g"),
    ("O15 comments resolve pictures through the document's rels", "O", "W6,W7", WM, "rels: commentRels, linkSeq: 3000", "rels: relById, linkSeq: 3000"),
    ("O16 notes resolve pictures through the document's rels", "O", "W7", WM, "rels: noteRels, linkSeq: 2000", "rels: relById, linkSeq: 2000"),
    ("O17 one rId cache across parts", "O", "W7", WM, "const m = (ctx.part === ctx.doc.docPath ? ctx.doc.media.get(rid) : undefined) ?? loadMediaSync(ctx, rid);", "const m = ctx.doc.media.get(rid) ?? loadMediaSync(ctx, rid);"),
    ("O18 canonicalised parts saved canonical (no original-bytes pass)", "O", "W8", WM, "if (d && o && td.decode(d) === c) out.set(p, o); }", "if (d && o && td.decode(d) === c && false) out.set(p, o); }"),
    ("O19 Word 2007 ve: parts rewritten (an edited header loses its untouched picture line's exact XML)", "H", "", WM, "if (!rels && !t.includes(\"AlternateContent\") && isCanonicalNs(t, WML_CANON_NO_MC)) return t;", ""),
    ("P1 move deltas not clamped", "P", "", PL, "Math.max(-lim, Math.min(lim, Math.round(x)))", "Math.round(x)"),
    ("P2 duplicate seq accepted", "P", "", PL, "if (prev !== undefined && seq <= prev) return false;", "if (prev !== undefined && seq < prev) return false;"),
    ("P3 replay memory unbounded", "P", "", PL, "  if (last.size > 64) last.delete(last.keys().next().value as string); // bounded memory\n", ""),
    ("P4 a minimized focused window is driven", "P", "", PL, "w.id === s.focus && !w.minimized) ? s.focus", "w.id === s.focus) ? s.focus"),
    ("P5 a stale focus id (no such window) is driven", "P", "", PL, "const f = s.focus && s.windows.some((w) => w.id === s.focus && !w.minimized) ? s.focus : null;", "const f = s.focus;"),
    ("P6 Shift ignored on arrows", "P", "", PL, "const step = op.shift ? KEY_STEP_BIG : KEY_STEP;", "const step = KEY_STEP;"),
    ("P7 Shift+Tab cycles forward", "P", "", PL, "dir: op.shift ? -1 : 1", "dir: 1"),
    ("P8 the pad may target itself", "P", "", PL, "if (id !== self && p.host", "if (p.host"),
    ("P9 a tab / pip may be the target", "P", "", PL, "p.host === \"screen\" && p.at > at", "p.at > at"),
    ("P10 any key name forwarded", "P", "", PL, "typeof o.key === \"string\" && (PAD_KEYS as readonly string[]).includes(o.key)", "typeof o.key === \"string\""),
    ("P11 sender id not validated", "P", "", PL, "typeof m.from !== \"string\" || !ID.test(m.from)) return null;", "typeof m.from !== \"string\") return null;"),
    ("P12 truthy shift accepted", "P", "", PL, "shift: o.shift === true", "shift: !!o.shift"),
    ("P13 negative seq accepted", "P", "", PL, " || (m.seq as number) < 0) return null;", ") return null;"),
    ("A1 a refusal (NotAllowedError) logged as a failure", "A", "", AL, "name === \"NotAllowedError\" || name === \"SecurityError\"", "name === \"SecurityError\""),
    ("A2 code-stopped tracks never end the entry (stop not wrapped)", "A", "", AL, "    t.stop = () => { stop(); one(t); };\n", ""),
    ("A3 a double stop ends a two-track stream early", "A", "", AL, "if (done.has(t)) return; done.add(t); ", ""),
    ("A4 Clear also forgets live streams", "A", "", AL, "entries = entries.filter((e) => e.live);", "entries = [];"),
    ("A5 a location refusal logged as a failure", "A", "", AL, "record(app, [\"location\"], e.code === e.PERMISSION_DENIED ? \"denied\" : \"failed\"", "record(app, [\"location\"], \"failed\""),
    ("A6 the log grows without bound", "A", "", AL, "entries = [e, ...entries].slice(0, MAX_ENTRIES);", "entries = [e, ...entries];"),
]
SUITE = {"O": "scripts/tt72-office.mts", "H": "scripts/tt49-writer.mts", "P": "scripts/tt72-padlink.mts", "A": "scripts/tt72-access.mts"}
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
for name, _s, _o, path, old, _n in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor found {pathlib.Path(path).read_text().count(old)}x"
orig = {p: pathlib.Path(p).read_text() for p in {m[3] for m in SELECTED}}
res = lambda f: pathlib.Path(f"docs/test-results/{pathlib.Path(f).stem}.json")
results = {s: res(f).read_bytes() for s, f in SUITE.items() if res(f).exists()}
killed = 0
try:
    for name, suite, only, path, old, new in SELECTED:
        pathlib.Path(path).write_text(orig[path].replace(old, new, 1))
        try:
            env = {**os.environ, **({"HARNESS_ONLY": only} if only else {})}
            r = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", SUITE[suite]],
                               capture_output=True, text=True, timeout=1200, env=env)
            out = r.stdout + r.stderr
        except subprocess.TimeoutExpired:
            out = "✗ timeout"
        finally:
            pathlib.Path(path).write_text(orig[path])
        failed = [l.strip()[2:90] for l in out.splitlines() if l.strip().startswith("✗")]
        crashed = "passed," not in out
        ran = "0 passed, 0 failed" not in out
        ok = (bool(failed) or crashed) and ran
        killed += ok
        print(f"{'KILLED' if ok else 'SURVIVED'}  {name}  [{suite}{':' + only if only else ''}]  {'crash' if crashed and not failed else (failed[0] if failed else '')}", flush=True)
finally:
    for p, t in orig.items(): pathlib.Path(p).write_text(t)
    for s, b in results.items(): res(SUITE[s]).write_bytes(b)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
