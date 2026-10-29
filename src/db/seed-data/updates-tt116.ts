/**
 * TT116 — eight rows that carried a prose claim with only incidental coverage now name a
 * suite that addresses them directly, and the nuance says what the run measured rather than
 * what the feature intends. Applied last, so these corrections win over every earlier map.
 *
 * Three of these rewrites exist because writing the test found the claim was narrower than
 * the row implied, and the row is now narrower too: RC-34 recognises duplicates per folder
 * and not across the archive; the search scope is a path-prefix scope that breaks on the
 * separator, which is a stronger statement than "in-folder"; and DP-14's journal records
 * stages for writes and safe saves but a single COMPLETE row for trash and restore.
 */
export const UPDATES_TT116: Record<string, {nuance?: string; status?: string; test?: string}> = {
  'FM-18': {
    nuance: 'A replacement is staged at /.safe-save/<token>.part, reopened in a separate transaction, verified byte-for-byte against the declared length and digest, and only then published over the target; the stage is reclaimed afterwards and an abandoned stage is swept. Measured in TT116 (15 assertions): the seven stages PREPARED, TEMP_WRITTEN, REOPENED, VALIDATED, REPLACED, TEMP_RECLAIMED, COMPLETE are journalled in causal order; an expected-version mismatch with onConflict "copy" publishes "name (copy N).ext" instead of overwriting; a FAILED attempt deletes its claim so the same token can be retried; the sweep cannot reclaim an in-flight save. Two honest limits are part of the contract: representability is validated on the INPUT, because a reopen-and-compare cannot see a loss that happened in the encoder on the way in (the driver substitutes U+FFFD for a lone surrogate before PostgreSQL sees it, and the digest of the string agrees); and the guarantee ends at the database, since there is no fsync of a real filesystem underneath.',
    status: 'built',
    test: 'tt116-safesave.mts (15 assertions)',
  },
  'RC-13': {
    nuance: 'A retention policy over exactly one grouping folder. Rules compose by INTERSECTION, so maxItems:1 with maxAgeDays:1 keeps what both rules keep and a mistaken rule errs towards keeping more. dryRun defaults to true and the UI cannot apply a plan it has not shown you: the Apply control exists only while a reviewed plan is on screen. Media and receipt are trashed as a pair inside one transaction with the purge lock held and the digest re-checked under FOR UPDATE; a memory whose pair cannot be proved is skipped and survives. Measured in TT116 (7 assertions): an applied run trashes exactly the dry run\'s candidates; an unpaired file is skipped with a /pair/ reason and is still there afterwards; maxAgeDays:0 keeps nothing and the intersection of maxAgeDays:1 and maxItems:1 over four fresh memories keeps one; ten invalid scopes and rule shapes are refused with 400; the run is auditable afterwards as actor "policy" with its considered and trashed counts. This moves memories to Trash. It is not secure erasure and makes no such claim.',
    status: 'built',
    test: 'tt116-recall-retention.mts (7 assertions)',
  },
  'RC-18': {
    nuance: 'Page one of a memory timeline pins the highest id it returned, and every later page carries that pin so the server adds id <= asOf. Without it, a save between two page reads shifts the offset and a memory is silently skipped — which is what this turn measured before fixing it. Measured in TT116: paging through seven memories while saving an eighth mid-sequence returns six distinct memories pinned, against the unpinned read that skipped one; asOf values 0, "abc", -1 and 99999999999 are refused with 400. The pin is a view of one instant, not a lock: a memory saved after page one is simply not in that sequence, and the next refresh shows it.',
    status: 'built',
    test: 'tt116-recall-retention.mts (7 assertions)',
  },
  'RC-10': {
    nuance: 'A memory is filed under the page\'s host, the page\'s title, or a folder name the person typed, and the folder is DERIVED from the page rather than chosen by the app. Measured in TT116: one page URL produces three different folders under the three groupings; the host grouping keeps the port, so two servers on one hostname do not share an archive; the label is NFKC-normalised with path separators and control characters replaced, leading dots stripped and the result capped at 90 characters, falling back to "untitled" rather than to an empty name; and a path outside the single-level /Downloads/Recall/<folder>/<file> layout is refused by the server, not only by the form.',
    status: 'built',
    test: 'tt116-recall-archive.mts (8 assertions)',
  },
  'RC-34': {
    nuance: 'A second save of bytes the folder already holds is recognised instead of duplicated. With onDuplicate:"skip" the server answers stored:false, names the memory already held in duplicateOf, and reports when it was first saved; no second file is written. The default is still to store, because a deliberate re-save is a choice the person made and silently dropping it would be the wrong answer. Measured in TT116: identical bytes are recognised and write nothing; different bytes under a similar name are stored normally; the scan is one indexed pass over the SAME folder only — recognition is per folder, not across the archive, and the row no longer implies otherwise. The digest is computed inside the database over the decoded bytes, under a CASE guard so a non-canonical base64 row yields NULL instead of raising.',
    status: 'built',
    test: 'tt116-recall-archive.mts (8 assertions) + e2e-tt109-recall.mts',
  },
  'RC-27': {
    nuance: 'Every saved memory is filtered by save method, page host and capture date, read from the receipts rather than from a separate index, so a filter can never disagree with the provenance it filters on. Measured in TT116: the method filter admits a memory saved that way and excludes one saved another way; the host filter does the same; a from-date in 2099 and a to-date in 2000 both return nothing rather than everything; and five malformed filters (a method with spaces, an invalid host, "yesterday" as a date, a zero limit, a folder outside the Recall root) are refused with 400. A blank filter means "unset" and is not an error. The reply carries the filters it actually applied, the number of receipts scanned, the count of unreadable receipts, and the bounds it enforced.',
    status: 'built',
    test: 'tt116-recall-archive.mts (8 assertions) + e2e-tt107-memory.mts',
  },
  'RC-28': {
    nuance: 'The integrity audit reports media without a receipt, receipts without media, unreadable receipts and checksum mismatches, and offers to trash an unpaired file. Measured in TT116: a healthy pair is reported as one healthy pair with no orphans; trashing the receipt moves the memory to orphanMedia and drops healthyPairs to zero; and nothing in the system writes the receipt back, because provenance cannot be reconstructed after the fact — a regenerated receipt would be a fabricated one. Three malformed scopes are refused with 400, while an empty scope legitimately means every folder, which is an explicit choice the person makes in the interface.',
    status: 'built',
    test: 'tt116-recall-archive.mts (8 assertions) + e2e-tt107-memory.mts',
  },
  'SR-05': {
    nuance: 'A search can be confined to a subtree, and the confinement is a path-prefix scope that breaks on the separator. Measured in TT116: with the same term indexed in /Documents/scope-X and /Documents/scope-X-sibling, an unscoped search finds both, a search scoped to /Documents/scope-X returns exactly one, and the sibling that shares a name prefix is NOT captured — the LIKE pattern anchors on the slash. Scoping to the parent returns both again. The scope composes with the visibility filter, so a scope can never reveal a private, encrypted or trashed document.',
    status: 'built',
    test: 'tt116-platform.mts (9 assertions) + tt110-core.mts',
  },
  'SR-08': {
    nuance: 'Search explains itself rather than scoring itself. With no query it reports index coverage per source and the time it took; with explain=1 it reports the number of indexed documents, the strategy by name (websearch_to_tsquery with ts_rank, substring fallback), what is excluded (private, encrypted, trashed and excluded paths) and the 50,000-character body truncation. Measured in TT116: coverage is reported per source with integer counts and is consistent with what the index can actually find; the diagnostic does not leak into ordinary searches; and POST /api/search returns 501 with rebuilt:false, because no rebuild operation exists and reporting one would be a claim the system cannot support.',
    status: 'built',
    test: 'tt116-platform.mts (9 assertions) + tt110-core.mts',
  },
  'DP-14': {
    nuance: 'Every file operation leaves an observable journal entry carrying its operation, its paths and its outcome, readable at /api/jobs. Measured in TT116: a write, a move and a trash each produce an entry, the move records BOTH ends so it can be reconstructed, a write carries its stage list through DEST_PUBLISHED, and a safe save records all seven of its stages in causal order — TEMP_WRITTEN before REOPENED, VALIDATED before REPLACED. The honest limit, stated here rather than implied away: writes and safe saves record a stage sequence, while trash and restore record a single COMPLETE row, so the journal proves that those happened but not how far they got.',
    status: 'built',
    test: 'tt116-platform.mts (9 assertions) + tt110-core.mts',
  },
  'SC-02': {
    nuance: 'A privacy switch is enforced by the server, not only by the interface. Measured in TT116: with privacy.screenCapture set to off, a commit whose receipt declares a capture method is refused with the configured refusal and leaves no file behind, while an ordinary write of resident bytes is unaffected — the switch disables a pathway, not the application; with the switch back on the same commit succeeds. An undeclared value is rejected with 422 and does not change the stored value. The switch is read inside the commit transaction, so flipping it off takes effect on the next commit rather than at the next page load.',
    status: 'built',
    test: 'tt116-platform.mts (9 assertions) + tt110-core.mts',
  },
};
