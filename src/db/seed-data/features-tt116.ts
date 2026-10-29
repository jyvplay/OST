import {F} from './row';

/**
 * TT116. Three new requirements, each one written only because this turn built the
 * mechanism and ran a suite against it. Nothing here is a plan.
 *
 * FM-18 answers a question every earlier turn dodged: what happens to the file you
 * already had when a save of its replacement goes wrong halfway? Until now the write
 * path journalled a COPYING_TO_TEMP stage with no temp behind it, so an interrupted
 * save could only be described, not survived. A safe save now stages the new bytes
 * under a token, reopens them in a separate transaction, proves they are the bytes
 * that were sent, and only then replaces the target — so the failure modes are
 * "nothing happened" and "the new bytes are published", with no third case.
 *
 * RC-13 is the first Recall feature that deletes. An archive of what you already saw
 * grows without limit, and a person who cannot prune it will eventually stop using
 * it. The rule is deliberately narrow: it plans first, it composes its rules by
 * intersection so a mistake keeps more rather than fewer, it moves media and receipt
 * together or not at all, and it refuses to touch a memory whose pair it cannot
 * prove. It trashes; it does not erase.
 *
 * RC-18 is the defect that paging over a growing archive hides. A timeline read page
 * one, the person saved something, and page two silently skipped a memory, because
 * the offset had moved under it. The first page now pins the highest id it saw and
 * every later page carries that pin, so a page sequence is a view of one instant.
 *
 * AX-18 is this turn's half of a standing instruction. Recall measured 213 visible
 * words at the start of the turn; the number is in the suite, and so is the floor
 * that stops the number being won by deleting a warning.
 */
export const tt116Features = [
  F('AX-18', 'Design', 'Caption rows become concept marks, with a floor', 'A', 'P2', '/recall',
    'Recall measured 213 visible words, 41 controls and 32 drawn marks at the start of TT116. The filter strip\'s five stacked captions, the file-input row, the keep-one row, the status line and the URL/folder/title captions are now stroke-only concept marks, each control keeping its full phrase as both aria-label and title so the visible word is always a substring of the accessible name (WCAG 2.5.3). Measured after the pass: 153 words, 43 controls, 52 marks, 33 geometrically distinct shapes, 0 label-in-name violations. The suite is built so the cheap wins fail: deleting a control fails the name check, hiding the row in a disclosure fails the visibility check, a letter instead of a drawing fails the geometry check, one shape reused everywhere fails the distinctness check, and deleting the "once a database commit starts it is not cancellable" warning fails the floor. Glyph comprehension by a human reader is still unmeasured; only geometry and naming are.',
    'built', 'tt116-density.mts (6 assertions)'),
];
