# PTC Creo: Sketcher (for our Sketch tab)

Creo's help is public at support.ptc.com (MATHEW asked to add it on 2026-11-06). This page
covers the **Sketcher** first, because the Sketch tab is being built now. It is written in our
own words from the Creo Parametric 12 help pages listed at the end. Creo's sketcher is the
best-known example of **"always solved" sketching**: the sketch is fully constrained at every
moment by the system, and you replace system guesses with your own values.

## 1. The core idea: weak and strong

| Kind | Who makes it | Look | Behaviour |
| --- | --- | --- | --- |
| **Weak** dimension / constraint | The system, automatically, as you draw | Grey / lighter | Fills whatever is needed to keep the sketch fully defined. Can **disappear** when you add, move or delete other geometry or dimensions |
| **Strong** dimension / constraint | You (you typed a value, added it, or "strengthened" a weak one) | Normal colour | Stays until you delete it. Never silently removed |

* Editing a weak dimension's value makes it strong. You can also **strengthen** a weak one
  without changing its value.
* Help advice: strengthen the weak dimensions you want to keep before leaving the sketch.
* Values become rounded to the default decimal places when strengthened (option, on by default;
  default 2 decimals for lengths, 1 for angles).
* **Auto-scale**: the first time you edit a weak dimension in the first sketch of a model, the
  whole sketch scales proportionally to match (on by default). So you can draw roughly at any
  size and type the first real value.
* Locked dimensions: a lock stops a dimension changing when geometry is dragged. Optional
  auto-lock for dimensions you create or modify (off by default); locks have their own colour.
  A dimension used in a relation ignores its lock.

**For us:** this is the big decision for the Sketch tab. Either SolidWorks-style (under-defined
sketch, blue/black, user adds everything) or Creo-style (system keeps it solved with weak
dimensions). A middle path that suits toolmakers: draw freely, show the **degrees of freedom
left** (colour), and offer weak dimensions as **ghost suggestions** that one click makes strong.
The solver (SolidCraft's sketch crate) has to report remaining DOF either way.

## 2. Constraint inference while drawing (Intent Manager)

* As the cursor moves within tolerance of a constraint, it **snaps**, a small symbol appears next
  to the entity, and the related geometry is highlighted.
* **Mouse and keys while a constraint is offered:**

| Input | Effect |
| --- | --- |
| Left click | Accept the offered constraint and place the point |
| Right click once | **Lock** the offered constraint and keep moving (e.g. keep it horizontal while you choose the length) |
| Right click twice | **Disable** the offered constraint for this entity |
| Right click three times | Re-enable it |
| **Tab** | Cycle between several active candidate constraints, to lock or disable one |
| Hold **Shift** | Turn off constraint snapping (and model snapping) for this action. When dragging existing geometry, Shift turns snapping **on** |
| Middle click or Esc | End the tool / abort |

* Each inferred constraint type can be switched off in options. Defaults on: collinear, equal
  length, equal radii, midpoint, parallel, perpendicular, point on entity, same point,
  symmetric, tangent, horizontal and vertical line-up. Default off: alignment.
* Snap sensitivity is a setting (default very high). Snapping to model edges/surfaces and grid
  snap are off by default.

**For us:** copy this exactly. Right-click lock / double right-click disable / Tab to cycle /
Shift to suppress is fast and fits our "right-click accepts" rule (here it accepts the
*constraint*, not the command). Show the symbol glyph at the cursor.

## 3. Constraints

| Constraint | Applies to |
| --- | --- |
| Vertical | A line, or two vertices |
| Horizontal | A line, or two vertices |
| Perpendicular | Two entities |
| Tangent | Two entities |
| Midpoint | A point at the middle of a line or arc |
| Coincident (align) | Points; also point on entity, collinear |
| Symmetric | Two points about a centerline |
| Equal | Lengths, angles, radii, curvature (two or more entities). Equal on a group of weak dimensions replaces them with an "E" mark |
| Parallel | Two or more lines |

* Constraint tools run in **continue mode** (stay active for the next pick).
* Constraints can be selected, deleted or **explained** (Explain highlights the entities a
  constraint ties together).
* Overlapping constraint symbols are **stacked**; right-click the stack to cycle, click to
  highlight the geometry.

## 4. Conflicts: the Resolve Sketch dialog

When a new or strengthened dimension/constraint conflicts with or duplicates existing **strong**
ones, the conflicting items are highlighted and a dialog offers:

* **Undo**: go back to just before the action (no redo).
* **Delete**: pick one of the highlighted items to remove.
* **Dim > Ref**: turn a highlighted dimension into a reference (driven, not driving).
* **Explain**: pick an item to see why it is involved.

**For us:** never refuse silently. Highlight the clashing set and offer these four choices in
the bottom prompt strip (our VISI-style prompt area), not a modal.

## 5. Dimensions

* Tools: **Normal** (linear, radius, diameter, angle, conic, ordinate, chosen by what you pick),
  **Perimeter** (total length of a chain), **Baseline** (all measured from the first pick),
  **Reference** (driven, can be toggled back to normal).
* Workflow: start the tool (or right-click > Dimension), pick one or two entities,
  **middle-click to place** the dimension where the cursor is. Continue mode.
* Edit one: double-click the dimension, type, Enter.
* Edit many: window-select dimensions, Modify: a list of all values with
  **Regenerate** (solve after each change, or only on OK), **Lock scale**, and a sensitivity
  slider. Useful so a big change doesn't flip the sketch inside out mid-edit.
* Dimensions can go to geometry, construction, reference entities and centerlines (between a
  centerline and an entity; a revolve diameter uses a centerline).

## 6. Drawing tools

Lines (line, **line chain**), rectangles (corner, centre; slanted and parallelogram in newer
versions), circles (centre, concentric, 3-point, 3-tangent in the full list), arcs (**3-point /
tangent end**, centre and ends, conic), ellipses (axis ends, centre and axis), splines,
**fillets** (circular, elliptical), chamfers, text, **centerlines** (construction axes for
mirror and symmetry), points, coordinate systems, **offset**, **thicken** (offset both sides
and close the ends), **project** (bring model edges into the sketch as linked entities, by
single / chain / loop).

* Each tool: click to place the first point; the next point follows the cursor (rubber-band);
  click to place. Line chain keeps going until middle-click.
* Point picks snap to model edges/curves/surfaces near the cursor; Shift disables for one pick.
* **Construction mode** toggle (tab or mini toolbar): anything drawn while on is construction.
* Editing (names from the tool set): **delete segment** (click a segment, or drag a path across
  several; it trims back to the nearest intersections), **corner** (trim/extend two entities to
  meet), **divide** (split an entity at a pick), **mirror** (about a centerline), **rotate and
  resize** (move, rotate, scale a selection with handles), modify (dimensions dialog above).
* Projected/offset composite curves keep stable IDs when the referenced edge chain changes.

## 7. Sketch diagnostics (display toggles)

* **Shade closed loops**: fill every closed region with a colour.
* **Highlight open ends**: mark endpoints not joined to anything.
* **Highlight overlaps** and **intersections**, highlight junctions.
* **Feature requirements**: a checklist of what the feature needs from the sketch
  (e.g. "a single closed loop") with pass/fail.
* Info on an entity, intersection point, tangency point.

**For us:** shaded closed loops and open-end markers should be **on by default** in our Sketch
tab; they answer "why won't it extrude?" instantly. Feature requirements = the check our Extrude
/ Pocket commands run before they accept a sketch.

## 8. References and setup

* A sketch has a **sketch plane** and an orientation reference; Sketcher can open looking
  straight at the plane (option).
* **References**: model geometry the sketch dimensions to (edges, faces, datums). Creo asks for
  enough references to place the sketch, can create them automatically from picked background
  geometry, and has update / remove / replace for missing ones. Hold **Alt** to pick background
  geometry as a reference while a tool is active.

**For us:** the sketch plane = our active workplane (VISI style). Projected edges as references
let a pocket sketch follow the part.

## 9. Palette

Library of ready shapes on tabs (polygons, profiles, shapes, stars) stored as section files in a
folder; drop one in, it auto-scales, then move, rotate and resize; its own strong dimensions and
constraints come with it. Users add their own shapes by saving sketches into the folder.
**For us:** a "symbols" folder with standard slots, keyways and
polygons.

## 10. Recommendations for the Sketch thread

1. Solver must report **DOF left** per entity; colour under-defined geometry.
2. Inference with **right-click lock, double right-click disable, Tab cycle, Shift suppress**.
3. **Middle-click places a dimension**; double-click edits; multi-edit list with "solve on OK".
4. **Conflict strip**: highlight the clash, offer Undo / Delete / Make reference / Explain.
5. **Shade closed loops** and **open ends** on by default.
6. **Auto-scale on first dimension** (huge time saver when sketching roughly).
7. Weak dimensions as optional ghosts (decide with MATHEW: VISI users are used to drawing exact
   values directly with typed input, so typed values while drawing matter more than weak dims).
8. Delete segment by click or drag path; corner; divide; mirror about centerline; offset and
   thicken; project edges.

## Sources (Creo Parametric 12 help unless noted)

* About Sketcher Constraints: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_Sketcher_Constraints.html>
* Available Constraints: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/Available_Constraints.html>
* About Using Constraints (inference keys): <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_Using_Constraints.html>
* To Resolve a Conflict: <https://support.ptc.com/help/creo/creo_pma/r12/usascii//part_modeling/sketcher/To_Resolve_a_Conflict.html>
* About Dimensioning: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_Dimensioning.html>
* About the Dimension Tools: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_the_Dimension_Tools.html>
* To Create Dimensions (basic): <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/To_Create_Dimensions__basic_.html>
* To Modify Dimension Values: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/To_Modify_Dimension_Values.html>
* Locked and Unlocked Dimensions: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_Locked_and_Unlocked_Dimensions.html>
* Creating Entities: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_Creating_Entities_in_Sketcher.html>
* Line Chain: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/Line_chain_sk.html>
* Diagnostic Tools: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_Sketcher_Diagnostic_Tools.html>
* References: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_References.html>
* Palette: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/About_the_Sketcher_Palette.html>
* Configuration options (defaults): <https://support.ptc.com/help/creo/creo_pma/r12/usascii/part_modeling/sketcher/Sketcher_Configuration_Options.html>
* Glossary: <https://support.ptc.com/help/creo/creo_pma/r11.0/usascii/part_modeling/sketcher/Sketcher_Glossary.html>
* Project and offset enhancements: <https://support.ptc.com/help/creo/creo_plus_early_visibility/usascii/whats_new/sketcher_enhancements_project_and_offset.html>
* Delete segment (Creo Simulate 7 sketcher): <https://support.ptc.com/help/creo/creo_sim/r7.0/usascii/sim/simulate/sketcher/To_Delete_a_Segment.html>
* Creo help home (MATHEW's link): <https://www.ptc.com/en/support/help/creo>

Note: the editing tools in section 6 (corner, divide, mirror, rotate and resize, and drag-path
delete) are named from Creo's tool set and general knowledge of it; their help pages weren't
read tonight. Creo Mold (mold design) is next on the Creo list, after the sketch work.
