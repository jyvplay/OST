# Whiteboard (TT23)

An Excalidraw / Miro-class infinite canvas.

* Engine: `src/lib/whiteboard-core.ts` (pure, Node-testable).
* UI: `src/components/modules/Whiteboard.tsx`.
* Native file format: `.fboard` (`fusion-board-1` JSON). Files opens these in the Whiteboard.

## What works

| Area | Behaviour |
|---|---|
| Drawing | Tools: rectangle, ellipse, diamond, sticky note (6 colours), text, line, arrow, freehand pen. Shapes are created by drag, or by click for a default size. Pen strokes are simplified with Ramer–Douglas–Peucker, so corners are kept and jitter is dropped. 10-unit snap can be toggled. |
| Connectors | A line or arrow end dropped on a shape **binds** to it. Bound ends are not stored as coordinates; they are re-resolved on every render to the point where the line meets the shape's true outline (rect edge, ellipse equation, diamond \|x\|/a + \|y\|/b = 1). Dragging a shape drags its connectors. Ends can be dragged to re-bind or detach. Deleting a shape detaches its connectors at their last point. Duplicating keeps bindings only inside the copied set. |
| Selecting | Click, shift-click, marquee (only fully-enclosed elements). Hit testing uses real outlines, so a click inside an ellipse's bounding box but outside the ellipse falls through to what is underneath. A group selects as one. |
| Arranging | Move, resize (4 corner handles; pen strokes scale), duplicate, delete, z-order (to front/back, forward/backward), group/ungroup, align ×6, distribute horizontally/vertically. |
| Text | Double-click, or Enter, edits text in place (multi-line). Ctrl+Enter or clicking away commits; **Escape cancels**. Text can also be edited in the side panel. An empty text element is removed. |
| View | Pan (Pan tool, middle button or wheel), zoom 20–400 % (Ctrl+wheel around the pointer, +/− buttons, keys + − 0), Fit. |
| History | Exact undo/redo over immutable snapshots (100 steps). A drag is one step. |
| Files | Save `.fboard`; reopen from Files or a path. The strict loader refuses unknown element kinds, non-finite geometry and other formats. It repairs dangling bindings, bad colours and duplicate ids, and reports the repair count. **Export SVG** writes a standalone SVG: text is escaped, colours are whitelisted, and there is no script, event handler or foreign content. |
| Keyboard and access | Tool letters: V (select), H (pan), R, O, D, S, T, L, A, P. Arrows nudge (Shift ×10). Delete; Ctrl+Z/Y/D/A/G (Shift+G ungroups); [ ] change z-order; Escape. The **Layers** list is a full keyboard and screen-reader route to every element, with plain-language names such as "Arrow from Ideas go here to Next step". The canvas has `role=application` with a live description. |

The board surface is always light: it is document content, like a page in Writer, so it keeps its colours in every
style and theme. The chrome around it follows the theme. Canvas text scales with **zoom**, not with the UI text-size
setting, the same rule as the Vector module's document text.

## Honest scope (not done)

* No real-time multi-user editing.
* No images, embeds or frames.
* No rotation.
* No curved or elbow connectors; no connector labels other than text on the line.
* No auto-wrapped text (explicit line breaks only).
* Groups are one level deep.
* SVG export only (no PNG or PDF); no Excalidraw or Miro import.
* Drawing a *new* shape needs a pointer. Everything else works from the keyboard.
* Not tested with a screen reader.

## Verification

* `scripts/whiteboard-engine.mts` (9 tests), with expected values worked out by hand:
  * boundary points (rect/ellipse/diamond);
  * connectors following a moved shape;
  * delete/duplicate binding integrity;
  * hit testing on true outlines;
  * marquee;
  * align/distribute/z-order/groups;
  * RDP simplification;
  * SVG escaping and colour-injection neutralising;
  * the `.fboard` round-trip being byte-identical;
  * hostile files refused or repaired;
  * the 5000-element cap;
  * sticky colour contrast.
* `scripts/e2e-whiteboard.mts` (7 tests), using real pointer and keyboard input in Chromium:
  * drawing every kind;
  * an arrow binding to two shapes and following a dragged shape;
  * the keyboard route;
  * marquee + align + group;
  * save / reopen / export / hostile file;
  * axe in 3 states (0 serious).
* Screenshots: `docs/screenshots/tt23-whiteboard.png`, `docs/screenshots/tt23-whiteboard-large.png` (200 % text).
