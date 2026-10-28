import {F} from './row';
export const tt105Features=[
 F('RC-22','Recall','Atomic memory and receipt publication','A','P2','Recall → human save','Create-only media plus receipt, index and journal share one PostgreSQL transaction. Server validates raw-byte checksum, schema, MIME, path and redacted labels. Existing orphan files remain; folders created beforehand may remain empty. Lost commit acknowledgements are unknown, not automatic retry or exactly-once semantics. Plaintext, not encryption.','partial','tt105-atomic.mts'),
 F('RC-23','Recall','Clicked already-loaded visual','A/B','P2','Fusion → Save clicked loaded visual','Real pointer selection of current connected img/video/canvas, then explicit host save. No URL fetch or silent fallback to largest. Native PNG ≤16 MP / 8 MiB, origin-clean required; not original encoding or secure attestation. Closed shadow-root targets, occlusion, DRM and physical browser matrix remain conditional.','partial','e2e-tt105-clicked.mts'),
];
