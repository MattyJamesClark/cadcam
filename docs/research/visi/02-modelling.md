# VISI: modelling

VISI is **hybrid**: solids, sheets (surfaces) and wireframe live together, with no history tree
forcing an order, on the Parasolid kernel (public product pages). For us that maps to OCCT B-rep
with direct edits, which matches our no-history decision.

## What the public pages list

* Wireframe and 2D/3D curves, profiles, solid primitives and boolean operations.
* Surface modelling for complex shapes, and repair of imported data.
* Direct editing of faces on imported solids.
* Release history: editing the radius of an existing constant-radius blend (2023.1); using a
  mesh as a body (2024.3).

The detail of each command (inputs, options) is for MATHEW to show from his own use of VISI.
The command list below is our own, built from what tool & die work needs and from the NX,
Fusion and Creo notes in this folder.

## Our command set (own design)

1. **Direct modelling first**: unite / subtract / intersect, cut by plane, split body by a sheet
   or face, cavity (pocket the shape of another body, with offset), delete face and heal,
   move/offset face, draft face, blend and chamfer edges, shell.
2. Every create command offers a **create mode**: new body, unite or subtract.
3. **Primitives with placement modes** (centre, corner, circle centre) for quick inserts and
   pockets.
4. Surfaces most needed for tool work: ruled, loft, N-sided patch, extrude/draft from curve,
   extract face, trim, sew to solid. Freeform tools can wait.
5. Curve tools for later surfacing: offset, project, intersection curve, edges to wire.

## Sources

* VISI Modelling page (Nexnet reseller): <https://visi.nexnet.cz/visi-modelling.html>
* VISI release history: <https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>
