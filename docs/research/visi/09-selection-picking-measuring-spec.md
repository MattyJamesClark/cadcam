# Selection, picking and measuring: spec for our rebuild

This is the spec for the selection system, with measuring redone on top of it. It is our own
design, using the public NX and Fusion docs in this folder, VISI's public release notes, and
MATHEW's own use of VISI. Items marked **(MATHEW)** need his answer from VISI itself, by
description or screenshot.

## 1. Two picking states

Every command step asks for one of two things, and the prompt says which:

| State | Wants | Snaps apply? | Example |
| --- | --- | --- | --- |
| **Point** | A position | Yes | Start of a line, a dimension end, a workplane origin |
| **Element** | An object (edge, face, curve, body) | No | Body to unite, edge to blend, circle to dimension |

A command can switch state between steps. Dimensions accept either two points or one element.

**Our build:** each command step declares `kind: 'point' | 'element'` plus the allowed types.
The bottom prompt shows the text and an icon for the state. The type filter only applies in the
element state; the snap set only applies in the point state.

## 2. Element state

### Type filter
Our palette already has Everything / Points / Edges / Faces / Surfaces / Bodies, one click for
one type and Ctrl+click to combine. Add circles vs arcs as a sub-filter of edges (for hole
picks), and dimensions. The filter can change mid-command without leaving it.

### Ways to pick
| Mode | Behaviour |
| --- | --- |
| Single pick | Click picks one item; a new click replaces it |
| Multi | Click items one after another to build a set; modifier key **(MATHEW said Shift)** |
| Window / crossing | Left-to-right box takes items fully inside; right-to-left takes anything touched (Fusion, AutoCAD) |
| Select all / visible | Every item that passes the filter, or only visible ones |
| Pre-selection | Pick first, then run a command, with a counter (VISI 2024.3 release notes, Fusion) |

### Grow rules (NX selection intent, Fusion)
A drop-down beside the palette: Single, Tangent faces, Region (seed plus boundary faces),
Adjacent, Same colour, Hole faces, Boss/pocket faces, All blends. For edges: Single, Tangent
chain, Face loop, Sheet boundary.

### Other
* **Select other**: long press (or Alt+click) lists everything under the cursor by depth.
* **Select-through** toggle for hidden items.

## 3. Point state (snaps)

Default mode is **inferred** (NX): it chooses the best snap under the cursor, in this order:
vertex, edge midpoint, circle centre, intersection, nearest on edge, point on face. A small glyph
shows which snap fired. Each snap can also be forced by an icon or key.

Snap set: free pick, typed X/Y/Z (in the active workplane or absolute), intersection of two
elements, point at a distance or fraction along an edge, circle quadrant, circle centre, between
two points, nearest on an element, project onto the workplane, grid.

## 4. Mouse and keys inside a command (our rules)

| Input | Meaning |
| --- | --- |
| Left click | Pick; hold and drag for a box |
| Right click | Accept the current set, direction or result |
| Middle click | Skip an optional input |
| Space / negative value | Flip side, sign or direction |
| Escape | Leave the input box, or end the command |
| Command repeat | After OK, the command starts again until Esc |

## 5. Measuring

**Our build, on top of the selection system:**
1. Quick measure: a command with two element-or-point steps. Result tag on screen with distance,
   dX/dY/dZ in the **active workplane**, and angle when both are planar or linear. Values can be
   clicked to copy (Fusion does this). Command repeats.
2. One-pick measure: an edge gives length (and radius/Ø for circles), a face gives area and
   normal or radius, a body gives area, volume and centre of gravity.
3. Hover analyser: draft angle (to workplane Z), radius and Z height near the cursor (VISI's
   public pages list a surface analyser and, in 2023.1, an altitude readout).
4. Value into input box: while typing a value, pick an element to take its length or radius.

## 6. Open questions for MATHEW

1. Which key adds to a selection, and does Ctrl remove?
2. Does a right-to-left box pick crossing items?
3. How does VISI's distance/angle measure work in your daily use, and what do you like or dislike
   about it?
4. Does a free pick land on the face under the cursor or on the workplane?

## Sources

* VISI release history (2023.1, 2024.3): <https://hexagon.com/products/product-groups/computer-aided-manufacturing-cad-cam-software/visi/release-history>
* VISI Analysis page: <https://hexagon.com/products/visi-analysis>
* NX and Fusion pages in this folder: [NX](../nx/nx-overview.md), [Fusion](../fusion/fusion-overview.md)
