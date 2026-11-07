# VISI Mould: split, core/cavity, mould tool, standard parts

## What the public pages list

From the Hexagon and Nexnet VISI Mould pages and the release history:

* Part preparation: analysis, orientation, shrinkage.
* **Split line** (parting line) on the part, found automatically and editable.
* **Parting / shut-off surfaces** built out from the split line; 2023.1 made this more
  interactive and automatic.
* **Core and cavity** inserts and side-action zones.
* **Mould tool** from supplier catalogues (more than 35 suppliers such as Hasco, DME and
  Meusburger), with plates and **standard elements** that cut their own clearances.
* Ejectors trimmed to the form, cooling channels, sliders and lifters, open/close animation.
* BOM and 2D detailing.
* **VISI Flow**: filling and warpage analysis (2024.3 changes to the filling phase). Out of
  scope for us for a long time.

How each step is driven in VISI is for MATHEW to show from his own use. The Creo and NX notes
in this folder give the public step-by-step detail for the same jobs.

## Our mould chain (own design)

1. Draft analysis and pull direction.
2. Shrinkage (uniform or per axis about a point).
3. Split line from the silhouette seen along the pull direction, shown as edge sets that can
   be removed or joined until the loops are closed, with a slider that pulls the two halves
   apart as a preview.
4. Parting surface: run-off extrusion from the split line, plus patches for shut-off holes.
5. Split the insert block into core and cavity.
6. Pocket the plates (the Cavity command).
7. Plate stack from a simple parametric template.
8. Standard parts with a start and end plate, length fitted to the plates, and automatic
   clearance holes.

Supplier catalogue data (Hasco, DME, Meusburger) is public in their own catalogues, but each
library is real work; start with a generic plate stack and ISO screws and dowels.

## Sources

* VISI Mould: <https://hexagon.com/products/visi-mould>, <https://visi.nexnet.cz/visi-mould.html>
* VISI Analysis: <https://hexagon.com/products/visi-analysis>
* VISI release history: <https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>
