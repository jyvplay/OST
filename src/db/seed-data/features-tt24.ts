import { F, type SpecRow } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test" | "status">>;

/**
 * TT24 register changes.
 *  • Contacts module (user request: "add more modules"): PR-05 changes from a Contact Picker probe into a first-party
 *    address book that keeps the picker as an optional import path. It gets four new CN rows.
 *  • FF-04: the missing half of the row (.ai detection) is built, so it moves from partial to built.
 */
export const tt24Features: SpecRow[] = [
  F("CN-01", "CN", "vCard interoperability: read vCard 2.1 / 3.0 / 4.0 (folding, quoted-printable + CHARSET, base64 PHOTO, RFC 6868 parameter escapes), write RFC 6350 vCard 4.0 that round-trips unmodelled properties and parameters (PID, ALTID, LABEL, CLIENTPIDMAP, X-…)",
    "A", "P2", "src/lib/contacts-core.ts parseVcf / serializeVcf / foldLine (75 octets, never splits a UTF-8 sequence) / escapeText; forge.ts vcf entry",
    "Checked against the verbatim RFC 6350 §8 and RFC 2426 §7 examples, and in both directions against vobject 0.9.9 (an independent Python implementation): we read its 3.0 output, it reads our 4.0 output, and 200 generated contacts survive ours → vobject → ours. Dates are written in the basic format, because RFC 6350 §4.3.1 disallows YYYY-MM-DD. Limits: no jCard/xCard. Nested AGENT vCards are skipped with a warning. Parameters on FN/N/ORG/TITLE/NOTE are not kept. Input is capped at 20 MB and 20 000 contacts.",
    "built", "contacts-engine.mts 'RFC 6350 §8', 'RFC 2426 §7', 'vCard 2.1', 'round trip', 'RFC 6350 §4.3.1 dates', 'hostile input'; oracle-vcard.mts A, B, A+B"),
  F("CN-02", "CN", "Address book: alphabetical list with letter groups, accent-insensitive multi-token search (names, e-mail, phone digits, notes, groups), contact card with mailto:/tel: links, edit form (multiple e-mails and phones, address, birthday, website, groups, notes) with validation, autosave to a real .vcf in Files, undo (20 steps)",
    "A", "P2", "src/components/modules/Contacts.tsx (autosave 0.5 s through the VFS safe-save path; a version counter stops a slow save from marking a newer edit saved); contacts-core matches / sortContacts / letterOf / validate",
    "The book is /Contacts/contacts.vcf, a plain vCard file that any other address book can import. Opening a .vcf from Files edits that file in place. Keyboard: list buttons; E edits, Delete deletes, Esc cancels, Enter saves. This is an in-app address book: it does not read or write the operating system's contacts (no web API allows that). Not screen-reader tested.",
    "built", "contacts-engine.mts 'search…'; e2e-contacts.mts 'create', 'search', 'edit', 'persistence', 'keyboard', 'axe'"),
  F("CN-03", "CN", "Contact hygiene: duplicate detection (same e-mail, same phone by last 10 digits, same accent-folded name, transitive) with lossless merge, and upcoming birthdays (30 days, year-less dates, Feb 29 observed on Feb 28 in common years)",
    "A", "P3", "contacts-core findDuplicates (union-find) / mergeContacts / upcomingBirthdays / parseBday; Contacts.tsx Duplicates panel and birthday strip",
    "Merging keeps the first contact's UID and name, fills its empty fields from the others, unions e-mails, phones, addresses, URLs and groups without duplicates, joins notes, and keeps every unknown property. Phone matching ignores numbers with fewer than 7 digits. There is no fuzzy name matching beyond case and accent folding.",
    "built", "contacts-engine.mts 'duplicates…', 'RFC 6350 §4.3.1 dates'; e2e-contacts.mts 'duplicates and merge'"),
  F("CN-04", "CN", "Contact import/export: import .vcf files (UID-deduplicated, with a warning list), Download .vcf, CSV export (RFC 4180, CSV-injection guarded) to Files and the browser, optional Contact Picker import",
    "A", "P3", "Contacts.tsx toolbar; contacts-core toCsv / csvField / fromPicker",
    "The Contact Picker API is feature-detected. It exists only in Chrome on Android, so on desktop the button is disabled and says why. The picker → contact mapping is unit-tested, but no device run was possible here. CSV cells starting with = + - @ get a leading apostrophe, except phone-like and numeric values.",
    "built", "contacts-engine.mts 'search, sort/letters, CSV export…'; e2e-contacts.mts 'import', 'export'"),
];

export const UPDATES_TT24: Record<string, Patch> = {
  "PR-05": {
    name: "Contacts: first-party address book (CN-01..04) with an optional Contact Picker import",
    tier: "A", status: "built",
    route: "Contacts module (src/components/modules/Contacts.tsx + src/lib/contacts-core.ts); navigator.contacts.select only when present",
    nuance: "TT24: was a Contact Picker probe. It is now an address book stored as a vCard file, and the picker is one import path. Picking stays one-shot and user-initiated, with no enumeration. Where the API is absent (every desktop browser), the button is disabled with the reason, not emulated.",
    test: "contacts-engine.mts; oracle-vcard.mts; e2e-contacts.mts",
  },
  "FF-04": {
    status: "built",
    route: "Vector studio (FF-32) for SVG; src/lib/ai-format.ts sniffAi for .ai / .eps / .ps; Peek shows the kind, the facts and, for PDF-compatible .ai, the browser's PDF view",
    nuance: "TT24: .ai detection is built. A file is called Illustrator-native only when it carries /AIPrivateDataN (the marker file-type 16 uses); /PieceInfo<</Illustrator alone means 'saved as PDF from Illustrator'. Agreement with pypdf (page count, /Creator) and file-type 16 is checked on 4 public .ai files (a corpus pinned by blob SHA, not committed) and 5 committed fixtures. Inflate is capped per stream and in total. Limits: PostScript-based .ai and EPS get metadata only (no PostScript interpreter; Ghostscript is AGPL). The PDF view depends on the browser having a PDF viewer.",
    test: "ai-format.mts; oracle-ai.mts; e2e-ai.mts; e2e-vector.mts hostile SVG test",
  },
};
