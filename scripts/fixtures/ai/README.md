# .ai / .eps test fixtures (FF-04, TT24)

| File | SHA-256 | Source | Licence |
|---|---|---|---|
| ft-fixture-adobe-illustrator.pdf | 94814149…78b38 | sindresorhus/file-type `fixture/fixture-adobe-illustrator.pdf` | MIT |
| ft-fixture-minimal.pdf | b7d25591…f0b73 | sindresorhus/file-type `fixture/fixture-minimal.pdf` | MIT |
| ft-fixture.eps | 89f58f7b…7e56e | sindresorhus/file-type `fixture/fixture.eps` | MIT |
| ft-fixture2.eps | 2fa6d70b…1c250 | sindresorhus/file-type `fixture/fixture2.eps` | MIT |
| tika-testAI_PS.ai | 0a9eb7c8…87036 | apache/tika test documents, `testAI_PS.ai` | Apache-2.0 |

`build.mts` constructs the remaining cases in code (PDF-compatible .ai with and without the PDF part, object-stream and
UTF-16 creators, an inflate bomb, 2000+ streams, corrupt Flate, DOS-EPS headers, junk before the header). The
constructed .ai files carry an XMP packet, because file-type 16 skips the first 1350 bytes, like real files do.

Not committed on purpose:
- ExifTool's sample images (GPL-3.0).
- The four real-world Illustrator files used by `oracle-ai.mts` (cncf/artwork and jenkins-infra/jenkins.io, no
  licence assertion on the files). The suite fetches them by pinned blob SHA into `$TOOLS_DIR/ai-corpus` and fails if
  a SHA does not match.
