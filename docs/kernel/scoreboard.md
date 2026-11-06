# Kernel stress-test scoreboard

The classic ways CAD kernels fail, run against plain OpenCascade (**raw**: the call a
naive program would make) and our layer over it (**ours**, `kernel/robust.hxx`). Generated
by `node kernel/scoreboard.mjs` from the shipped WebAssembly kernel, so the times are the
app's own. Cases live in `kernel/stress.hxx`.

* ✅ **pass**: both work.  🔧 **fixed**: raw OpenCascade fails or gives a broken result, ours is right.
* 💬 **clear error**: impossible (or not solved yet), and we say why in plain English, naming the edge or face (shown red in the app).
* ❌ **fail**: wrong result or a vague error. Still to do.

Build: `em3-legacy, link -O3, O1 files: extra/ShapeCustom_BSplineRestriction.o extra/ShapeUpgrade_ShapeDivide.o`, 2026-11-06, 74 cases in 57.9 s.

| | Count |
| --- | --- |
| ✅ pass | 54 |
| 🔧 fixed by our layer | 7 |
| 💬 clear error | 12 |
| ❌ fail | 1 |
| Raw OpenCascade alone correct | 54 of 74 |


## Fillet

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **F1** Cube, all 12 edges r2 (three fillets meet at every corner) | ✅ pass | ok, 12 ms | ok, 14 ms | direct |
| **F2** Cube corner, three edges with radii 1, 2 and 3 meeting at one vertex | ✅ pass | ok, 13 ms | ok, 12 ms | direct |
| **F3** L-block, concave + convex edges meeting at the inner corner r2 | ✅ pass | ok, 18 ms | ok, 21 ms | direct |
| **F4** Boss on a plate: round base (concave) and top (convex) edges r2 | ✅ pass | ok, 2 ms | ok, 3 ms | direct |
| **F5** Slot: rolling-ball r2 round a tangent chain (line, arc, line, arc) | ✅ pass | ok, 2 ms | ok, 5 ms | direct |
| **F6** Slot: variable radius 1 to 3 along a tangent chain | ✅ pass | ok, 14 ms | ok, 44 ms | direct |
| **F7** Fillet bigger than the faces beside it (r25 on a 20 mm plate) | 💬 clear error | not done (4 ms) | 0 ms | “A 25 mm fillet won't fit on the 4 mm straight edge (edge 1): the faces beside it only leave room for 20 mm.” |
| **F8** Full round: r5 on both top edges of a 10 mm rib (the fillets use up the whole top face) | 🔧 fixed | not done (1 ms) | ok, 39 ms | corner profile as a boolean; needed: corner profile as a boolean |
| **F8b** Fillets that would overlap: r6 on both top edges of a 10 mm rib | 💬 clear error | not done (1 ms) | 42 ms | “The fillet fails on the 40 mm straight edge (edge 12). The largest radius that fits there is about 4.88 mm.” |
| **F9** Fillet as tall as the wall: r4 on one top edge of a 4 mm bar (uses up the side face) | 💬 clear error | not done (2 ms) | 0 ms | “A 4 mm fillet on the 40 mm straight edge (edge 10) runs off the end: the flat face (face 1) where the edge ends is only 4 mm across there. Use under 4 mm, or round that face's edges too.” |
| **F10** Fillet just under the wall height: r3.9 on a 4 mm bar | ✅ pass | ok, 1 ms | ok, 2 ms | direct |
| **F11** T pipe: r2 on the saddle edge where two cylinders meet | ✅ pass | ok, 13 ms | ok, 56 ms | direct |
| **F12** Sphere scooped from a box: r2 on the plane / sphere edge | ✅ pass | ok, 3 ms | ok, 13 ms | direct |
| **F13** Lofted (freeform) block: r1.5 round the twisted top | ✅ pass | ok, 159 ms | ok, 164 ms | direct |
| **F14** Pyramid apex: r1 on four edges meeting at one point | ✅ pass | ok, 33 ms | ok, 26 ms | direct |
| **F15** Fillet on a smooth (tangent) edge | 💬 clear error | exception: There are no suitable edges for chamfer or fillet (0 ms) | 0 ms | “the 8 mm straight edge (edge 1) is already smooth (its faces meet tangentially), so there's nothing to round” |
| **F16** Big job: r0.5 on 100 hole edges at once | ✅ pass | ok, 147 ms | ok, 238 ms | direct |
| **F17** Rounded block: r1 round the whole top (a tangent loop of lines and arcs) | ✅ pass | ok, 3 ms | ok, 7 ms | direct |
| **F18** Cube corner with radii 1, 1 and 8 meeting at one vertex (very different sizes) | ✅ pass | ok, 3 ms | ok, 5 ms | direct |
| **F19** Thin-walled cup: r0.9 on both rim edges of a 2 mm wall (fillets nearly meet) | ✅ pass | ok, 13 ms | ok, 16 ms | direct |
| **F20** Thin-walled cup: r1 on both rim edges of a 2 mm wall (full round rim) | 💬 clear error | not done (10 ms) | 208 ms | “The fillet fails on the 30 mm straight edge (edge 2). The largest radius that fits there is about 0.97 mm.” |

## Chamfer

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **C1** Cube, all 12 edges 1 mm | ✅ pass | ok, 8 ms | ok, 10 ms | direct |
| **C2** Two distances (1 x 3) on one edge | ✅ pass | ok, 1 ms | ok, 2 ms | direct |
| **C3** Distance 2 at 30° on one edge | ✅ pass | ok, 2 ms | ok, 3 ms | direct |
| **C5** C5 | ❌ fail |  (0 ms) | 0 ms | “kernel crashed: null function or function signature mismatch” |
| **C6** Shelled box (3 mm walls): 2 mm chamfer on an outside corner | ✅ pass | ok, 3 ms | ok, 9 ms | direct |
| **C4** Chamfer deeper than the plate (6 mm on a 4 mm plate) | 💬 clear error | not done (2 ms) | 0 ms | “A 6 mm chamfer won't fit on the 20 mm straight edge (edge 10): the faces beside it only leave room for 3.99 mm.” |

## Shell

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **S1** Box 2 mm walls, top open | ✅ pass | ok, 6 ms | ok, 7 ms | direct |
| **S2** Box 0.05 mm walls (very thin), top open | ✅ pass | ok, 5 ms | ok, 6 ms | direct |
| **S3** Wall thicker than the box is wide (12 mm on 20 mm), closed | 💬 clear error | not done (5 ms) | 0 ms | “A 12 mm wall leaves no room inside: the body is only 20 mm across at its thinnest.” |
| **S4** Rounded box (r4 corners), 2 mm walls: walls thinner than the rounds | ✅ pass | ok, 11 ms | ok, 17 ms | direct |
| **S5** Rounded box (r1 corners), 2 mm walls: walls thicker than the rounds (inner corner collapses) | 🔧 fixed | not done (10 ms) | ok, 51 ms | intersection mode; needed: intersection mode |
| **S6** Box with all edges r1, 2 mm walls, top open (every fillet tighter than the wall) | 🔧 fixed | wrong result: volume 23924.1 outside 3000..9000 (3 ms) | ok, 95 ms | sharp inside corners (rounds tighter than the wall); needed: sharp inside corners (rounds tighter than the wall) |
| **S7** Cylinder cup, 1 mm walls, top open | ✅ pass | ok, 2 ms | ok, 3 ms | direct |
| **S8** Hollow sphere (closed, no faces open), 2 mm | 🔧 fixed | wrong result: volume 24429 outside 9076.3..9086.3 (0 ms) | ok, 3 ms | offset and cut; needed: offset and cut |
| **S9** Lofted block (freeform faces), 1.5 mm walls, bottom open | ✅ pass | ok, 601 ms | ok, 598 ms | direct |
| **S12** Box with two r8 fillets meeting at a corner, 3 mm walls, top open (found in the app) | 🔧 fixed | wrong result: volume 237852 outside 35677.7..95140.6 (11 ms) | ok, 151 ms | hollow, then open the faces; needed: hollow, then open the faces |
| **S11** Box with a through hole, 2 mm walls, top open (wall round the hole too) | ✅ pass | ok, 8 ms | ok, 9 ms | direct |
| **S10** T pipe, 1 mm walls, all three ends open | ✅ pass | ok, 5 ms | ok, 41 ms | direct |

## Offset

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **O1** Grow a cube by 2 mm (rounded edges and corners) | ✅ pass | ok, 7 ms | ok, 15 ms | direct |
| **O2** Shrink a cube by 2 mm | ✅ pass | ok, 5 ms | ok, 6 ms | direct |
| **O3** Grow a lofted (freeform) solid by 1 mm | ✅ pass | ok, 11 ms | ok, 43 ms | direct |
| **O4** Thicken a wavy freeform surface by 2 mm | ✅ pass | ok, 7 ms | ok, 8 ms | direct |
| **O5** Thicken a saddle (doubly curved) surface by 1 mm | ✅ pass | ok, 2 ms | ok, 7 ms | direct |
| **O6** Thicken a tightly rippled surface by 3 mm (ripples tighter than the thickness) | 💬 clear error | wrong result: invalid B-rep (11 ms) | 1.1 s | “The faces couldn't be thickened by 3 mm: they curve more tightly than that somewhere, or fold back on themselves.” |
| **O7** Shrink a block with r1 corners by 2 mm (the rounds collapse to sharp corners) | 🔧 fixed | not done (8 ms) | ok, 106 ms | sharp corners where rounds collapse; needed: sharp corners where rounds collapse |
| **O8** Grow a block with a 3 mm slot by 2 mm (the slot closes up) | 🔧 fixed | not done (14 ms) | ok, 39 ms | intersection mode; needed: intersection mode |

## Draft

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **D1** Cube, four sides 3° about the base | ✅ pass | ok, 6 ms | ok, 3 ms | direct |
| **D2** Rounded block: draft one flat wall that runs tangent into round corners | ✅ pass | ok, 3 ms | ok, 6 ms | direct |
| **D3** Draft the top face (it faces along the pull) | 💬 clear error | exception: Standard_ConstructionError (0 ms) | 0 ms | “the flat face (face 6) faces straight along the pull direction, so it can't be drafted (it would tilt sideways). Draft the side walls instead.” |
| **D5** Rounded block: all walls and corner rounds 2° (a mould core) | ✅ pass | ok, 3 ms | ok, 6 ms | direct |
| **D4** Cylinder wall 5° (becomes a cone) | ✅ pass | ok, 1 ms | ok, 1 ms | direct |

## Boolean

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **B1** Two boxes sharing a whole face (coincident faces), add | ✅ pass | ok, 3 ms | ok, 4 ms | direct |
| **B2** Two boxes sharing part of a face, offset, add | ✅ pass | ok, 4 ms | ok, 4 ms | direct |
| **B3** Flush cut: pocket whose top is level with the top face | ✅ pass | ok, 3 ms | ok, 3 ms | direct |
| **B4** Near-coincident: second box 0.00001 mm into the first, add | ✅ pass | ok, 6 ms | ok, 7 ms | direct |
| **B5** Near-coincident gap: second box 0.00001 mm away, add (should stay 2 bodies or join) | ✅ pass | ok, 1 ms | ok, 2 ms | direct |
| **B6** Cylinder lying tangent on a box face (line contact), add | ✅ pass | ok, 3 ms | ok, 4 ms | direct |
| **B7** Sphere touching a box at one point, add | ✅ pass | ok, 2 ms | ok, 3 ms | direct |
| **B8** Same-radius coaxial cylinders end to end (coincident round faces), add | ✅ pass | ok, 4 ms | ok, 4 ms | direct |
| **B9** A body added to an identical copy of itself | ✅ pass | ok, 3 ms | ok, 3 ms | direct |
| **B10** Sliver faces: cutter rotated 0.001° off the top face | ✅ pass | ok, 4 ms | ok, 5 ms | direct |
| **B14** Hole touching the side wall from inside (r5 hole, centre 5 mm from the wall) | ✅ pass | ok, 5 ms | ok, 6 ms | direct |
| **B15** Cylinder exactly on a fillet's round face (coincident curved faces), add: nothing should change | ✅ pass | ok, 9 ms | ok, 11 ms | direct |
| **B16** Box standing on its edge on another box's face (line contact), add | ✅ pass | ok, 3 ms | ok, 4 ms | direct |
| **B11** Cut that removes the whole body (should say so, not return nothing) | 💬 clear error | wrong result: 0 solids, expected 1 (2 ms) | 1 ms | “The cut removes the whole body” |
| **B12** Cut splitting a body in two (must keep both pieces) | ✅ pass | ok, 5 ms | ok, 6 ms | direct |
| **B13** Edit faces on a box + cylinder Add result: pull the round face out 2 mm (the 'box vanished' bug) | ✅ pass | ok, 4 ms | ok, 7 ms | direct |

## Tolerance

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **T1** 60 booleans in a row with near-miss edges: still valid, tolerances still tight | ✅ pass | ok, 1.7 s | ok, 2.7 s | tidy after every step; max tolerance 1.5e-07 mm |

## Import

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **I1** STEP with corner points nudged 0.002 mm (faces don't quite meet) | ✅ pass | ok, 44 ms | ok, 8 ms | direct |
| **I2** STEP with a face missing from the shell | 💬 clear error | wrong result: 0 solids, expected 1 (5 ms) | 15 ms | “The body has a hole in it (a face is missing), so it came in as a surface body: the body has gaps between its faces, so it stays a surface body” |
| **I3** STEP file cut off half way | 💬 clear error | not done (1 ms) | 1 ms | “The file couldn't be read: it is cut short or isn't STEP.” |

## Speed

| Case | Result | Raw OpenCascade | Ours | What we did / said |
| --- | --- | --- | --- | --- |
| **P1** Plate with 400 holes, cut in one go | ✅ pass | ok, 850 ms | ok, 1.3 s | one boolean, all tools |
| **P2** Plate with 100 holes, cut one at a time | ✅ pass | ok, 1.7 s | ok, 3.2 s | 100 booleans |
