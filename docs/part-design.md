# Part Design

The Part Design tab makes and combines solids. It works the VISI way: direct modelling, one undo
step per command, no feature tree. Sketches keep their constraints and dimensions, so a profile
can be changed and used again.

## Commands

| Command | What it does |
| --- | --- |
| Extrude | Closed profiles straight out along the sketch normal. Distance (arrow handle or typed, negative goes the other way), Flip, Both sides (half each side), Through all (cut right through the target), Draft ° (positive narrows away from the sketch). |
| Revolve | Profiles round an axis. The axis is the sketch's only centreline if it has one; otherwise click a sketch line, or use Sketch X / Y. Angle (ring handle or typed), 360 / 180 / 90, Flip. A profile may touch the axis but not cross it. |
| Sweep | A profile carried along a path: click a curve in another sketch and everything joined to it end to end is the path (lines, arcs, or a circle). The profile keeps its place relative to the path with no twist, so draw it where the path starts. |
| Extrude cut, Revolve cut, Sweep cut | The same commands starting in Cut mode. Extrude cut starts with Through all on and aims into the body. |
| Add, Cut, Intersect | Booleans between bodies. The first body picked is the target (it keeps its name and place in the tree); the rest are tools and are used up unless Keep tools is on. Bodies already selected are used straight away. |

Extrude, Revolve and Sweep each have a mode: **New body**, **Add**, **Cut** or **Intersect**. The
target is found for you (the body the new shape meets); click another body to change it. Extrudes
aim away from the target when adding and into it when cutting, until you flip or drag them.

## How it works

* Profiles come from `sketch/profiles.ts` `findRegions()`. By default the outermost regions are
  picked (a plate with its holes, not the hole fillings); click regions to add or remove them.
* The instant preview (`part/preview.ts`) carries every loop of the profile through a list of
  placements (straight out, round the axis, along the path with rotation-minimising frames) and
  caps the ends. It is pure JS, so it follows a drag with no lag.
* The exact solid comes from the kernel's `solid()` call (`kernel/cadkernel.cpp`): faces from the
  profile loops, then `BRepPrimAPI_MakePrism` (plus `BRepOffsetAPI_DraftAngle`),
  `BRepPrimAPI_MakeRevol` or `BRepOffsetAPI_MakePipeShell`, then `BRepAlgoAPI_Fuse / Cut / Common`
  with the target and `ShapeUpgrade_UnifySameDomain` to merge split faces. The work is done in the
  target body's own frame, so moved bodies are fine.
* Used sketches are hidden (in the same undo step). Running a command with no sketch on screen
  picks up the last hidden one.

## Next

Fillet and chamfer edges (the kernel already has TKFillet), shell, holes, draft on faces, offset
start for extrudes ("from a face / up to a face"), patterns of bodies, and sketching straight on a
face.
