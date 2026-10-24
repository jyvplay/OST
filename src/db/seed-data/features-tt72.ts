import type { SpecRow } from "./row";

/**
 * TT72 register changes (no new rows).
 *  · FF-21 / FF-22 / FF-23 / FF-51 (+ encrypted files via FF-21 / FF-22): the OOXML readers are now prefix- and quote-agnostic (XML 1.0 attribute syntax,
 *    namespaces resolved by URI, not by the conventional prefix) — proven by whole-corpus differentials.
 *  · SH-11 was registered "built" but the Blackout pad only nudged the local screen — now a real cross-window transport.
 *  · SC-05 was registered "built" with no access log in code — now built.
 */
const UP: Record<string, { note: string; test: string; route?: string; status?: SpecRow["status"] }> = {
  "FF-22": {
    note: "TT72: Writer reads Word documents by namespace URI, not by the w: prefix (a document using any prefix, or a default namespace, opens identically) and accepts single-quoted / spaced attributes per XML 1.0; Track Changes and save work on such files. Pictures and links in comments, footnotes and endnotes resolve through their own part's relationships, and the picture cache is per part (TT71 showed the body's picture, or styles.xml, in headers / comments / notes). An unedited save stays byte-identical even for files read through canonicalisation.",
    test: "tt72-office.mts W1–W4 (113 corpus docx rewritten to prefix q: and to a default namespace → identical models, the TT71 reader opened 0 of them; lxml namespace equivalence on 768 parts; python-docx agrees; legacy /api/office reader); W5 (113 single-quoted → identical, revision-id counter above every existing w:id); W6 (part pictures vs a zipfile + lxml oracle); W7 (one rId9 in body / header / comment / footnote → four different pictures; TT71 showed the body's in all four); W8 (113 originals + 113 q-prefixed rewrites save byte-identically unedited)",
  },
  "FF-51": {
    note: "TT72: reading by namespace now also means reading by XML 1.0 attribute syntax — single quotes and spaces around = — not only Excel's own serialisation (cells, styles, colours, borders, fills).",
    test: "tt72-office.mts S1–S2 (330 corpus workbooks, 1 250 494 cells, single-quoted → identical models; the TT71 reader lost data on all 330 and 106 lost border/fill colours; openpyxl agrees; b/u/fill val semantics)",
  },
  "FF-23": {
    note: "TT72: the slide reader accepts single-quoted attributes.",
    test: "tt72-office.mts P1 (63 corpus decks with text identical after single-quoting; TT71 differed on 63)",
  },
  "FF-21": {
    note: "TT72: the SpreadsheetML reader accepts XML 1.0 attribute syntax (single quotes, spaces around =) in every part, including the colour / border / fill helpers; password-protected files whose EncryptionInfo XML uses single quotes decrypt (HMAC verified) and a wrong password is still refused.",
    test: "tt72-office.mts S1–S2 (330 corpus workbooks, 1 250 494 cells, single-quoted → identical models; TT71 lost data on all 330) and C1 (single-quoted Agile EncryptionInfo)",
  },
  "SH-11": {
    note: "TT72: was registered as built but the Blackout pad only moved windows on its own screen. Now built: BroadcastChannel(\"fusion-shell\") presence (tab / pip / screen, goodbye on pagehide), the pad sends validated move / key commands addressed to the newest presenting screen, which applies them through its own reducer (commands, not synthetic DOM events) and acknowledges the moved window. Arrows nudge (Shift ×5), Tab cycles, Enter maximises, Home shows the desktop; wrong-recipient, malformed and replayed messages are dropped; with no presenting screen the pad moves this screen's window and says so.",
    test: "tt72-padlink.mts (6: 24 malformed shapes, replay / order, key table, 2 000-case safety property, real reducer, target choice); e2e-tt72-pad.mts (4: real drag on the tab moves the display-2 window in its DOM and persisted row, keys, channel adversary, fallback)",
    route: "src/lib/windowing/pad-link.ts + components/usePadLink.ts + Shell Blackout overlay",
  },
  "SC-05": {
    note: "TT72: was registered as built but no access log existed. Now built: every camera / microphone / screen / clipboard-read / location request made by a Fusion module goes through src/lib/access-log.ts, which records the time, the asking module and the outcome (granted / denied / failed + error name), keeps granted streams live until their last track ends (including stops by code, which fire no event) and lets Privacy → Device access stop them. Memory of this tab only: never sent or stored, no content (clipboard text, coordinates) recorded.",
    test: "tt72-access.mts (3); e2e-tt72-access.mts (4: Chromium fake devices — mic / camera / screen live and stopped from the dashboard or by the module; refusals without devices or permissions; grants without content; no request body names the log)",
    route: "src/lib/access-log.ts + modules/AccessLog.tsx (Privacy → Device access); Devices, Lens, Capture, Share, Clipboard, Maps, Shell",
  },
};

export function patchTT72(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
