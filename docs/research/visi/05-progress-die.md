# VISI Progress: progressive die and press tools

## What the public pages list

From the Hexagon VISI Progress page, the Nexnet VISI Blank and Multi-Slides pages and the
release history:

* **Part study** of the sheet part: material, thickness, neutral fibre; 2023.1 added automatic
  neutral fibre and recognition of etching.
* **Unfolding** step by step to plan the forming stages.
* **VISI Blank**: one-step flattening of a 3D form, with thinning and formability maps and
  springback prediction.
* **Strip layout**: nesting, pitch, width, scrap, stations, strip simulation.
* **Punches**: pierce, trim, notch, bend and form.
* **Tool build**: die set plates, punch clearances and standard parts, saved as templates.
* Multi-slide tools (VISI Multi-Slides).

How each step is driven in VISI is for MATHEW to show from his own use.

## Our build (own design)

This is a large module. Pieces that are useful early and reuse other work:

1. Sheet thickness plus K-factor unfold of simple bends. OCCT handles developable bends; a real
   one-step solver is a big project.
2. Strip layout for flat blanks: pitch, width, margins and scrap % (2D nesting maths, very
   doable).
3. Plate stack and punches through plates with a clearance offset per plate type (the same
   engine as mould standard parts).

## Sources

* VISI Die Tool Design: <https://hexagon.com/products/visi-progress>
* VISI Blank: <https://visi.nexnet.cz/visi-blank.html>
* VISI Multi-Slides: <https://visi.nexnet.cz/visi-multi-slides.html>
* VISI release history: <https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>
