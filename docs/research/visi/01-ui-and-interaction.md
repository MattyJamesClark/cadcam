# VISI: user interface and interaction

VISI (Hexagon) is the main UX reference for this app. MATHEW knows it from daily use, so the
detailed behaviour (how a command runs, how picking and workplanes work) comes from **his own use
of VISI and his screenshots**, not from Hexagon's help or training material. This page keeps
only what Hexagon's public product pages and release notes say, plus the design rules we have
chosen for our own app.

## 1. What the public pages say

| Release / page | Change | Notes for us |
| --- | --- | --- |
| Release history, 2023.1 | Command toolbar can float, dock or hide; dialogs reworked with collapsible sections; electrode moved to a standard dialog with live preview | Keep option sets short and collapsible |
| Release history, 2023.1 | Altitude: a live Z-height readout while hovering | Add a Z readout (in the active workplane) to hover info |
| Release history, 2024.3 | Multi-select on the main graphics screen, so items can be picked before a command; a counter shows how many are selected; highlight can be set to faces and bodies or edges only | Pre-select then run, and a selection count on the bar |
| VISI Analysis page | A surface analyser shows information about the face under the cursor | Hover info with draft angle and radius |
| VISI Modelling pages (Hexagon, Nexnet) | Hybrid modelling: solids, sheets and wireframe together, direct editing, Parasolid kernel | Same idea on OCCT, no history tree |

## 2. Our own interaction rules

These are our design decisions. Where they match VISI, MATHEW should confirm from his own use.

1. **Commands repeat** after OK until Esc, keeping the last values.
2. **Right-click accepts** the current step; middle-click skips an optional step.
3. **Space flips** a side or direction; a negative typed value does the same.
4. **One prompt per step** on the bottom bar, saying whether a point or an object is wanted.
5. **Preview before OK**, with drag handles on screen for every value (see the drag-handle rule).
6. **Copy toggle and count** on move, rotate and mirror.
7. **Everything is undoable**, including workplane changes.

## 3. Selection, snaps, workplanes, layers

The selection spec is in [09](09-selection-picking-measuring-spec.md). It is built from our own
design, NX and Fusion public docs, and MATHEW's answers. Workplanes follow what is already in the
app (one active plane, Absolute always there, new planes temporary until pinned). Layers follow
the import of layer data from STEP and other CAD files, which is standard across CAD.

## Sources

* VISI release history (2023.1, 2024.3): <https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>
* VISI Modelling product page (Nexnet reseller): <https://visi.nexnet.cz/visi-modelling.html>
* VISI Analysis product page: <https://hexagon.com/products/visi-analysis>
