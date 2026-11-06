import type { CadModule, Command, ModuleContext } from '@/core/types'
import { openFeature, type FeatureKind } from '@/part/feature'
import { openBoolean, type BoolOp } from '@/part/boolean'
import type { Mode } from '@/part/common'

/**
 * Part Design: sketches (the Sketch button) and solids from them (extrude, revolve, sweep) and booleans
 * (add, cut, intersect). Direct modelling: each command makes or changes a
 * plain body in one undo step; there is no feature history. Values are typed
 * in the strip or dragged on screen, with a live preview.
 */

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

const ico = {
  sketch: svg('<path d="M4 20h16"/><path d="M5 16 15 6l3 3L8 19H5z"/><path d="m13 8 3 3"/>'),
  extrude: svg('<path d="M4 17l5 3 11-5-5-3z"/><path d="M4 17V9l11-5v8"/><path d="M9 20v-8L4 9"/><path d="M9 12l11-5v8" opacity=".55"/><path d="M15 4l5 3"/>'),
  extrudeCut: svg('<path d="M3 15l7 4 11-5-7-4z"/><path d="M8 13.5l4 2.2 4.5-2-4-2.2z" fill="currentColor" opacity=".35"/><path d="M12 15.7V9M16.5 13.7V7.5M8 13.5V7" stroke-dasharray="2 1.6"/>'),
  revolve: svg('<path d="M12 3v18" stroke-dasharray="3 2"/><ellipse cx="12" cy="7" rx="6" ry="2"/><path d="M6 7v10M18 7v10"/><path d="M6 17a6 2 0 0 0 12 0"/><path d="M15 3.5l2 1.2-1.6 1.4" opacity=".7"/>'),
  revolveCut: svg('<path d="M3 16l7 4 11-5-7-4z"/><ellipse cx="12" cy="14.5" rx="3.5" ry="1.3" fill="currentColor" opacity=".35"/><path d="M12 4v8" stroke-dasharray="2.4 1.6"/><path d="M8.5 14.5V9a3.5 1.3 0 0 1 7 0v5.5" opacity=".7"/>'),
  sweep: svg('<path d="M4 18c0-6 4-11 16-12"/><rect x="2" y="15" width="5" height="5" rx=".5"/><path d="M8 20c1-6 5-10 13-10.5" opacity=".55"/><path d="M18 4.5l2.5 1.5-2.2 1.8"/>'),
  add: svg('<rect x="3" y="8" width="11" height="11" rx="1"/><circle cx="15" cy="9" r="6"/><path d="M15 6.5v5M12.5 9h5"/>'),
  cut: svg('<rect x="3" y="8" width="11" height="11" rx="1"/><path d="M15 3a6 6 0 1 1-6 6" stroke-dasharray="2 1.6"/><path d="M12.5 9h5"/>'),
  intersect: svg('<rect x="3" y="8" width="11" height="11" rx="1" opacity=".55"/><circle cx="14" cy="10" r="6" opacity=".55"/><path d="M8 10.3A6 6 0 0 1 14 4.1V8h0V19H8z" fill="currentColor" opacity=".0"/><path d="M8.1 8.7A6 6 0 0 0 13.5 16V8z" fill="currentColor" opacity=".45"/>')
}

const hasSketches = (ctx: ModuleContext): boolean => ctx.doc.sketches.some((s) => s.curves.length > 0)
const solids = (ctx: ModuleContext): number => ctx.doc.bodies().filter((n) => (n.object as { geometry?: { userData: { brep?: unknown } } }).geometry?.userData.brep).length

function featureCmd(kind: FeatureKind, mode: Mode | undefined, id: string, label: string, icon: string, tooltip: string): Command {
  return {
    id,
    label,
    icon,
    tooltip,
    isEnabled: (ctx) => hasSketches(ctx) && (mode !== 'cut' || solids(ctx) > 0),
    run: (ctx) => openFeature(ctx, kind, mode)
  }
}

function boolCmd(op: BoolOp, id: string, label: string, icon: string, tooltip: string): Command {
  return { id, label, icon, tooltip, isEnabled: (ctx) => solids(ctx) >= 2, run: (ctx) => openBoolean(ctx, op) }
}

export const partModule: CadModule = {
  id: 'part',
  title: 'Part Design',
  order: 20,
  groups: [
    {
      label: 'Sketch',
      commands: [
        // The sketch module's own command (it has no tab): pick a plane, face or sketch, then the Sketch tools come up.
        {
          id: 'part.sketch',
          label: 'Sketch',
          icon: ico.sketch,
          tooltip: 'New sketch: click a plane (Top, Front, Right or a work plane), a flat face or an existing sketch, then the Sketch tools come up',
          isEnabled: (ctx) => ctx.command('sketch.new')?.isEnabled?.(ctx) ?? true,
          isActive: (ctx) => ctx.command('sketch.new')?.isActive?.(ctx) ?? false,
          run: (ctx) => ctx.runCommand('sketch.new')
        }
      ]
    },
    {
      label: 'Make solid',
      commands: [
        featureCmd('extrude', undefined, 'part.extrude', 'Extrude', ico.extrude, 'Extrude closed sketch profiles straight out (distance, both sides, draft), as a new body or added to / cut from one'),
        featureCmd('revolve', undefined, 'part.revolve', 'Revolve', ico.revolve, 'Turn closed sketch profiles round an axis line'),
        featureCmd('sweep', undefined, 'part.sweep', 'Sweep', ico.sweep, 'Carry a closed profile along a path drawn in another sketch')
      ]
    },
    {
      label: 'Remove',
      commands: [
        featureCmd('extrude', 'cut', 'part.extrude-cut', 'Extrude cut', ico.extrudeCut, 'Cut a pocket or hole from a body with a sketch profile (through all, a depth, or both sides)'),
        featureCmd('revolve', 'cut', 'part.revolve-cut', 'Revolve cut', ico.revolveCut, 'Cut a turned groove or bore from a body (profile round an axis)'),
        featureCmd('sweep', 'cut', 'part.sweep-cut', 'Sweep cut', ico.sweep, 'Cut a channel along a path')
      ]
    },
    {
      label: 'Combine',
      commands: [
        boolCmd('fuse', 'part.add', 'Add', ico.add, 'Join bodies into one (the first one picked is kept)'),
        boolCmd('cut', 'part.subtract', 'Cut', ico.cut, 'Take bodies away from a target body'),
        boolCmd('common', 'part.intersect', 'Intersect', ico.intersect, 'Keep only where bodies overlap')
      ]
    }
  ]
}
