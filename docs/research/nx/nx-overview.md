# Siemens NX: what to borrow

NX's full help (docs.sw.siemens.com) needs a Siemens account, so this page is built from public
Siemens blogs, white papers, university tutorials and the public NX Open API reference (which
lists the real option names). Items marked *(general knowledge)* come from familiarity with
NX rather than a page fetched tonight; check them in NX before relying on detail.

## 1. Interaction model

### Dialogs and mouse
* **MB1** select, **Shift+MB1** deselect.
* **MB2 (middle click) = OK / next step**; held MB2 rotates. *(general knowledge)*
* **MB3** = context menu; press-and-hold MB3 = **radial menu** of quick actions; MB3 on a
  selection opens selection-filter choices.
* Dialogs have **OK / Apply / Cancel**. Apply keeps the dialog open for the next one (like VISI
  command repeat). Each input in a dialog is a "select step" with a status icon; the active
  step is highlighted, and MB2 moves to the next step. *(general knowledge)*
* **Command finder** search box: finds, explains, runs, and shows where a command lives.

### Selection bar (top of graphics)
* **Type filter** (Feature, Body, Face, Edge, Curve, Point, Datum, Component...).
* **Selection scope**: entire assembly / within work part / within work part and components.
* **Selection intent (rules)**: a drop-down that changes how one click grows into a set. The API
  lists the rule set; the useful ones for tool & die:

| Face rules | Edge / curve rules |
| --- | --- |
| Single face | Single curve / edge |
| **Tangent faces** (grow over smooth edges) | Connected curves |
| **Region faces** (seed face + boundary faces; grow until boundary) | **Tangent curves** |
| Body faces | Face edges |
| Feature faces | Sheet boundary edges |
| **Adjacent faces** / face and adjacent | Body edges |
| **Boss / pocket faces** | Vertex edges / vertex tangent edges |
| **Hole faces**, slot faces, rib faces | Feature curves |
| All blend faces, **connected blend faces** | Intersection curves |
| Merged rib | **Stop at intersection**, **follow fillet** toggles |

  *For us: add a "grow" rule to our selection bar next to the type filter: Single, Tangent,
  Region (seed + boundary), Adjacent, Hole/Boss, All blends. That is exactly what electrode burn
  faces and parting face sets need.*

* **Snap point toolbar** (the "wheel" of snaps): end, mid, control, intersection, centre,
  quadrant, existing point, point on curve, point on face, knot, pole, facet vertex, bounded
  grid. Each can be on/off. "Inferred" picks the best snap under the cursor.
* **Point dialog** (when a point is needed): type list (inferred, cursor, existing, end, control,
  intersection, arc centre, angle on arc, quadrant, on curve, on face, between two points, by
  expression) plus typed XYZ relative to **WCS or Absolute**, and an offset option. *(general
  knowledge)*

### Coordinate systems
* **Absolute CS** (fixed) and **WCS** (work coordinate system, one, movable).
* **Dynamic WCS**: drag the origin (snaps to corners and midpoints along edges), drag an arrow to
  move along one axis, drag a ball between axes to rotate (click a ball to type an angle), click
  an axis then an edge or face to align that axis to it. MB3 then OK to finish. "Set WCS to
  Absolute" resets.
* **Datum CSYS** features are saved frames (like VISI saved workplanes).
* In CAM the **MCS** (machine CS) is separate from the WCS.

*For us: our active workplane = WCS. Add the dynamic triad handles (drag origin with snaps,
drag arrow, drag ball to rotate, click axis then edge to align). That is the drag-based version
of our current move/rotate strip.*

## 2. Synchronous (direct) modelling

Works on any body, imported or native, with no history:

| Command | Behaviour |
| --- | --- |
| Move face | Pick faces; drag arrow/angle handles or type distance/angle |
| Pull face | Move a face along its normal, changing adjacent faces |
| Offset region | Offset faces by a distance, neighbours follow |
| **Replace face** | Replace face set A with face set B (make two faces coplanar etc.) |
| **Delete face** | Remove faces and heal; holes, blends, bosses disappear |
| **Resize hole / blend / chamfer** | Pick one; **Face finder > find clone** collects identical holes to edit together |
| Resize pattern | Pick one face of a pattern; NX finds the pattern; change count and pitch |
| **Radiate face** | Offset faces normal to a revolve axis (shrink, stock, fits) |
| Make coplanar / coaxial / tangent / symmetric / parallel / perpendicular / offset | Geometric relations between faces |
| Linear / angular dimension on faces | Drive a face by a dimension |
| Pattern face, mirror face, copy/cut/paste face | |
| **Face finder** | During any of the above: also pick faces that are coplanar, coaxial, equal radius, tangent, symmetric, parallel, perpendicular to the selected ones |

*For us: OCCT has BRepOffsetAPI_MakeOffset (offset faces), BRepAlgoAPI_Defeaturing (delete face
and heal) and BRepTools_ReShape. "Delete face", "offset faces", "move face" and "find similar
holes" are high-value for imported customer models.*

## 3. Mold Wizard

**Workflow (in toolbar order):**

1. **Initialise project**: product body, project path/name, **material** (sets shrink factor,
   e.g. 1.0045) or manual shrink. Add more products for a **family mould**.
2. **Mold CSYS**: place the product in the mould frame without changing the product file.
3. **Shrinkage**: uniform, axisymmetric, or general (per axis).
4. **Workpiece** (insert block): default "user defined block" sized by offsets from the part;
   from existing solid or a workpiece library. Shown translucent.
5. **Layout**: cavity count and arrangement (multi-cavity).
6. **Check regions**: body + draw direction + calculation settings.
   * Face tab: draft analysis colours, finds undercut faces and edges; separate A-side and
     B-side draft thresholds; categories: drafted cavity side, under-drafted cavity side,
     drafted core side, under-drafted core side, vertical, undercut.
   * Region tab: parting loops, inner loops, parting edges, incomplete loops.
   * Assign faces to cavity or core (colour orange / blue). Goal: **no undefined faces**.
7. **Patch surfaces**: close through-holes and windows where core and cavity must meet (shut-
   offs) before defining regions.
8. **Define regions**: cavity region, core region, plus extra regions for slides and lifters.
   Options "create regions" and "create parting lines".
9. **Design parting surface**: extend continuous surfaces from the parting line through the
   workpiece (extrude, sweep, extend, bounded plane per segment), split by transition points.
10. **Define cavity and core**: split the workpiece; preview; **reverse normal** if core and
    cavity swap.
11. **Mold base library** (DME, Hasco, Futaba, LKM...), **standard parts** (screws, pins,
    location ring, sprue bush), **ejector pins** with **post-processing**: trim to the core
    surface, adjust length, or untrim; fit distance and offset.
12. **Slides and lifters** library (associative), **cooling** (channel patterns, plugs, o-rings),
    **gates and runners**.
13. **Pocket** (create cavity in plates for all standard parts in one go).
14. Validation: wall thickness, undercuts, corner radii, clearances, **electrode requirement
    analysis**, motion simulation with collision.
15. BOM, drawings, NC.

## 4. Progressive Die Wizard / Engineering Die Wizard

* Sheet metal recognition turns an imported model into a parametric sheet part.
* Maps part features to 50+ process feature types (pierce, trim, form, bend...).
* **Blank generation** (one-step formability), **blank layout** with multiple parts and rows,
  live **material utilisation**.
* **Scrap design**: split the trim area into scrap pieces that each become a punch.
* **Strip layout**: assign operations to stations, simulate, compute **force centre** and press
  force.
* Die base library, 10+ insert group types, standard part libraries, clearance in plates.
* Associative drawings; design rules held in spreadsheets (company knowledge base).

## 5. Electrode design

Auto-identify faces by process and colour them (EDM, wire, mill, grind); electrode head and
blank, associative to core/cavity changes; undersize for spark gap with **circular, square,
spherical or custom orbit**; interference check and **spark area** calculation; swap a design
version and update electrodes, drawings and toolpaths.

## 6. NX CAM

* **Operation navigator** with four views of the same operations: **Program order**, **Machine
  tool** (by tool), **Geometry** (MCS > WORKPIECE > ops), **Machining method** (rough / semi /
  finish with stock and tolerances). Parameters are **inherited** down the tree.
* Geometry: MCS, WORKPIECE = part + blank + check geometry; auto blank for prismatic parts.
* Tools: flat, ball, bull nose; diameter vs smallest inside corner rule.
* Main 3-axis ops: **Cavity mill** (rough; follow part / follow periphery / zig-zag; stepover %
  of flat; common depth per cut; cut levels; cut order depth/level first; IPW = use 3D to only
  cut leftover), **Z-level** (steep finishing), **Fixed contour** (drive methods: boundary,
  area, streamline, flow cut; scallop stepover), **Planar mill** and **Floor wall**, **Face
  mill**, hole making (feature-based).
* Stock: part side stock, floor stock; intol/outtol.
* Non-cutting moves: from/start point, clearance plane, engage/retract.
* Status icons: red = needs generate, yellow = generated not posted, green tick = posted.
* Verify: replay, **3D dynamic material removal with IPW colour**, **gouge check**.
* Output CLSF (neutral cutter location) then **post-process** to G-code with a machine post.

## 7. What NX does better than VISI (ideas to take)

1. **Selection intent rules** next to the type filter.
2. **Face finder** in direct edits (find clone holes, coplanar faces).
3. **Dynamic WCS** drag handles.
4. **Check regions**: one dialog that both analyses draft and assigns core/cavity faces, with a
   live count of undefined faces.
5. **Inheritance in the CAM tree** (method groups hold stock/tolerance; ops inherit).
6. **Status icons** on CAM operations.

Sources:
* Siemens Design Center blog, Mold Wizard: <https://blogs.sw.siemens.com/designcenter/getting-started-with-mold-wizard-nx-tips-and-tricks/>
* Swoosh Technologies, NX10 Mold Wizardry part 3: <https://www.swooshtech.com/2016/03/30/nx10-mold-wizardry-part-3/>
* Siemens core/cavity white paper: <https://www.plm.automation.siemens.com/en_sg/Images/3014_tcm963-4308.pdf>
* NX Progressive Die Wizard white paper: <https://www.plm.automation.siemens.com/en_us/Images/wp_nx_prog_die_wizard_tcm1023-4504.pdf>
* NX Electrode Design: <https://www.siemens.com/en-gb/products/nx-manufacturing/tooling-fixture-design/electrode-design/>
* Synchronous modelling blog: <https://blogs.sw.siemens.com/designcenter/designcenternx-synchronous-modeling/>
* NX Open selection intent rule list: <https://nxopencsdocumentation.thescriptingengineer.com/NX2022_1/NXOpen.SelectionIntentRule.RuleType.html>
* NX Open snap types: <https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/nxopen_net/class_n_x_open_1_1_infer_snap_type.html>
* NX Open ejector post-processing: <https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/nxopen_python_ref/NXOpen.Tooling.EjectorPostProcessingBuilder.html>
* TU Darmstadt NX tutorial, dynamic WCS: <https://www.iim.maschinenbau.tu-darmstadt.de/CAD-Tutorial/3_basics_in_nx/7_navigation_and_display/4_dynamic_wcs/index.en.html>
* NX cheat sheet: <https://jmorris335.github.io/assets/files/NX_Cheat_Sheet.pdf>
* NX 12 CAM tutorial chapter: <https://me5763.github.io/lab/assets/books/NX12_Tutorial_CH9.pdf>
* Mold Wizard overview (Designfusion): <https://designfusion.com/mold-wizard-v2>
