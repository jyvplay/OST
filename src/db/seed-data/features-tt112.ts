import {F} from './row';

/**
 * TT112. The third byte-exact Recall pathway, and the one the other two cannot reach.
 *
 * RC-01 asks the publisher again. RC-37 keeps what the publisher sent while the page was open. Both
 * of them depend on the bytes having been a network response. A page can hold media that never was
 * one: a picture it drew on a canvas and exported, a file the human dropped onto it, an image it
 * assembled or decoded in memory, or an object inlined into the document itself. Those live behind
 * a blob: or data: address that only that document can read, and the desktop runs them in an
 * opaque-origin sandbox precisely so that nothing else can.
 *
 * RC-38 asks the document, in the open, for a list of what it is holding, and reads one item only
 * when the human names it. Nothing is retained anywhere until that moment, so there is no new store
 * and no new policy surface: the act is the human's, and the bytes are the object's own.
 */
export const tt112Features=[
 F('RC-38','Recall','Saving an object the page is holding itself — blob: and data: media',
   'A','P2',
   'Recall → "Objects this page is holding itself" → Scan the open page → Save',
   'A scan asks the open proxied document to list every blob:/data: media object it currently holds (up to 400 elements walked); a save reads exactly one named object and archives those bytes with no decode and no re-encode. Byte-for-byte: the archived SHA-256 equals the object\u2019s own. Verified with the origin shut down AND against objects the origin never served at all, so no refetch could have produced them. Ceiling 8 MiB, enforced where the bytes are read; over-ceiling, empty, revoked and live MediaSource objects are refused by name and write nothing. A MediaSource-backed video is listed (only a read can tell) and refused on read. Receipts record method resident-object-url, attribution user-declared-label and refetched:false; the address recorded is the page the object belongs to, never a claim that the address would serve these bytes. http(s) media is deliberately NOT listed here: that belongs to RC-01 and RC-37.',
   'built','e2e-tt112-resident.mts'),
];
