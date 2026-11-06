# Selection, side toolbar and Translate

MATHEW's spec (2026-11-06): selection is the core of the software, so it comes first. Everything should look the same and respond instantly, with no animations.

## Box selection (`core/boxselect.ts`)

- Hold the left button and drag. **Left to right** (solid box) takes only items wholly inside. **Right to left** (dashed box) takes anything it touches. The sketcher already used this convention.
- **Shift** (or Multi-select) adds to the selection, **Ctrl** takes items out, and a plain box replaces the selection.
- The box follows the selection filter. With bodies or surfaces on, it takes whole bodies. Otherwise it takes the points, edges or faces inside it. Faces turned away from the view are skipped.
- Hidden items are skipped. Items behind other items are still taken, as in VISI.
- `boxSelect()` and `BoxRubber` are shared, so any command that needs a set uses the same code. Translate already does.

Point snapping (`pickAt`) also looks at corners of bodies next to the one under the pointer, and just off the model. A corner on a body's outline can now be picked even when the pointer is a pixel outside it.

## Side toolbar (`core/sidebar.ts`)

- The toolbar is always on screen on the right of the view, under the view cube. It never moves or animates.
- With no command running it shows the **Tools** layout: Fit all and Measure, Translate and Rotate, Delete, then CAM and Plotview. CAM and Plotview are greyed out until they are built.
- A command calls `showSideLayout({ title, rows })` to replace those buttons with its own while it runs. It uses `handle.flyout(el)` to show typed-value boxes to the left of the toolbar.
- Every movement command uses the same shape. The top row holds the main modes (Single, Multiple copies), the next row holds Incremental, and the row after that sets how points are picked (Point, Midpoint).

## Translate (`core/translate.ts`)

- The command starts straight away and needs no selection first. Click a point on a part and that part follows the pointer. Click where it goes and it moves there, as one undo step.
- Targets snap to corners, centres, quadrants and midpoints, to edges and faces, and to **datum origins** (Absolute and the work planes). Off the model, the target is the point on the plane through the first point.
- Build a set first with a drag box (which adds), **Shift+click** to toggle one body, or **Ctrl+box** to take bodies out. Then click the from point and the to point, and the whole set moves together.
- **Multiple copies** leaves the originals where they are and makes N copies, each one step further. The N box is in the flyout.
- **Incremental** (key **I**) opens the X / Y / Z flyout along the active work plane, with **Reverse** and **Apply**, plus the XYZ drag handle. In this mode, two clicks fill in the boxes instead of moving the part.
- **Midpoint** (key **M**) uses the point halfway between two clicks. Switch back to Point for the target.
- **Enter** or the tick applies the move. **Backspace** or the back arrow undoes the last pick. **Esc** cancels.
- The options (mode, incremental, point mode, copies) are remembered for the rest of the session.

## Next

- Move Rotate onto the same layout (single, copies, incremental angle flyout, pick axis by two points).
- Delete and copy on a box-selected set already work. A "Copy" (Ctrl+C-style) command could use the same from/to flow.
- Sketches and dimensions don't move with Translate yet. Only bodies (solids, surfaces, wireframes) do.
