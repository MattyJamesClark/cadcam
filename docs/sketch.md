# Sketch module

2D constrained sketching on the active work plane. Modelled on the sketcher in
[SolidCraft](https://github.com/tangency-labs/solidcraft) (MIT / Apache-2.0):
same data model (shared points, circles owning a radius, arcs as centre + two
ends), a Levenberg–Marquardt solver with a minimum-motion step, per-group
solving, rank analysis for degrees of freedom, and closed-profile detection.
The code here is our own TypeScript, written after their design.

Code: `src/renderer/src/sketch/` (model, solver, geom, profiles, editor, tools,
ops, render, dimgeom) and `src/renderer/src/modules/sketch/`.

## Stage 1 (built)

- New sketch on the active work plane; edit again from the tree (double-click);
  ✓ / Enter finishes, ✗ throws away the edits since it was opened. Sketches are
  saved in the project file and every change is one undo step.
- Draw: line chains (L), centreline, point, construction toggle (X),
  rectangle (R), centre rectangle, 3-point rectangle, slot, polygon (corners or
  flats), circle (C), 3-point circle, centre-point arc (A), 3-point arc,
  tangent arc. Typing a number fills the tool's box (length, Ø, width...).
- Snaps: ends, centres, midpoints, quadrants, crossings, on-curve, model
  corners; lining up with other points, level / upright lines. Each snap adds
  its relation. Shift turns snapping off.
- Relations from the strip that appears for the selection: coincident, on
  curve, midpoint, horizontal, vertical, parallel, perpendicular, collinear,
  tangent, equal, concentric, symmetric, fix. Redundant or conflicting ones are
  refused with a message. Glyphs show for hovered / selected geometry (G or
  Show relations for all); click a glyph, Delete removes it.
- Smart dimension (D): length, Ø / R, point distances (true / horizontal /
  vertical by where the text goes), point–line, centre distances, angles.
  Value box plus a drag arrow; double-click a dimension to change it; an
  over-defining dimension becomes a reference one. The first dimension scales
  the whole sketch (as in Creo).
- Modify: trim (T), extend (E), fillet, chamfer (keep a virtual sharp),
  offset chains (O, one driving distance, drag arrow), mirror (symmetric).
- Drag geometry: the solver keeps every relation; dropping a point on another
  point / curve joins it. Box select (left to right inside, right to left
  crossing).
- Colours: blue = still free, white / black = fully defined, red = conflict,
  orange points = open ends. Closed regions are shaded; the tree shows how
  many profiles a sketch has.

## Later stages (SolidCraft has these, not built yet)

Ellipse, conic, splines (control / fit point), equation curves, text, sketch
patterns (rectangular / circular), move / copy / scale / transform, blend
curve, break, project / include 3D edges, intersection curves, sketch on a
picked face directly, DXF / SVG insert and DXF export, loose-end tie-up,
auto-constrain, Creo-style constraint locking while drawing (right-click to
lock / disable an offered relation) and a conflict dialog (undo / delete /
make reference) instead of a refusal.
