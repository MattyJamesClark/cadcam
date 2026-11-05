import type { CadModule, Command, ModuleContext } from '@/core/types'
import { icons } from '@/core/icons'
import { selectFilter, type SelectFilter } from '@/core/picking'
import { closeMeasure, isMeasuring, openMeasure } from '@/core/measure'
import { hoverInfoEnabled, setHoverInfo, startHoverInfo } from '@/core/hoverinfo'
import { closeDimensionTool, dimToolKind, openDimensionTool, type DimKind } from '@/core/dimtool'
import { dimsShown, setDimsShown, startDimensions } from '@/core/dimensions'
import { closeBoundingBox, isBoundingBoxOpen, openBoundingBox } from '@/core/bbox'

/**
 * Query: inspect the model without changing it. Measure, bounding box, and the
 * select filter that decides what a click picks (points, edges, faces, bodies;
 * sketch entities later).
 */

const dimCommand = (kind: DimKind, label: string, icon: string, tooltip: string, shortcut?: string): Command => ({
  id: `query.dim.${kind}`,
  label,
  icon,
  shortcut,
  tooltip,
  isEnabled: (ctx) => !ctx.doc.isEmpty(),
  isActive: () => dimToolKind() === kind,
  run: (ctx) => (dimToolKind() === kind ? closeDimensionTool() : openDimensionTool(ctx, kind))
})

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
  init: (ctx) => {
    startHoverInfo(ctx)
    startDimensions(ctx)
  },
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
      label: 'Dimensions',
      commands: [
        dimCommand('distance', 'Point to point', icons.dimLinear, 'Distance between two points, edges, faces or hole centres: true, or along X / Y / Z', 'D'),
        dimCommand('size', 'Diameter / radius', icons.dimDia, 'Ø or R of a hole, boss, arc or fillet'),
        dimCommand('angle', 'Angle', icons.dimAngle, 'Angle between two straight edges or flat faces'),
        dimCommand('ordinate', 'Ordinate', icons.dimOrd, 'X / Y / Z of a point or hole centre from a datum'),
        {
          id: 'query.dim.show',
          label: 'Show dimensions',
          icon: icons.eye,
          tooltip: 'Show or hide the dimensions in the view',
          isActive: () => dimsShown(),
          run: (ctx) => {
            setDimsShown(!dimsShown())
            ctx.refreshRibbon()
          }
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
    },
    {
      label: 'Dynamic',
      commands: [
        {
          id: 'query.hover-info',
          label: 'Hover info',
          icon: icons.pickFace,
          tooltip: 'Highlight faces, edges and points under the pointer and show their size (click to pin)',
          isActive: () => hoverInfoEnabled(),
          run: (ctx) => {
            setHoverInfo(!hoverInfoEnabled())
            ctx.refreshRibbon()
          }
        }
      ]
    }
  ]
}
