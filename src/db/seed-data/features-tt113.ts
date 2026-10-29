import {F} from './row';

/**
 * TT113. The small print stops being the interface.
 *
 * Recall and the Browser had become documents. Every limit, refusal and privacy caveat was printed
 * as body copy, so the first screen of Recall was about 450 words of prose standing between a
 * person and the controls. None of that text was wrong — which is why it could not simply be cut.
 *
 * AX-16 states the contract that replaced it: the honest small print is kept, word for word, in a
 * real disclosure a keyboard can open, and the pane itself opens as a tool. It is written as an
 * accessibility requirement rather than a styling one because the failure it forbids is an
 * accessibility failure in both directions — an unreadable wall of prose, or text so hidden that
 * only a mouse hover could ever reveal it.
 */
export const tt113Features=[
 F('AX-16','AX','Honest small print without the essay: limits live in keyboard-reachable disclosures',
   'A','P2',
   'Recall / Browser → the muted "What this means" rows under each heading',
   'A module opens with no more than 120 words of prose that is not a control, heading, badge or list row; every limit it used to print is still present, verbatim, inside a native <details> disclosure that is focusable, operable with Enter from the keyboard alone, labelled with a specific phrase rather than "more", and announced by the platform. Measured, not asserted: Recall opens at 55 visible prose words with 12 disclosures holding 483 words, and opening them all restores 464 words to the page; Browser opens at 11 words. The anti-cheat is part of the contract — a future turn that lowers the visible count by DELETING a limit fails the floor on disclosed words. No saving pathway may be lost to compaction: the six Recall actions are asserted present and enabled afterwards.',
   'built','e2e-tt113-density.mts'),
];
