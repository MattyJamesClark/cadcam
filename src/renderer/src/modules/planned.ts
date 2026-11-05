import type { CadModule } from '@/core/types'

/**
 * Tabs for modules that are on the roadmap but not built yet. Each one gets
 * replaced by a real module folder when we build it.
 */
export const plannedModules: CadModule[] = [
  {
    id: 'sketch',
    title: 'Sketch',
    order: 10,
    groups: [],
    planned: '2D constrained sketching on planes and faces: lines, arcs, circles, dimensions and constraints.'
  },
  {
    id: 'part',
    title: 'Part Design',
    order: 20,
    groups: [],
    planned: 'Solid modelling from sketches: extrude, revolve, fillet, chamfer, holes, booleans. STEP/IGES import and export arrive with this module.'
  },
  {
    id: 'cam',
    title: 'CAM',
    order: 30,
    groups: [],
    planned: 'Stock and tool libraries, 2.5D and 3D toolpaths, simulation, and post-processors for G-code.'
  }
]
