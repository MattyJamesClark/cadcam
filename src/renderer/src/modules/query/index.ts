import type { CadModule, Command, ModuleContext } from '@/core/types'
import { icons } from '@/core/icons'
import { selectFilter, type SelectFilter } from '@/core/picking'
import { closeMeasure, isMeasuring, openMeasure } from '@/core/measure'
import { closeBoundingBox, isBoundingBoxOpen, openBoundingBox } from '@/core/bbox'

/**
 * Query: inspect the model without changing it. Measure, bounding box, and the
 * select filter that decides what a click picks (points, edges, faces, bodies;
 * sketch entities later).
 */

const filterCommand = (key: keyof SelectFilter, label: string, icon: string): Command => ({
  id: `query.select.${key}`,
  label,
  icon,
  tooltip: `Pick ${label.toLowerCase()} when measuring`,
  isActive: () => selectFilter.value[key],
  run: (ctx: ModuleContext) => {
    selectFilter.toggle(key)
    ctx.refreshRibbon()
  }
})

export const queryModule: CadModule = {
  id: 'query',
  title: 'Query',
  order: 5,
  groups: [
    {
      label: 'Measure',
      commands: [
        {
          id: 'query.measure',
          label: 'Measure',
          icon: icons.ruler,
          shortcut: 'M',
          tooltip: 'Measure points, edges, faces and the distance / angle between two of them',
          isEnabled: (ctx) => !ctx.doc.isEmpty(),
          isActive: () => isMeasuring(),
          run: (ctx) => (isMeasuring() ? closeMeasure() : openMeasure(ctx))
        },
        {
          id: 'query.bbox',
          label: 'Bounding box',
          icon: icons.bbox,
          shortcut: 'B',
          tooltip: 'Overall size of the selection (or everything), rectangular or cylindrical, relative to a datum',
          isEnabled: (ctx) => !ctx.doc.isEmpty(),
          isActive: () => isBoundingBoxOpen(),
          run: (ctx) => (isBoundingBoxOpen() ? closeBoundingBox() : openBoundingBox(ctx))
        }
      ]
    },
    {
      label: 'Select',
      commands: [
        filterCommand('vertex', 'Points', icons.pickPoint),
        filterCommand('edge', 'Edges', icons.pickEdge),
        filterCommand('face', 'Faces', icons.pickFace),
        filterCommand('body', 'Bodies', icons.pickBody)
      ]
    }
  ]
}
