# VISI Machining (2D, 3D, 5-axis) and PEPS-Wire

## Shared CAM structure

* **Operation tree**: operations and tools in a tree, drag to reorder.
* **Multiple origins** (work offsets) for indexed/multi-side work.
* **Tool library**: tools, holders, extensions, adapters, feeds/speeds, offsets; tool life
  tracking with sister tools.
* **Cutting data** suggested from workpiece material + tool material (feed, speed, stepover,
  chip thickness).
* **Templates**: save a sequence of operations and re-run it on a similar part (e.g. every
  electrode in a group).
* **Stock**: pre-machined blank or casting is recognised; cut only where stock remains.
* **Simulation**: solid verification of material removal, surface finish, warning on rapid
  into stock; kinematic simulation with machine model, holder, clamps.
* **Post processors**: large library, configurable; canned drilling cycles, subprograms,
  arc output, cutter comp.
* **Reports**: HTML / XLS setup sheet (work offset, tools, conditions, times, allowances).
* 2024.3: colours show which geometry is ready for machining; **face lists built automatically
  from face colours**; dialogs only show parameters for the chosen strategy; the model manager
  shows which operations use each geometry; stock analyser shows rest material; nested pocket
  ordering.
* 2023.1: Add Operation groups strategies as Standard / Expert / Superseded.

## 2D / 2.5D

* **Feature recognition** of holes (diameter, depth, type) and pockets directly from the solid.
  Plates in mould and die tools are recognised and get drilling and milling automatically.
* Hole cycles: spot, drill, tap, ream, bore, helical mill, thread mill, hole milling. Avoids
  clamps automatically.
* Profiling: direction, approach/lead, number of depth passes, cutter comp, ramped or stepped,
  rest corners with a smaller tool.
* Pocketing: spiral or zigzag, multi-level, islands of different heights, drafted walls, floor
  radii, side and floor allowances, open pockets entered from outside.
* Facing: spiral/zigzag, islands.
* 2.5D: extrude/revolve/wrap a profile to make simple 3D paths; chamfer and edge rounding;
  thread milling.

## 3D

* Roughing: constant-Z, **adaptive** (trochoidal, constant engagement, step-up rest passes),
  residual (rest) roughing; helical/ramp entry.
* Finishing: ISO (along surface parameters), flat area, **3D equidistant (constant scallop)**,
  spiral, radial, **parallel planes** with steep/shallow angle split and cross pass,
  **constant Z** with auto step on steep walls plus shallow areas in the same op, hybrid
  constant Z with pocket passes on shallow areas, curve driven, 3D curve (engraving).
* Rest machining with smaller tools, linking nearby areas.
* HSM: smoothed corners, arc lead-outs, feed adapting to load, multi-core calc, batch overnight.
* Holder collision: warns and reports the tool length needed; only cuts what the holder clears.

## 5-axis

3+2 positional for 2D and 3D ops; continuous strategies for deep cores (tilt to shorten tool),
impeller/blisk, deburring along a curve; **convert 3D paths to 5-axis** with auto tilt away from
collisions; axis limits; kinematic machine simulation.

## PEPS-Wire (wire EDM)

* 2-axis and 4-axis; 4-axis straight from solids; sync lines for deep dies.
* Feature recognition: holes, open/closed openings, constant or variable taper, die lands and
  chamfers. Features go into a tree with method + technology.
* Variable taper corner modes: sharp, conical, constant radius.
* **Bridges (tabs)** placed automatically near start holes; separate safe distance for bridge
  cut.
* Strategies: attended day vs unattended night; rough with bridges then remove before finish, or
  keep bridges to the end; power ramp on lead-in/out; secondary wire; small moves to avoid
  witness marks.
* M-codes for stop, generator on/off, wire cut/rethread at any point; auto rethread.
* Multiple start holes per part, from CAD points or rules.
* Simulation on a solid with clamps, check part can drop out, compare with target, show rest.
* Post library by machine maker.

## Takeaways

CAM is the biggest module and our main differentiator against free CAD tools. Order:
1. Setup (stock box, work offset = workplane), tool library, operation tree, post to G-code.
2. 2D: drilling from recognised holes (OCCT cylinder faces), profile, pocket, face.
3. 3D: constant-Z rough + rest, constant-Z finish, parallel finish with steep/shallow split,
   3D scallop. Use a proven open engine where licence allows (e.g. OpenCAMLib, LGPL, for drop
   cutter and waterline) rather than write it all.
4. Simulation (dexel/heightfield stock in WebGL) and setup sheet.
5. Wire EDM 2-axis for punch apertures; 4-axis taper later.

Sources: <https://visi.nexnet.cz/visi-machining-2d.html>,
<https://visi.nexnet.cz/visi-machining-3D.html>,
<https://visi.nexnet.cz/visi-machining-5-axis.html>,
<https://visi.nexnet.cz/visi-peps-wire.html>, release history
<https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>.
