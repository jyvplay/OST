import {F} from './row';

/**
 * TT114. Two new requirements, written for the two things this turn actually proved.
 *
 * RC-39 closes the last honest gap in the Recall commit contract. Every earlier turn could say
 * that a commit is atomic — that a half-written memory is impossible. None could say what happens
 * when the *answer* is lost: the client fires a save, the connection dies after the server has
 * committed but before the receipt is read, and the client has no way to tell a commit that never
 * happened from one whose reply went missing. Retrying risked a duplicate; not retrying risked
 * losing the save. TT114 gives the client a token to mint and the server a claim to make, so the
 * retry is answered by the first commit instead of performing a second one.
 *
 * AX-17 is the second half of TT113's de-wordification. TT113 bounded prose; the buttons were
 * still a paragraph with borders — fifteen stacked controls carrying forty-five words. Shortening
 * them is only legitimate if the name survives, because the name is what a screen reader speaks
 * and what every existing test asks for. The row therefore states the pair, and its suite fails
 * if either half is broken.
 */
export const tt114Features=[
 F('RC-39','RC','Exactly-once saving across a lost answer: client-minted commit token',
   'A','P2',
   'Recall → any saving pathway (the token is minted per attempt and never shown)',
   'A save carries a client-minted commit token. The server claims it as the FIRST statement inside the commit transaction (INSERT ... ON CONFLICT DO NOTHING ... RETURNING), so a second arrival of the same token cannot begin a second write: it is answered from the first commit with {stored:false, replayed:true} plus a present flag saying whether that memory is still in the archive. A token replayed with different bytes is refused 409 and writes nothing — the token identifies one body, not a licence to overwrite. Proven against real HTTP and PostgreSQL: an aborted request retried with the same body yields one memory; eight concurrent commits of one token yield one write, seven replays and one file; a replay after the memory was trashed honestly answers present:false rather than resurrecting it; untokened saves are unaffected and still produce one memory each. Limits stated honestly: this is idempotency of the publication, not a distributed transaction, and the token is held in the same database as the memory, so it cannot survive a loss of that database.',
   'built','tt114-recall-token.mts'),
 F('AX-17','AX','A control may be shortened only if its name survives: concept glyph plus one word',
   'A','P2',
   'Recall → the memory toolbar; Browser → split, tear-out and tab-side controls',
   'Dense chrome is drawn, not written: each action shows an original stroke glyph and at most one word, while the full phrase it used to print stays as the accessible name (aria-label) and the tooltip. The pair is the contract. Measured, not asserted: the fifteen Recall memory actions fell from 45 visible words to 16 and from four rows to two, every one of them carries a drawn SVG rather than an emoji or an arrow character, and all fifteen still resolve by their exact former names; the Browser split, tear-out and tab-side controls are glyph-only with full names. The anti-cheat is explicit — deleting a control passes the word count and fails the name check, and replacing a glyph with a letter passes both and fails the drawing check. Glyph geometry is compared so that one shape cannot be reused for every concept.',
   'built','e2e-tt114-density.mts'),
];
