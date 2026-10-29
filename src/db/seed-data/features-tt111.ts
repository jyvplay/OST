import {F} from './row';

/**
 * TT111. One genuinely new capability, aimed squarely at Recall's first use case: keeping media the
 * browser has ALREADY loaded, at the moment the human decides to keep it, WITHOUT asking the
 * publisher for it again.
 *
 * Every pathway before this one either re-requested the bytes (original-response) or saved something
 * the page had handed to the desktop directly — a resident file, a clipboard item, a canvas, an
 * authorized capture. Media inside the in-app browser was the hole: the bytes stream through the
 * proxy into an opaque-origin frame the desktop cannot read, and proxied responses are deliberately
 * no-store, so they are not in the browser's disk cache either. Asking again is a different act with
 * a different result — signed URLs expire, CDNs rotate, live images change, hosts go down.
 *
 * RC-37 keeps those bytes where they already passed: in this server's memory, for the life of the
 * browsing session, only when the human has switched the tap on. The test stops the origin server
 * before the save, so a refetch is not merely unobserved — it is impossible.
 */
export const tt111Features=[
 F('RC-37','Recall','Saving media the page already loaded, without asking the publisher again','A','P2','Recall → "Media this page already loaded" (Settings → Privacy → Remember media this page loads)',
   'Complete image/audio/video responses that the in-app browser loads are kept in this server\u2019s memory for the life of the browsing session, so a later human-initiated save writes the publisher\u2019s exact bytes with no second request. Proven by stopping the origin server before the save: a fresh request for the same URL fails while the save still produces a byte-identical file (sha256 equal, 76 KB measured). Receipts record method session-retained-response with attribution proxy-recorded-response — a third provenance class, distinct from requested-url (a refetch) and user-declared-label (a re-encode), and the server refuses any method that borrows another\u2019s claim. Bounds are deliberate: off by default, media only, complete 200 responses only (a 206 range or an aborted body is never kept), 8 MiB per item, 24 items and 48 MiB per session, 192 MiB per process, oldest out first, nothing written to disk. Switching the setting off, closing the page or pressing Forget drops the bytes immediately, and the switch is re-read on every save. It cannot see media loaded outside the in-app browser, and it decodes nothing — no DRM is touched and no content is analysed.',
   'built','tt111-recall-tap.mts + e2e-tt111-recall.mts'),
];
