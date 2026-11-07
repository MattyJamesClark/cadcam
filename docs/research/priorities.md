# What to build next (prioritised)

Based on the VISI, NX and Fusion research in this folder and on what the app has at v0.1.33
(import with layers and colours, VISI-style selection palette, active workplane with move/rotate
strip, command bar with tick/cross/back/next, bottom prompts, quick measure, dimensions,
translate). The order follows MATHEW's rule: **foundations first, then features on top**.

Each item says which reference behaviour it copies and roughly how big it is
(S = a day or two, M = about a week, L = several weeks).

## Tier 1: finish the foundations (everything else uses these)

| # | Item | Reference | Size |
| --- | --- | --- | --- |
| 1 | **Command engine rules**: commands repeat after OK until Esc; right-click = accept step; middle-click = skip optional step; Space = flip side; negative value flips; last values remembered | Our rules | S |
| 2 | **Selection grow rules** next to the type palette: single, tangent faces, region (seed + boundary), adjacent, same colour, hole/boss, all blends; plus edge rules: tangent chain, face loop | NX selection intent, Fusion | M |
| 3 | **Selection modes**: window (left-to-right) vs crossing (right-to-left), lasso, select-through toggle, **select-other list** on long press, selection counter, pre-select then run command | Fusion, VISI 2024.3 | S-M |
| 4 | **Point input menu**: intersection, quadrant, parametric point (fraction along edge), between two points, project to workplane, typed XYZ in workplane or absolute | NX point dialog, Fusion | M |
| 5 | **Workplane completion**: by current view, flip Z, midplane, plane at angle about an edge, along path, drag triad (NX dynamic WCS), WPL-to-WPL transform; make all of it undoable | NX, Fusion | M |
| 6 | **Layers as working tool**: current layer on bottom bar, move selection to layer, lock, groups, swap hidden/visible, set current by picking | Our design | S-M |
| 7 | **Associative dimensions** (store face/edge refs, re-measure) | Our design | M |

## Tier 2: the tool & die starter kit (most used daily)

| # | Item | Reference | Size |
| --- | --- | --- | --- |
| 8 | **Draft analysis**: pick body + direction (workplane Z default); user bands (e.g. 0 to ±1, ±1 to ±3, >3); live as direction changes; tolerance band; **write colours to faces** so select-by-colour works; | VISI public pages, NX check regions, Fusion | M |
| 9 | **Hover analyser**: draft angle, radius, and Z height of the face under the cursor | VISI public pages | S |
| 10 | **Direct edit basics** on imported solids: unite / subtract / intersect, cut by plane, split body by sheet or face, **cavity** (pocket shaped like another body, with offset), delete face and heal, offset/move face, draft face, blend/chamfer edges, find similar holes | NX synchronous | L (in pieces) |
| 11 | **Hole table**: group holes by diameter, letter each group, X/Y from workplane origin, place table on screen, export CSV | Our design | M |
| 12 | **Primitives with placement modes** (centre, corner, circle centre) and create mode (new / unite / subtract) for quick blocks and pockets | Our design | S-M |
| 13 | **Compare two bodies** (fast: common / changed faces; accurate: distance bands) | VISI public pages | M |
| 14 | Clean-up: find sliver faces, duplicate bodies, sew sheets to solid, heal (OCCT ShapeFix) | OCCT | S-M |

## Tier 3: first real modules

| # | Item | Reference | Size |
| --- | --- | --- | --- |
| 15 | **Electrode module**: burn faces (with grow rules), direction, vertical/tangent extension to clearance, blank from stock list with auto-rotate and datum corner, collision sweep, spark gap per stage (rough/semi/finish), positions (incl. mirrored), STEP per electrode in its own frame, setup sheet | VISI Electrode, PowerShape wizard, Cimatron | L |
| 16 | **Split line and parting**: silhouette imprint from pull direction, edge sets tree (remove, join, close loops), face sets with an explode slider, then run-off extrude + patch shut-offs, then split insert block into core and cavity | NX Mold Wizard, Creo | L |
| 17 | **Shrinkage** (uniform / per axis about a point) | NX | S |
| 18 | **CAM foundation**: setup (WCS from workplane, origin from stock box point, stock box/relative/from solid), tool library, operation tree with inheritance and status icons, post to G-code for one or two controls, HTML setup sheet | Fusion setup, NX navigator, VISI | L |
| 19 | **2D CAM**: hole recognition to drilling cycles (spot/drill/tap/ream/bore), contour, pocket, face | VISI 2D, Fusion | L |
| 20 | **3D CAM**: adaptive rough, rest rough, constant-Z finish, steep-and-shallow, scallop; negative stock for electrode spark gap; holder collision; stock simulation | Fusion, VISI 3D | L+ |

## Tier 4: later

Mould tool plate stack and standard parts with start/end plate and auto clearance; ejector
pins trimmed to core; cooling channels with wall checks; 2D drawing sheets (OCCT HLR); wire EDM
2-axis; progressive die strip layout (pitch, width, scrap %); sheet unfolding; 5-axis.

## Quick wins (each under a day, good for filling gaps)

* Selection counter on the bottom bar.
* Space bar flips direction in Translate and plane move.
* Click the workplane tag to cycle Top/Front/Side; right-click to open the list.
* "Copy" toggle and number of copies in Translate.
* Previous-selection recall already exists; add "invert selection" and "select all visible".
* Section view with a draggable plane (Fusion section analysis).

## Things to ask MATHEW (from his own use of VISI)

1. In draft analysis, which band colours and angles does the shop use by default?
2. For electrodes, which blank sizes are in stock, and what spark gaps per stage are typical?
3. Which EDM machine and controller, and which milling controllers, need posts first?
4. Does the shop use VISI Mould (plates and standard parts) day to day, or mainly split and
   inserts? That decides whether Tier 4 mould base work moves up.
