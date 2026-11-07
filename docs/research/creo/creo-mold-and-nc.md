# PTC Creo: Mold Design and NC (CAM)

Second Creo page (after the [Sketcher](creo-sketcher.md)). Written in our own words from the
public Creo Parametric 11-13 help. Creo is volume-based for moulds: you build **mold volumes**
and **parting surfaces**, then split the workpiece into core, cavity and sliders. That differs
from VISI (split the part, then build parting faces) and NX (check regions, then define regions),
and is worth comparing before we build our parting module.

## 1. Mold Design

### Command set (Mold tab), grouped as Creo groups it

| Group | Commands | Notes for us |
| --- | --- | --- |
| Reference model and workpiece | Locate / assemble / create reference model; **automatic workpiece** (offsets from the part, or overall size); assemble / create workpiece | Automatic workpiece = our "insert block from part + offsets" |
| Modifiers | **Shrink by scale**, **shrink by dimension** (per-dimension), pattern the reference model, classify components | Shrink by dimension is a nice extra over uniform scale |
| Design features | **Silhouette curve**, **pull direction**, draft line | |
| Parting surface and volume | **Parting surface** (general surfacing tools), **classify surfaces** (core / cavity / slider), refpart cutout, mold volume, **shape volume** (build a volume on one side of the parting surface from classified surfaces), **volume split** (split workpiece / volume / components into one or two), attach volumes, rename, remove | |
| Components | **Cavity insert** (turn a volume into a solid part), assemble / create mold component, **create molding** (the moulded part as the tool fills), catalog (ejector pins, workpieces), mold base components, **solid split**, **shadow cut** (trim a workpiece with a quilt), component operations | |
| Production features | **Water line** (sketch path, size, name), **runner** (sketch, shape, size, flow path, direction), trim to geometry, **ejector pin hole** | |
| Analysis | **Mold opening** (define opening steps, check draft and interference while it moves), **thickness check**, **projected area**, mold analysis (min waterline clearance, draft check), **parting surface check** (contour problems, self-intersection), shrinkage information | |
| Layout | Mold layout assembly (multi-cavity) | |
| View | Mold display (show/hide components, parting surfaces, volumes), blank / unblank geometry, temporary shade | |

### Silhouette curve and skirt surface (Creo's split line)
* A **silhouette curve** is made on the reference part where its surface is normal to the pull
  direction; it can be several closed loops including inner loops, and is a valid parting line.
  A separate variant handles undercuts.
* A **skirt surface** is a parting surface made automatically from that curve: the outer loop is
  **extended out to the workpiece** boundary (extend-curve controls how each segment runs out),
  and inner loops are **filled** (shut-offs, "fill loops", with an offset control).
* **Parting surface check** finds contour problems and self-intersections before splitting.

### Multi-cavity layout (procedure)
1. Make the mold model (reference part + workpiece).
2. Create a mold layout assembly; **Locate cavity**: pick the mold model and a population rule:
   **single, rectangular, circular or variable**; set positions.
3. Optional: mold base, injection machine.
4. Back in Mold Design: parting surfaces and volumes, split the workpiece, other cavity parts.
5. Optional per-cavity differences via family-table instances (exchangeable inserts).
6. Finish: runners, waterlines, ejector pin holes, ejector pins from the catalog.

### Ejector pin clearance holes (procedure)
1. Ejector Pin Hole. 2. Placement: **linear** (offsets from two planes), **radial** (offset from
an axis + angle), **coaxial** (on an axis), or **on point** (many holes as one feature, on
datum points). 3. Pick placement points. 4. Location and direction from the placement plane.
5. Pick plates to pass through (auto or manual). 6. Hole diameter per plate (defaults offered).
7. Counterbore diameter and depth. 8. OK: all holes regenerate as one feature.

**For us:** "on point" with per-plate clearance diameter and a counterbore is exactly the
ejector clearance tool to build: pick points on the core, choose plates, one feature.

### Ideas to take from Creo Mold
1. **Mold opening** simulation as an analysis: steps (move component A along Z by n, then B),
   with draft and interference checks during the movement.
2. **Classify surfaces** into core / cavity / slider as a separate step from splitting (like
   NX regions). Our draft-colour faces can feed this directly.
3. **Skirt** = silhouette + run-off to workpiece + fill inner loops, in one command.
4. **Create molding**: show the part as the empty space the tool would fill (quick check that
   core + cavity close properly).
5. **Projected area** and **thickness check** in the same analysis group.

## 2. Creo NC (CAM)

### Milling sequence types
| Sequence | What it does |
| --- | --- |
| Face | Square off the top of the stock |
| **Volume rough** | 2.5-axis layered removal of a defined volume |
| **Roughing** | High-speed removal of everything inside a mill window |
| Plunge rough | Repeated plunges for deep cavities |
| **Re-rough** | Only what earlier roughing could not reach |
| **Local milling** | Clean up leftovers from earlier sequences (smaller tool), or named corners |
| Surface milling | 3-5 axis on chosen surfaces, several cut definitions |
| Conventional milling | 3-5 axis at a set tool angle |
| Profile milling | Vertical or angled walls |
| **Finishing** | Final detail after roughing / re-roughing |
| **Corner finishing** | Pencil cleanup of corners a ball mill missed |
| Pocketing | 2.5-axis pockets (walls like profiling, floors like volume) |
| Swarf | 5-axis side-of-tool cutting |
| Trajectory / custom trajectory | Tool along a curve, or along an interactively built path |
| Engraving | Follow a groove or curve |
| Thread milling | Helical threads |
| Drilling / **auto drilling** | Drill, bore, tap; auto drilling takes chosen holes with a coordinate system or retract plane |

### Parameters (named groups: Cut option, Cut param, Feed, Machine, Entry/Exit)
* Cut: **STEP_DEPTH**, **STEP_OVER**, **ROUGH_STOCK_ALLOW**, **PROF_STOCK_ALLOW** (must be
  ≤ rough), **BOTTOM_STOCK_ALLOW** (floors parallel to retract plane; default follows profile
  stock), SCAN_TYPE (several patterns, spiral, one direction), CUT_TYPE (climb, upcut, zig-zag),
  corner round radius and smoothing for HSM, corner slowdown.
* Feed: cut feed (default for others left blank), arc feed, traverse feed, ramp, approach, exit.
* Machine: spindle speed, spindle sense.
* Entry/exit: CLEAR_DIST (rapid ends here, plunge feed starts), PULLOUT_DIST, approach / exit
  distance and feed, lead in / out arcs.
* A dash means "inherit a default", which keeps parameter tables short.

### Negative stock (electrodes)
Negative stock allowance is allowed for **electrode milling**. Volume, local, conventional,
contour and pocket accept a negative value limited by the tool corner radius; profile and
trajectory accept any negative value. **For us:** confirm the same limit applies in our 3D
engine (a ball tool can't go below -R without the offset surface degenerating).

### Material removal
Creo simulates the removed material per sequence automatically from the sequence's geometry, or
you model it yourself as a cut. That is Creo's in-process stock.

### Ideas to take from Creo NC
1. Sequence list maps cleanly onto ours: Face, Rough (adaptive), Re-rough (rest), Finish (steep
   and shallow), Corner finish (pencil), Pocket, Profile, Drill / Auto drill, Thread, Engrave.
2. Parameter names in **one flat table with "inherit" (dash)** values. Pairs well with NX-style
   inheritance in the operation tree.
3. **Separate floor stock** from wall stock, and the rule that finish stock ≤ rough stock.

## Sources

* Mold user interface (Creo 13): <https://support.ptc.com/help/creo/creo_pma/r13/usascii/mold_and_casting/mold/About_the_Mold_User_Interface.html>
* Silhouette curves: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/mold_and_casting/mold/About_Creating_Silhouette_Curves.html>
* Skirt surfaces: <https://support.ptc.com/help/creo/creo_pma/r11.0/usascii/mold_and_casting/mold/About_Skirt_Surfaces.html>
* Multi-cavity mold: <https://support.ptc.com/help/creo/creo_pma/r11.0/usascii/mold_and_casting/mold/To_Create_a_Typical_Multi_Cavity_Mold.html>
* Ejector pin clearance holes: <http://support.ptc.com/help/creo/creo_pma/usascii/mold_and_casting/mold/To_Create_Ejector_Pin_Clearance_Holes.html>
* Milling NC sequences: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/manufacturing/nc/about_milling_nc_sequences.html>
* Milling parameters: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/manufacturing/nc/milling_parameters.html>
* Negative stock allowance: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/manufacturing/nc/to_specify_negative_stock_allowance.html>
* Automatic material removal: <https://support.ptc.com/help/creo/creo_pma/r12/usascii/manufacturing/nc/about_automatic_material_removal.html>
