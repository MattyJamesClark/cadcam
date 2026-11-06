# The kernel's robust layer

The CAD kernel is OpenCascade 7.9 compiled to WebAssembly (`kernel/cadkernel.cpp`). OpenCascade is
capable but brittle: a fillet meeting a corner badly, a boolean on faces that touch, or a shell
over a tight round either fails with no reason, or worse, hands back a broken or half-empty solid.
VISI runs on Parasolid, so that is the bar. Our answer is a layer of our own between the app and
OpenCascade, `kernel/robust.hxx`, that every modelling operation goes through:

1. **Pre-checks** catch the impossible cases before any work, in plain English, naming the edge or
   face (the app shows it red): a fillet wider than the faces beside it, an edge that is already
   smooth or is a seam, a wall thicker than the body, a draft on a face that points along the pull.
2. **The direct OpenCascade call.**
3. **A gate on the result.** Valid B-rep (ShapeFix gets one go), no solid lost, and a volume that
   makes sense for the operation (a fuse can't be smaller than its biggest input; a shell holds
   about area × wall of material; an offset adds about area × distance). This catches OpenCascade
   quietly returning the wrong thing, the "box vanished" kind of bug.
4. **A retry ladder** when the gate refuses: other blend shapes, healed input, fuzzy tolerances for
   near-coincident faces, gluing for faces lying on each other, other offset join modes, and
   alternative algorithms of our own:
   * *corner profile as a boolean* for fillets / chamfers on straight edges between flat faces,
     which works when the fillet uses up a whole face (full rounds, fillets as tall as the wall);
   * *one edge at a time* for corners where several blends meet;
   * *sharp inside corners* for shells and offsets where rounds are tighter than the wall: the
     rounds are taken off (defeaturing), the sharp body offset, and the result cut from the
     original. This is the classic case OpenCascade gets wrong;
   * *offset and cut* for closed hollows.
5. **Tidy-up**: split faces merged, tolerances pulled back (stops tolerance creep over many ops).
6. **When nothing works**: which edges / faces failed, and the largest size that does fit there.

## Stress tests

`kernel/stress.hxx` holds the classic ways kernels fail (fillets at vertices, tangent chains,
fillets bigger than faces, thin and curved shells, freeform offsets, coincident / tangent /
near-coincident booleans, slivers, tolerance creep, broken STEP files, big models). Each runs
plain OpenCascade and our layer, and checks the result's validity, solid count and volume.

* The kernel CI build runs them on the wasm it just built and commits
  [scoreboard.md](scoreboard.md) / `scoreboard.json` beside it.
* Natively, for quick work on the layer: build OpenCascade 7.9.3 static on Linux, then
  `kernel/stress-native.sh <occt src> <occt build> stress && ./stress [id or group]`.
* In the app's kernel worker: `Module.stressTest('')` returns the same rows as JSON.
