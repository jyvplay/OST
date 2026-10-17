# Contacts (TT24 · PR-05, CN-01..04)

An address book that stores its data as a plain **vCard 4.0** file in Files (`/Contacts/contacts.vcf`).
Any `.vcf` opened from Files is edited in place. Engine: `src/lib/contacts-core.ts` (no React).
UI: `src/components/modules/Contacts.tsx`.

## What it does
- **Reads** vCard 2.1, 3.0 and 4.0:
  - line folding;
  - quoted-printable with any CHARSET the browser's TextDecoder knows (UTF-8 and ISO-8859-1 are tested), base64 PHOTO;
  - RFC 6868 `^n ^' ^^` parameter escapes;
  - quoted TYPE lists, `TYPE=PREF` (3.0) and `PREF=n` (4.0), `VALUE=uri` `tel:` numbers.
- **Writes** RFC 6350 vCard 4.0: CRLF, folded at 75 octets without splitting a UTF-8 sequence, text escaped, and dates in
  the *basic* format §4.3.1 requires (`19850412`, `--0412`).
- **Keeps what it does not model.** Unknown properties (GEO, KEY, TZ, LANG, X-…) and unknown parameters on
  EMAIL/TEL/URL/ADR (PID, ALTID, LABEL…) are written back verbatim. PID and CLIENTPIDMAP are what sync clients key on (§7).
- **Address book UI:**
  - search (accent-insensitive, multi-token, phone digits), alphabetical groups, card with mailto:/tel: links;
  - edit form with validation, autosave (0.5 s) and undo (20).
- **Hygiene:**
  - duplicates (same e-mail, same phone by last 10 digits, same folded name) with a lossless merge;
  - birthdays in the next 30 days (year-less dates; Feb 29 observed on Feb 28 in common years).
- **Import/export:**
  - .vcf import (skips UIDs already present, lists warnings), Download .vcf;
  - CSV export (RFC 4180, formula-injection guarded) to Files and the browser.
- **Contact Picker:** used only where `navigator.contacts` exists (Chrome on Android). Elsewhere the button is disabled
  and says why.

## Evidence
- `scripts/contacts-engine.mts` (8 tests):
  - the verbatim RFC 6350 §8 and RFC 2426 §7 examples, the §4.1 NOTE example;
  - 2.1 QP, round trip, dates, duplicates/merge, CSV, hostile input.
- **Mutation check:** breaking unfolding, the 75-octet fold limit or parameter preservation each makes tests fail.
- `scripts/oracle-vcard.mts` (3 tests): vobject 0.9.9 (independent Python implementation, Apache-2.0):
  - it reads our 4.0 output;
  - we read its 3.0 output;
  - 200 generated contacts survive ours → vobject → ours.
- `scripts/e2e-contacts.mts` (8 tests, headless Chromium):
  - create, validate, import, search, reload persistence, keyboard edit/delete/undo;
  - merge, birthdays, CSV/.vcf export, Files double-click;
  - axe in 4 states.

## Limits (declared)
- This is not the operating system's address book; no web API can read or write that.
- No jCard/xCard. Nested AGENT vCards are skipped with a warning.
- Parameters on FN/N/ORG/TITLE/NOTE are not kept, and ORG TYPE is dropped. PRODID and `KIND:individual` are dropped
  (other KINDs are kept). N comma-lists become ", " text.
- The editor shows the first address (others are kept unchanged) and one website.
- The Contact Picker path was not run on a device here; only its mapping is unit-tested.
- Not screen-reader tested.
