# Research: VISI, Siemens NX, Autodesk Fusion and PTC Creo

Notes gathered on 2026-11-05/06 to guide what CADCAM Studio builds and how it should behave.
Everything is written in our own words from public pages; no text, images or icons were copied.
Hexagon's VISI help and training material is not used; VISI detail comes from MATHEW's own use.
Each page lists its sources.

**Start here: [priorities.md](priorities.md)**, the ordered build list.

## VISI (main UX reference)

| Page | Covers |
| --- | --- |
| [UI and interaction](visi/01-ui-and-interaction.md) | What the public release notes say about the UI, plus our own interaction rules |
| [Modelling](visi/02-modelling.md) | Hybrid modelling, public feature list, and our direct-modelling command set |
| [Analysis](visi/03-analysis.md) | Draft, compare, thickness, curvature, hover analyser; our build order |
| [Mould](visi/04-mould.md) | Public mould feature list and our mould chain (split line to standard parts) |
| [Progressive die](visi/05-progress-die.md) | Public progressive die feature list and the pieces worth building early |
| [Electrode](visi/06-electrode.md) | VISI plus PowerShape, Cimatron and NX electrode options in detail |
| [CAM and wire](visi/07-cam-and-wire.md) | 2D, 3D, 5-axis, PEPS-Wire |
| [Drafting and dimensions](visi/08-drafting-and-dimensions.md) | Public detailing features and our dimension and hole table plan |
| [Selection, picking, measuring spec](visi/09-selection-picking-measuring-spec.md) | Our spec for the selection rebuild and the new measure tools, with open questions |
| [Source catalogue](visi/10-source-catalogue.md) | The public VISI pages and videos used, and which ones can be read |

## Others

| Page | Covers |
| --- | --- |
| [Siemens NX](nx/nx-overview.md) | Selection intent, snap points, dynamic WCS, synchronous modelling, Mold Wizard, Progressive Die Wizard, electrode, CAM navigator |
| [PTC Creo: Sketcher](creo/creo-sketcher.md) | Weak/strong dimensions, constraint inference keys, conflicts, dimension tools, diagnostics, palette; recommendations for our Sketch tab |
| [PTC Creo: Mold and NC](creo/creo-mold-and-nc.md) | Mold tab commands, silhouette + skirt parting, multi-cavity layout, ejector holes, mold opening; NC sequence types, parameters, negative stock for electrodes |
| [Autodesk Fusion](fusion/fusion-overview.md) | Selection modes and select-other, construction planes, inspect tools, CAM setup/stock/toolpath tabs, hole recognition |

## Gaps and how to fill them

* **VISI itself**: the best source for gaps is MATHEW's own use of VISI 2026.2. Send
  screenshots of a dialog to the project and they can be turned into specs.
* **NX docs** (docs.sw.siemens.com) need a Siemens account; NX notes use blogs, white papers,
  tutorials and the public NX Open API reference. Some items are marked *general knowledge*.
* **YouTube** is blocked from cloud sessions, so videos could not be used.
