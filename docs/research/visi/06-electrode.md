# EDM electrodes (VISI Electrode, compared with NX, PowerShape and Cimatron)

MATHEW's shop does EDM electrode work, so this area matters early. VISI's public pages give the
shape of the workflow; Autodesk PowerShape's online help (Electrode Wizard) and Cimatron's help
give the detailed options. All three agree on the same pipeline, which is what we should build.

## The common pipeline

1. **Burn region**: faces of the core/cavity the electrode must burn.
2. **Burn direction** (extraction vector).
3. **Extension** of the burn faces up/out to clear the part.
4. **Blank / base** (stock size, material, datum corner).
5. **Holder** (from a library, or sized).
6. **Spark gap / undersize** per stage (rough, semi, finish) and orbit.
7. **Positions**: one electrode burnt at several places, including mirrored copies.
8. **Checks**: collision along the burn direction, burn area (projected and 3D).
9. **Outputs**: electrode solid exported in its own workplane, setup sheet, EDM data file, link to CAM.

## VISI Electrode (what the product pages say)

* Burn area: enclose the area with a 2D or 3D boundary, or pick faces.
* Shape body ("nose"): guided build; extend **vertically or tangentially**; open-sided electrodes
  can be pulled out in several directions; animation and collision check at any time.
* Base and body added interactively: name, material, burn type, ID marks, edge chamfers (datum
  corner), position, rotation. All stored and written to an HTML report.
* Holder: by width/depth/height or from a library; can be offset from the electrode centre to
  clear neighbouring walls.
* **EDM manager**: workpiece, electrodes, multiple positions, vertical / horizontal / angled
  simulation, collision checks, HTML report and EPX output. 2023.1 improved electrode origin
  handling and mirrored copies; 2024.3 lets you work with solid groups and mirrored electrodes.
* Stock definition options (2023.1): **colour contact faces** and **mark edges**.
* Export each electrode in its own workplane as IGES, STEP or STL; send to VISI Machining with
  machining templates applied per electrode group.

## PowerShape Electrode Wizard (detailed options)

**Burn region page**
* Selection method: single face, **concave region**, **convex region** (by surface normals).
  Hover highlights a candidate region; click selects; Shift/Ctrl/box add or remove.
* Direction: +Z by default (from the workplane), principal axes, or manual vector by A (XY
  rotation) and B (angle from vertical; 90 = side sparking), or a face normal.
* Trace region with a closed curve as fallback; divide a face to take part of it.

**Extension page**
* Extension distance, Z and XY scale.
* Methods: **normal to edge**, **grow to box** (square flat sides on open ribs), follow surface
  internals, **align vertically** (keeps tangency), split surface along normal with angle.
* Clearance distance from a reference: above block, above extension, above burn region, above
  burn Z min. Negative clearance trims the base to avoid the part ("offset base electrode").
* Draft angle on the extension to strengthen thin electrodes.
* Preview runs a collision check.

**Blank page**
* Standard blank from a list that fits, or user defined: rectangular or round, length, width /
  diameter, height; base height; minimum machined thickness; material (copper, graphite grades).
* **Auto-rotate** about Z to fit the smallest blank.
* **Datum**: pick datum face and position on it; datum XYZ rounded to 0.1 mm for EDM setup.

**General page**: name + counter (auto-increment), collision gap between base and part,
**spark gap (undersize)**, orbit type, fill-in surfaces over holes in the burn region, setup
sheets (electrode detail per electrode, and a GA sheet of all electrodes).

**Family page**: rough / semi / finish from one model, each with undersize, quantity, material;
presets: minimum (keeps sharp corners), standard (machine-maker table by material), user
defined (save as default).

**Finish / Exit / Cancel**: finish at any page with current values; exit keeps what was made;
cancel removes everything.

## Cimatron EDM setup (extra parameters)

Per electrode: name, comment, material, **burn area 2D (projected) and 3D**, location count.
Per stage (rough, semi-finish, finish, polish): quantity, orbit type, orbit size, spark gap,
offset (undersize actually machined), material, holder.

## NX Electrode Design

Auto-find and colour faces by process (EDM, wire, mill, grind); associative electrode heads that
update when the core/cavity changes; undersize for spark gap with circular, square, spherical or
custom orbits; interference check and sparking area calculation; swap design versions and update
electrodes, drawings and toolpaths.

## Takeaways for our app

We already import VISI STEP files with their layers and colours, and MATHEW has a bank-electrode
skill in this project. A first Electrode tab:

1. Pick burn faces (filter = Faces, concave/convex region grow, tangent flow), pick direction
   (active workplane Z by default).
2. Extend: vertical extrude of the boundary to a clearance height, with "grow to box" option.
3. Blank: rectangular from a stock list, auto-rotate, datum corner chamfer, base height.
4. Unite into one solid; collision check by sweeping along -direction (OCCT boolean common).
5. Spark gap per stage stored as data (not modelled), quantities, material.
6. Positions: list of placements (XYZ + C rotation) in the part's workplane, with mirrored copies.
7. Outputs: STEP of the electrode in its own frame, a setup sheet (HTML/PDF) with positions,
   burn area, spark gaps, and a CSV for the EDM.

Sources: <https://hexagon.com/products/visi-electrode-design>,
<https://visi.nexnet.cz/visi-electrode.html>, PowerShape help (workflow
<https://help.autodesk.com/cloudhelp/2022/ENU/PWRS-ReferenceHelp/files/GUID-1E6BC31F-9291-4EF8-B6FD-448D3D6F2F9D.htm>,
region <https://help.autodesk.com/cloudhelp/2022/ENU/PWRS-ReferenceHelp/files/GUID-64ABD051-5756-4D60-9107-0C239CC182BF.htm>,
extension <https://help.autodesk.com/cloudhelp/2022/ENU/PWRS-ReferenceHelp/files/GUID-5977D9AD-5590-443B-8C83-F70B5B3D02A8.htm>,
blank <https://help.autodesk.com/cloudhelp/2022/ENU/PWRS-ReferenceHelp/files/GUID-87F1FD6A-CD32-4D88-B0F6-7988B1EC85C3.htm>,
general <https://help.autodesk.com/cloudhelp/2022/ENU/PWRS-ReferenceHelp/files/GUID-9519C86A-C1DF-479E-AE94-200F62194035.htm>,
family <https://help.autodesk.com/cloudhelp/2022/ENU/PWRS-ReferenceHelp/files/GUID-D3AE2C04-9F75-448E-980B-7C44F1561791.htm>),
Cimatron <https://help.cimatron.com/en/2026/edm_setup_electrode.htm>, NX
<https://www.siemens.com/en-gb/products/nx-manufacturing/tooling-fixture-design/electrode-design/>.
