import {F} from './row';

/**
 * TT110. Two genuinely new capabilities, both aimed at the same use case as the rest of Recall:
 * doing something useful with media the browser has ALREADY loaded, without asking the network
 * for it again.
 *
 * RC-35 acts on a memory that is already in the archive. RC-36 is the switch that removes the
 * capture pathways entirely, enforced where the writing happens rather than where the buttons are.
 * Everything else this turn was a correction to an existing row — see updates-tt110.
 */
export const tt110Features=[
 F('RC-35','Recall','Acting on a memory that is already saved','A','P2','Recall → open a memory in the timeline → Copy / Open in Photos / Show in Files',
   'A memory already in the archive can be copied to the system clipboard or handed to another app by path. The clipboard copy is honest about what the platform does to it: Chromium decodes and re-encodes images that pass through the system clipboard, so the pasted picture has the SAME PIXELS but not the same file bytes, and the status line says so — measured at 250 bytes on the clipboard against 272 bytes in the archive for an identical 64x48 image. Formats the clipboard will not take as a file (video, audio) copy the memory path as text instead of pretending. Handing a memory to Photos or Files passes only the VFS path: no temporary duplicate is written anywhere, which is the deliberate difference from the incumbent desktop feature that stages a copy in a temp directory. The archived bytes are never touched by any of these actions, re-read and re-digested after every one of them.','built','e2e-tt110-shell.mts'),
 F('RC-36','Recall','Switching screen and element capture off for the installation','A','P2','Settings → Privacy → Screen and element capture',
   'One setting removes the three capture pathways (authorized display frame, authorized display recording, element frame). The interface disables the buttons and states the reason with the exact settings path, and the SERVER refuses the commit inside the publication transaction, reading the policy row in the same transaction that would write the pair — so a stale page, a scripted client or a request crafted by hand is refused on the same terms, and a flip of the switch microseconds earlier is honoured. The refusal is deterministic and is reported as one: HTTP 403 naming the switch, never the ambiguous "publication was not acknowledged" that would send a user looking for a pair that was never written. Pathways that save something the page already had (chosen file, paste, drop, clipboard image) are deliberately unaffected: this is a capture switch, not a save switch.','built','tt110-core.mts'),
];
