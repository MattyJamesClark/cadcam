# VISI: dimensions and 2D detailing

## What the public pages list

From the VISI Mould and Progress pages and the release history:

* A full drawing set generated from the tool assembly: 2D and isometric views, sections, and
  mixed rendered and 2D views.
* Automatic **plate dimensioning** and **hole tables**.
* Catalogue parts drawn correctly in section.
* **Associative** views and dimensions that update with the model.
* BOM tables with balloons.
* 2023.1: plot page management (drag and drop pages, multi-select, sorting).

## Our build (own design)

Our v0.1.19 dimensions cover linear, Ø/R and angle. Next:

1. Make dimensions associative (store face/edge ids and re-measure).
2. **Hole table**: group holes by diameter, letter each group, list X/Y from the active
   workplane origin, export CSV. Very high value for plates and inserts.
3. Ordinate dimensions from the workplane origin.
4. Centre crosses and balloons.
5. Later: 2D drawing sheets with projected views (OCCT HLR gives hidden-line projections).

## Sources

* VISI Mould: <https://hexagon.com/products/visi-mould>
* VISI Progress: <https://hexagon.com/products/visi-progress>
* VISI release history: <https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>
