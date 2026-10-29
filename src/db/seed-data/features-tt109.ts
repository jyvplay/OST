import {F} from './row';

/**
 * TT109. One new capability only: recognising that a memory is already held, so a second human
 * save of the same picture does not quietly produce a second copy. Everything else this turn was
 * a correction to an existing row (see updates-tt109), because measuring a row honestly is not the
 * same as inventing one.
 */
export const tt109Features=[
 F('RC-34','Recall','Recognising a memory the archive already holds','A','P2','Recall → save an image that is already saved','A second human save of bytes the archive already holds inside the same memory folder is recognised instead of silently duplicated: the response says which earlier memory matched and when it was first saved, and the interface reports "Already saved on <date>" rather than a new filename. The comparison is made on the SHA-256 of the DECODED bytes (vfs_nodes.sha256 digests stored text, so it cannot be used for this), it is computed inside the same transaction that would otherwise write the pair, and it is scoped to the memory folder, excludes trashed rows and reads the stored base64 only through a CASE-guarded canonical-base64 test so a hostile row cannot make the scan error. Recognition is opt-in twice over: the API default is still to write a fresh pair, and the interface exposes it as a checkbox that starts OFF, because a save a person explicitly asked for must never be silently refused — the first version of this feature made recognition the default and three older end-to-end suites correctly failed, which is how the regression was caught before it shipped. It is a duplicate check, not deduplicated storage: two identical pictures saved into two different memory folders are still two files, and nothing is ever deleted or rewritten by this path.','partial','tt109-recall.mts'),
];
