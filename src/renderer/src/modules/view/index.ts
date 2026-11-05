import { icons } from '@/core/icons'
import type { CadModule, Command } from '@/core/types'
import type { StandardView } from '@/core/viewport'

const view = (v: StandardView, label: string, icon: string, shortcut: string): Command => ({
  id: `view.${v}`,
  label,
  icon,
  shortcut,
  tooltip: `${label} view`,
  run: (ctx) => ctx.viewport.setStandardView(v)
})

export const viewModule: CadModule = {
  id: 'view',
  title: 'View',
  order: 90,
  groups: [
    {
      label: 'Zoom',
      commands: [
        { id: 'view.fit', label: 'Fit all', icon: icons.fit, shortcut: 'F', run: (ctx) => ctx.viewport.fitAll() },
        {
          id: 'view.fit-selection',
          label: 'Fit selected',
          icon: icons.fitSel,
          shortcut: 'Shift+F',
          isEnabled: (ctx) => ctx.doc.selection().length > 0,
          run: (ctx) => ctx.viewport.fitSelection()
        }
      ]
    },
    {
      label: 'Standard views',
      commands: [
        view('iso', 'Iso', icons.iso, '0'),
        view('top', 'Top', icons.top, '7'),
        view('front', 'Front', icons.front, '1'),
        view('right', 'Right', icons.right, '3'),
        view('left', 'Left', icons.left, 'Ctrl+3'),
        view('back', 'Back', icons.back, 'Ctrl+1'),
        view('bottom', 'Bottom', icons.bottom, 'Ctrl+7')
      ]
    },
    {
      label: 'Projection',
      commands: [
        {
          id: 'view.perspective',
          label: 'Perspective',
          icon: icons.persp,
          shortcut: '5',
          isActive: (ctx) => ctx.viewport.projection === 'perspective',
          run: (ctx) => ctx.viewport.setProjection('perspective')
        },
        {
          id: 'view.orthographic',
          label: 'Orthographic',
          icon: icons.ortho,
          shortcut: 'Shift+5',
          isActive: (ctx) => ctx.viewport.projection === 'orthographic',
          run: (ctx) => ctx.viewport.setProjection('orthographic')
        }
      ]
    },
    {
      label: 'Display',
      commands: [
        {
          id: 'view.shaded',
          label: 'Shaded',
          icon: icons.shaded,
          isActive: (ctx) => ctx.viewport.displayMode === 'shaded',
          run: (ctx) => ctx.viewport.setDisplayMode('shaded')
        },
        {
          id: 'view.shaded-edges',
          label: 'With edges',
          icon: icons.edges,
          isActive: (ctx) => ctx.viewport.displayMode === 'shaded-edges',
          run: (ctx) => ctx.viewport.setDisplayMode('shaded-edges')
        },
        {
          id: 'view.wireframe',
          label: 'Wireframe',
          icon: icons.wire,
          isActive: (ctx) => ctx.viewport.displayMode === 'wireframe',
          run: (ctx) => ctx.viewport.setDisplayMode('wireframe')
        }
      ]
    },
    {
      label: 'Show',
      commands: [
        {
          id: 'view.grid',
          label: 'Grid',
          icon: icons.grid,
          shortcut: 'G',
          isActive: (ctx) => ctx.viewport.grid.visible,
          run: (ctx) => ctx.viewport.setGridVisible(!ctx.viewport.grid.visible)
        },
        {
          id: 'view.axes',
          label: 'Axes',
          icon: icons.axes,
          isActive: (ctx) => ctx.viewport.axes.visible,
          run: (ctx) => ctx.viewport.setAxesVisible(!ctx.viewport.axes.visible)
        }
      ]
    }
  ]
}
