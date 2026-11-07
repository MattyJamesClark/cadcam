# Autodesk Fusion: what to borrow

Fusion's help is public (help.autodesk.com/view/fusion360), so the CAM detail here is solid.
Fusion is a general product-design tool with a strong CAM module (the old HSMWorks engine). It has
little mould or die tooling, so its value to us is **selection, inspect tools and CAM**.
Autodesk's tooling CAD is **PowerShape**; its Electrode Wizard is written up on the
[electrode page](../visi/06-electrode.md).

## 1. Interaction model

* **Timeline** (history) along the bottom; history can be switched off for direct modelling.
  *(general knowledge)*
* **Marking menu**: right-click gives a radial menu of common commands plus a short list.
  **S** opens a searchable shortcut box. *(general knowledge)*
* **Press Pull**: one command that picks the right action for what you click (face = offset,
  edge = fillet, profile = extrude). *(general knowledge)* A nice "do what I mean" pattern for our
  Move face.
* Dialogs show selection inputs at the top, each with a count and an X to clear.
  *(general knowledge)*

### Selection
* Click to select; **Shift or Ctrl+click** adds.
* **Click and hold** opens a **"select other" list** of everything under the cursor, ordered by
  **depth**, or by **parent** in the tree. *Very useful for picking a hidden face or a body
  behind another. We should add this (long-press or Alt+click).*
* **Selection filters**: a tick list of types: bodies, body edges, body faces, body vertices,
  components, sketch curves, points, profiles, work geometry, mesh bodies, mesh faces,
  mesh face groups, features, joints, dimensions...
* **Select through**: when on, window/freeform selection also takes hidden items behind others.
* **Selection priority**: a one-click mode that turns on a single filter (components, bodies,
  faces, edges) and turns the others off; click again to restore. Same as our VISI palette
  click-for-one behaviour.
* **Selection modes**: **window** (drag left to right: only fully enclosed), **crossing**
  (right to left: anything touched), **freeform** lasso (same direction rule), **paint**
  (drag over items to pick them).

*For us: window vs crossing by drag direction, lasso, paint, select-through, and select-other
are all missing and cheap to add with three-mesh-bvh.*

### Construction geometry (= workplanes)
Planes: offset, at angle (about an edge/axis), tangent to a cylinder, **midplane** between two
faces, perpendicular, through two edges, through three points, **along a path** (at a distance
along an edge chain).
Axes: through cylinder/cone/torus, perpendicular to face at point, two planes, two points,
along edge.
Points: at vertex/snap, two edges, three planes, centre of circle/sphere, edge and plane,
along path.

*For us: add midplane, at angle about an edge, and along path to our plane creation.*

## 2. Inspect tools

| Tool | Inputs | Output |
| --- | --- | --- |
| Measure | 1-2 picks | Min distance, angle, area, position; click a value to copy it |
| Section analysis | Plane, offset distance, angle, flip | Live cut view; saved in the browser |
| Interference | Bodies / components | Table of clashes; can make bodies from them |
| Centre of mass | Objects | Glyph you can measure from |
| Curvature comb | Edges | Comb plot |
| Curvature map | Body, Gaussian / min / max, limits | Colour gradient |
| **Draft analysis** | Bodies, direction, start/stop angle, optional **tolerance zone** band, opacity, quality | Continuous gradient, up to ±90 deg |
| Zebra | Body | Stripes for continuity |
| Isocurve | Faces, type, count, comb density | UV curves |
| **Accessibility** | Body, direction | Green reachable, red not (3-axis check) |
| **Minimum radius** | Body | Concave faces under a radius shown red (smallest cutter) |

*For us: draft (with a tolerance band), section view, accessibility and minimum radius all come
from the same per-face normal and curvature data. Do them as one "Analysis" family.*

## 3. CAM (Manufacture)

### Setup
* **Operation type**: milling, turning, cutting, additive.
* **WCS orientation**: model orientation; pick Z + X; pick Z + Y; pick X + Y (each axis
  flippable); or an existing coordinate system. Z must point away from the face being cut.
* **Origin**: model origin, selected point, **stock box point**, model box point (a corner,
  centre top, etc.).
* **Model**: which bodies to machine. **Fixtures**: bodies treated as clamps (collision in
  simulation). **Accessibility analysis** toggle.
* **Stock**: fixed size box (W/D/H, model position X/Y/Z: left/centre/right, front/centre/back,
  top/centre/bottom; round up to nearest), **relative size box** (no offset / sides and
  top-bottom / each side), fixed or relative **cylinder** and **tube**, **from solid** (e.g.
  forging), from bounding solid, **from preceding setup** (rest machining between setups).

### Toolpath dialog tabs (same five tabs for every strategy)
1. **Tool**: tool from library, coolant, feeds and speeds (rpm or surface speed; cutting,
   lead-in, lead-out, ramp, plunge; per tooth), **shaft and holder** collision: off / pull away /
   detect tool length / fail, with clearances.
2. **Geometry**: machining boundary (none, bounding box, **silhouette**, selection), tool
   containment (inside / centre / outside) with offset, contact-point boundary, **slope
   range** (from/to angle), **rest machining** (source: previous ops, a tool, file, solids,
   setup stock; ignore stock less than), tool orientation, **surface manager** (machine, avoid,
   ignore, fixture per face).
3. **Heights**: clearance, retract, top, bottom (each from stock top, model top, selection, with
   offset).
4. **Passes**: tolerance, stepover, direction (climb/conventional, one-way/both), stock to leave
   radial and axial (**negative stock allowed, e.g. for electrode spark gap**), fillets,
   smoothing (arc fit), feed optimisation at corners, strategy-specific values.
5. **Linking**: retraction policy (full / minimum / shortest), high-feed mode, safe distance,
   max stay-down distance, lead-in/lead-out radii, transition type (none / straight / shortest /
   smooth), ramp type and angle, entry positions.

### Strategies worth copying first
* **2D**: face, 2D adaptive, pocket, 2D contour (with multiple depths and finishing passes),
  slot, trace, bore, circular, thread, chamfer (deburr), drill.
* **3D**: **adaptive clearing** (constant engagement roughing), pocket clearing, **steep and
  shallow** (contour on steep, parallel or scallop on shallow, one op; threshold angle, overlap,
  wall clearance), contour (waterline), parallel, **scallop** (constant stepover offsets),
  pencil (corners), horizontal (flats), ramp, spiral, radial, morph, project, flow, blend.
* **Hole recognition**: finds cylinders on any plane (option to include partial holes),
  assigns an action per hole (spot, drill, counterbore, bore, tap, ream; override allowed), makes
  several operations per hole, uses a **hole template** editor.
* **Feature recognition** (2022 docs): holes, slots, bosses, pockets, sides, faces, chamfers,
  draft.

### After the toolpath
* Simulate with stock (material removal, collisions with holder and fixtures, colour by
  operation or comparison to model). *(general knowledge)*
* **Post process** with a JavaScript post library (open format, thousands of machines).
  *(general knowledge)*
* **Setup sheet** (HTML) with tools, ops, times. *(general knowledge)*
* **Templates**: save operations as a template and apply to another part.

## 4. What Fusion does better (ideas to take)

1. **Same five tabs** for every toolpath (Tool, Geometry, Heights, Passes, Linking). Easy to
   learn; build our CAM dialogs on this skeleton.
2. **Stock point and origin from the stock box** (top-centre, corner).
3. **Negative stock to leave** for spark gap when machining electrodes.
4. **Select other** list under the cursor.
5. Window vs crossing by drag direction.
6. Accessibility and minimum-radius analysis.
7. Open JavaScript post-processor format. Autodesk posts are not ours to copy; write our own
   post engine with a simple template format and a few common controls (Fanuc, Heidenhain,
   Haas, Mazak), plus user-editable posts.

Sources:
* Selection filters: <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION-FILTERS.htm>
* Selection priority: <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION-PRIORITY-FILTERS.htm>
* Selection modes: <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION-MODES.htm>
* Select objects: <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECT-OBJECTS.htm>
* Construction geometry: <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-CONSTRUCT-TOOLS.htm>
* Inspect tools: <https://help.autodesk.com/view/fusion360/ENU/?contextId=SLD-INSPECT-TOOLS>
* Draft analysis: <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-F372F1AF-71F1-499D-AA1F-712E57C89806.htm>
* Setup tab: <https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-REF-SETUP-MILL.htm>
* Stock tab: <https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-REF-SETUP-STOCK.htm>
* Scallop reference: <https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/GUID77067110-3D88-4DA7-B171-6B27F04CF8B3.htm>
* Steep and shallow: <https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-REF-3DM-STEEP-SHALLOW>
* Hole recognition: <https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/LP-READ-IRONHOLERECOGNITION.htm>
* Recognisable features: <https://help.autodesk.com/cloudhelp/2022/ENU/FCAM/files/GUID-EA13655C-5F00-4670-9857-5F0CA86E5EF7.htm>
