import type { CadModule } from '@/core/types'

/**
 * Tabs for modules that are on the roadmap but not built yet. Each one gets
 * replaced by a real module folder when we build it.
 */
export const plannedModules: CadModule[] = [
  {
    id: 'cam',
    title: 'CAM',
    order: 30,
    groups: [],
    planned: 'Stock and tool libraries, 2.5D and 3D toolpaths, simulation, and post-processors for G-code.'
  }
]
