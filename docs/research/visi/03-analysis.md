# VISI: analysis tools

These are what toolmakers open first on a customer part. Several feed straight into mould
splitting (draft colours, then face sets, then the split).

## What the public pages list

From the VISI Analysis product page, the Nexnet analysis page and the release history:

* **Draft analysis**: faces coloured by draft angle against a pull direction. Since 2023.1 the
  view updates live and several scenarios can be stored.
* **Compare models**: differences between two versions of a part.
* **Thickness** and **curvature / radius** colour maps.
* **Surface analyser**: information about the face under the cursor.
* **Interference** checking between bodies.
* **Data clean-up** for imported models.
* **Altitude** (2023.1): live Z height while hovering.

How each one is driven in VISI is for MATHEW to show from his own use.

## Our build (own design)

* **Draft analysis**: pick a body and a direction (workplane Z by default). User bands of angle,
  each a colour, positive toward one side and negative toward the other, with a tolerance band
  for vertical faces. Done as a shader on the mesh (normal against the pull direction), then a
  **"colour faces by draft"** step that writes face colours so select-by-colour works.
* **Hover analyser**: draft angle, radius and Z height under the cursor.
* **Seed-face growth**: pick faces, the set grows over neighbours within an angle.
* **Compare two bodies**: fast (common / changed faces) and accurate (distance bands).
* Thickness, curvature, interference.
* Clean-up from OCCT (ShapeFix, ShapeUpgrade): sliver faces, duplicate bodies, sew, heal.

Build order: draft analysis, hover analyser, seed growth, compare, thickness, curvature,
interference. NX check regions and Fusion's draft analysis (see their pages) give the public
detail.

## Sources

* VISI Analysis product page: <https://hexagon.com/products/visi-analysis>
* Nexnet analysis page: <https://visi.nexnet.cz/visianalysis-video.html>
* VISI release history: <https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>
