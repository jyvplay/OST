# TT134 — all-app initial-view review

All **47 apps / 94 initial views** were visually read in the sixteen linked contact sheets. This is a bounded visual review, **not** an assertion that every app feature, hidden tab, device, permission flow, or state was exercised. Public application state API setup opens the real modules; it does not demonstrate every Launcher path.

**92/94** reached network-idle settling; both Photos views did not. Word counts are all rendered body text (including off-viewport rows/options), not viewport-only prose. Preserve the raw metadata and captures rather than converting an unsettle/overflow into a clean result.

Notable follow-ups: Spec/Clock/Settings/Apps/Monitor/Backup density; compact horizontally scrolling Contacts toolbar discoverability; Spreadsheet wide-grid overflow; device and external-service validation. Messages is not a proven complete messaging client. Existing original glyphs/layout diagrams/shape graphics are visible; this review does not count them as twenty new features.

| App | Wide / compact rendered words | Review notes |
|---|---:|---|
| Recall | 236 / 236 | Method groups and limits are folded; two-column controls remain dense in compact view. Recording and background/OS-wide recall are not inferred from an idle preview. |
| Files | 95 / 95 | Folder table and top actions are legible at both sizes; the operation journal is real test-generated state. Initial view is not an exercise of every file operation. |
| Editor | 21 / 21 | Sparse, clear no-document state; Save is visible but no file is open. Empty state is not an editing/encoding acceptance test. |
| Find | 39 / 39 | Primary controls fit in compact view; saved searches and diagnostics are folded. Initial results area is visually sparse. Functional acceptance is in the native search suite, not this image. |
| Terminal | 13 / 13 | Minimal dark terminal and one-line context; the visible surface is the application VFS shell, not a claim to expose the host operating-system terminal. |
| SSH | 61 / 61 | Connection/key controls fit; recent localhost address is the real disposable sshd used by the native suite. Password/host-key guidance is still a paragraph. |
| Notes | 54 / 54 | Compact title input ellipsizes, tags and Save stay available, outline and extra commands are folded. Saved test notes are visible; a screenshot alone cannot establish ownership/CAS correctness. |
| Browser | 130 / 130 | Blocked external embed is explicitly disclosed; handoff, proxy and reader paths are distinct. The failure explanation remains wordy; sandbox egress refusal is not evidence that all external sites refuse embedding. |
| Media | 213 / 213 | Native empty player is honest; captions and export panels occupy substantial vertical space. Real external receiver/playback/codec behavior was not established by this view. |
| Capture | 88 / 88 | Empty authorized-capture preview; browser and storage limits are visible. An initial Muted HUD overlays part of the view. No physical screen-sharing/audio grant was exercised here. |
| Lens | 142 / 142 | Camera start and effect controls are visible, with a blank unstarted preview. Compact canvas/controls still fit; lower transport explanations are dense. Physical camera/microphone quality is unverified. |
| Beam | 302 / 302 | Several real transport APIs are separated from explicitly blocked native protocols. Status and explanatory cards are text-heavy; availability is not evidence of a receiver connection. |
| Together | 84 / 84 | Room/media controls and idle event panel are legible. Not joined; this image does not prove two-device clock synchronization. |
| Messages | 294 / 294 | Bridge configuration and generic message connector are visible, followed by capability explanations. This remains an externally dependent/skeleton surface, not a verified universal messaging client. |
| Vault | 58 / 58 | Focused create-vault card with no-recovery and encryption warning. A reported passkey capability does not prove a physical authenticator ceremony. |
| Privacy | 76 / 76 | Creation and encrypted-restore forms fit. Security and persistence claims require separate tests; no claim of secure disk erasure or resistance to a compromised host is inferred. |
| Backup | 436 / 436 | Export, saved bundles, recovery key and restore form are organized but still dense, especially compact. Critical secret/recovery warnings should not be removed merely to lower a word count. |
| Alerts | 97 / 97 | Clear no-alert state and explicit browser notification boundary; cannot read another application’s notifications. Physical OS delivery/permission interaction is not proved by this capture. |
| Monitor | 460 / 460 | Measured browser/runtime values are visibly labeled, not host-wide instrumentation. Long compositor/job detail creates a dense scrolling initial module; frame cost is only a thermal proxy. |
| Apps | 891 / 891 | Install/handler declarations are explained as declarations, not installed-OS acceptance. Large handler/startup listing remains text-heavy; native handler registration needs installed-device verification. |
| Calculator | 180 / 180 | Keypad and result/history controls are clear; converter is below the fold compact. Existing Number/programmer precision and breadth boundaries remain, despite the polished initial keypad. |
| Settings | 1014 / 1014 | Original layout diagrams/style swatches help scanning. Numerous settings remain in one long scrolling pane; not a complete reduction of wordiness or exhaustive device/settings test. |
| Spec | 12653 / 12653 | The full 627-row register is a deliberately long document, with filter/export/status tools. Rendered-text word count includes off-viewport register rows; it is not the number simultaneously visible. |
| Clock | 1581 / 1581 | World clocks and timezone conversion are legible; stopwatch/timer/tool sections create a long document. Test browser timezone is not proof of all physical-device alarm/background behavior. |
| Planner | 34 / 34 | Concise task toolbar, folded notes/limits and clear empty agenda. Foreground reminder notice is retained; background OS scheduling remains outside the verified contract. |
| Devices | 40 / 40 | Capability tabs and unstarted recorder are clear. Zero origin-storage usage is compatible with a fresh browser context and is separate from server VFS size. No hardware was attached or invented. |
| Share | 67 / 67 | Honest empty screen/room controls and browser-only transport boundary. No physical second device or authenticated remote hardware connection was exercised here. |
| Routines | 98 / 98 | Workspace preset and original command-list routine editor are coherent; dry-run status is distinct from execution. Empty routine list is not proof of trigger coverage. |
| Clipboard | 136 / 136 | Clear zero-entry memory-only state; explicit capture is required for another app’s clipboard. Scope explanation remains long but avoids falsely implying OS-wide clipboard surveillance. |
| Storage | 338 / 349 | Server VFS values are populated (505/515 KiB across sequential captures), origin usage is separately zero, real generated duplicate groups are visible. Initial zero VFS is not reproduced here; duplicate actions need separate ownership tests. |
| Archive | 58 / 58 | Clean no-archive state; many actions share a horizontally scrollable toolbar. No encryption/extraction acceptance is inferred from disabled controls. |
| Local disk | 85 / 85 | One clear mount action and an honest direct-child/UTF-8/conflict boundary. A real OS directory permission grant and file-system-provider equivalence were not exercised here. |
| Photos | 39 / 37 | Actual VFS thumbnails/graphics are visible and wrap in compact view. Both captures missed network-idle settling, explicitly retained rather than relabeled; initial thumbnails are not all format/metadata/recipe operations. |
| Image Editor | 161 / 143 | Canvas, tool icons and layer/brush controls are readable in compact view; horizontal toolbar overflow is folded. An empty background layer is not all editing/format coverage. |
| Vector | 158 / 144 | Original shapes on canvas, explicit tools and properties are visible at both sizes. Native resize/export checks supply actual dimensions; initial layout alone is not SVG equivalence. |
| Writer | 198 / 201 | Toolbar overflow has a More action; document canvas scrolls in compact view. An authentic recovery offer from earlier interrupted test work is visible, not an invented clean-store screenshot. Cross-paragraph correctness comes from the independent saved ZIP/XML test. |
| PDF | 39 / 39 | Clear no-file state, short toolbar and page/forms/signatures tabs. Empty viewer is not a PDF fidelity/security/signature acceptance test. |
| Books | 25 / 25 | Small, clear open-book prompt with the scripts-never-run boundary retained. No claim that all EPUB variants were manually opened in this review. |
| Slides | 92 / 87 | Initial editable slide/thumbnail and speaker-note area fit both sizes. Toolbar uses overflow; kept-media-not-played caveat is visible. No universal PPTX fidelity claim. |
| Spreadsheet | 295 / 297 | Dense editable grid intentionally scrolls; measured body scrollWidth exceeds clientWidth by 289px wide/575px compact. Do not report zero overflow or that all columns/actions are visible at once; native layout tests separately exercise navigation/save/export. |
| Contacts | 51 / 51 | Address-book empty state is clear. The compact toolbar clips later actions at the initial scroll position; CSS deliberately supplies horizontal toolbar scrolling, rather than wrapping. Discoverability is a follow-up, not proof that controls were removed. |
| Tables | 90 / 90 | Initial linked task table is coherent and readable; wide data columns scroll within the data area. This view does not establish every type/link/formula operation. |
| Whiteboard | 70 / 62 | Original sample sticky, ellipse and connector are legible; layer list remains beside the canvas compact. Sample content is disclosed, not a purported user-created drawing. |
| Peek | 3 / 3 | Minimal Nothing to preview state; intentionally almost no prose. A selected-file preview would be a different state to verify. |
| Video | 40 / 40 | Empty player, URL field and saved-library area are clear. External service playability is not established in an egress-restricted sandbox. |
| Music | 49 / 49 | URL and library controls are clear, but the multi-service example explanation remains verbose. No streaming entitlement, physical audio, or external-service availability assertion. |
| Maps | 57 / 57 | Real offline border map, original controls and attribution fit compact. No tile server/online route/physical GPS success is inferred; GeoNames and Natural Earth are attributed. |

## Contact sheets

- [wide 01](screens/tt134-review/wide-01.jpg) — recall, files, editor, find, terminal, ssh
- [wide 02](screens/tt134-review/wide-02.jpg) — notes, browser, media, capture, lens, beam
- [wide 03](screens/tt134-review/wide-03.jpg) — together, messages, vault, privacy, backup, alerts
- [wide 04](screens/tt134-review/wide-04.jpg) — monitor, apps, calculator, settings, spec, clock
- [wide 05](screens/tt134-review/wide-05.jpg) — planner, devices, share, routines, clipboard, storage
- [wide 06](screens/tt134-review/wide-06.jpg) — archive, localdisk, photos, imageedit, vector, writer
- [wide 07](screens/tt134-review/wide-07.jpg) — pdf, books, slides, sheet, contacts, tables
- [wide 08](screens/tt134-review/wide-08.jpg) — whiteboard, peek, video, music, maps
- [compact 01](screens/tt134-review/compact-01.jpg) — recall, files, editor, find, terminal, ssh
- [compact 02](screens/tt134-review/compact-02.jpg) — notes, browser, media, capture, lens, beam
- [compact 03](screens/tt134-review/compact-03.jpg) — together, messages, vault, privacy, backup, alerts
- [compact 04](screens/tt134-review/compact-04.jpg) — monitor, apps, calculator, settings, spec, clock
- [compact 05](screens/tt134-review/compact-05.jpg) — planner, devices, share, routines, clipboard, storage
- [compact 06](screens/tt134-review/compact-06.jpg) — archive, localdisk, photos, imageedit, vector, writer
- [compact 07](screens/tt134-review/compact-07.jpg) — pdf, books, slides, sheet, contacts, tables
- [compact 08](screens/tt134-review/compact-08.jpg) — whiteboard, peek, video, music, maps

Machine-readable per-view hashes/observations: [`evidence/tt134-visual-review.json`](evidence/tt134-visual-review.json). Raw capture metadata: [`evidence/tt134-visual.json`](evidence/tt134-visual.json).

## Final-build supplement

The two updated original header marks were captured again in Notes/Find at both sizes, and compact Contacts was genuinely scrolled/clicked to open Duplicates. **5/0 native checks; all five supplemental captures manually viewed.** These are additional changed-view checks, not another 94-view run. See [supplement evidence](evidence/tt134-icon-review.json) and the `finalBuildSupplement` hashes in the full review JSON.

- [Notes wide](screens/tt134-polish/notes-wide.png) / [compact](screens/tt134-polish/notes-compact.png)
- [Find wide](screens/tt134-polish/find-wide.png) / [compact](screens/tt134-polish/find-compact.png)
- [Contacts after native scrolling/click](screens/tt134-polish/contacts-compact-scrolled.png)

The Contacts result proves reachability, not that all actions are visible at once or that overflow discoverability is solved.


## Later review repairs — retained as distinct source stages

- **Source 5:** all ten Browser/Spec/Beam wide/compact captures were actually viewed. Known GitHub refusal retained its measured policy, explanation and alternatives; genuine DNS failure showed a separate unverified state. Spec retained all 627 row identities and twelve complete question/status/pass/fallback/result records behind a native mouse/Enter/Space disclosure. Beam's file label touched its native picker; this was a real visual finding, not a passed criterion. [Hashed pre-spacing evidence](evidence/tt134-review-repairs-before-spacing.json).
- **Final source 6:** all ten fresh captures were actually viewed again after the wrapping label-gap correction and coverage rebuild. Native geometry measures **8 px** in both widths. Final network/disclosure/geometry suite **8/0**, stricter full density suite **23/0**, compiled/live/source ledger **5/0**. [Final captures, hashes and measured values](evidence/tt134-review-repairs.json), [36-case receipt](evidence/tt134-final-native.json).
- Plain `innerText` values (off-viewport content/select options included): Spec **12,217 closed / 12,657 open**, Beam **291**, Browser measured-denial state **121**, unverified DNS-failure state **60** in both widths. These are state-specific values, not a global cross-metric before/after improvement. Density gates pass the unchanged Spec **12,400** and Beam **300** caps; all critical spike/receiver/transport limits remain.
- Still visible: long Spec health warnings, some dark Browser glyph contrast, and native off-viewport content requiring scrolling. Expanded Spec screenshots show the first question, not every criterion at once; actual API-to-DOM checks cover all twelve records. No physical receiver, universal assistive-technology, phone-size or all-state acceptance is implied.
- The original **94 initial views / 47 apps** are not replaced or inflated by five historical mark/layout supplements and these twenty later-stage captures. No supplementary screenshot counts as a new Class A feature.
